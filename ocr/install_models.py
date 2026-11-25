"""Fetch only pinned, verified files from PaddlePaddle's official model repos."""
import hashlib
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request


def permitted(url):
    value = urllib.parse.urlsplit(url); host = value.hostname or ''
    if value.scheme != 'https' or value.username or value.password or not (host == 'huggingface.co' or host.endswith('.huggingface.co') or host.endswith('.hf.co')):
        raise ValueError('Model downloads must stay on the approved HTTPS model hosts.')


class ModelRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        permitted(newurl); return super().redirect_request(request, file, code, message, headers, newurl)


def verified(data, checksum):
    if 'sha256' in checksum: return hashlib.sha256(data).hexdigest() == checksum['sha256']
    return hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() == checksum['git']


def install(destination=None):
    root = Path(destination or os.environ.get('LANGY_OCR_MODEL_DIR', '/opt/ocr-models')); root.mkdir(parents=True, exist_ok=True)
    sources = json.loads(Path(__file__).with_name('model-sources.json').read_text()); opener = urllib.request.build_opener(ModelRedirect())
    for name, source in sources.items():
        folder = root / name; folder.mkdir(exist_ok=True)
        for filename, checksum in source['files'].items():
            target = folder / filename
            if target.is_file() and verified(target.read_bytes(), checksum): continue
            url = f'https://huggingface.co/PaddlePaddle/{name}/resolve/{source["revision"]}/{filename}'
            permitted(url)
            with opener.open(url, timeout=180) as response: data = response.read(128 * 1024 * 1024)
            if not verified(data, checksum): raise ValueError(f'OCR model checksum mismatch: {name}/{filename}')
            temporary = target.with_suffix(target.suffix + '.tmp'); temporary.write_bytes(data); temporary.replace(target)
            print(f'Installed {name}/{filename}', flush=True)


if __name__ == '__main__': install()
