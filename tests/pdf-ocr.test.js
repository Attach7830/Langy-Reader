import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { openLibrary } from '../server/books.js';
import { openPDFOCR } from '../server/pdf-ocr.js';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
async function until(check) { for (let i = 0; i < 250; i++) { const value = check(); if (value) return value; await delay(10); } throw new Error('OCR job timed out'); }

test('the real OCR HTTP transport saves the complete PDF and keeps language probes responsive during processing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-ocr-http-save-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir), source = Buffer.from('%PDF-1.4\noriginal scan\n%%EOF'), output = Buffer.from('%PDF-1.4\ncomplete searchable result\n%%EOF');
  const path = join(library.uploads, 'scan.pdf'); await writeFile(path, source);
  const book = await library.importBook('http-scan', { path, originalname: 'scan.pdf', size: source.length }, { language: 'zh' });
  let receive, release;
  const received = new Promise((resolve) => { receive = resolve; }), ready = new Promise((resolve) => { release = resolve; });
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-ocr-key');
    if (request.url === '/ocr/languages') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ engine: 'paddleocr', protocol: 1, languages: ['chi_sim', 'eng'] })); return;
    }
    const parts = []; for await (const part of request) parts.push(part);
    assert.deepEqual(Buffer.concat(parts), source); receive(); await ready;
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'X-Langy-OCR-Pages': '1', 'X-Langy-OCR-Text-Pages': '1', 'X-Langy-OCR-Characters': '28' });
    response.end(output);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { release(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const service = await openPDFOCR(dir, { library }); t.after(() => service.close());
  await service.save({ provider: 'paddle', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic-ocr-key' });
  service.queue(book, { languages: ['chi_sim'] }); await received;
  assert.deepEqual(await service.languages(), ['chi_sim', 'eng'], 'a scan waiting for response headers must not block connection checks');
  assert.equal(service.status(book).state, 'running'); release();
  const job = await until(() => ['ready', 'error'].includes(service.status(book)?.state) && service.status(book));
  assert.equal(job.state, 'ready', job.error); assert.equal(job.book.id, book.id); assert.equal(job.recognizedCharacters, 28);
  assert.deepEqual(await readFile(library.filePath(library.getBook(book.id))), output);
  assert.deepEqual(await readFile(library.filePath(book)), source);
});

test('OCR transport failure records a diagnostic code without exposing credentials or replacing the source PDF', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-ocr-http-error-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir), source = Buffer.from('%PDF-1.4\noriginal\n%%EOF'), path = join(library.uploads, 'scan.pdf'); await writeFile(path, source);
  const book = await library.importBook('failed-http-scan', { path, originalname: 'scan.pdf', size: source.length }, {});
  const service = await openPDFOCR(dir, { library, request: async (_url, options) => {
    for await (const _part of options.body) {}
    throw new TypeError('fetch failed for a URL containing synthetic-private-key', { cause: Object.assign(new Error('private connection details'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
  } }); t.after(() => service.close());
  service.queue(book, { languages: ['eng'] });
  const job = await until(() => service.status(book)?.state === 'error' && service.status(book));
  assert.equal(job.errorCode, 'UND_ERR_HEADERS_TIMEOUT'); assert.match(job.error, /before the result was saved/u);
  assert.equal(JSON.stringify(job).includes('synthetic-private-key'), false);
  assert.deepEqual(await readFile(library.filePath(library.getBook(book.id))), source);
  assert.equal(library.getBook(book.id).ocrComplete, false);
});

test('PDF OCR updates the same book, keeps metadata and original bytes, and exposes installed languages', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-pdf-ocr-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir), source = Buffer.from('%PDF-1.4\noriginal scanned pages\n%%EOF'), output = Buffer.from('%PDF-1.4\nsearchable text layer\n%%EOF');
  const path = join(library.uploads, 'scan.pdf'); await writeFile(path, source);
  const book = await library.importBook('scan', { path, originalname: 'scan.pdf', size: source.length }, { title: 'Scanned book', author: 'Author', language: 'zh', languages: ['zh', 'en'], categoryId: 'spanish', coverStyle: 'forest' });
  assert.equal(book.ocrComplete, false);
  library.saveBookmark(book.id, { target: 2, label: 'Continue here', note: 'Saved before OCR' }); library.setCurrentlyReading(book.id, { currentlyReading: true });
  const originalCount = library.snapshot().books.length;
  let analyzed, calls = 0;
  const service = await openPDFOCR(dir, { library, onImport: (value) => { analyzed = value.id; }, request: async (value, options) => {
    const url = new URL(value);
    if (url.pathname === '/ocr/languages') return Response.json({ languages: ['eng', 'spa', 'chi_sim', 'chi_tra'] });
    calls++; assert.equal(url.searchParams.get('languages'), 'chi_sim+eng');
    const chunks = []; for await (const chunk of options.body) chunks.push(chunk); assert.deepEqual(Buffer.concat(chunks), source);
    return new Response(output, { headers: { 'X-Langy-OCR-Pages': '2', 'X-Langy-OCR-Text-Pages': '2', 'X-Langy-OCR-Characters': '24', 'X-Langy-OCR-Scanned-Pages': '2', 'X-Langy-OCR-Skipped-Pages': '0' } });
  } }); t.after(() => service.close());
  assert.deepEqual(await service.languages(), ['eng', 'spa', 'chi_sim', 'chi_tra']);
  service.queue(book, { languages: ['chi_sim', 'eng'] });
  const job = await until(() => { const job = service.status(book); return ['ready', 'error'].includes(job?.state) && job; });
  assert.equal(job.state, 'ready', job.error); assert.equal(calls, 1); assert.equal(job.book.id, book.id); assert.equal(job.inPlace, true); assert.equal(analyzed, job.book.id);
  assert.equal(job.book.ocrComplete, true); assert.equal(library.getBook(book.id).ocrComplete, true); assert.equal(library.snapshot().books.find((item) => item.id === book.id).ocrComplete, true);
  assert.equal(job.recognizedCharacters, 24); assert.equal(job.scannedPages, 2); assert.equal(job.skippedPages, 0);
  assert.equal(job.book.title, 'Scanned book'); assert.equal(job.book.author, 'Author'); assert.equal(job.book.coverStyle, 'forest');
  assert.deepEqual(job.book.languages, ['zh', 'en']); assert.equal(job.book.categoryId, 'spanish'); assert.equal(job.pages, 2);
  assert.deepEqual(library.bookmarks(book.id).map(({ target, note }) => ({ target, note })), [{ target: 2, note: 'Saved before OCR' }]);
  assert.ok(library.getBook(book.id).starredAt); assert.equal(library.snapshot().books.length, originalCount);
  assert.deepEqual(await readFile(library.filePath(book)), source); assert.deepEqual(await readFile(library.filePath(library.getBook(book.id))), output); assert.equal(library.snapshot().books.length, 2);
  service.close(); const reopened = await openPDFOCR(dir, { library, request() { assert.fail('Ready OCR copies do not get scanned again'); } });
  t.after(() => reopened.close()); assert.equal(reopened.status(book).book.id, job.book.id); assert.equal(reopened.status(book).recognizedCharacters, 24);
  assert.throws(() => reopened.queue(book, { languages: ['eng;evil'] }), { status: 422 });
});

test('completed legacy OCR copies gain a persistent label while failed and queued scans stay unmarked', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-legacy-ocr-label-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir), bytes = Buffer.from('%PDF-1.4\nlegacy PDF\n%%EOF');
  const db = new DatabaseSync(join(dir, 'pdf-ocr.sqlite')); db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT');
  for (const [id, state] of [['old-copy', 'ready'], ['failed-copy', 'error'], ['queued-copy', 'queued']]) {
    const path = join(library.uploads, id); await writeFile(path, bytes);
    await library.importBook(id, { path, originalname: id + '.pdf', size: bytes.length }, { title: id });
    db.prepare('INSERT INTO jobs VALUES(?,?)').run(id, JSON.stringify({ id, source: id, state, result: state === 'ready' ? { id, format: 'pdf' } : null }));
  }
  db.close(); const service = await openPDFOCR(dir, { library, demo: true }); t.after(() => service.close());
  assert.equal(library.getBook('old-copy').ocrComplete, true); assert.equal(library.getBook('failed-copy').ocrComplete, false); assert.equal(library.getBook('queued-copy').ocrComplete, false);
  const saved = new DatabaseSync(join(dir, 'library.sqlite'), { readOnly: true });
  assert.equal(saved.prepare('SELECT ocrComplete FROM books WHERE id=?').get('old-copy').ocrComplete, 1); saved.close();
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
  let fail = true;
  const service = await openPDFOCR(dir, { library, request: async () => fail ? Response.json({ detail: 'Choose a clearer scan or correct languages.' }, { status: 422 }) : new Response(source) }); t.after(() => service.close());
  service.queue(book, { languages: ['eng'] }); const job = await until(() => service.status(book)?.state === 'error' && service.status(book));
  assert.match(job.error, /clearer scan/u); assert.equal(library.snapshot().books.length, 2); assert.deepEqual(await readFile(library.filePath(book)), source);
  fail = false; service.retry(book, job.id); await until(() => service.status(book)?.state === 'ready'); assert.equal(service.status(book).book.id, book.id);
  const demo = await openPDFOCR(dir, { library, demo: true }); t.after(() => demo.close()); assert.throws(() => demo.queue(book, { languages: ['eng'] }), { status: 403 });
});

test('the external PDF connector sends a private key only to its tested service and replaces the same book', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-paddle-connector-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir), source = Buffer.from('%PDF-1.4\noriginal scan\n%%EOF'), output = Buffer.from('%PDF-1.4\nChinese text layer\n%%EOF');
  const path = join(library.uploads, 'traditional.pdf'); await writeFile(path, source);
  const book = await library.importBook('traditional', { path, originalname: 'traditional.pdf', size: source.length }, { title: 'Traditional Chinese book', language: 'zh-TW' });
  let calls = 0;
  const service = await openPDFOCR(dir, { library, workerURL: 'http://language:8000', request: async (value, options) => {
    const url = new URL(value); assert.equal(url.origin, 'http://ocr.test:8093'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer synthetic-private-key');
    if (url.pathname === '/gateway/ocr/languages') return Response.json({ engine: 'paddleocr', protocol: 1, languages: ['chi_sim', 'chi_tra'] });
    calls++; assert.equal(url.pathname, '/gateway/ocr'); assert.equal(url.searchParams.get('languages'), 'chi_tra'); assert.equal(url.searchParams.get('mode'), 'redo');
    const chunks = []; for await (const chunk of options.body) chunks.push(chunk); assert.deepEqual(Buffer.concat(chunks), source);
    return new Response(output, { headers: { 'X-Langy-OCR-Pages': '1', 'X-Langy-OCR-Text-Pages': '1' } });
  } }); t.after(() => service.close());
  await service.save({ provider: 'paddle', baseUrl: 'http://ocr.test:8093/gateway', apiKey: 'synthetic-private-key' });
  service.queue(book, { languages: ['chi_tra'] });
  const result = await until(() => { const item = service.status(book); return ['ready', 'error'].includes(item?.state) && item; });
  assert.equal(result.state, 'ready', result.error); assert.equal(result.book.id, book.id); assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes('synthetic-private-key'), false);
  assert.deepEqual(await readFile(library.filePath(library.getBook(book.id))), output); assert.deepEqual(await readFile(library.filePath(book)), source);
});

test('cancelling active OCR aborts the scan and retains the same original PDF',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'langy-cancel-ocr-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const library=await openLibrary(dir),source=Buffer.from('%PDF-1.4\noriginal pages\n%%EOF'),path=join(library.uploads,'scan.pdf');await writeFile(path,source);
  const book=await library.importBook('cancel-scan',{path,size:source.length,originalname:'scan.pdf'},{language:'zh'});let started=false,aborted=false;
  const service=await openPDFOCR(dir,{library,request:async(_url,options)=>{for await(const _chunk of options.body){}started=true;
    return new Promise((_resolve,reject)=>{const cancel=()=>{aborted=true;reject(new DOMException('Cancelled','AbortError'));};if(options.signal.aborted)cancel();else options.signal.addEventListener('abort',cancel,{once:true});});
  }});t.after(()=>service.close());
  const job=service.queue(book,{languages:['chi_sim']});await until(()=>started);service.cancel(book,job.id);await until(()=>aborted);await service.pump();
  assert.equal(service.status(book).state,'cancelled');assert.deepEqual(await readFile(library.filePath(library.getBook(book.id))),source);assert.equal(library.getBook(book.id).contentRevision,'');
  assert.equal(library.getBook(book.id).ocrComplete, false);
});

test('a busy OCR service keeps PDFs queued and retries them sequentially instead of failing every waiting scan', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-ocr-busy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir), source = Buffer.from('%PDF-1.4\nscan\n%%EOF'), books = [];
  for (const name of ['first', 'second']) {
    const path = join(library.uploads, name + '.pdf'); await writeFile(path, source);
    books.push(await library.importBook(name, { path, originalname: name + '.pdf', size: source.length }, { title: name }));
  }
  let clock = 1000, calls = 0, active = 0, maximum = 0;
  const service = await openPDFOCR(dir, { library, now: () => clock, request: async (_url, options) => {
    active++; maximum = Math.max(maximum, active); calls++;
    for await (const _part of options.body) {}
    active--;
    if (calls === 1) return Response.json({ detail: 'A PDF OCR scan is already running.' }, { status: 409, headers: { 'Retry-After': '5' } });
    return new Response(source);
  } }); t.after(() => service.close());
  books.forEach((book) => service.queue(book, { languages: ['eng'] }));
  await until(() => service.status(books[0])?.notice);
  assert.equal(service.status(books[0]).state, 'queued'); assert.equal(service.status(books[1]).state, 'queued');
  assert.equal(service.status(books[0]).error, null); assert.equal(calls, 1);
  await delay(10); await service.pump(); assert.equal(calls, 1, 'other PDFs must wait behind the busy worker');
  clock += 5000; await service.pump();
  await until(() => books.every((book) => service.status(book)?.state === 'ready'));
  assert.equal(calls, 3); assert.equal(maximum, 1); assert.equal(service.status(books[0]).book.id, books[0].id);
});
