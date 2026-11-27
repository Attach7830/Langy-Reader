import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { languageHelpPreferences } from '../shared/language-defaults.js';
import { defaults, mergePreferences, preferenceChanges, validatePreferences } from '../shared/reader-preferences.js';
import { languageDefaultsEditor } from '../src/ui-language-defaults.js';

test('shared defaults and per-language overrides resolve independently without changing global or native settings', () => {
  const prefs = { ...defaults, nativeLanguage: 'en', translationLanguage: 'en', summaryLanguage: 'es', languageDefaults: {
    pt: { translationLanguage: 'es', summaryLanguage: 'pt' }, zh: { translationLanguage: 'en', summaryLanguage: 'zh' },
    'pt-BR': { summaryLanguage: 'en' },
  } };
  assert.equal(languageHelpPreferences(prefs, 'pt').translationLanguage, 'en');
  const separate = { ...prefs, languageDefaultsMode: 'per-language' };
  assert.equal(languageHelpPreferences(separate, 'pt-PT').summaryLanguage, 'pt');
  assert.equal(languageHelpPreferences(separate, 'pt-BR').summaryLanguage, 'en');
  assert.equal(languageHelpPreferences(separate, 'pt-BR').translationLanguage, 'es');
  assert.equal(languageHelpPreferences(separate, 'zh-Hans').summaryLanguage, 'zh');
  assert.equal(languageHelpPreferences(separate, 'de').summaryLanguage, 'es');
  assert.equal(languageHelpPreferences(separate, 'zh').nativeLanguage, 'en');
  assert.equal(prefs.translationLanguage, 'en'); assert.equal(prefs.summaryLanguage, 'es');
});

test('account patches merge individual output fields and validate language maps', () => {
  const first = { languageDefaults: { es: { translationLanguage: 'en', summaryLanguage: 'es' }, pt: { summaryLanguage: 'pt' } } };
  const next = mergePreferences(first, { languageDefaults: { es: { translationLanguage: 'pt' } } });
  assert.deepEqual(next.languageDefaults.es, { translationLanguage: 'pt', summaryLanguage: 'es' });
  assert.equal(next.languageDefaults.pt.summaryLanguage, 'pt');
  assert.deepEqual(preferenceChanges(first, next), { languageDefaults: { es: { translationLanguage: 'pt' } } });
  assert.doesNotThrow(() => validatePreferences({ languageDefaultsMode: 'per-language', languageDefaults: { pt: { summaryLanguage: 'pt', translationLanguage: null } } }));
  for (const value of [{ xx: { apiKey: 'not allowed' } }, { 'not a language': { summaryLanguage: 'en' } }, { es: { translationLanguage: 'bogus language' } }])
    assert.throws(() => validatePreferences({ languageDefaults: value }), /Invalid/u);
});

test('language default editor preserves drafts while changing reading language and supports inheriting shared values', async (t) => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'));
  const saved = new Map(['document', 'Option'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of saved.keys()) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  t.after(() => { dom.window.close(); for (const [key, old] of saved) if (old) Object.defineProperty(globalThis, key, old); else delete globalThis[key]; });
  const editor = languageDefaultsEditor(); editor.languages(['es', 'pt']); editor.set({ ...defaults, languageDefaultsMode: 'per-language' });
  assert.equal(document.querySelector('#language-defaults-panel').hidden, false);
  document.querySelector('#language-summary-default').value = 'Spanish';
  const choice = document.querySelector('#language-default-language'); choice.value = 'pt'; choice.dispatchEvent(new dom.window.Event('change'));
  document.querySelector('#language-translation-default').value = 'English'; document.querySelector('#language-summary-default').value = 'Portuguese';
  choice.value = 'es'; choice.dispatchEvent(new dom.window.Event('change')); assert.equal(document.querySelector('#language-summary-default').value, 'Spanish');
  assert.deepEqual(editor.value().languageDefaults, { es: { translationLanguage: null, summaryLanguage: 'es' }, pt: { translationLanguage: 'en', summaryLanguage: 'pt' } });
});
