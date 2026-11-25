import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { libraryScreen } from '../src/ui-library.js';

async function until(check) { for (let n = 0; n < 150; n++) { if (check()) return; await delay(10); } throw new Error('Folder UI timed out'); }

test('category editor saves optional language and the import dialog explains and applies folder inheritance', async (t) => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test', pretendToBeVisual: true });
  const names = ['window', 'document', 'Option', 'Node', 'Element', 'HTMLElement', 'CustomEvent', 'FormData'];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval, intervals = [];
  globalThis.setInterval = (...args) => { const handle = originalInterval(...args); intervals.push(handle); return handle; };
  t.after(() => {
    intervals.forEach(clearInterval); globalThis.setInterval = originalInterval; globalThis.fetch = originalFetch;
    dom.window.close(); for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  let categories = [{ id: 'folder', name: 'Mandarin books', language: null }], saves = [];
  globalThis.fetch = async (path, options) => {
    if (path === '/api/library') return Response.json({ books: [], categories, demo: false, storage: { available: false }, vocabulary: { byLanguage: [] } });
    assert.equal(path, '/api/categories/folder'); assert.equal(options.method, 'PATCH');
    const body = JSON.parse(options.body); saves.push(body); categories = [{ id: 'folder', ...body }];
    return Response.json(categories[0]);
  };
  const library = libraryScreen({ progress: {}, onRemove() {} }); await library.refresh();
  const edit = () => document.querySelector('[aria-label="Edit category Mandarin books"]').click();
  const form = document.querySelector('#category-form'); edit();
  assert.equal(form.elements.l1Folder.checked, false);
  assert.match(document.querySelector('#l1-folder-help').textContent, /Removes comprehension assistance/);
  form.elements.l1Folder.checked = true;
  form.elements.language.value = 'Mandarin';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !document.querySelector('#category-dialog').open);
  assert.deepEqual(saves, [{ name: 'Mandarin books', language: 'zh', l1Folder: true }]);
  assert.match(document.querySelector('#library-description').textContent, /L1 Folder/);
  assert.match(document.querySelector('#library-description').textContent, /inherit this language/);
  document.querySelector('#import-book').click();
  const bookForm = document.querySelector('#book-form');
  assert.equal(bookForm.elements.categoryId.value, 'folder');
  assert.equal(bookForm.elements.language.value, 'zh'); assert.equal(bookForm.elements.language.readOnly, true);
  assert.equal(document.querySelector('#book-folder-language-note').hidden, false);
  assert.match(document.querySelector('#book-folder-language-note').textContent, /Comprehension assistance is off/);
  bookForm.elements.categoryId.value = ''; bookForm.elements.categoryId.dispatchEvent(new dom.window.Event('change'));
  assert.equal(bookForm.elements.language.readOnly, false); assert.equal(document.querySelector('#book-folder-language-note').hidden, true);
  edit(); form.elements.language.value = 'invalid language!';
  assert.equal(form.elements.l1Folder.checked, true);
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(saves.length, 1); assert.match(document.querySelector('#category-error').textContent, /valid language code/);
  form.elements.language.value = '';
  form.elements.l1Folder.checked = false;
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !document.querySelector('#category-dialog').open);
  assert.equal(saves.length, 2);
  assert.equal(saves[1].language, '');
  assert.equal(saves[1].l1Folder, false);
});
