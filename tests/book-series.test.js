import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';
import { compareLibraryBooks } from '../shared/library-order.js';
import { seriesKey, seriesLabel } from '../shared/book-series.js';

test('series names and fractional sequence numbers persist across imports, edits, sharing and reopening without changing book bytes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-book-series-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir), bytes = await sampleBook(), path = join(library.uploads, 'series.epub'); await writeFile(path, bytes);
  const owner = { id: 'owner' }, reader = { id: 'member' };
  const book = await library.importBook('series-book', { path, originalname: 'series.epub', size: bytes.length }, { title: 'Second story', language: 'es', series: '  Stories   of the world  ', seriesIndex: '2.5', shared: true }, owner);
  assert.equal(book.series, 'Stories of the world'); assert.equal(book.seriesIndex, 2.5);
  assert.equal(library.snapshot(reader).books[0].seriesIndex, 2.5);
  assert.throws(() => library.editBook(book.id, { title: book.title, language: 'es', series: 'Other series' }, reader), { status: 403 });
  const details = { title: 'Edited story', author: 'A Writer', language: 'es' };
  const edited = library.editBook(book.id, details, owner);
  assert.equal(edited.series, book.series); assert.equal(edited.seriesIndex, 2.5, 'older clients may omit series fields without clearing them');
  assert.equal((await openLibrary(dir)).getBook(book.id, owner).seriesIndex, 2.5);
  assert.deepEqual(await readFile(library.filePath(library.getBook(book.id, owner))), bytes);
  assert.equal(library.editBook(book.id, { ...details, seriesIndex: '0' }, owner).seriesIndex, 0);
  assert.equal(library.editBook(book.id, { ...details, seriesIndex: ' ' }, owner).seriesIndex, null);
  for (const invalid of [{ series: {} }, { series: 'x'.repeat(201) }, { series: 'Bad\nName' }, { seriesIndex: -1 }, { seriesIndex: Infinity }, { seriesIndex: true }, { seriesIndex: 'unknown' }]) assert.throws(() => library.editBook(book.id, { ...details, ...invalid }, owner), { status: 422 });
  const cleared = library.editBook(book.id, { ...details, series: '', seriesIndex: '3' }, owner);
  assert.equal(cleared.series, ''); assert.equal(cleared.seriesIndex, null);
});

test('the series migration preserves existing library rows and defaults older books to no series', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-series-migration-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await openLibrary(dir), before = first.getBook('sample');
  const db = new DatabaseSync(join(dir, 'library.sqlite'));
  db.exec('ALTER TABLE books DROP COLUMN seriesIndex; ALTER TABLE books DROP COLUMN series'); db.close();
  const library = await openLibrary(dir), after = library.getBook('sample');
  assert.equal(after.title, before.title); assert.equal(after.addedAt, before.addedAt);
  assert.equal(after.series, ''); assert.equal(after.seriesIndex, null);
});

test('series sorting keeps numeric reading order, including prequels and unnumbered entries, while regular sorting retains pins', () => {
  const books = [
    { id: 'ten', title: 'Tenth story', series: 'Stories', seriesIndex: 10, starredAt: 3 },
    { id: 'two', title: 'Second story', series: 'stories', seriesIndex: 2 },
    { id: 'prequel', title: 'Prequel', series: 'Stories', seriesIndex: 0.5 },
    { id: 'unknown', title: 'Unnumbered story', series: 'Stories', seriesIndex: null },
    { id: 'standalone', title: 'A standalone', series: '', seriesIndex: null },
  ];
  assert.deepEqual([...books].sort((a, b) => compareLibraryBooks(a, b, 'series')).map((book) => book.id), ['prequel', 'two', 'ten', 'unknown', 'standalone']);
  assert.equal([...books].sort((a, b) => compareLibraryBooks(a, b, 'recent'))[0].id, 'ten');
  assert.equal(seriesKey(' ＳＴＯＲＩＥＳ '), 'stories');
  assert.equal(seriesLabel({ series: 'Stories', seriesIndex: 0 }), 'Stories · Book 0');
});
