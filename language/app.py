import base64
import difflib
import functools
import io
import math
import os
import re
import subprocess
import tempfile
import threading
import unicodedata
import numpy as np

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

app = FastAPI()
lock = threading.RLock()
MODELS = {"es": "es_core_news_sm", "en": "en_core_web_sm"}
WORD = re.compile(r"[^\W_]+", re.UNICODE)


class Analysis(BaseModel):
    text: str = Field(max_length=120000)
    language: str = Field(max_length=35)


class Alignment(BaseModel):
    audio: str = Field(max_length=24000000)
    words: list[str] = Field(max_length=2000)
    language: str = Field(max_length=35)


@functools.lru_cache(maxsize=12)
def pipeline(language):
    import spacy
    if language in MODELS:
        return spacy.load(MODELS[language], exclude=["parser"]), "contextual"
    try:
        model = spacy.blank(language)
        model.add_pipe("lemmatizer", config={"mode": "lookup"})
        model.initialize()
        return model, "dictionary"
    except (ValueError, ImportError, KeyError):
        return spacy.blank("xx"), "word forms"


@app.get("/healthz")
def health():
    return {"ready": True}


@app.post("/analyze")
def analyze(body: Analysis):
    language = body.language.split("-")[0]
    with lock:
        model, method = pipeline(language)
        doc = model(body.text)
    # Browser text ranges and JavaScript use UTF-16 code-unit offsets.
    offsets = [0]
    for char in body.text:
        offsets.append(offsets[-1] + (2 if ord(char) > 0xFFFF else 1))
    tokens = []
    lemmas = set()
    for token in doc:
        if not any(char.isalpha() for char in token.text):
            continue
        lemma = unicodedata.normalize("NFC", token.lemma_ or token.text).casefold()
        is_name = token.pos_ == "PROPN" or token.ent_type_ in {"PER", "PERSON", "LOC", "GPE"}
        if language == "es":
            if token.text.casefold() in {"hago", "hace"}:
                lemma = "hacer"
            if token.text.casefold() == "haces" and token.pos_ != "NOUN":
                lemma = "hacer"
        if not is_name:
            if language == "es" and token.text.casefold() in {"al", "del"}:
                lemmas.update(("a" if token.text.casefold() == "al" else "de", "el"))
            else:
                lemmas.add(lemma)
        tokens.append({
            "word": token.text, "from": offsets[token.idx], "to": offsets[token.idx + len(token)],
            "lemma": lemma, "pos": token.pos_, "properName": is_name,
        })
    return {"tokens": tokens, "lemmas": sorted(lemmas), "method": method}


@functools.lru_cache(maxsize=1)
def recognizer():
    from faster_whisper import WhisperModel
    folder = os.path.join(os.environ.get("LANGY_MODELS", "./models"), "whisper")
    return WhisperModel(folder, device="cpu", compute_type="int8", cpu_threads=min(4, os.cpu_count() or 2), local_files_only=True)


def normalized(text):
    # Stress accents vary in recognition. Preserve ñ as its own letter.
    decomposed = unicodedata.normalize("NFD", text.casefold())
    return unicodedata.normalize("NFC", "".join(char for char in decomposed if not unicodedata.combining(char) or char == "\u0303"))


@app.post("/align")
def align(body: Alignment):
    try:
        audio = base64.b64decode(body.audio, validate=True)
    except ValueError:
        raise HTTPException(422, "Invalid audio data.") from None
    with tempfile.NamedTemporaryFile(suffix=".wav") as temporary:
        temporary.write(audio)
        temporary.flush()
        try:
            decoded = subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
                "-i", temporary.name, "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1",
            ], capture_output=True, check=True, timeout=90).stdout
            with lock:
                segments, _ = recognizer().transcribe(
                    np.frombuffer(decoded, dtype="<f4"), language=body.language.split("-")[0], word_timestamps=True,
                    beam_size=3, condition_on_previous_text=False,
                    initial_prompt=" ".join(body.words[:40]),
                )
                heard = []
                for segment in segments:
                    for word in segment.words or []:
                        pieces = WORD.findall(word.word)
                        for index, piece in enumerate(pieces):
                            width = (word.end - word.start) / max(1, len(pieces))
                            heard.append((normalized(piece), word.start + width * index,
                                          word.start + width * (index + 1), word.probability))
        except (ValueError, RuntimeError) as error:
            raise HTTPException(422, "The alignment model could not process this recording.") from error
    source = [normalized(word) for word in body.words]
    detected = [word[0] for word in heard]
    times = [None] * len(source)
    previous = 0
    for match in difflib.SequenceMatcher(None, source, detected, autojunk=False).get_matching_blocks():
        for step in range(match.size):
            _, start, end, confidence = heard[match.b + step]
            start = max(previous, float(start))
            if not math.isfinite(end) or end - start < 0.005:
                continue
            times[match.a + step] = {"start": round(start, 3), "end": round(float(end), 3),
                                     "review": bool(confidence < 0.48)}
            previous = end
    return {"timings": times}


@app.post("/pdf")
async def extract_pdf(request: Request):
    from pypdf import PdfReader
    content = await request.body()
    if len(content) > 120 * 1024 * 1024:
        raise HTTPException(413, "This PDF is too large.")
    try:
        pdf = PdfReader(io.BytesIO(content))
        chapters = [{"key": f"pdf:{index + 1}", "title": f"Page {index + 1}",
                     "text": " ".join((page.extract_text() or "").split()), "markers": []}
                    for index, page in enumerate(pdf.pages)]
        def bookmarks(items):
            for item in items:
                if isinstance(item, list):
                    bookmarks(item)
                    continue
                try:
                    page_number = pdf.get_destination_page_number(item)
                    title = str(item.title).strip()[:150]
                    if title and page_number is not None and 0 <= page_number < len(chapters):
                        chapters[page_number]["markers"].append({"title": title, "from": 0})
                except (AttributeError, KeyError, ValueError):
                    continue
        bookmarks(pdf.outline)
        if not any(chapter["markers"] for chapter in chapters):
            for chapter in chapters:
                chapter["markers"] = [{"title": chapter["title"], "from": 0}]
        return {"chapters": chapters}
    except Exception:
        raise HTTPException(422, "The PDF text could not be extracted.") from None
