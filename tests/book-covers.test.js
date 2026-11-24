import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';
import { bookCovers } from '../shared/book-covers.js';
import { bookCover, bookCoverPicker } from '../src/book-covers.js';

test('book cover choices persist with library metadata without modifying the EPUB or existing original cover', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-covers-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir), epub = await sampleBook(), path = join(library.uploads, 'book.epub'); await writeFile(path, epub);
  let book = await library.importBook('covered', { path, originalname: 'book.epub', size: epub.length }, { coverStyle: 'ocean' });
  assert.equal(book.coverStyle, 'ocean'); const raw = library.getBook(book.id); await writeFile(library.coverPath(raw), 'original cover');
  for (const coverStyle of Object.keys(bookCovers)) {
    book = library.editBook(book.id, { ...book, coverStyle }); assert.equal(book.coverStyle, coverStyle);
    assert.equal((await openLibrary(dir)).getBook(book.id).coverStyle, coverStyle);
  }
  assert.throws(() => library.editBook(book.id, { ...book, coverStyle: '<script>' }), { status: 422 });
  assert.deepEqual(await readFile(library.filePath(raw)), epub); assert.equal(await readFile(library.coverPath(raw), 'utf8'), 'original cover');
});

test('cover previews are keyboard-accessible and an embedded image can be replaced and restored', (t) => {
  const dom = new JSDOM('<form><input name="title" value="有意思的案子"><input name="author" value="Author"><div id="covers"></div></form>', { url: 'https://langy.test' });
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; dom.window.close(); });
  const form = document.querySelector('form'), picker = bookCoverPicker(form, document.querySelector('#covers'));
  const book = { id: 'one', title: 'A book', author: 'Author', format: 'epub', thumbnailType: 'image/jpeg', coverStyle: 'auto' };
  picker.set(book); assert.equal(form.elements.coverStyle.value, 'auto');
  assert.equal(document.querySelectorAll('[name="coverStyle"]').length, 7);
  assert.equal(document.querySelectorAll('.book-cover-preview img').length, 1);
  form.elements.coverStyle.value = 'midnight'; assert.equal(new dom.window.FormData(form).get('coverStyle'), 'midnight');
  assert.equal(bookCover({ ...book, coverStyle: 'forest' }).querySelector('img'), null);
  assert.ok(bookCover(book).querySelector('img'));
  picker.set({ ...book, coverStyle: 'plum' }); assert.equal(form.elements.coverStyle.value, 'plum');
  assert.ok([...document.querySelectorAll('input[type="radio"]')].every((input) => input.getAttribute('aria-label')));
});
