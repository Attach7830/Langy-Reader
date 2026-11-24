import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { openLibrary } from '../server/books.js';
import { openPDFOCR } from '../server/pdf-ocr.js';
async function until(check) { for (let i = 0; i < 250; i++) { const value = check(); if (value) return value; await delay(10); } throw new Error('OCR job timed out'); }

test('PDF OCR publishes a separate searchable book, keeps metadata and original bytes, and exposes installed languages', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-pdf-ocr-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir), source = Buffer.from('%PDF-1.4\noriginal scanned pages\n%%EOF'), output = Buffer.from('%PDF-1.4\nsearchable text layer\n%%EOF');
  const path = join(library.uploads, 'scan.pdf'); await writeFile(path, source);
  const book = await library.importBook('scan', { path, originalname: 'scan.pdf', size: source.length }, { title: 'Scanned book', author: 'Author', language: 'zh', languages: ['zh', 'en'], categoryId: 'spanish', coverStyle: 'forest' });
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
  assert.equal(job.state, 'ready', job.error); assert.equal(calls, 1); assert.notEqual(job.book.id, book.id); assert.equal(analyzed, job.book.id);
  assert.equal(job.book.title, 'Scanned book (OCR)'); assert.equal(job.book.author, 'Author'); assert.equal(job.book.coverStyle, 'forest');
  assert.deepEqual(job.book.languages, ['zh', 'en']); assert.equal(job.book.categoryId, 'spanish'); assert.equal(job.pages, 2);
  assert.deepEqual(await readFile(library.filePath(book)), source); assert.deepEqual(await readFile(library.filePath(job.book)), output);
  service.close(); const reopened = await openPDFOCR(dir, { library, request() { assert.fail('Ready OCR copies do not get scanned again'); } });
  t.after(() => reopened.close()); assert.equal(reopened.status(book).book.id, job.book.id);
  assert.throws(() => reopened.queue(book, { languages: ['eng;evil'] }), { status: 422 });
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
