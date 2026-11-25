"""Install pinned high-accuracy Tesseract models for Chinese and mixed English."""
import hashlib
import json
from pathlib import Path
import urllib.request

REVISION = 'e12c65a915945e4c28e237a9b52bc4a8f39a0cec'
MODELS = ['chi_sim', 'chi_tra', 'chi_sim_vert', 'chi_tra_vert', 'eng']


def install(destination='/usr/share/tesseract-ocr/5/tessdata'):
    destination = Path(destination); destination.mkdir(parents=True, exist_ok=True); checksums = {}
    for language in MODELS:
        url = f'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/{REVISION}/{language}.traineddata'
        with urllib.request.urlopen(url, timeout=120) as response: data = response.read(50 * 1024 * 1024)
        if len(data) < 100000: raise RuntimeError(f'Incomplete OCR model: {language}')
        (destination / f'{language}.traineddata').write_bytes(data); checksums[language] = hashlib.sha256(data).hexdigest()
    (destination / 'langy-ocr-models.json').write_text(json.dumps({'source': 'tesseract-ocr/tessdata_best', 'revision': REVISION, 'sha256': checksums}))


if __name__ == '__main__': install()
