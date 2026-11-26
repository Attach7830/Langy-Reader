"""Optional self-hosted PaddleOCR PDF service using Langy's OCR protocol."""
import hmac
import json
import logging
import multiprocessing
import os
from pathlib import Path
import shutil
import tempfile
import threading

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from paddle_pdf import LANGUAGES, LIMIT, MODELS, convert_pdf, offline_recognition

app = FastAPI(title='Langy PaddleOCR PDF service'); lock = threading.Lock()
active_scan = None


def authorize(request):
    key = os.environ.get('LANGY_OCR_API_KEY', '')
    if key and not hmac.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + key): raise HTTPException(401, 'OCR API key required.')


@app.get('/healthz')
def health(): return {'status': 'ok', 'engine': 'paddleocr', 'protocol': 1}


@app.get('/ocr/languages')
def languages(request: Request):
    authorize(request)
    return {'engine': 'paddleocr', 'protocol': 1, 'languages': LANGUAGES, 'models': MODELS}


@app.get('/ocr/progress/{job_id}')
def progress(request: Request, job_id: str):
    authorize(request)
    current = active_scan
    if current is None or not job_id.isascii() or not hmac.compare_digest(current[0], job_id):
        raise HTTPException(404, 'This scan is not active.')
    try:
        data = json.loads((current[1] / 'progress.json').read_text())
    except (OSError, ValueError):
        data = {'phase': 'preparing', 'complete': 0, 'total': 0}
    return {'job': job_id, **data}


def child(folder, codes, mode, rotate):
    folder = Path(folder)
    try:
        details = {}
        def report(value):
            temporary = folder / 'progress.tmp'
            temporary.write_text(json.dumps(value))
            temporary.replace(folder / 'progress.json')
        with offline_recognition(): pages, text_pages = convert_pdf(folder / 'input.pdf', folder / 'output.pdf', codes, mode, rotate, diagnostics=details, progress=report)
        report({'phase': 'saving', 'complete': pages, 'total': pages})
        result = {'pages': pages, 'textPages': text_pages, **details}
    except ValueError as error: result = {'error': str(error)[:300], 'status': 422}
    except Exception:
        logging.exception('PaddleOCR PDF recognition failed')
        result = {'error': 'PaddleOCR could not process this PDF. Check the service logs and installed models.', 'status': 503}
    (folder / 'result.json').write_text(json.dumps(result))


def scan(folder, codes, mode, rotate):
    process = multiprocessing.get_context('spawn').Process(target=child, args=(str(folder), codes, mode, rotate)); process.start()
    try:
        process.join(3600)
        if process.is_alive(): process.kill(); process.join(); raise HTTPException(422, 'OCR exceeded one hour. Scan a smaller volume.')
        status = folder / 'result.json'
        if not status.is_file(): raise HTTPException(503, 'The OCR worker stopped before completing. Check the server memory and service logs.')
        result = json.loads(status.read_text())
        if 'error' in result: raise HTTPException(result['status'], result['error'])
        return result
    finally:
        if process.is_alive(): process.kill(); process.join()
        process.close()


@app.post('/ocr')
async def ocr(request: Request):
    global active_scan
    authorize(request)
    if not lock.acquire(blocking=False): raise HTTPException(409, 'An OCR scan is already running.')
    folder = Path(tempfile.mkdtemp(prefix='langy-paddle-')); delivered = False
    try:
        job = request.headers.get('x-langy-ocr-job', '')
        if job and (len(job) > 64 or not all(char.isascii() and (char.isalnum() or char == '-') for char in job)):
            raise HTTPException(422, 'Choose a valid OCR job identifier.')
        active_scan = (job, folder) if job else None
        codes = list(dict.fromkeys(request.query_params.get('languages', 'chi_sim').split('+'))); mode = request.query_params.get('mode', 'redo')
        if mode not in {'redo', 'skip'} or not codes or len(codes) > 20 or any(code not in LANGUAGES for code in codes): raise HTTPException(422, 'Choose supported PaddleOCR languages and an OCR mode.')
        size = 0
        with (folder / 'input.pdf').open('wb') as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > LIMIT: raise HTTPException(413, 'PDFs must be at most 120 MiB.')
                output.write(chunk)
        result = await run_in_threadpool(scan, folder, codes, mode, request.query_params.get('rotate', '1') != '0')
        delivered = True
        headers = {'X-Langy-OCR-Pages': str(result['pages']), 'X-Langy-OCR-Text-Pages': str(result['textPages'])}
        for field, name in [('recognizedCharacters', 'Characters'), ('scannedPages', 'Scanned-Pages'), ('skippedPages', 'Skipped-Pages')]:
            if field in result: headers['X-Langy-OCR-' + name] = str(result[field])
        return FileResponse(folder / 'output.pdf', media_type='application/pdf', filename='searchable.pdf', headers=headers,
            background=BackgroundTask(shutil.rmtree, folder, ignore_errors=True))
    finally:
        active_scan = None
        lock.release()
        if not delivered: shutil.rmtree(folder, ignore_errors=True)
