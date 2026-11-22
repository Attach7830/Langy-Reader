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
MODELS = {"es": "es_core_news_sm", "en": "en_core_web_sm", "pt": "pt_core_news_sm"}
WORD = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)


class Analysis(BaseModel):
    text: str = Field(max_length=120000)
    language: str = Field(max_length=35)


class Alignment(BaseModel):
    audio: str = Field(max_length=24000000)
    words: list[str] = Field(max_length=2000)
    language: str = Field(max_length=35)


class RecordingMatch(BaseModel):
    words: list[str] = Field(max_length=500000)
    heard: list[dict] = Field(max_length=500000)


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
    language = body.language.replace("_", "-").split("-")[0].lower()
    if language in {"zh", "cmn"}:
        tokens, offset = [], 0
        for char in body.text:
            width = 2 if ord(char) > 0xffff else 1
            point = ord(char)
            if 0x3400 <= point <= 0x9fff or 0xf900 <= point <= 0xfaff or 0x20000 <= point <= 0x3ffff or char == "〇":
                tokens.append({"word": char, "from": offset, "to": offset + width, "lemma": char, "pos": "", "properName": False, "language": "zh"})
            offset += width
        return {"tokens": tokens, "lemmas": sorted({token["word"] for token in tokens}), "method": "characters"}
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
            elif language == 'pt' and token.pos_ == 'ADP' and ' ' in lemma:
                lemmas.update(lemma.split())
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
    clean = unicodedata.normalize("NFC", "".join(char for char in decomposed if not unicodedata.combining(char) or char == "\u0303"))
    return "".join(WORD.findall(clean)).replace("'", "").replace("’", "")


def match_timings(words, heard):
    if any(any(0x3400 <= ord(char) <= 0x9fff or 0x20000 <= ord(char) <= 0x3ffff for char in word) for word in words):
        from book_alignment import align_recording
        return align_recording(words, [{"word": word, "start": start, "end": end} for word, start, end, _ in heard])["timings"]
    source = [normalized(word) for word in words]
    detected = [word[0] for word in heard]
    times = [None] * len(source)
    previous = 0
    for match in difflib.SequenceMatcher(None, source, detected, autojunk=False).get_matching_blocks():
        for step in range(match.size):
            _, start, end, confidence = heard[match.b + step]
            if not math.isfinite(start) or not math.isfinite(end):
                continue
            start = max(previous, float(start))
            if end - start < 0.005:
                continue
            times[match.a + step] = {"start": round(start, 3), "end": round(float(end), 3),
                                     "review": bool(confidence < 0.48)}
            previous = end
    return times


def recognized_words(model, samples, language, words, retry=False, vad=False):
    language = language.replace('_', '-').split('-')[0].lower()
    automatic = language in {'', 'mul', 'und', 'auto'}
    if language == 'cmn': language = 'zh'
    segments, _ = model.transcribe(
        samples, language=None if automatic else language, multilingual=automatic, task='transcribe', word_timestamps=True, beam_size=5 if retry else 3,
        condition_on_previous_text=False, temperature=0.0,
        initial_prompt=None if retry else " ".join(words[:40]),
        # Whisper can classify short headings as silence. Retry only the failed chunk.
        no_speech_threshold=None if retry else 0.6,
        vad_filter=vad,
    )
    heard = []
    for segment in segments:
        for word in segment.words or []:
            pieces = WORD.findall(word.word)
            for index, piece in enumerate(pieces):
                width = (word.end - word.start) / max(1, len(pieces))
                heard.append((normalized(piece), word.start + width * index,
                              word.start + width * (index + 1), word.probability))
    return heard


def decode_recording(encoded):
    try:
        audio = base64.b64decode(encoded, validate=True)
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
            return np.frombuffer(decoded, dtype="<f4")
        except (ValueError, RuntimeError, subprocess.SubprocessError, OSError) as error:
            raise HTTPException(422, "The alignment model could not process this recording.") from error


@app.post("/align")
def align(body: Alignment):
    samples = decode_recording(body.audio)
    with lock:
        model = recognizer()
        language = body.language.replace("_", "-").split("-")[0].lower()
        times = match_timings(body.words, recognized_words(model, samples, language, body.words))
        if body.words and not any(times):
            times = match_timings(body.words, recognized_words(model, samples, language, body.words, retry=True))
    return {"timings": times}


@app.post("/transcribe")
def transcribe_recording(body: Alignment):
    samples = decode_recording(body.audio)
    with lock:
        language = body.language.replace("_", "-").split("-")[0].lower()
        heard = recognized_words(recognizer(), samples, language, [], vad=True)
    return {"heard": [{"word": word, "start": float(start), "end": float(end)}
                       for word, start, end, _ in heard]}


@app.post("/rescan")
def rescan_recording(body: Alignment):
    # Fresh recognition of a short gap; do not reuse the book transcript or
    # force the supplied text onto speech that may be absent from this edition.
    samples = decode_recording(body.audio)
    if len(samples) > 70 * 16000:
        raise HTTPException(422, "Rescan windows must be at most 70 seconds.")
    with lock:
        language = body.language.replace("_", "-").split("-")[0].lower()
        heard = recognized_words(recognizer(), samples, language, [], retry=True, vad=False)
        heard = [word for word in heard if word[3] >= 0.65 and word[2] - word[1] >= 0.02
                 and 0 <= word[1] < word[2] <= len(samples) / 16000 + .1
                 and np.sqrt(np.mean(samples[max(0, int(word[1] * 16000)):int(word[2] * 16000)] ** 2)) > 0.0001]
        times = match_timings(body.words, heard)
    return {"timings": times}


@app.post("/match-recording")
def match_recording(body: RecordingMatch):
    from book_alignment import align_recording
    if sum(len(word) for word in body.words) > 3000000:
        raise HTTPException(422, "This book is too large for recording alignment.")
    try:
        return align_recording(body.words, body.heard)
    except (KeyError, TypeError, ValueError):
        raise HTTPException(422, "The recording transcript could not be matched.") from None


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
