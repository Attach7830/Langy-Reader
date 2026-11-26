import os
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
import app as service


class ServiceTests(unittest.TestCase):
    def test_live_progress_requires_the_service_key_and_exact_active_job(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'LANGY_OCR_API_KEY': 'synthetic-test-ocr-key'}), TestClient(service.app) as client:
            folder = Path(folder); headers = {'Authorization': 'Bearer synthetic-test-ocr-key'}
            with patch.object(service, 'active_scan', ('job-123', folder)):
                self.assertEqual(client.get('/ocr/progress/job-123').status_code, 401)
                self.assertEqual(client.get('/ocr/progress/other-job', headers=headers).status_code, 404)
                self.assertEqual(client.get('/ocr/progress/其他', headers=headers).status_code, 404)
                self.assertEqual(client.get('/ocr/progress/job-123', headers=headers).json()['phase'], 'preparing')
                (folder / 'progress.json').write_text(json.dumps({'phase': 'scanning', 'complete': 12, 'total': 51}))
                self.assertEqual(client.get('/ocr/progress/job-123', headers=headers).json(), {'job': 'job-123', 'phase': 'scanning', 'complete': 12, 'total': 51})
            self.assertEqual(client.get('/ocr/progress/job-123', headers=headers).status_code, 404)

    def test_pdf_protocol_authorization_and_validation(self):
        with patch.dict(os.environ, {'LANGY_OCR_API_KEY': 'synthetic-test-ocr-key'}), TestClient(service.app) as client:
            self.assertEqual(client.get('/healthz').status_code, 200)
            self.assertEqual(client.get('/ocr/languages').status_code, 401)
            headers = {'Authorization': 'Bearer synthetic-test-ocr-key', 'Content-Type': 'application/pdf'}
            languages = client.get('/ocr/languages', headers=headers).json()
            self.assertEqual(languages['engine'], 'paddleocr'); self.assertEqual(languages['protocol'], 1); self.assertIn('chi_tra', languages['languages'])
            for query in ['languages=missing', 'languages=chi_sim&mode=force']:
                self.assertEqual(client.post('/ocr?' + query, headers=headers, content=b'%PDF-1.4').status_code, 422)
            folders = []
            def scan(folder, codes, mode, rotate):
                folders.append(folder); self.assertEqual(codes, ['chi_tra_vert', 'eng']); self.assertEqual(mode, 'redo'); self.assertFalse(rotate)
                (folder / 'output.pdf').write_bytes(b'%PDF-1.4\nsearchable output\n%%EOF')
                return {'pages': 2, 'textPages': 1, 'recognizedCharacters': 0, 'scannedPages': 1, 'skippedPages': 1}
            with patch.object(service, 'scan', side_effect=scan):
                response = client.post('/ocr?languages=chi_tra_vert%2Beng&rotate=0', headers=headers, content=b'%PDF-1.4\nscanned source')
            self.assertEqual(response.status_code, 200); self.assertEqual(response.headers['content-type'], 'application/pdf')
            self.assertEqual(response.headers['x-langy-ocr-pages'], '2'); self.assertEqual(response.headers['x-langy-ocr-text-pages'], '1')
            self.assertEqual(response.headers['x-langy-ocr-characters'], '0'); self.assertEqual(response.headers['x-langy-ocr-scanned-pages'], '1'); self.assertEqual(response.headers['x-langy-ocr-skipped-pages'], '1')
            self.assertTrue(response.content.startswith(b'%PDF-')); self.assertFalse(folders[0].exists())
            service.lock.acquire()
            try: self.assertEqual(client.post('/ocr', headers=headers, content=b'%PDF-1.4').status_code, 409)
            finally: service.lock.release()


if __name__ == '__main__': unittest.main()
