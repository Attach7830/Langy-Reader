import shutil
import tempfile
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from fastapi import HTTPException
from pdf_ocr import installed_languages, searchable_pdf


class PDFOCRTests(unittest.TestCase):
    def tearDown(self): installed_languages.cache_clear()

    def test_unknown_languages_and_command_fragments_are_rejected_before_running_ocr(self):
        with patch('pdf_ocr.installed_languages', return_value=['eng', 'spa', 'chi_sim']):
            for codes in [[], ['eng; touch file'], ['../../eng'], ['missing']]:
                with self.assertRaises(HTTPException) as error: searchable_pdf(b'%PDF-1.4', codes)
                self.assertEqual(error.exception.status_code, 422)

    def test_chinese_uses_accurate_lstm_oversampling_and_longer_page_budget(self):
        from PIL import Image
        from reportlab.pdfgen import canvas
        import io
        image = Image.new('RGB', (200, 200), 'white'); buffer = io.BytesIO(); image.save(buffer, 'PDF'); image.close()
        calls = []
        def process(command, **kwargs):
            calls.append(command)
            drawing = canvas.Canvas(command[-1]); drawing.drawString(10, 20, 'searchable text'); drawing.save()
            return SimpleNamespace(communicate=lambda timeout=None: (b'', b''), returncode=0)
        with patch('pdf_ocr.installed_languages', return_value=['eng', 'chi_tra_vert']), patch('pdf_ocr.subprocess.Popen', side_effect=process):
            for codes, dpi, seconds, mode in [(['chi_tra_vert'], '400', '300', 'skip'), (['eng'], '300', '120', 'redo')]:
                folder, output, pages, text_pages = searchable_pdf(buffer.getvalue(), codes, mode=mode)
                try:
                    command = calls[-1]
                    self.assertEqual(command[command.index('--oversample') + 1], dpi)
                    self.assertEqual(command[command.index('--tesseract-timeout') + 1], seconds)
                    self.assertEqual(command[command.index('--tesseract-oem') + 1], '1')
                    self.assertEqual('--deskew' in command, mode == 'skip')
                    self.assertEqual((pages, text_pages), (1, 1))
                finally: shutil.rmtree(folder, ignore_errors=True)

    @unittest.skipUnless(shutil.which('ocrmypdf') and shutil.which('tesseract'), 'Local OCR binaries are not installed')
    def test_real_scanned_pdf_gets_a_selectable_text_layer_and_preserves_the_original(self):
        from PIL import Image, ImageDraw, ImageFont
        from pypdf import PdfReader
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'scanned.pdf'
            image = Image.new('RGB', (1600, 600), 'white'); draw = ImageDraw.Draw(image)
            font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 52)
            draw.text((90, 140), 'Readers enjoy books and stories.', font=font, fill='black')
            draw.text((90, 240), 'This page contains scanned text.', font=font, fill='black')
            image.save(source, 'PDF', resolution=200)
            original = source.read_bytes(); self.assertFalse(PdfReader(source).pages[0].extract_text())
            folder, output, pages, text_pages = searchable_pdf(original, ['eng'], False)
            try:
                text = ' '.join(PdfReader(output).pages[0].extract_text().split()).casefold()
                self.assertIn('readers enjoy books and stories', text)
                self.assertEqual((pages, text_pages), (1, 1)); self.assertEqual(source.read_bytes(), original)
            finally: shutil.rmtree(folder, ignore_errors=True)


if __name__ == '__main__': unittest.main()
