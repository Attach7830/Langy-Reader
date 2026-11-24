import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { bookContents } from '../src/book-contents.js';
import { offlineDownloads } from '../src/offline-downloads.js';
import { readingPackQueue } from '../src/offline-download-queue.js';

async function browser(t, options = {}) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test', pretendToBeVisual: true, ...options });
  const saved = new Map();
  for (const key of ['window', 'document', 'Option', 'Node', 'HTMLElement', 'location']) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }); }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  t.after(() => { dom.window.close(); for (const [key, value] of saved) if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; });
  return dom;
}

test('book sections filter and navigate to EPUB chapters or inferred passages without a server connection', async (t) => {
  const dom = await browser(t), doc = dom.window.document, jumps = [];
  const current = { sectionIndex: 1, contents: [{ label: 'First chapter', depth: 0, target: { index: 0 } }, { label: 'Second chapter', depth: 0, target: { index: 1, fragment: 'heading' } }],
    async readingOutline() { return [{ label: 'A quiet garden', marker: true, target: { index: 2, cfi: 'epubcfi(...)' } }]; } };
  const contents = bookContents({ renderer: () => current, book: () => ({ format: 'epub' }), go: (target) => jumps.push(target) });
  contents.open(); assert.equal(doc.querySelector('#contents-dialog').open, true);
  assert.equal(doc.querySelector('[aria-current="location"]').textContent, 'Second chapter');
  const search = doc.querySelector('#contents-body input[type="search"]'); search.value = 'Second'; search.dispatchEvent(new dom.window.Event('input')); await delay(0);
  assert.equal([...doc.querySelectorAll('.toc-item')].filter((item) => !item.hidden).length, 1);
  doc.querySelector('.toc-item[aria-current]').click(); assert.deepEqual(jumps, [{ index: 1, fragment: 'heading' }]); assert.equal(doc.querySelector('#contents-dialog').open, false);
  current.contents = []; contents.open(); await delay(0);
  assert.match(doc.querySelector('#contents-body').textContent, /A quiet garden/u);
  doc.querySelector('.toc-item').click(); assert.equal(jumps[1].index, 2);
  assert.equal(doc.querySelector('#audio-toggle').closest('#reader-more'), null, 'Audio stays in the primary toolbar');
  assert.match(doc.querySelector('#audio-toggle').textContent, /Audio/u);
});

test('PDF sections retain a working page-number fallback when the file has no chapter bookmarks', async (t) => {
  const dom = await browser(t), jumps = [], current = { contents: [], pageNumber: 3, pageCount: 10 };
  bookContents({ renderer: () => current, book: () => ({ format: 'pdf' }), go: (page) => jumps.push(page) }).open();
  const input = document.querySelector('#contents-body input[type="number"]'); input.value = '7';
  document.querySelector('.pdf-jump').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.deepEqual(jumps, [7]); assert.equal(document.querySelector('#contents-dialog').open, false);
});

test('adding a pack closes its dialog immediately and download progress stays visible while more books are queued', async (t) => {
  const dom = await browser(t), values = new Map(); let finish, report;
  const gate = new Promise((resolve) => { finish = resolve; });
  const queue = readingPackQueue({ store: { all: async () => [...values.values()], put: async (job) => values.set(job.id, structuredClone(job)), remove: async (id) => values.delete(id) }, owner: () => 'one', online: () => true,
    async download(book, { progress }) { report = progress; progress({ phase: 'audio', label: 'Downloading complete audiobook', loaded: 1024, total: 2048, percent: 70 }); if (book.id === 'a') await gate; } });
  const previous = globalThis.fetch; globalThis.fetch = async () => Response.json({ audio: { state: 'missing' }, recordings: [] });
  t.after(() => { globalThis.fetch = previous; });
  const ui = offlineDownloads({ queue }); t.after(() => ui.dispose());
  await ui.open({ id: 'a', title: 'First book' }); document.querySelector('#offline-save').click(); await delay(5);
  assert.equal(document.querySelector('#offline-dialog').open, false); assert.match(document.querySelector('#offline-status').textContent, /1 KiB \/ 2 KiB/u);
  await ui.open({ id: 'b', title: 'Second book' }); document.querySelector('#offline-save').click(); await delay(5);
  document.querySelector('#open-offline-downloads').click();
  assert.equal(document.querySelector('#downloads-dialog').open, true); assert.equal(document.querySelectorAll('.download-card').length, 2);
  assert.equal(document.querySelector('[data-download="a"] progress').value, 70); assert.match(document.querySelector('[data-download="b"]').textContent, /Queued/u);
  const cancel = document.querySelector('[data-download="a"] button');
  report({ phase: 'audio-updated', label: 'Downloading complete audiobook', loaded: 1536, total: 2048, percent: 80 });
  assert.equal(document.querySelector('[data-download="a"] button'), cancel, 'live progress must not remove the Cancel button during a tap');
  assert.equal(document.querySelector('[data-download="a"] progress').value, 80);
  finish(); await queue.idle(); assert.ok(queue.snapshot().every((job) => job.state === 'complete'));
});

test('the Android fullscreen channel tracks both browser fullscreen and CSS fallback without exposing other native capabilities', async (t) => {
  const dom = await browser(t, { runScripts: 'outside-only' }), messages = []; let closed = false;
  dom.window.eval(await readFile(new URL('../android/app/src/main/assets/reader-fullscreen.js', import.meta.url), 'utf8'));
  const port = { postMessage: (value) => messages.push(value), close: () => { closed = true; } };
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: 'wrong', ports: [port] })); assert.deepEqual(messages, []);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: '__LANGY_FULLSCREEN_TOKEN__', ports: [port] })); assert.deepEqual(messages, ['exit']);
  dom.window.document.documentElement.classList.add('focus-mode'); await delay(0); assert.equal(messages.at(-1), 'enter');
  dom.window.document.documentElement.classList.remove('focus-mode'); await delay(0); assert.equal(messages.at(-1), 'exit');
  Object.defineProperty(dom.window.document, 'fullscreenElement', { configurable: true, value: dom.window.document.body });
  dom.window.document.dispatchEvent(new dom.window.Event('fullscreenchange')); assert.equal(messages.at(-1), 'enter');
  dom.window.__langyFullscreenCleanup(); assert.equal(closed, true);
});
