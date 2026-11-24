import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';
import { wordHelp } from '../src/words.js';
import { defaults } from '../src/settings.js';

const entry = { word: '卷发', pinyin: 'juǎn fà', senses: [{ pinyin: 'juǎn fà', meanings: ['curly hair', 'to curl hair'] }],
  characters: [{ character: '卷', pinyin: 'juǎn', readings: ['juǎn', 'juàn'], meanings: ['to roll up', 'to sweep up', 'to engulf'] },
    { character: '发', pinyin: 'fà', readings: ['fà', 'fā'], meanings: ['hair', 'Taiwan pronunciation'] }], note: 'Character meanings are separate clues.' };
async function until(check) { for (let n = 0; n < 250; n++) { if (check()) return; await delay(5); } throw new Error('Word meanings timed out'); }
function fixture(t, options = {}) {
  const dom = new JSDOM('<p id="book">卷发</p><div id="word-help" hidden><div data-word-mode></div><strong data-word></strong><div data-word-lemma></div><div data-word-answer></div></div>', { url: 'https://langy.test', pretendToBeVisual: true });
  const names = ['window', 'document', 'Node', 'AbortController'], original = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  const root = document.querySelector('#book'), bubble = document.querySelector('#word-help'), node = root.firstChild; let requests = 0;
  document.caretPositionFromPoint = () => ({ offsetNode: node, offset: 0 });
  dom.window.Range.prototype.getClientRects = () => [{ left: 0, top: 0, right: 50, bottom: 25, width: 50, height: 25 }];
  const help = wordHelp({ preferences: () => ({ ...defaults, translationLanguage: options.translation || 'en' }), languages: () => ['zh'],
    async request(path) { requests++; if (path === '/api/mandarin/word') return entry; return options.extra; } });
  help.bind(root, 'zh', () => root.textContent);
  t.after(() => { help.clear(); dom.window.close(); for (const [name, value] of original) { if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; } });
  return { dom, root, bubble, help, requests: () => requests, show() { const event = new dom.window.MouseEvent('pointerup', { clientX: 10, clientY: 10, bubbles: true }); Object.defineProperty(event, 'pointerType', { value: 'touch' }); root.dispatchEvent(event); },
    down(key = 'ArrowDown') { const event = new dom.window.KeyboardEvent('keydown', { key, cancelable: true }); assert.equal(help.keydown(event), true); assert.equal(event.defaultPrevented, true); } };
}

test('word and character meanings start compact, expand on demand, cycle with arrows and reset when a cached popup reopens', async (t) => {
  const f = fixture(t); f.show(); await until(() => f.bubble.querySelectorAll('.meaning-choices').length === 3);
  const pickers = () => [...f.bubble.querySelectorAll('.meaning-choices')];
  assert.equal(pickers()[0].querySelector('.meaning-selected').textContent, 'juǎn fà · curly hair');
  assert.equal(pickers()[1].querySelector('.meaning-selected').textContent, 'to roll up');
  assert.ok(pickers().every((picker) => picker.querySelector('.meaning-options').hidden));
  const top = f.bubble.style.top; pickers()[1].querySelector('.meaning-toggle').focus();
  pickers()[1].querySelector('.meaning-toggle').click(); assert.equal(pickers()[1].querySelector('.meaning-options').hidden, false);
  assert.equal(f.bubble.style.top, top, 'opening alternatives does not move the popup away from its focused control');
  f.bubble.dispatchEvent(new f.dom.window.MouseEvent('pointerleave')); await delay(200); assert.equal(f.bubble.hidden, false, 'a focused list remains usable with the keyboard');
  pickers()[1].querySelectorAll('[role="option"]')[1].click(); assert.equal(pickers()[1].querySelector('.meaning-selected').textContent, 'to sweep up');
  f.down(); assert.equal(pickers()[1].querySelector('.meaning-selected').textContent, 'to engulf');
  f.down(); assert.equal(pickers()[1].querySelector('.meaning-selected').textContent, 'to roll up');
  f.down('ArrowUp'); assert.equal(pickers()[1].querySelector('.meaning-selected').textContent, 'to engulf');
  f.down('Escape'); assert.equal(f.bubble.hidden, true);
  f.show(); await until(() => !f.bubble.hidden); assert.equal(pickers()[1].querySelector('.meaning-selected').textContent, 'to roll up');
  assert.equal(f.requests(), 1, 'closing resets only the selection, keeping the dictionary lookup cache');
});

test('a late translated gloss preserves the selected character meaning until the popup closes', async (t) => {
  let finish; const extra = new Promise((resolve) => { finish = resolve; });
  const f = fixture(t, { translation: 'es', extra }); f.show(); await until(() => f.bubble.querySelectorAll('.meaning-choices').length === 3);
  const character = () => f.bubble.querySelectorAll('.meaning-choices')[1];
  character().querySelector('.meaning-toggle').click(); character().querySelectorAll('[role="option"]')[2].click();
  finish({ text: 'cabello rizado' }); await until(() => f.bubble.textContent.includes('cabello rizado'));
  assert.equal(character().querySelector('.meaning-selected').textContent, 'to engulf');
  f.help.clear(); f.show(); await until(() => !f.bubble.hidden); assert.equal(character().querySelector('.meaning-selected').textContent, 'to roll up');
});
