import shutil
import tempfile
from pathlib import Path
import unittest
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
