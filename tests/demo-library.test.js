import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';
import { extractBook } from '../server/book-text.js';

const limits = { upload: 20 * 1024 * 1024, books: 4, storage: 512 * 1024 * 1024 };
test('demo upgrades add readable Mandarin and English stories and folders without taking visitor upload slots', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-demo-library-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const personal = await openLibrary(dir);
  assert.deepEqual(personal.snapshot().books.map((book) => book.id), ['sample'], 'personal installations do not gain demo-only stories');
  const library = await openLibrary(dir, limits), first = { id: 'first-reader', expires: Date.now() + 3600000 }, second = { id: 'second-reader', expires: first.expires };
  assert.deepEqual(library.snapshot(first).categories.map((folder) => folder.name), ['English', 'Mandarin', 'Spanish']);
  assert.equal(library.snapshot(first).books.length, 3);
  for (const [id, language, title, content] of [['demo-story-zh', 'zh-Hans', '蓝色的伞', '图书馆'], ['demo-story-en', 'en', 'The Note in the Book', 'library book']]) {
    const book = library.getBook(id, first); assert.equal(book.title, title); assert.equal(book.language, language); assert.equal(book.canEdit, false);
    const folder = library.snapshot(second).categories.find((folder) => folder.id === book.categoryId); assert.equal(folder.language, language);
    const sections = await extractBook(book, library.filePath(book), () => { throw new Error('EPUB samples must be readable without a language server'); });
    assert.equal(sections.length, 1); assert.ok(sections[0].text.includes(content));
    assert.throws(() => library.editBook(id, { title: 'Changed', language }, first), { status: 403 });
    await assert.rejects(library.removeBook(id, first), { status: 403 });
  }
  library.setReadStatus('demo-story-zh', { read: true }, first);
  assert.equal(library.readBooks(first)[0].id, 'demo-story-zh'); assert.equal(library.readBooks(second).length, 0);
  for (let index = 0; index < 4; index++) {
    const bytes = await sampleBook(), path = join(library.uploads, `visitor-${index}.epub`); await writeFile(path, bytes);
    await library.importBook(`visitor-${index}`, { path, originalname: 'own.epub', size: bytes.length }, { title: 'My own upload', categoryId: 'demo-english', language: 'en' }, first);
  }
  assert.equal(library.snapshot(first).books.length, 7); assert.equal(library.snapshot(second).books.length, 3);
  const reopened = await openLibrary(dir, limits); assert.equal(reopened.snapshot(first).books.length, 7); assert.equal(reopened.snapshot(first).categories.length, 3);
  assert.equal(reopened.snapshot(first).books.find((book) => book.id === 'demo-story-zh').readAt > 0, true);
  assert.throws(() => library.saveCategory('demo-mandarin', { name: 'Changed' }, false, first), { status: 404 });
  assert.throws(() => library.getBook('visitor-0', second), { status: 404 });
});
