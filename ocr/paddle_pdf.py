"""PaddleOCR recognition with a positioned, invisible text layer on the original PDF."""
import io
import math
import os
import re
import time
from pathlib import Path
from contextlib import contextmanager
from ctypes import byref, c_int
import socket

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ContentStream
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

LANGUAGES = ['chi_sim', 'chi_tra', 'chi_sim_vert', 'chi_tra_vert', 'eng', 'jpn']
MODELS = dict(text_detection_model_name='PP-OCRv5_server_det', text_recognition_model_name='PP-OCRv5_server_rec')
LIMIT = 120 * 1024 * 1024


def pipeline():
    root = Path(os.environ.get('LANGY_OCR_MODEL_DIR', '/opt/ocr-models'))
    names = [*MODELS.values(), 'PP-LCNet_x1_0_textline_ori']
    for name in names:
        if any(not (root / name / filename).is_file() for filename in ['inference.json', 'inference.yml', 'inference.pdiparams']): raise ValueError('Pinned OCR models are missing. Rebuild the PaddleOCR service.')
    os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
    from paddleocr import PaddleOCR
    return PaddleOCR(**MODELS, text_detection_model_dir=str(root / MODELS['text_detection_model_name']), text_recognition_model_dir=str(root / MODELS['text_recognition_model_name']),
                     textline_orientation_model_name='PP-LCNet_x1_0_textline_ori', textline_orientation_model_dir=str(root / 'PP-LCNet_x1_0_textline_ori'),
                     device='cpu', use_doc_orientation_classify=False,
                     use_doc_unwarping=False, use_textline_orientation=True, enable_mkldnn=True,
                     text_recognition_batch_size=1,
                     cpu_threads=min(4, os.cpu_count() or 2))


@contextmanager
def offline_recognition():
    """Recognition needs no network; prevent upstream SDK download/metadata probes."""
    connect, connect_ex, create = socket.socket.connect, socket.socket.connect_ex, socket.create_connection
    def deny(*args, **kwargs): raise OSError('Network access is disabled in the OCR recognition worker.')
    socket.socket.connect = socket.socket.connect_ex = socket.create_connection = deny
    try: yield
    finally: socket.socket.connect, socket.socket.connect_ex, socket.create_connection = connect, connect_ex, create


def remove_hidden_text(page):
    """Remove render-mode-3 OCR only; digital text and visible artwork stay intact."""
    contents = page.get_contents()
    if contents is None: return
    stream = ContentStream(contents, page.indirect_reference.pdf)
    operations, stack, mode = [], [], 0
    for operands, operator in stream.operations:
        if operator == b'q': stack.append(mode)
        elif operator == b'Q': mode = stack.pop() if stack else 0
        elif operator == b'Tr': mode = int(operands[0])
        if mode == 3 and operator in {b'Tj', b'TJ', b"'", b'"'}:
            if operator == b"'": operations.append(([], b'T*'))
            elif operator == b'"': operations.extend([([operands[0]], b'Tw'), ([operands[1]], b'Tc'), ([], b'T*')])
            continue
        operations.append((operands, operator))
    stream.operations = operations; page.replace_contents(stream)


def text_layer(width, height, pixels, results, vertical=False, diagnostics=None):
    """Map detected polygons back to PDF points, including vertical Han columns."""
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    pdfmetrics.registerFont(UnicodeCIDFont('HeiseiMin-W3'))
    output = io.BytesIO(); drawing = canvas.Canvas(output, pagesize=(width, height), pageCompression=1)
    boxes = []
    for text, score, polygon in zip(results.get('rec_texts', []), results.get('rec_scores', []), results.get('rec_polys', [])):
        if not isinstance(text, str) or not text.strip() or not math.isfinite(float(score)) or float(score) < .35: continue
        text = re.sub(r'[\x00-\x1f]', '', text).strip()
        if not text: continue
        if len(polygon) != 4 or any(len(point) != 2 or any(not math.isfinite(float(n)) for n in point) for point in polygon): continue
        xs, ys = [float(point[0]) for point in polygon], [float(point[1]) for point in polygon]
        left, right = max(0, min(xs)), min(pixels[0], max(xs)); top, bottom = max(0, min(ys)), min(pixels[1], max(ys))
        if right <= left or bottom <= top: continue
        boxes.append((text, left * width / pixels[0], top * height / pixels[1], right * width / pixels[0], bottom * height / pixels[1]))
    if vertical: boxes.sort(key=lambda item: (-round(item[3] / 6), item[2]))
    if diagnostics is not None: diagnostics['recognizedCharacters'] += sum(len(item[0]) for item in boxes)
    for text, left, top, right, bottom in boxes:
        font = 'HeiseiMin-W3' if re.search(r'[\u3040-\u30ff]', text) else 'STSong-Light'
        han_column = bottom - top > (right - left) * 1.6 and bool(re.search(r'[\u3400-\u9fff]', text))
        if han_column:
            step = (bottom - top) / len(text); size = min(right - left, step) * .95
            for index, character in enumerate(text):
                target = drawing.beginText(left, height - top - (index + .85) * step); target.setFont(font, size); target.setTextRenderMode(3); target.textOut(character); drawing.drawText(target)
        else:
            size = max(.1, (bottom - top) * .86); target = drawing.beginText(left, height - bottom + (bottom - top) * .12)
            target.setFont(font, size); target.setTextRenderMode(3)
            measured = pdfmetrics.stringWidth(text, font, size)
            if measured: target.setHorizScale((right - left) / measured * 100)
            target.textOut(text); drawing.drawText(target)
    drawing.showPage(); drawing.save(); output.seek(0)
    return PdfReader(output).pages[0], len(boxes)


def mask_digital_text(image, page):
    """Exclude retained text from recognition without changing the source PDF.

    Page numbers and headings must not cause an image-based page to be skipped.
    PDFium's coordinate transform accounts for crop boxes and page rotation.
    """
    import pypdfium2.raw as raw
    from PIL import ImageDraw
    text = page.get_textpage(); drawing = ImageDraw.Draw(image)
    def pixel(x, y):
        a, b = c_int(), c_int()
        if not raw.FPDF_PageToDevice(page.raw, 0, 0, image.width, image.height, 0, x, y, byref(a), byref(b)):
            raise ValueError('Could not locate existing PDF text safely for OCR.')
        return a.value, b.value
    try:
        for index in range(text.count_chars()):
            if not text.get_text_range(index, 1).strip(): continue
            left, bottom, right, top = text.get_charbox(index)
            if not all(math.isfinite(value) for value in (left, bottom, right, top)) or right <= left or top <= bottom: continue
            points = [pixel(x, y) for x, y in [(left, bottom), (left, top), (right, bottom), (right, top)]]
            x0 = max(0, min(point[0] for point in points) - 2); x1 = min(image.width - 1, max(point[0] for point in points) + 2)
            y0 = max(0, min(point[1] for point in points) - 2); y1 = min(image.height - 1, max(point[1] for point in points) + 2)
            if x1 <= x0 or y1 <= y0: continue
            samples = [image.getpixel(point) for point in [(x0, y0), (x0, y1), (x1, y0), (x1, y1)]]
            background = tuple(sorted(sample[channel] for sample in samples)[len(samples) // 2] for channel in range(3))
            drawing.rectangle((x0, y0, x1, y1), fill=background)
    finally: text.close()


def convert_pdf(source, output, languages, mode='redo', rotate=True, recognize=None, diagnostics=None):
    if mode not in {'redo', 'skip'} or not languages or any(code not in LANGUAGES for code in languages): raise ValueError('Choose supported PaddleOCR languages and an OCR mode.')
    source, output = Path(source), Path(output)
    with source.open('rb') as stream: header = stream.read(5)
    if source.stat().st_size > LIMIT or header != b'%PDF-': raise ValueError('Choose a PDF of at most 120 MiB.')
    reader = PdfReader(source)
    if reader.is_encrypted or not 0 < len(reader.pages) <= 2000: raise ValueError('Choose an unencrypted PDF with 1 to 2,000 pages.')
    writer = PdfWriter(); writer.append(reader)
    if reader.metadata: writer.add_metadata({key: str(value) for key, value in reader.metadata.items() if value is not None})
    for page in writer.pages:
        page.transfer_rotation_to_content()
        if mode == 'redo': remove_hidden_text(page)
    prepared = output.with_suffix('.source.pdf'); writer.write(prepared)
    import pypdfium2 as pdfium
    document = pdfium.PdfDocument(str(prepared)); engine = None
    stats = diagnostics if diagnostics is not None else {}
    stats.update(scannedPages=0, skippedPages=0, recognizedCharacters=0)
    deadline = time.monotonic() + 3500
    try:
        for index, page in enumerate(writer.pages):
            if time.monotonic() > deadline: raise ValueError('OCR exceeded one hour. Scan a smaller volume.')
            retained_text = bool((page.extract_text() or '').strip())
            if mode == 'skip' and retained_text:
                stats['skippedPages'] += 1
                print(f'OCR page {index + 1}/{len(writer.pages)}: retained existing text (skip mode)', flush=True)
                continue
            raster = document[index]; width, height = raster.get_size()
            scale = min(400 / 72, math.sqrt(24_000_000 / max(1, width * height)))
            bitmap = raster.render(scale=scale); image = bitmap.to_pil().convert('RGB')
            try:
                if retained_text: mask_digital_text(image, raster)
                before = stats['recognizedCharacters']
                if recognize is not None: result = recognize(image)
                else:
                    import numpy as np
                    if engine is None: engine = pipeline()
                    prediction = next(iter(engine.predict(np.asarray(image)[:, :, ::-1].copy(), use_doc_orientation_classify=False,
                        use_doc_unwarping=False, use_textline_orientation=rotate, text_det_limit_side_len=1280, text_det_limit_type='max')))
                    result = prediction.json['res']
                layer, count = text_layer(width, height, image.size, result, vertical=any(code.endswith('_vert') for code in languages), diagnostics=stats)
                stats['scannedPages'] += 1
                print(f'OCR page {index + 1}/{len(writer.pages)}: {count} regions, {stats["recognizedCharacters"] - before} new characters', flush=True)
                if count: page.merge_translated_page(layer, float(page.cropbox.left), float(page.cropbox.bottom), over=True)
            finally: image.close(); bitmap.close(); raster.close()
        writer.write(output)
        if output.stat().st_size > LIMIT: raise ValueError('The searchable PDF exceeds 120 MiB.')
        result = PdfReader(output); text_pages = sum(bool((page.extract_text() or '').strip()) for page in result.pages)
        if not text_pages: raise ValueError('OCR found no readable text. Check the scan and selected languages.')
        return len(result.pages), text_pages
    finally: document.close(); prepared.unlink(missing_ok=True)
