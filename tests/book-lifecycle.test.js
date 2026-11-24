import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLibrary } from '../server/books.js';
import { compareLibraryBooks } from '../shared/library-order.js';

test('currently reading and set aside persist separately from completion and remain private to demo accounts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-lifecycle-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir, { upload: 100000, books: 4, storage: 1000000 }), first = { id: 'first', expires: Date.now() + 60000 }, second = { id: 'second', expires: Date.now() + 60000 };
  const original = library.getBook('sample', first);
  library.setReadStatus('sample', { read: true }, first);
  const star = library.setCurrentlyReading('sample', { currentlyReading: true }, first);
  assert.ok(star.starredAt); assert.equal(library.getBook('sample', second).starredAt, null);
  assert.ok(library.getBook('sample', first).readAt);
  const aside = library.setAside('sample', { setAside: true }, first);
  assert.ok(aside.setAsideAt); assert.equal(aside.starredAt, null); assert.ok(library.getBook('sample', first).readAt);
  assert.equal(library.getBook('sample', second).setAsideAt, null);
  const reopened = await openLibrary(dir, { upload: 100000, books: 4, storage: 1000000 });
  assert.equal(reopened.snapshot(first).books[0].setAsideAt, aside.setAsideAt);
  reopened.setCurrentlyReading('sample', { currentlyReading: true }, first);
  assert.equal(reopened.getBook('sample', first).setAsideAt, null);
  assert.equal(reopened.getBook('sample', first).bytes, original.bytes);
  reopened.setCurrentlyReading('sample', { currentlyReading: false }, first); assert.equal(reopened.getBook('sample', first).starredAt, null);
  assert.throws(() => library.setAside('sample', { setAside: 'yes' }, first), { status: 422 });
  assert.throws(() => library.setCurrentlyReading('sample', { currentlyReading: true }, { ...first, expires: 1 }), { status: 410 });
});
test('starred books lead each library ordering, and unstarred books retain recent or density ordering', () => {
  const books = [
    { id: 'a', addedAt: 10, familiarity: { unfamiliarDensity: 2 } },
    { id: 'b', addedAt: 20, familiarity: { unfamiliarDensity: 1 } },
    { id: 'c', addedAt: 1, starredAt: 50, familiarity: { unfamiliarDensity: 99 } },
  ];
  for (const sort of ['recent', 'familiar', 'known']) assert.equal(books.slice().sort((a, b) => compareLibraryBooks(a, b, sort))[0].id, 'c');
  assert.deepEqual(books.slice().sort((a, b) => compareLibraryBooks(a, b, 'familiar')).map((book) => book.id), ['c', 'b', 'a']);
});
