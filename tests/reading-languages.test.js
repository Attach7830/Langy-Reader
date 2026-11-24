import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { bookLanguageSuggestions, readingLanguagesPicker } from '../src/reading-languages.js';
import { ocrBookLanguages } from '../shared/ocr-languages.js';
import { narrationOptions } from '../server/language-voices.js';

test('selected reading languages supply a short import list, including Portuguese variants and Mandarin', (t) => {
  const dom = new JSDOM('<div id="list"></div><input id="choice"><button id="add"></button><datalist id="book-languages"></datalist>');
  const previous = new Map(['document', 'Option'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document }); Object.defineProperty(globalThis, 'Option', { configurable: true, value: dom.window.Option });
  t.after(() => { dom.window.close(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });
  let error = ''; const input = document.querySelector('#choice');
  const picker = readingLanguagesPicker({ host: document.querySelector('#list'), input, add: document.querySelector('#add'), error: (text) => { error = text; } });
  picker.set(['pt', 'zh']); input.value = 'English'; document.querySelector('#add').click();
  assert.deepEqual(picker.value(), ['pt', 'zh', 'en']); assert.equal(error, '');
  bookLanguageSuggestions(picker.value()); assert.deepEqual([...document.querySelector('#book-languages').options].map((option) => option.value), ['pt', 'zh', 'en']);
  input.value = ''; assert.deepEqual(picker.value(), ['pt', 'zh', 'en']);
  input.value = 'pt-PT'; assert.ok(picker.value().includes('pt-PT'));
  picker.set(['pt']); document.querySelector('#list button').click(); assert.throws(() => picker.value(), /at least one/u);
});

test('Portuguese OCR produces Portuguese analysis metadata and narration uses a Portuguese voice in monolingual and mixed books', () => {
  assert.deepEqual(ocrBookLanguages({ language: 'es', languages: [] }, ['por']), { language: 'pt', languages: [] });
  assert.deepEqual(ocrBookLanguages({ language: 'pt-PT', languages: ['pt-PT', 'en'] }, ['por', 'eng']), { language: 'pt-PT', languages: ['pt-PT', 'en'] });
  const options = narrationOptions({ voice: 'ef_dora', model: 'kokoro', speed: 1, baseUrl: 'http://kokoro/v1' }, ['pt-PT', 'en', 'zh']);
  assert.equal(options.voiceMap.pt, 'pf_dora'); assert.equal(options.voiceMap.en, 'af_heart'); assert.equal(options.voiceMap.zh, 'zf_xiaobei');
});
