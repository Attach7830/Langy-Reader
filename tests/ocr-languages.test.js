import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedOCRLanguages, preferredOCRLanguages, ocrBookLanguages } from '../shared/ocr-languages.js';
test('OCR options follow only selected reading languages, retain preference order, and include Mandarin script variants', () => {
  const available = ['deu', 'spa', 'por', 'eng', 'chi_sim', 'chi_tra', 'chi_sim_vert', 'jpn', 'osd'];
  assert.deepEqual(selectedOCRLanguages(available, ['pt-PT', 'en', 'zh-Hans']), ['por', 'eng', 'chi_sim', 'chi_tra', 'chi_sim_vert']);
  assert.deepEqual(selectedOCRLanguages(available, ['fr']), []);
  assert.deepEqual(selectedOCRLanguages(available, ['es', 'es-MX']), ['spa']);
  assert.deepEqual(ocrBookLanguages({ language: 'pt', languages: [] }, ['por']), { language: 'pt', languages: [] });
});
test('Mandarin OCR defaults distinguish traditional tags and regions without automatically choosing vertical models', () => {
  const installed = ['chi_sim', 'chi_tra', 'chi_sim_vert', 'chi_tra_vert', 'eng'];
  for (const language of ['zh-Hant', 'zh-TW', 'zh-HK']) assert.deepEqual(preferredOCRLanguages(installed, [language, 'en']), ['chi_tra', 'eng']);
  for (const language of ['zh', 'zh-Hans', 'zh-CN']) assert.deepEqual(preferredOCRLanguages(installed, [language]), ['chi_sim']);
});
