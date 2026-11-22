import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';

async function fixture(t, demo = false) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-language-folders-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir, demo ? { books: 4, upload: 20 * 1024 ** 2, storage: 512 * 1024 ** 2 } : null);
  const bytes = await sampleBook();
  async function importBook(id, body = {}, visitor) {
    const path = join(library.uploads, id + '.epub'); await writeFile(path, bytes);
    return library.importBook(id, { path, originalname: id + '.epub', size: bytes.length }, body, visitor);
  }
  return { dir, library, bytes, importBook };
}

test('language folders update existing books and assign language on import and move without modifying files or completion status', async (t) => {
  const f = await fixture(t), l = f.library;
  l.saveCategory('languages', { name: 'My books' }, true);
  const first = await f.importBook('existing', { language: 'es', categoryId: 'languages' });
  const read = l.setReadStatus(first.id, { read: true });
  const folder = l.saveCategory('languages', { name: 'Portuguese', language: 'pt-BR' }, false);
  assert.deepEqual(folder, { id: 'languages', name: 'Portuguese', language: 'pt-BR' });
  const check = (id) => {
    const book = l.getBook(id); assert.equal(book.language, 'pt-BR'); assert.deepEqual(book.languages, ['pt-BR']); return book;
  };
  const existing = check(first.id);
  assert.equal(existing.readAt, read.readAt);
  assert.deepEqual(await readFile(l.filePath(existing)), f.bytes);
  check((await f.importBook('new', { categoryId: folder.id })).id);
  const moving = await f.importBook('moving');
  check(l.editBook(moving.id, { title: moving.title, author: '', language: 'es', categoryId: folder.id }).id);
  const renamed = l.saveCategory(folder.id, { name: 'Reading Portuguese' }, false);
  assert.equal(renamed.language, 'pt-BR');
  assert.equal(l.getBook(first.id).updatedAt, existing.updatedAt, 'renaming does not trigger a language update');
  const reopened = await openLibrary(f.dir);
  assert.equal(reopened.snapshot().categories.find((row) => row.id === folder.id).language, 'pt-BR');
  assert.deepEqual(reopened.readBooks().map((book) => [book.id, book.readAt]), [[first.id, read.readAt]]);
});

test('mixed-language choices survive folder assignment and clearing the folder language leaves existing choices intact', async (t) => {
  const f = await fixture(t), l = f.library;
  l.saveCategory('chinese', { name: 'Bilingual', language: 'zh-Hant' }, true);
  const book = await f.importBook('mixed', { language: 'en', languages: ['en', 'zh-Hans'], categoryId: 'chinese' });
  assert.equal(book.language, 'zh-Hant'); assert.deepEqual(book.languages, ['zh-Hant', 'en']);
  l.saveCategory('chinese', { name: 'Bilingual', language: '' }, false);
  assert.deepEqual(l.getBook(book.id).languages, ['zh-Hant', 'en']);
  const next = await f.importBook('after', { language: 'es', categoryId: 'chinese' });
  assert.equal(next.language, 'es'); assert.deepEqual(next.languages, []);
  assert.equal(l.snapshot().categories.find((row) => row.id === 'chinese').language, null);
  for (const language of [123, {}, 'not a valid language!']) assert.throws(() => l.saveCategory('chinese', { name: 'Bilingual', language }, false), { status: 422 });
});

test('a failed folder update is atomic and demo visitors cannot change another visitor’s folder or books', async (t) => {
  const f = await fixture(t, true), l = f.library;
  const a = { id: 'a', expires: Date.now() + 60000 }, b = { id: 'b', expires: Date.now() + 60000 };
  l.saveCategory('private', { name: 'Private', language: 'es' }, true, a);
  await f.importBook('owned', { categoryId: 'private' }, a);
  assert.throws(() => l.saveCategory('private', { name: 'Wrong', language: 'de' }, false, b), { status: 404 });
  assert.throws(() => l.saveCategory('spanish', { name: 'Wrong', language: 'de' }, false, a), { status: 404 });
  assert.equal(l.getBook('owned', a).language, 'es');
  assert.equal(l.snapshot(b).categories.some((row) => row.id === 'private'), false);
  const db = new DatabaseSync(join(f.dir, 'library.sqlite')); t.after(() => db.close());
  const languages = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'sv', 'da', 'nb', 'fi', 'pl', 'cs', 'ru', 'uk', 'el', 'ar', 'he', 'ja', 'ko'];
  db.prepare('UPDATE books SET languages=? WHERE id=?').run(JSON.stringify(languages), 'owned');
  assert.throws(() => l.saveCategory('private', { name: 'Should roll back', language: 'zh' }, false, a), { status: 422 });
  assert.equal(l.snapshot(a).categories.find((row) => row.id === 'private').name, 'Private');
  assert.equal(l.snapshot(a).categories.find((row) => row.id === 'private').language, 'es');
  l.setReadStatus('sample', { read: true }, a);
  assert.equal(l.readBooks(a).length, 1); assert.equal(l.readBooks(b).length, 0);
  l.setReadStatus('owned', { read: true }, a);
  db.prepare('UPDATE books SET expires=1 WHERE id=?').run('owned');
  assert.deepEqual(l.readBooks(a).map((book) => book.id), ['sample'], 'expired books do not contribute completion exposures');
});
