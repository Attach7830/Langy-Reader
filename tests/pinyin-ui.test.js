import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { pinyinOverlay } from '../src/pinyin.js';
import { pinyinCharacters } from '../shared/mandarin-pinyin.js';
import { readingText } from '../shared/reading-text.js';
import { getSettings, saveSettings, defaults } from '../src/settings.js';
import { settingsDialog } from '../src/ui-settings.js';
import { wordHelp } from '../src/words.js';

function globals(t, dom) {
  const names = ['window', 'document', 'localStorage', 'Option', 'Event', 'CustomEvent', 'Node', 'NodeFilter', 'AbortController', 'AbortSignal', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'];
  const original = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === 'ResizeObserver' ? class { observe() {} disconnect() {} }
      : ['requestAnimationFrame', 'cancelAnimationFrame'].includes(name) ? dom.window[name].bind(dom.window) : dom.window[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => { dom.window.close(); for (const [name, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
}
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await delay(10); } throw new Error('Pinyin update timed out'); }

test('pinyin annotations use original iframe ranges, preserve source text, and disappear immediately when disabled', async (t) => {
  const dom = new JSDOM('<main><div id="viewer"><iframe></iframe></div></main>', { url: 'https://langy.test', pretendToBeVisual: true });
  globals(t, dom);
  const host = document.querySelector('#viewer'), frame = host.querySelector('iframe'), doc = frame.contentDocument;
  doc.body.innerHTML = '<p lang="zh" style="font-size:20px;writing-mode:horizontal-tb">银行 and 书</p><p lang="ja">日本語</p>';
  const original = doc.body.innerHTML;
  const rect = { left: 100, top: 100, right: 800, bottom: 800, width: 700, height: 700 };
  host.getBoundingClientRect = frame.getBoundingClientRect = () => rect;
  host.parentElement.getBoundingClientRect = () => ({ ...rect, left: 80, top: 80 });
  frame.contentWindow.Range.prototype.getClientRects = function () {
    return [{ left: 10 + this.startOffset * 20, top: 60, width: 20, height: 24 }];
  };
  let preferences = { ...defaults, showPinyin: true }, requests = 0;
  const overlay = pinyinOverlay({ host, preferences: () => preferences, renderer: () => ({ readingRoots: () => [doc.body] }), book: () => ({ language: 'en', languages: ['en', 'zh', 'ja'] }),
    async request(path, options) { requests++; assert.equal(path, '/api/mandarin/pinyin'); return { characters: pinyinCharacters(options.body.text) }; } });
  overlay.refresh();
  await until(() => document.querySelectorAll('.pinyin-layer span').length === 3);
  assert.deepEqual([...document.querySelectorAll('.pinyin-layer span')].map((node) => node.textContent), ['yín', 'háng', 'shū']);
  assert.equal(document.querySelector('.pinyin-layer span').style.left, '30px');
  assert.equal(doc.body.innerHTML, original);
  assert.equal(readingText(doc.body).text, '银行 and 书 日本語');
  overlay.refresh(); await until(() => document.querySelectorAll('.pinyin-layer span').length === 3);
  assert.equal(requests, 1, 'the page cache reuses local pronunciation results');
  preferences = { ...preferences, showPinyin: false }; overlay.refresh();
  assert.equal(document.querySelectorAll('.pinyin-layer span').length, 0);
  assert.equal(doc.body.innerHTML, original);
  assert.equal(requests, 1);
});

test('the actual settings checkbox saves pinyin on and off while preserving hover preferences', async (t) => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://langy.test', pretendToBeVisual: true });
  globals(t, dom);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let current = { ...defaults, keys: { ...defaults.keys }, mode: 'translation' }, applied = 0;
  settingsDialog({ preferences: () => current, apply(value) { current = value; saveSettings(value); applied++; } });
  const form = document.querySelector('#settings-form');
  document.querySelector('[data-settings="language"]').click();
  assert.equal(form.elements.showPinyin.checked, false);
  form.elements.showPinyin.checked = true;
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => applied === 1);
  assert.equal(getSettings().showPinyin, true);
  assert.equal(getSettings().mode, 'translation');
  document.querySelector('[data-settings="language"]').click(); assert.equal(form.elements.showPinyin.checked, true);
  form.elements.showPinyin.checked = false;
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => applied === 2);
  assert.equal(getSettings().showPinyin, false);
  assert.equal(getSettings().mode, 'translation');
});

test('hover in an English passage resolves a Chinese compound across inline markup and includes pinyin with inline pinyin off', async (t) => {
  const dom = new JSDOM('<div id="book"><p lang="en">Look at 银<em>行</em> now.</p></div><div id="word-help" hidden><div data-word-mode></div><strong data-word></strong><div data-word-lemma></div><div data-word-answer></div></div>', { url: 'https://langy.test', pretendToBeVisual: true });
  globals(t, dom);
  const root = document.querySelector('#book'), node = root.querySelector('em').firstChild, source = root.innerHTML;
  document.caretPositionFromPoint = () => ({ offsetNode: node, offset: 0 });
  dom.window.Range.prototype.getClientRects = () => [{ left: 0, top: 0, right: 30, bottom: 25, width: 30, height: 25 }];
  const requests = [];
  const help = wordHelp({ preferences: () => ({ ...defaults, mode: 'translation', showPinyin: false }), async request(path, options) {
    requests.push(path); assert.equal(options.body.text[options.body.offset], '行'); assert.ok(options.body.text.includes('银行'));
    return { word: '银行', pinyin: 'yín háng', senses: [{ pinyin: 'yín háng', meanings: ['bank'] }],
      characters: [{ character: '银', pinyin: 'yín', readings: ['yín'], meanings: ['silver'] }, { character: '行', pinyin: 'háng', readings: ['háng', 'xíng'], meanings: ['line of business'] }], note: 'Whole-word and character meanings differ.' };
  } });
  help.bind(root, 'en', () => readingText(root).text);
  root.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }));
  await until(() => document.querySelectorAll('.mandarin-character').length === 2);
  assert.deepEqual(requests, ['/api/mandarin/word']);
  assert.equal(document.querySelector('[data-word]').textContent, '银行');
  const text = document.querySelector('[data-word-answer]').textContent;
  for (const expected of ['yín háng', 'bank', 'silver', 'line of business', 'xíng']) assert.ok(text.includes(expected), expected);
  assert.equal(root.innerHTML, source);
  help.clear();
});

test('ambiguous Spanish conjugations show both possible lemmas on hover', async (t) => {
  const dom = new JSDOM('<p id="book">fuere</p><div id="word-help" hidden><div data-word-mode></div><strong data-word></strong><div data-word-lemma></div><div data-word-answer></div></div>', { url: 'https://langy.test', pretendToBeVisual: true });
  globals(t, dom);
  const root = document.querySelector('#book'), node = root.firstChild;
  document.caretPositionFromPoint = () => ({ offsetNode: node, offset: 1 });
  dom.window.Range.prototype.getClientRects = () => [{ left: 0, top: 0, right: 60, bottom: 25, width: 60, height: 25 }];
  const help = wordHelp({ preferences: () => ({ ...defaults, mode: 'translation' }),
    lemmaAt: () => ({ lemma: 'ser', lemmaCandidates: ['ir', 'ser'], lemmaUncertain: true }),
    async request(path, options) { assert.equal(options.body.lemma, 'ser'); return { text: 'were / went', language: 'en' }; } });
  help.bind(root, 'es', () => root.textContent);
  root.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }));
  await until(() => document.querySelector('[data-word-answer]').textContent === 'were / went');
  assert.equal(document.querySelector('[data-word-lemma]').textContent, 'Possible lemmas · ir / ser');
  assert.equal(document.querySelector('[data-word-lemma]').hidden, false);
  assert.equal(root.textContent, 'fuere');
  help.clear();
});

test('Spanish attached pronouns are displayed separately and dictionary lookup uses the base verb', async (t) => {
  const dom = new JSDOM('<p id="book">aproximársele</p><div id="word-help" hidden><div data-word-mode></div><strong data-word></strong><div data-word-lemma></div><div data-word-answer></div></div>', { url: 'https://langy.test', pretendToBeVisual: true });
  globals(t, dom);
  const root = document.querySelector('#book');
  document.caretPositionFromPoint = () => ({ offsetNode: root.firstChild, offset: 2 });
  dom.window.Range.prototype.getClientRects = () => [{ left: 0, top: 0, right: 160, bottom: 25, width: 160, height: 25 }];
  const help = wordHelp({ preferences: () => ({ ...defaults, mode: 'synonyms' }),
    lemmaAt: () => ({ lemma: 'aproximar', components: [{ pos: 'VERB' }, { pos: 'PRON', word: 'se' }, { pos: 'PRON', word: 'le' }] }),
    async request(path, options) { assert.equal(options.body.lemma, 'aproximar'); assert.equal(options.body.word, 'aproximársele'); return { text: 'acercar', language: 'es' }; } });
  help.bind(root, 'es', () => root.textContent);
  root.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }));
  await until(() => document.querySelector('[data-word-answer]').textContent === 'acercar');
  assert.equal(document.querySelector('[data-word-lemma]').textContent, 'Lemma · aproximar · Pronouns: se + le');
  help.clear();
});
