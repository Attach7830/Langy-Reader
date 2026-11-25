import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
import pypdfium2 as pdfium
from paddle_pdf import convert_pdf, text_layer, offline_recognition
from install_models import permitted, verified


class PDFTests(unittest.TestCase):
    def fixture(self, folder, hidden=False, digital=False, rotated=False):
        source = folder / 'scan.pdf'; image = Image.new('RGB', (1200, 800), '#f3f0e9'); image.save(source, 'PDF', resolution=200); image.close()
        writer = PdfWriter(); writer.append(PdfReader(source)); writer.add_metadata({'/Title': 'Reading scan', '/Author': 'Test author'}); writer.add_outline_item('First page', 0)
        page = writer.pages[0]
        if hidden:
            layer, _ = text_layer(float(page.mediabox.width), float(page.mediabox.height), (1200, 800), {'rec_texts': ['旧的错误文字'], 'rec_scores': [.99], 'rec_polys': [[[100, 100], [700, 100], [700, 160], [100, 160]]]}); page.merge_page(layer)
        if digital:
            buffer = io.BytesIO(); drawing = canvas.Canvas(buffer, pagesize=page.mediabox[2:]); drawing.drawString(20, 30, 'Visible digital text'); drawing.save(); buffer.seek(0); page.merge_page(PdfReader(buffer).pages[0])
        if rotated: page.cropbox.lower_left = (20, 10); page.cropbox.upper_right = (350, 240); page.rotate(90)
        writer.write(source); return source

    def pixels(self, path):
        document = pdfium.PdfDocument(str(path)); page = document[0]; bitmap = page.render(scale=1); image = bitmap.to_pil(); result = (image.size, image.tobytes()); image.close(); bitmap.close(); page.close(); document.close(); return result

    def test_searchable_chinese_pdf_preserves_images_metadata_outline_and_page_geometry(self):
        for rotated in [False, True]:
            with self.subTest(rotated=rotated), tempfile.TemporaryDirectory() as value:
                folder = Path(value); source = self.fixture(folder, hidden=True, rotated=rotated); original = source.read_bytes(); before = self.pixels(source)
                def recognize(image):
                    width, height = image.size
                    return {'rec_texts': ['中文阅读'], 'rec_scores': [.99], 'rec_polys': [[[width*.1,height*.2],[width*.8,height*.2],[width*.8,height*.3],[width*.1,height*.3]]]}
                output = folder / 'output.pdf'; self.assertEqual(convert_pdf(source, output, ['chi_sim'], recognize=recognize), (1, 1))
                result = PdfReader(output); self.assertIn('中文阅读', result.pages[0].extract_text()); self.assertNotIn('旧的错误文字', result.pages[0].extract_text())
                self.assertEqual(result.metadata.title, 'Reading scan'); self.assertEqual(result.outline[0]['/Title'], 'First page'); self.assertEqual(source.read_bytes(), original)
                self.assertEqual(self.pixels(output), before, 'a hidden text layer must not alter the visible page')

    def test_skip_retains_existing_text_and_redo_preserves_digital_pages(self):
        with tempfile.TemporaryDirectory() as value:
            folder = Path(value); source = self.fixture(folder, hidden=True)
            def unexpected(image): self.fail('A page with retained text must not be OCRed twice')
            output = folder / 'skip.pdf'; convert_pdf(source, output, ['chi_sim'], mode='skip', recognize=unexpected)
            self.assertIn('旧的错误文字', PdfReader(output).pages[0].extract_text())
            source = self.fixture(folder, digital=True); before = self.pixels(source); convert_pdf(source, output, ['eng'], recognize=unexpected)
            self.assertIn('Visible digital text', PdfReader(output).pages[0].extract_text()); self.assertEqual(self.pixels(output), before)

    def test_vertical_chinese_and_untrusted_model_destinations(self):
        page, count = text_layer(100, 200, (100, 200), {'rec_texts': ['中文阅读'], 'rec_scores': [.99], 'rec_polys': [[[30,20],[50,20],[50,160],[30,160]]] }, vertical=True)
        self.assertEqual(''.join(page.extract_text().split()), '中文阅读'); self.assertEqual(count, 1)
        for url in ['http://100.100.100.200/', 'https://127.0.0.1/', 'http://huggingface.co/file', 'https://huggingface.co.attacker.test/file']:
            with self.assertRaises(ValueError): permitted(url)
        permitted('https://huggingface.co/PaddlePaddle/model/resolve/revision/inference.json')
        import hashlib
        self.assertTrue(verified(b'model', {'sha256': hashlib.sha256(b'model').hexdigest()}))

    def test_recognition_worker_cannot_make_network_connections(self):
        import socket
        original = socket.create_connection
        with offline_recognition():
            with self.assertRaisesRegex(OSError, 'disabled'): socket.create_connection(('example.org', 443))
        self.assertIs(socket.create_connection, original)


if __name__ == '__main__': unittest.main()
