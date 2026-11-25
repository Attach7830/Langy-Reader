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
  assert.deepEqual(folder, { id: 'languages', name: 'Portuguese', language: 'pt-BR', l1Folder: false });
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

test('L1 folders apply to existing, imported and moved books, persist, and restore assistance when disabled or removed', async (t) => {
  const f = await fixture(t), l = f.library;
  assert.equal(l.getBook('sample').l1Folder, false);
  l.saveCategory('native', { name: 'Native reading' }, true);
  const first = await f.importBook('first-native', { categoryId: 'native' });
  const read = l.setReadStatus(first.id, { read: true });
  l.saveCategory('native', { name: 'Native reading', l1Folder: true }, false);
  assert.equal(l.getBook(first.id).l1Folder, true); assert.equal(l.getBook(first.id).readAt, read.readAt);
  assert.equal((await f.importBook('second-native', { categoryId: 'native' })).l1Folder, true);
  const moved = await f.importBook('moved-native'); assert.equal(moved.l1Folder, false);
  assert.equal(l.editBook(moved.id, { title: moved.title, language: 'es', categoryId: 'native' }).l1Folder, true);
  l.saveCategory('native', { name: 'Renamed' }, false);
  assert.equal(l.snapshot().categories.find((folder) => folder.id === 'native').l1Folder, true, 'legacy saves preserve the choice');
  const reopened = await openLibrary(f.dir); assert.equal(reopened.getBook(first.id).l1Folder, true);
  assert.equal(reopened.snapshot().books.find((book) => book.id === first.id).l1Folder, true);
  reopened.saveCategory('native', { name: 'Renamed', l1Folder: false }, false);
  assert.equal(reopened.getBook(first.id).l1Folder, false);
  reopened.saveCategory('native', { name: 'Renamed', l1Folder: true }, false);
  assert.equal(reopened.editBook(moved.id, { title: moved.title, language: 'es', categoryId: '' }).l1Folder, false);
  reopened.removeCategory('native'); assert.equal(reopened.getBook(first.id).l1Folder, false);
  assert.deepEqual(await readFile(l.filePath(l.getBook(first.id))), f.bytes);
});

test('L1 settings stay with the folder owner and validate without changing shared readers’ assistance', async (t) => {
  const f = await fixture(t), l = f.library, owner = { id: 'owner', authenticated: true }, reader = { id: 'reader', authenticated: true };
  l.saveCategory('private-l1', { name: 'My L1', l1Folder: true }, true, owner);
  const book = await f.importBook('shared-l1', { categoryId: 'private-l1', shared: true }, owner);
  assert.equal(book.l1Folder, true); assert.equal(l.getBook(book.id, reader).l1Folder, false);
  assert.equal(l.snapshot(reader).books.find((item) => item.id === book.id).l1Folder, false);
  assert.throws(() => l.saveCategory('private-l1', { name: 'Other', l1Folder: false }, false, reader), { status: 404 });
  for (const l1Folder of ['true', 1, null, {}]) assert.throws(() => l.saveCategory('private-l1', { name: 'My L1', l1Folder }, false, owner), { status: 422 });
  assert.equal(l.getBook(book.id, owner).l1Folder, true);
});

test('existing catalogs acquire the L1 option with assistance enabled by default', async (t) => {
  const f = await fixture(t), db = new DatabaseSync(join(f.dir, 'library.sqlite')); t.after(() => db.close());
  db.exec('ALTER TABLE categories DROP COLUMN l1Folder');
  const reopened = await openLibrary(f.dir);
  assert.equal(reopened.snapshot().categories[0].l1Folder, false); assert.equal(reopened.getBook('sample').l1Folder, false);
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
