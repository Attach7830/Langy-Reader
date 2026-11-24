import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { maxUpload, RequestError } from './books.js';
import { ocrBookLanguages } from '../shared/ocr-languages.js';

export async function openPDFOCR(dir, { library, demo = false, onImport = () => {}, request = fetch,
  workerURL = process.env.READER_LANGUAGE_URL || 'http://127.0.0.1:8091' }) {
  const db = new DatabaseSync(join(dir, 'pdf-ocr.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT`);
  const jobs = new Map(db.prepare('SELECT * FROM jobs ORDER BY rowid').all().map((row) => [row.id, JSON.parse(row.json)]));
  let running = false, closed = false;
  const persist = (job) => db.prepare('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id, JSON.stringify(job));
  for (const job of jobs.values()) if (['running', 'importing'].includes(job.state)) { job.state = 'queued'; persist(job); }
  const publicJob = (job) => job ? { id: job.id, state: job.state, languages: job.languages, error: job.error, book: job.result, pages: job.pages, textPages: job.textPages } : null;
  const status = (book) => publicJob([...jobs.values()].filter((job) => job.source === book.id).at(-1));
  async function languages() {
    if (demo) return [];
    try {
      const response = await request(new URL('/ocr/languages', workerURL), { signal: AbortSignal.timeout(15000) });
      const body = response.ok && await response.json();
      if (!Array.isArray(body?.languages)) throw new Error('Unavailable');
      return body.languages.filter((code) => typeof code === 'string' && /^[a-zA-Z][a-zA-Z0-9_]*$/u.test(code));
    } catch { throw new RequestError(503, 'PDF OCR is unavailable. Rebuild the language service, then try again.'); }
  }
  async function pump() {
    if (running || closed || demo) return;
    running = true;
    try {
      for (const job of jobs.values()) {
        if (closed || job.state !== 'queued') continue;
        const temporary = join(library.uploads, `ocr-${job.id}.pdf`);
        try {
          job.state = 'running'; job.error = null; persist(job);
          if (job.outputBook) { try { job.result = library.getBook(job.outputBook); job.state = 'ready'; persist(job); continue; } catch {} }
          const book = library.getBook(job.source);
          const url = new URL('/ocr', workerURL); url.search = new URLSearchParams({ languages: job.languages.join('+'), rotate: job.rotate ? '1' : '0' });
          const response = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/pdf' },
            body: createReadStream(library.filePath(book)), duplex: 'half', signal: AbortSignal.timeout(3_660_000) });
          if (!response.ok) {
            let body; try { body = await response.json(); } catch {}
            throw new RequestError(502, typeof body?.detail === 'string' ? body.detail.slice(0, 300) : 'The language service could not OCR this PDF.');
          }
          let size = 0;
          const meter = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length;
            callback(size > maxUpload ? new RequestError(413, 'The searchable PDF exceeds 120 MiB.') : null, chunk); } });
          await rm(temporary, { force: true });
          await pipeline(response.body, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
          library.getBook(book.id);
          job.state = 'importing'; job.outputBook ||= randomUUID(); persist(job);
          job.result = await library.importBook(job.outputBook, { path: temporary, originalname: 'searchable.pdf', size }, {
            title: `${book.title.slice(0, 244)} (OCR)`, author: book.author, ...ocrBookLanguages(book, job.languages),
            categoryId: book.categoryId, coverStyle: book.coverStyle || 'auto',
          });
          job.pages = Number(response.headers.get('X-Langy-OCR-Pages')) || null;
          job.textPages = Number(response.headers.get('X-Langy-OCR-Text-Pages')) || null;
          job.state = 'ready'; persist(job); try { onImport(job.result); } catch {}
        } catch (error) { job.state = 'error'; job.error = error instanceof RequestError ? error.message : 'OCR could not finish. Check the language service and retry.'; persist(job); }
        finally { await rm(temporary, { force: true }); }
      }
    } finally { running = false; }
  }
  function queue(book, body) {
    if (demo) throw new RequestError(403, 'PDF OCR is available on self-hosted installations.');
    if (book.format !== 'pdf') throw new RequestError(422, 'OCR is available for PDF books.');
    if (!Array.isArray(body.languages) || !body.languages.length || body.languages.length > 20 || body.languages.some((code) => typeof code !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{1,40}$/u.test(code))) throw new RequestError(422, 'Choose the OCR languages contained in the PDF.');
    const existing = [...jobs.values()].find((job) => job.source === book.id && ['queued', 'running', 'importing'].includes(job.state));
    if (existing) return publicJob(existing);
    if ([...jobs.values()].filter((job) => ['queued', 'running', 'importing'].includes(job.state)).length >= 10) throw new RequestError(409, 'Ten PDFs are already queued for OCR. Wait for some scans to finish.');
    const job = { id: randomUUID(), source: book.id, languages: [...new Set(body.languages)], rotate: body.rotate !== false, state: 'queued' };
    jobs.set(job.id, job); persist(job); void pump(); return publicJob(job);
  }
  if (!demo) void pump();
  return { status, languages, queue, pump, close() { closed = true; } };
}
