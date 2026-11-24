import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setInterfaceLanguage, translateUI } from '../src/i18n.js';
import { learningLanguages } from '../shared/learning-languages.js';
import { validatePreferences } from '../shared/reader-preferences.js';

test('interface language switches independently, retains select values, and never translates book text, dictionary meanings or reader-created labels', async (t) => {
  const dom = new JSDOM('<h1>Your library</h1><button title="Settings">Settings</button><select><option>Advanced</option></select><div id="viewer">Read</div><span class="book-title">Read</span><p data-user-content>Settings</p><div id="summary-body">Play</div><div id="word-help">Read</div>', { pretendToBeVisual: true });
  const names = ['window', 'document', 'MutationObserver'], before = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  t.after(() => { dom.window.close(); for (const [name, descriptor] of before) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  setInterfaceLanguage('es'); assert.equal(document.querySelector('h1').textContent, 'Tu biblioteca'); assert.equal(document.querySelector('button').title, 'Ajustes');
  assert.equal(document.querySelector('option').textContent, 'Avanzado'); assert.equal(document.querySelector('select').value, 'Advanced');
  for (const [selector, value] of [['#viewer', 'Read'], ['.book-title', 'Read'], ['[data-user-content]', 'Settings'], ['#summary-body', 'Play'], ['#word-help', 'Read']]) assert.equal(document.querySelector(selector).textContent, value);
  setInterfaceLanguage('pt'); assert.equal(document.querySelector('h1').textContent, 'Sua biblioteca');
  setInterfaceLanguage('zh'); assert.equal(document.querySelector('h1').textContent, '你的书库');
  const button = document.createElement('button'); button.textContent = 'Save offline'; document.body.append(button); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(button.textContent, '保存以供离线阅读');
  setInterfaceLanguage('en'); assert.equal(document.querySelector('h1').textContent, 'Your library'); assert.equal(button.textContent, 'Save offline');
  assert.equal(translateUI('Podcast mode', 'pt'), 'Modo podcast');
});
test('L1 removes native-language book metrics without mutating analysis or changing literal word counts', () => {
  const analysis = { lemmaCount: 9, wordCount: 100, vocabulary: { unit: 'lemmas', count: 7, lemmaCount: 9, characterCount: 3, characters: { total: 10, unique: 3, inventory: '中文书' }, byLanguage: [
    { language: 'en', unit: 'lemmas', count: 7 }, { language: 'es', unit: 'lemmas', count: 2 }, { language: 'zh', unit: 'characters', count: 3 }], languages: ['en', 'es', 'zh'] } };
  const result = learningLanguages(analysis, 'en-US'); assert.equal(result.lemmaCount, 2); assert.equal(result.wordCount, 100); assert.deepEqual(result.vocabulary.languages, ['es', 'zh']);
  assert.equal(analysis.lemmaCount, 9); assert.equal(learningLanguages(analysis, '').vocabulary.languages.length, 3);
  const chinese = learningLanguages(analysis, 'zh-Hant'); assert.equal(chinese.vocabulary.characterCount, 0); assert.equal(chinese.vocabulary.characters.inventory, '');
  assert.doesNotThrow(() => validatePreferences({ uiLanguage: 'pt', nativeLanguage: '', summaryLanguage: 'es' }));
  assert.throws(() => validatePreferences({ uiLanguage: 'anything' })); assert.throws(() => validatePreferences({ nativeLanguage: 'not valid' }));
});
