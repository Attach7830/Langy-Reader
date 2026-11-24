import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JSDOM } from 'jsdom';
import { openLibrary } from '../server/books.js';
import { readingBookmarks } from '../src/bookmarks.js';

const cfi = 'epubcfi(/6/2!/4/2/1:7)';
test('bookmarks and notes persist, deduplicate a source position and never change the book bytes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-bookmarks-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let library = await openLibrary(dir); const before = await readFile(library.filePath(library.getBook('sample')));
  library.saveBookmark('sample', { target: cfi, label: 'A useful passage', note: 'Read this again.' });
  library.saveBookmark('sample', { target: cfi, label: 'Renamed', note: 'A revised note.' });
  library = await openLibrary(dir); const entries = library.bookmarks('sample');
  assert.equal(entries.length, 1); assert.equal(entries[0].target, cfi); assert.equal(entries[0].label, 'Renamed'); assert.equal(entries[0].note, 'A revised note.');
  assert.deepEqual(await readFile(library.filePath(library.getBook('sample'))), before);
  assert.throws(() => library.saveBookmark('sample', { target: 'https://other.example', label: 'Invalid' }), { status: 422 });
  library.removeBookmark('sample', entries[0].id); assert.equal(library.bookmarks('sample').length, 0);
});

test('demo bookmarks on the shared sample remain private to their visitor and expire', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-bookmark-privacy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir, { books: 4, upload: 20000000, storage: 100000000 });
  const a = { id: 'a', expires: Date.now() + 60000 }, b = { id: 'b', expires: Date.now() + 60000 };
  const saved = library.saveBookmark('sample', { target: cfi, label: 'Private', note: 'My note' }, a).bookmarks[0];
  assert.equal(library.bookmarks('sample', b).length, 0);
  assert.throws(() => library.removeBookmark('sample', saved.id, b), { status: 404 });
  const expired = { id: 'old', expires: Date.now() - 1 }; library.saveBookmark('sample', { target: cfi, label: 'Expired' }, expired);
  assert.equal(library.bookmarks('sample', expired).length, 0); assert.equal(library.bookmarks('sample', a).length, 1);
});

test('bookmark UI freezes the saved page while audio advances, renders notes safely and navigates to the stored target', async (t) => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test' });
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { dom.window.close(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const dialog = document.querySelector('#bookmarks-dialog'); dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; };
  let position = { target: cfi, label: 'Page 4' }, entries = []; const visited = [], calls = [];
  const ui = readingBookmarks({ book: () => ({ id: 'book' }), position: () => position, go: (target) => { visited.push(target); }, request: async (path, options = {}) => {
    calls.push({ path, ...options }); if (options.method === 'POST') entries = [{ id: 'one', ...options.body }]; return { bookmarks: entries };
  } });
  await ui.open(); position = { target: 'epubcfi(/6/4!/4/2/1:0)', label: 'Page 5' };
  const form = document.querySelector('#bookmark-form'); form.elements.note.value = '<img src=x onerror=alert(1)> Important passage';
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true })); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.find((call) => call.method === 'POST').body.target, cfi);
  assert.equal(document.querySelector('#bookmark-list img'), null); assert.match(document.querySelector('#bookmark-list').textContent, /Important passage/u);
  document.querySelector('.bookmark-entry button').click(); assert.deepEqual(visited, [cfi]); assert.equal(dialog.open, false);
});
