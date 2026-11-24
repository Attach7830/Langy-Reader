import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { defaults, getSettings, saveSettings } from '../src/settings.js';
import { readingShortcut } from '../src/reader-shortcuts.js';
import { bookLanguagePicker } from '../src/book-languages.js';

function globals(t, dom) {
  const saved = new Map(['window', 'document', 'localStorage'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of saved.keys()) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name], writable: true });
  t.after(() => { dom.window.close(); for (const [name, value] of saved) { if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; } });
}

test('pinyin, typography, audio and custom shortcuts survive a fresh settings load and partial preference updates', async (t) => {
  const first = new JSDOM('', { url: 'https://langy.test' }); globals(t, first);
  saveSettings({ ...getSettings(), theme: 'midnight', font: 'chinese', size: 25, line: 2, showPinyin: true, summaryLanguage: 'es',
    audioToolbarHidden: true, audioRate: 1.5, keys: { ...defaults.keys, pinyin: 'j' } });
  saveSettings({ background: 'plain' });
  const serialized = localStorage.getItem('langy-settings-v1');
  const reopened = new JSDOM('', { url: 'https://langy.test' }); t.after(() => reopened.window.close());
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: reopened.window.localStorage });
  localStorage.setItem('langy-settings-v1', serialized);
  const fresh = (await import('../src/settings.js?fresh-session')).getSettings();
  assert.equal(fresh.showPinyin, true); assert.equal(fresh.keys.pinyin, 'j'); assert.equal(fresh.theme, 'midnight');
  assert.equal(fresh.font, 'chinese'); assert.equal(fresh.size, 25); assert.equal(fresh.line, 2); assert.equal(fresh.summaryLanguage, 'es');
  assert.equal(fresh.audioToolbarHidden, true); assert.equal(fresh.audioRate, 1.5); assert.equal(fresh.background, 'plain');
});

test('new hotkey defaults preserve existing assignments and malformed saved preferences do not break startup', (t) => {
  globals(t, new JSDOM('', { url: 'https://langy.test' }));
  localStorage.setItem('langy-settings-v1', JSON.stringify({ theme: 'dark', keys: { next: 'y', fullscreen: 'b', summary: 'a' } }));
  const saved = getSettings();
  assert.equal(saved.keys.next, 'y'); assert.equal(saved.keys.fullscreen, 'b'); assert.equal(saved.keys.summary, 'a');
  assert.equal(saved.keys.pinyin, ''); assert.equal(saved.keys.returnLocation, ''); assert.equal(saved.keys.audioToolbar, '');
  for (const value of ['{broken', '[]', 'true', '{"keys":null}']) {
    localStorage.setItem('langy-settings-v1', value); assert.equal(getSettings().keys.pinyin, 'y');
  }
});

test('holding page arrows repeats navigation while pinyin, summary and playback toggles run once', (t) => {
  const dom = new JSDOM('<p id="page">Book</p><input><button>Control</button>', { url: 'https://langy.test' }); globals(t, dom);
  let settings = getSettings(); const actions = [];
  document.addEventListener('keydown', (event) => {
    const action = readingShortcut(event, settings); if (!action) return;
    actions.push(action); if (action === 'pinyin') settings = saveSettings({ ...settings, showPinyin: !settings.showPinyin });
  });
  const key = (value, repeat = false, target = document.querySelector('#page'), options = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: value, repeat, bubbles: true, cancelable: true, ...options }); target.dispatchEvent(event); return event;
  };
  key('y'); key('y', true); key('y', true); assert.equal(getSettings().showPinyin, true);
  key('y'); assert.equal(getSettings().showPinyin, false);
  for (const value of ['ArrowRight', 'ArrowLeft']) { key(value); key(value, true); key(value, true); }
  assert.equal(actions.filter((action) => action === 'next').length, 3); assert.equal(actions.filter((action) => action === 'previous').length, 3);
  key('s'); key('s', true); assert.equal(actions.filter((action) => action === 'summary').length, 1);
  settings.audioEnabled = true; key(' '); assert.equal(key(' ', true).defaultPrevented, true);
  assert.equal(actions.filter((action) => action === 'playback').length, 1);
  const before = actions.length; key('y', false, document.querySelector('input')); key('y', false, document.querySelector('#page'), { ctrlKey: true }); key(' ', false, document.querySelector('button'));
  assert.equal(actions.length, before, 'typing and native button actions keep their keys');
  settings.keys.pinyin = 'j'; key('y'); assert.equal(getSettings().showPinyin, false); key('j'); assert.equal(getSettings().showPinyin, true);
  key('['); key(']'); assert.equal(actions.at(-2), 'rewindAudio'); assert.equal(actions.at(-1), 'forwardAudio');
  key(']', true); assert.equal(actions.at(-1), 'forwardAudio');
});

test('an empty extra-language field permits native book form submission, including after abandoning another language', async (t) => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test' }); globals(t, dom);
  const form = document.querySelector('#book-form'), picker = bookLanguagePicker(form), input = form.querySelector('#book-language-choice'), toggle = form.querySelector('#book-language-limit');
  picker.set(); toggle.checked = true; toggle.dispatchEvent(new dom.window.Event('change'));
  input.value = 'Mandarin'; form.querySelector('#book-language-add').click();
  input.focus(); input.value = 'English'; input.dispatchEvent(new dom.window.Event('input')); input.value = ''; input.dispatchEvent(new dom.window.Event('input'));
  const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); input.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false); assert.equal(form.checkValidity(), true); assert.deepEqual(picker.value(), ['zh']);
  let submitted = 0; form.addEventListener('submit', (event) => { event.preventDefault(); submitted++; assert.deepEqual(picker.value(), ['zh']); });
  form.requestSubmit(); assert.equal(submitted, 1);
  input.value = 'not a language'; form.querySelector('#book-language-add').click(); assert.equal(form.checkValidity(), false);
  input.value = ''; input.dispatchEvent(new dom.window.Event('blur')); assert.equal(form.checkValidity(), true);
  form.querySelector('#book-language-add').click(); assert.equal(form.checkValidity(), true, 'adding an empty optional draft is harmless');
  picker.set([]); toggle.checked = true; toggle.dispatchEvent(new dom.window.Event('change')); assert.deepEqual(picker.value(), []);
  assert.equal(form.elements.language.required, false); assert.equal(form.checkValidity(), true, 'automatic language detection does not require a manual value');
});
