"""Local searchable-PDF creation; no external OCR or AI API calls."""
import functools
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import threading

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

router = APIRouter()
ocr_lock = threading.Lock()
LIMIT = 120 * 1024 * 1024


@functools.lru_cache(maxsize=1)
def installed_languages():
    try:
        result = subprocess.run(['tesseract', '--list-langs'], capture_output=True, text=True, check=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        raise HTTPException(503, 'PDF OCR is unavailable. Rebuild the language service with its OCR packages.') from None
    return sorted({code.strip() for code in result.stdout.splitlines()
                   if re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_]*', code.strip()) and code.strip() not in {'osd', 'equ'}})


@router.get('/ocr/languages')
def ocr_languages():
    return {'languages': installed_languages()}


def searchable_pdf(content, languages, correct_rotation=True):
    if not 1 <= len(languages) <= 20 or any(code not in installed_languages() for code in languages):
        raise HTTPException(422, 'Choose installed OCR languages for this PDF.')
    if not content.startswith(b'%PDF-') or len(content) > LIMIT:
        raise HTTPException(422, 'Choose a PDF of at most 120 MiB.')
    if not ocr_lock.acquire(blocking=False):
        raise HTTPException(409, 'A PDF OCR scan is already running. Try again after it finishes.')
    folder = Path(tempfile.mkdtemp(prefix='langy-ocr-'))
    try:
        from pypdf import PdfReader
        source, output = folder / 'input.pdf', folder / 'output.pdf'
        source.write_bytes(content)
        reader = PdfReader(source)
        if reader.is_encrypted or not 0 < len(reader.pages) <= 2000:
            raise HTTPException(422, 'OCR needs an unencrypted PDF with 1 to 2,000 pages.')
        command = ['ocrmypdf', '--skip-text', '--output-type', 'pdf', '--optimize', '0', '--jobs', '2',
                   '--tesseract-timeout', '120', '--language', '+'.join(languages)]
        if correct_rotation: command += ['--rotate-pages', '--deskew']
        command += [str(source), str(output)]
        try:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try: process.communicate(timeout=3600)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL); process.communicate()
                raise HTTPException(422, 'OCR exceeded one hour. Split this PDF into smaller books and retry.') from None
            if process.returncode:
                raise HTTPException(422, 'OCR could not scan this PDF. Check that it is readable and choose the correct languages.')
        except OSError:
            raise HTTPException(503, 'Install the OCR packages by rebuilding the language service.') from None
        if not output.is_file() or output.stat().st_size > LIMIT:
            raise HTTPException(413, 'The searchable PDF exceeds the 120 MiB book limit.')
        result = PdfReader(output)
        text_pages = sum(bool((page.extract_text() or '').strip()) for page in result.pages)
        if not text_pages:
            raise HTTPException(422, 'OCR found no selectable text. Check the scan quality and selected languages.')
        return folder, output, len(result.pages), text_pages
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    finally: ocr_lock.release()


@router.post('/ocr')
async def ocr_pdf(request: Request):
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > LIMIT: raise HTTPException(413, 'PDFs must be at most 120 MiB.')
    languages = list(dict.fromkeys(request.query_params.get('languages', 'eng').split('+')))
    folder, output, pages, text_pages = await run_in_threadpool(searchable_pdf, bytes(content), languages, request.query_params.get('rotate', '1') != '0')
    return FileResponse(output, media_type='application/pdf', filename='searchable.pdf',
                        headers={'X-Langy-OCR-Pages': str(pages), 'X-Langy-OCR-Text-Pages': str(text_pages)},
                        background=BackgroundTask(shutil.rmtree, folder, ignore_errors=True))
