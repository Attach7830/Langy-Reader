"""Opt-in end-to-end recognition using pinned local models and no network."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader
from paddle_pdf import convert_pdf, offline_recognition, pipeline


class RealPaddleTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('LANGY_TEST_PADDLE') == '1', 'Enable the explicit local-model integration test')
    def test_chinese_scan_becomes_searchable_without_network(self):
        with offline_recognition(): engine = pipeline()
        for phrase, code, expected, vertical in [('我们喜欢阅读中文故事。', 'chi_sim', '阅读中文', False), ('我們喜歡閱讀中文故事。', 'chi_tra', '閱讀中文', False), ('中文閱讀', 'chi_tra_vert', '中文閱讀', True)]:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temporary:
                folder = Path(temporary); image = Image.new('RGB', (500, 1000) if vertical else (1800, 500), 'white'); draw = ImageDraw.Draw(image)
                font = ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 90)
                if vertical:
                    for index, character in enumerate(phrase): draw.text((200, 100 + index * 130), character, font=font, fill='black')
                else: draw.text((100, 150), phrase, font=font, fill='black')
                source, output = folder / 'scan.pdf', folder / 'output.pdf'; image.save(source, 'PDF', resolution=300); image.close()
                with offline_recognition(), patch('paddle_pdf.pipeline', return_value=engine): pages, text_pages = convert_pdf(source, output, [code])
                text = ''.join(PdfReader(output).pages[0].extract_text().split())
                self.assertIn(expected, text); self.assertEqual((pages, text_pages), (1, 1)); print(code, 'recognized:', text)


if __name__ == '__main__': unittest.main()
