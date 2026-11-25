import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { openLibrary } from '../server/books.js';
import { openPDFOCR } from '../server/pdf-ocr.js';
async function until(check) { for (let i = 0; i < 250; i++) { const value = check(); if (value) return value; await delay(10); } throw new Error('OCR job timed out'); }

test('PDF OCR updates the same book, keeps metadata and original bytes, and exposes installed languages', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-pdf-ocr-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir), source = Buffer.from('%PDF-1.4\noriginal scanned pages\n%%EOF'), output = Buffer.from('%PDF-1.4\nsearchable text layer\n%%EOF');
  const path = join(library.uploads, 'scan.pdf'); await writeFile(path, source);
  const book = await library.importBook('scan', { path, originalname: 'scan.pdf', size: source.length }, { title: 'Scanned book', author: 'Author', language: 'zh', languages: ['zh', 'en'], categoryId: 'spanish', coverStyle: 'forest' });
  library.saveBookmark(book.id, { target: 2, label: 'Continue here', note: 'Saved before OCR' }); library.setCurrentlyReading(book.id, { currentlyReading: true });
  const originalCount = library.snapshot().books.length;
  let analyzed, calls = 0;
  const service = await openPDFOCR(dir, { library, onImport: (value) => { analyzed = value.id; }, request: async (value, options) => {
    const url = new URL(value);
    if (url.pathname === '/ocr/languages') return Response.json({ languages: ['eng', 'spa', 'chi_sim', 'chi_tra'] });
    calls++; assert.equal(url.searchParams.get('languages'), 'chi_sim+eng');
    const chunks = []; for await (const chunk of options.body) chunks.push(chunk); assert.deepEqual(Buffer.concat(chunks), source);
    return new Response(output, { headers: { 'X-Langy-OCR-Pages': '2', 'X-Langy-OCR-Text-Pages': '2' } });
  } }); t.after(() => service.close());
  assert.deepEqual(await service.languages(), ['eng', 'spa', 'chi_sim', 'chi_tra']);
  service.queue(book, { languages: ['chi_sim', 'eng'] });
  const job = await until(() => { const job = service.status(book); return ['ready', 'error'].includes(job?.state) && job; });
  assert.equal(job.state, 'ready', job.error); assert.equal(calls, 1); assert.equal(job.book.id, book.id); assert.equal(job.inPlace, true); assert.equal(analyzed, job.book.id);
  assert.equal(job.book.title, 'Scanned book'); assert.equal(job.book.author, 'Author'); assert.equal(job.book.coverStyle, 'forest');
  assert.deepEqual(job.book.languages, ['zh', 'en']); assert.equal(job.book.categoryId, 'spanish'); assert.equal(job.pages, 2);
  assert.deepEqual(library.bookmarks(book.id).map(({ target, note }) => ({ target, note })), [{ target: 2, note: 'Saved before OCR' }]);
  assert.ok(library.getBook(book.id).starredAt); assert.equal(library.snapshot().books.length, originalCount);
  assert.deepEqual(await readFile(library.filePath(book)), source); assert.deepEqual(await readFile(library.filePath(library.getBook(book.id))), output); assert.equal(library.snapshot().books.length, 2);
  service.close(); const reopened = await openPDFOCR(dir, { library, request() { assert.fail('Ready OCR copies do not get scanned again'); } });
  t.after(() => reopened.close()); assert.equal(reopened.status(book).book.id, job.book.id);
  assert.throws(() => reopened.queue(book, { languages: ['eng;evil'] }), { status: 422 });
});

test('PDF replacement validates output, rejects stale revisions and retains only the original backup plus the latest OCR file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-pdf-replace-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir), original = Buffer.from('%PDF-1.4\noriginal\n%%EOF'), upload = join(library.uploads, 'original.pdf'); await writeFile(upload, original);
  const book = await library.importBook('scan', { path: upload, originalname: 'scan.pdf', size: original.length }, { title: 'My scan' });
  const output = join(library.uploads, 'ocr.pdf'); await writeFile(output, 'not a PDF');
  await assert.rejects(library.replacePDF(book.id, { path: output }, { revision: 'ocr-1', expectedRevision: '' }));
  assert.deepEqual(await readFile(library.filePath(library.getBook(book.id))), original);
  await writeFile(output, '%PDF-1.4\nfirst text\n%%EOF'); const first = await library.replacePDF(book.id, { path: output }, { revision: 'ocr-1', expectedRevision: '' });
  await writeFile(output, '%PDF-1.4\nsecond text\n%%EOF');
  await assert.rejects(library.replacePDF(book.id, { path: output }, { revision: 'ocr-2', expectedRevision: '' }), { status: 409 });
  const latest = await library.replacePDF(book.id, { path: output }, { revision: 'ocr-2', expectedRevision: first.contentRevision });
  assert.equal(latest.id, book.id); assert.equal(await readFile(library.filePath(latest), 'utf8'), '%PDF-1.4\nsecond text\n%%EOF');
  await assert.rejects(readFile(library.filePath(first)), { code: 'ENOENT' }); assert.deepEqual(await readFile(library.filePath(book)), original);
  await library.removeBook(book.id); await assert.rejects(readFile(library.filePath(book)), { code: 'ENOENT' }); await assert.rejects(readFile(library.filePath(latest)), { code: 'ENOENT' });
});

test('OCR failures and demo restrictions never replace the source PDF or create a partial library entry', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-pdf-ocr-error-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir), source = Buffer.from('%PDF-1.4\noriginal\n%%EOF'), path = join(library.uploads, 'scan.pdf'); await writeFile(path, source);
  const book = await library.importBook('scan', { path, originalname: 'scan.pdf', size: source.length }, {});
  const service = await openPDFOCR(dir, { library, request: async () => Response.json({ detail: 'Choose a clearer scan or correct languages.' }, { status: 422 }) }); t.after(() => service.close());
  service.queue(book, { languages: ['eng'] }); const job = await until(() => service.status(book)?.state === 'error' && service.status(book));
  assert.match(job.error, /clearer scan/u); assert.equal(library.snapshot().books.length, 2); assert.deepEqual(await readFile(library.filePath(book)), source);
  const demo = await openPDFOCR(dir, { library, demo: true }); t.after(() => demo.close()); assert.throws(() => demo.queue(book, { languages: ['eng'] }), { status: 403 });
});
