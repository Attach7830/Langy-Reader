import base64
from contextlib import contextmanager
import difflib
import functools
import io
import math
import re
import subprocess
import tempfile
import threading
import unicodedata
import numpy as np

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from spanish_morphology import spanish_correction
from vocabulary_filters import lexical_tokens, lemma_inventory
from pdf_ocr import router as ocr_router
from whisper_runtime import AlignmentRuntimeError, runtime as whisper_runtime

app = FastAPI()
app.include_router(ocr_router)
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
    text: str = Field(default='', max_length=4000)


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
        correction = None
        is_name = token.pos_ == "PROPN" or token.ent_type_ in {"PER", "PERSON", "LOC", "GPE"}
        if language == "es":
            correction = spanish_correction(token)
            if correction:
                lemma = correction["lemma"]
                if correction.get("pos", token.pos_) in {"VERB", "AUX"}:
                    is_name = False
                if correction.get("components"):
                    correction["components"] = [{**part, "from": offsets[token.idx + part["from"]],
                                                  "to": offsets[token.idx + part["to"]]} for part in correction["components"]]
        if not is_name:
            if language == "es" and token.text.casefold() in {"al", "del"}:
                lemmas.update(("a" if token.text.casefold() == "al" else "de", "el"))
            elif language == 'pt' and token.pos_ == 'ADP' and ' ' in lemma:
                lemmas.update(lemma.split())
            elif correction and correction.get("components"):
                lemmas.update(part["lemma"] for part in correction["components"])
            else:
                lemmas.add(lemma)
        tokens.append({
            "word": token.text, "from": offsets[token.idx], "to": offsets[token.idx + len(token)],
            "lemma": lemma, "pos": token.pos_, "properName": is_name,
            **(correction or {}),
        })
    tokens = lexical_tokens(body.text, tokens)
    return {"tokens": tokens, "lemmas": lemma_inventory(tokens, language), "method": method}


def recognizer():
    return whisper_runtime.load()


@app.get("/alignment/status")
def alignment_status():
    # Do not load a model or contact a model host just to inspect the service.
    return whisper_runtime.status()


@contextmanager
def alignment_operation(task, samples):
    try:
        with whisper_runtime.operation(task, len(samples) / 16000, lock):
            yield
    except AlignmentRuntimeError as error:
        raise HTTPException(503, error.detail) from None


def normalized(text):
    # Stress accents vary in recognition. Preserve ñ as its own letter.
    decomposed = unicodedata.normalize("NFD", text.casefold())
    clean = unicodedata.normalize("NFC", "".join(char for char in decomposed if not unicodedata.combining(char) or char == "\u0303"))
    return "".join(WORD.findall(clean)).replace("'", "").replace("’", "")


def match_timings(words, heard):
    if any(any(0x3400 <= ord(char) <= 0x9fff or 0x20000 <= ord(char) <= 0x3ffff for char in word) for word in words):
        from book_alignment import align_recording
        return align_recording(words, [{"word": word, "start": start, "end": end, "confidence": confidence}
                                       for word, start, end, confidence in heard])["timings"]
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


def recognized_words(model, samples, language, words, retry=False, vad=False, text=''):
    language = language.replace('_', '-').split('-')[0].lower()
    automatic = language in {'', 'mul', 'und', 'auto'}
    if language == 'cmn': language = 'zh'
    segments, _ = model.transcribe(
        samples, language=None if automatic else language, multilingual=automatic, task='transcribe', word_timestamps=True, beam_size=5 if retry else 3,
        condition_on_previous_text=False, temperature=0.0,
        initial_prompt=None if retry else (text[:350] or ("".join(words[:80]) if language == 'zh' else " ".join(words[:40]))),
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


def timing_quality(words, times):
    # Weight by source characters so one matched syllable cannot hide a missing
    # long compound. Interpolated subword boundaries are less reliable anchors.
    total = sum(max(1, len(normalized(word))) for word in words)
    matched = sum(max(1, len(normalized(word))) * (0.7 if stamp.get('review') else 1)
                  for word, stamp in zip(words, times) if stamp)
    return matched / max(1, total)


def merge_timing_passes(words, first, second):
    primary, other = (second, first) if timing_quality(words, second) > timing_quality(words, first) else (first, second)
    result = list(primary)
    # Fill holes only inside unchanged, ordered neighbouring anchors. Do not
    # combine conflicting passes into a timeline that jumps backward.
    right, boundary = [math.inf] * len(result), math.inf
    for index in range(len(result) - 1, -1, -1):
        right[index] = boundary
        if result[index]: boundary = result[index]['start']
    end = 0
    for index, stamp in enumerate(result):
        if stamp:
            end = stamp['end']
            continue
        candidate = other[index] if index < len(other) else None
        if candidate and candidate['start'] >= end and candidate['end'] <= right[index] and candidate['end'] > candidate['start']:
            result[index] = candidate
            end = candidate['end']
    return result


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
    with alignment_operation("align", samples):
        model = recognizer()
        language = body.language.replace("_", "-").split("-")[0].lower()
        times = match_timings(body.words, recognized_words(model, samples, language, body.words, text=body.text))
        # Partial Mandarin matches are common: the old all-or-nothing test never
        # retried those gaps. Keep retries bounded to one extra pass per chunk.
        if body.words and timing_quality(body.words, times) < .88:
            retry = match_timings(body.words, recognized_words(model, samples, language, body.words, retry=True))
            times = merge_timing_passes(body.words, times, retry)
    return {"timings": times}


@app.post("/transcribe")
def transcribe_recording(body: Alignment):
    samples = decode_recording(body.audio)
    with alignment_operation("transcribe", samples):
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
    with alignment_operation("rescan", samples):
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
