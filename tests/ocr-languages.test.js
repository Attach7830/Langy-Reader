import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedOCRLanguages, ocrBookLanguages } from '../shared/ocr-languages.js';
test('OCR options follow only selected reading languages, retain preference order, and include Mandarin script variants', () => {
  const available = ['deu', 'spa', 'por', 'eng', 'chi_sim', 'chi_tra', 'chi_sim_vert', 'jpn', 'osd'];
  assert.deepEqual(selectedOCRLanguages(available, ['pt-PT', 'en', 'zh-Hans']), ['por', 'eng', 'chi_sim', 'chi_tra', 'chi_sim_vert']);
  assert.deepEqual(selectedOCRLanguages(available, ['fr']), []);
  assert.deepEqual(selectedOCRLanguages(available, ['es', 'es-MX']), ['spa']);
  assert.deepEqual(ocrBookLanguages({ language: 'pt', languages: [] }, ['por']), { language: 'pt', languages: [] });
});
