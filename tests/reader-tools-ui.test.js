import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { libraryScreen } from '../src/ui-library.js';
import { deviceSettings } from '../src/ui-device-settings.js';
import { phraseHelp } from '../src/phrase-help.js';

async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); } throw new Error('Reader tool did not update'); }
async function browser(t) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test', pretendToBeVisual: true });
  const names = ['window', 'document', 'localStorage', 'navigator', 'Option', 'Node', 'location', 'CustomEvent'];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])), originalFetch = globalThis.fetch;
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  t.after(() => { globalThis.fetch = originalFetch; dom.window.close(); for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  return dom;
}

test('Analysis & audio reveals ready controls while an unrelated iVoox request remains pending; empty Uncategorized is hidden', async (t) => {
  await browser(t); let release, books = [{ id: 'book', title: 'My book', author: '', language: 'es', format: 'epub', categoryId: 'folder', addedAt: 1 }];
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (path) => {
    if (path === '/api/library') return Response.json({ books, categories: [{ id: 'folder', name: 'Spanish' }], maxUpload: 1000000, demo: false, storage: { available: false }, vocabulary: { byLanguage: [] } });
    if (path === '/api/books/book/learning') return Response.json({ analysis: { state: 'ready', wordCount: 20, lemmaCount: 5, reading: { state: 'ready', band: 'Intermediate' }, counts: { words: 20 } }, chapters: [], narration: { audio: { state: 'missing' } } });
    if (path === '/api/books/book/recordings') return Response.json({ available: true, recordings: [] });
    if (path === '/api/books/book/ivoox') { await held; return Response.json({ job: null }); }
    if (path === '/api/settings/audiobookshelf') return Response.json({ connected: false });
    throw new Error('Unexpected path ' + path);
  };
  const ui = libraryScreen({ progress: {}, onRemove() {} }); t.after(() => ui.dispose()); await ui.refresh();
  assert.equal([...document.querySelectorAll('#categories button')].some((item) => item.textContent.includes('Uncategorized')), false);
  assert.equal([...document.querySelectorAll('#mobile-category option')].some((item) => item.value === 'uncategorized'), false);
  document.querySelector('[aria-label="Analysis and audio for My book"]').click();
  await until(() => !document.querySelector('#upload-audio-form').hidden && document.querySelector('#learning-stats').textContent.includes('5 unique lemmas'));
  assert.equal(document.querySelector('#find-similar-books').disabled, false, 'slow import status must not block vocabulary tools');
  release(); await delay(20); document.querySelector('#learning-dialog').close();
  books[0].categoryId = ''; await ui.refresh();
  assert.equal([...document.querySelectorAll('#categories button')].some((item) => item.textContent.includes('Uncategorized')), true);
});

test('Devices displays OPDS connection independently of slow progress sync', async (t) => {
  await browser(t); let release;
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (path) => {
    if (path === '/api/settings/audiobookshelf') return Response.json({ configurable: false, connected: false });
    if (path === '/api/settings/opds') return Response.json({ available: true, path: '/opds', authenticated: true, username: 'reader' });
    if (path === '/api/settings/sync') { await held; return Response.json({ available: true, deviceAvailable: true, path: '/kosync', username: 'reader' }); }
    throw new Error('Unexpected path');
  };
  const ui = deviceSettings(), loaded = ui.load();
  await until(() => !document.querySelector('#opds-connection').hidden);
  assert.equal(document.querySelector('#sync-connection').hidden, true); assert.match(document.querySelector('#opds-url').value, /\/opds$/u);
  release(); await loaded; assert.equal(document.querySelector('#sync-connection').hidden, false);
});

test('selecting a phrase offers one explicit contextual AI action and closes or aborts safely', async (t) => {
  const dom = await browser(t), root = document.createElement('article'); root.innerHTML = '<p>La viajera tenía muchas ganas de leer esta historia.</p>'; document.body.append(root);
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 30, top: 100, bottom: 125 });
  const calls = []; let selected = 0, pending;
  const ui = phraseHelp({ book: () => ({ id: 'book', language: 'es' }), preferences: () => ({ translationLanguage: 'pt' }), onSelection() { selected++; },
    async request(path, options) { calls.push({ path, ...options }); return pending ? await pending : { text: 'Significa estar com muita vontade de ler.' }; } });
  const unbind = ui.bind(root); t.after(unbind);
  const range = document.createRange(); range.setStart(root.firstChild.firstChild, 17); range.setEnd(root.firstChild.firstChild, 28); const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new dom.window.Event('selectionchange'));
  await until(() => !document.querySelector('#phrase-help').hidden);
  assert.equal(calls.length, 0, 'selection itself must not spend tokens'); assert.equal(selected, 1);
  document.querySelector('[data-explain-phrase]').click(); await until(() => document.querySelector('[data-phrase-answer]').textContent.includes('Significa'));
  assert.equal(calls[0].path, '/api/ai/phrase'); assert.equal(calls[0].body.translationLanguage, 'pt'); assert.ok(calls[0].body.context.includes(calls[0].body.phrase));
  let resolve; pending = new Promise((done) => { resolve = done; }); document.querySelector('[data-explain-phrase]').click(); await delay(0);
  ui.clear(); assert.equal(calls.at(-1).signal.aborted, true); resolve({ text: 'Late answer' }); await delay(0); assert.equal(document.querySelector('#phrase-help').hidden, true); assert.equal(document.querySelector('[data-phrase-answer]').textContent, '');
});
