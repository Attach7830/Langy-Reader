import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { libraryScreen } from '../src/ui-library.js';

async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await delay(10); } throw new Error('Read status UI timed out'); }

test('library read controls show saved status, filter books, prevent duplicate saves and retain status after a failed save', async (t) => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test', pretendToBeVisual: true });
  const names = ['window', 'document', 'Option', 'Node', 'Element', 'HTMLElement', 'CustomEvent'];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
  const originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval, intervals = [];
  globalThis.setInterval = (...args) => { const handle = originalInterval(...args); intervals.push(handle); return handle; };
  t.after(() => {
    intervals.forEach(clearInterval); globalThis.setInterval = originalInterval; globalThis.fetch = originalFetch;
    dom.window.close(); for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  const books = [
    { id: 'one', title: 'One book', author: '', language: 'es', languages: [], format: 'epub', addedAt: 2, readAt: null },
    { id: 'two', title: 'Two book', author: '', language: 'es', languages: [], format: 'pdf', addedAt: 1, readAt: 1000 },
  ];
  let fail = false, release, saves = 0;
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (path, options) => {
    if (path === '/api/library') return Response.json({ books, categories: [], maxUpload: 120 * 1024 ** 2, demo: false, storage: { available: false }, vocabulary: { byLanguage: [] } });
    assert.equal(path, '/api/books/one/read-status'); assert.equal(options.method, 'PATCH'); saves++;
    if (saves === 1) await held;
    if (fail) return Response.json({ error: 'Unable to save status.' }, { status: 500 });
    books[0].readAt = JSON.parse(options.body).read ? 2000 : null;
    return Response.json({ id: 'one', readAt: books[0].readAt });
  };
  const library = libraryScreen({ progress: {}, onRemove() {} }); await library.refresh();
  const card = (id) => document.querySelector(`#books a[href="#read/${id}"]`)?.closest('article');
  assert.equal(card('one').querySelector('.book-read-badge'), null);
  assert.equal(card('two').querySelector('.book-read-badge').textContent, 'Read');
  const toggle = card('one').querySelector('.book-read-toggle'); toggle.click();
  toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(toggle.disabled, true); assert.equal(saves, 1);
  release(); await until(() => card('one')?.querySelector('.book-read-badge'));
  assert.equal(card('one').querySelector('.book-read-toggle').getAttribute('aria-pressed'), 'true');
  const filter = document.querySelector('#book-status-filter');
  filter.value = 'unread'; filter.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.querySelectorAll('#books article').length, 0);
  assert.equal(document.querySelector('#empty-title').textContent, 'No matching books');
  filter.value = 'read'; filter.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.querySelectorAll('#books article').length, 2);
  card('one').querySelector('.book-read-toggle').click();
  await until(() => !card('one'));
  assert.ok(card('two'));
  filter.value = ''; filter.dispatchEvent(new dom.window.Event('change'));
  assert.equal(card('one').querySelector('.book-read-toggle').textContent, 'Mark as read');
  fail = true; card('one').querySelector('.book-read-toggle').click();
  await until(() => document.querySelector('#library-error').textContent === 'Unable to save status.');
  assert.equal(card('one').querySelector('.book-read-badge'), null);
  assert.equal(card('one').querySelector('.book-read-toggle').disabled, false);
});
