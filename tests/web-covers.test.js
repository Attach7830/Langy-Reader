import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadCover } from '../server/cover-images.js';
import { openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=', 'base64');
const response = (bytes, type = 'image/png') => { const stream = Readable.from([bytes]); stream.statusCode = 200; stream.headers = { 'content-type': type, 'content-length': String(bytes.length) }; return stream; };
test('cover URL downloads decode a raster image and reject web pages, SVG and private addresses', async () => {
  const cover = await downloadCover('https://images.example.org/cover.png', { request: async () => response(png) });
  assert.equal(cover.thumbnailType, 'image/png'); assert.ok(cover.thumbnail.length > 50);
  await assert.rejects(downloadCover('https://images.example.org/page', { request: async () => response(Buffer.from('<html>page</html>'), 'text/html') }), { status: 422 });
  await assert.rejects(downloadCover('https://images.example.org/cover.svg', { request: async () => response(Buffer.from('<svg/>'), 'image/svg+xml') }), { status: 422 });
  for (const url of ['http://images.example.org/cover.png', 'https://127.0.0.1/cover', 'https://169.254.169.254/cover', 'https://user:pass@example.org/cover']) await assert.rejects(downloadCover(url), { status: 422 });
});
test('web covers persist without changing the book file and failed replacement keeps the previous cover', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-web-cover-')); t.after(() => rm(dir, { recursive: true, force: true })); let fail = false;
  const library = await openLibrary(dir, null, { coverDownload: async () => { if (fail) throw new Error('download failed'); return { thumbnail: png, thumbnailType: 'image/png' }; } });
  const epub = await sampleBook(), path = join(library.uploads, 'book.epub'); await writeFile(path, epub);
  const book = await library.importBook('covered', { path, originalname: 'book.epub', size: epub.length }, { title: 'My book', coverUrl: 'https://images.example.org/cover.png' });
  assert.equal(book.thumbnailType, 'image/png'); assert.deepEqual(await readFile(library.coverPath(book)), png);
  const updated = await library.importCover(book.id, 'https://images.example.org/another.png');
  assert.ok(updated.coverRevision); assert.ok(updated.updatedAt > book.updatedAt); assert.deepEqual(await readFile(library.filePath(updated)), epub);
  fail = true; await assert.rejects(library.importCover(book.id, 'https://images.example.org/fail.png')); assert.equal(library.getBook(book.id).coverRevision, updated.coverRevision);
  assert.deepEqual(await readFile(library.coverPath(updated)), png); assert.throws(() => library.getBook(book.id, { id: 'someone-else' }), { status: 404 });
  const reopened = await openLibrary(dir); assert.equal(reopened.getBook(book.id).coverRevision, updated.coverRevision);
  await library.removeBook(book.id); await assert.rejects(readFile(library.coverPath(updated)), { code: 'ENOENT' }); await assert.rejects(readFile(library.coverPath(book)), { code: 'ENOENT' });
});
