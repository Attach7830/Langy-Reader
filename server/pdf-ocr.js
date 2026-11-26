import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { maxUpload, RequestError } from './books.js';
import { ocrBookLanguages } from '../shared/ocr-languages.js';
import { ocrSettings } from './ocr-settings.js';
import { ocrHTTP, ocrRequestTimeout } from './ocr-http.js';

export async function openPDFOCR(dir, { library, demo = false, onImport = () => {}, request,
  workerURL = process.env.READER_LANGUAGE_URL || 'http://127.0.0.1:8091', now = Date.now }) {
  const transport = request ? null : ocrHTTP();
  request ||= transport.request;
  const db = new DatabaseSync(join(dir, 'pdf-ocr.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT`);
  const jobs = new Map(db.prepare('SELECT * FROM jobs ORDER BY rowid').all().map((row) => [row.id, JSON.parse(row.json)]));
  let running = false, closed = false, retryTimer; const controllers = new Map();
  const connection = await ocrSettings(dir, { demo, request, workerURL, busy: () => running });
  const persist = (job) => db.prepare('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id, JSON.stringify(job));
  for (const job of jobs.values()) {
    // Older releases imported OCR output as a separate book without a revision.
    if (job.state === 'ready' && job.result?.id) library.markOCRComplete(job.result.id);
    if (['running', 'importing'].includes(job.state)) { job.state = 'queued'; persist(job); }
  }
  const publicJob = (job) => { if (!job) return null; const { owner, expires, bytes, ...book } = job.result || {};
    return { id: job.id, state: job.state, languages: job.languages, error: job.error, errorCode: job.errorCode, notice: job.notice, retryAt: job.retryAt, book: job.result ? book : undefined, inPlace: job.result?.id === job.source, pages: job.pages, textPages: job.textPages, recognizedCharacters: job.recognizedCharacters, scannedPages: job.scannedPages, skippedPages: job.skippedPages }; };
  const status = (book) => publicJob([...jobs.values()].filter((job) => job.source === book.id).at(-1));
  const languages = () => connection.languages();
  async function pump() {
    if (running || closed || demo) return;
    clearTimeout(retryTimer);
    running = true;
    try {
      for (const job of jobs.values()) {
        if (closed || job.state !== 'queued') continue;
        if (job.retryAt > now()) break;
        const temporary = join(library.uploads, `ocr-${job.id}.pdf`);
        const controller = new AbortController(); controllers.set(job.id, controller);
        try {
          job.state = 'running'; job.error = null; job.errorCode = null; job.notice = null; job.retryAt = null; persist(job);
          const book = library.getBook(job.source);
          if (book.contentRevision === job.id) { job.result = book; job.state = 'ready'; persist(job); try { onImport(book); } catch {} continue; }
          if (job.connection && job.connection !== connection.fingerprint()) throw new RequestError(409, 'The OCR connection changed while this scan was queued. Queue the PDF again to use the new connection.');
          const selected = connection.connection(job.provider || 'builtin');
          const url = new URL(selected.baseUrl.replace(/\/+$/u, '') + '/ocr'); url.search = new URLSearchParams({ languages: job.languages.join('+'), rotate: job.rotate ? '1' : '0', mode: job.mode || 'redo' });
          const response = await request(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/pdf', ...(selected.apiKey ? { Authorization: `Bearer ${selected.apiKey}` } : {}) },
            body: createReadStream(library.filePath(book)), duplex: 'half', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(ocrRequestTimeout)]) });
          if (!response.ok) {
            let body; try { body = await response.json(); } catch {}
            if (response.status === 409) {
              job.state = 'queued'; job.retryAt = now() + Math.min(60000, Math.max(5000, (Number(response.headers.get('Retry-After')) || 5) * 1000));
              job.notice = 'Waiting for the OCR service’s current scan to finish. This PDF remains queued.'; persist(job); break;
            }
            throw new RequestError(502, [401, 403].includes(response.status) ? 'The OCR service rejected the API key.' : typeof body?.detail === 'string' ? body.detail.slice(0, 300) : 'The OCR service could not scan this PDF.');
          }
          let size = 0;
          const meter = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length;
            callback(size > maxUpload ? new RequestError(413, 'The searchable PDF exceeds 120 MiB.') : null, chunk); } });
          await rm(temporary, { force: true });
          await pipeline(response.body, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), {signal:controller.signal});
          controller.signal.throwIfAborted();
          library.getBook(book.id);
          for (const [field, header] of [['pages', 'Pages'], ['textPages', 'Text-Pages'], ['recognizedCharacters', 'Characters'], ['scannedPages', 'Scanned-Pages'], ['skippedPages', 'Skipped-Pages']]) {
            const raw = response.headers.get('X-Langy-OCR-' + header), value = Number(raw);
            job[field] = raw !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
          }
          job.state = 'importing'; persist(job);
          const current = library.getBook(book.id);
          job.result = await library.replacePDF(book.id, { path: temporary, size }, {
            revision: job.id, expectedRevision: book.contentRevision, ...ocrBookLanguages(current, job.languages),
          }, { id: book.owner || '' });
          job.state = 'ready'; persist(job); try { onImport(job.result); } catch {}
        } catch (error) { if (job.state !== 'cancelled') {
          job.state = 'error';
          const code = error.cause?.code || error.code || error.name;
          job.errorCode = typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/u.test(code) ? code : null;
          job.error = error instanceof RequestError ? error.message : 'PDF OCR ended before the result was saved. Check the reader and OCR service logs, then retry.';
          if (!(error instanceof RequestError)) console.error('PDF OCR request failed', { code: job.errorCode });
        } persist(job); }
        finally { controllers.delete(job.id); await rm(temporary, { force: true }); }
      }
    } finally {
      running = false;
      const next = [...jobs.values()].find((job) => job.state === 'queued');
      if (!closed && next) { retryTimer = setTimeout(() => void pump(), Math.max(50, (next.retryAt || now()) - now())); retryTimer.unref?.(); }
    }
  }
  function queue(book, body) {
    if (demo) throw new RequestError(403, 'PDF OCR is available on self-hosted installations.');
    if (book.format !== 'pdf') throw new RequestError(422, 'OCR is available for PDF books.');
    if (body.mode !== undefined && !['redo', 'skip'].includes(body.mode)) throw new RequestError(422, 'Choose a supported OCR mode.');
    if (!Array.isArray(body.languages) || !body.languages.length || body.languages.length > 20 || body.languages.some((code) => typeof code !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{1,40}$/u.test(code))) throw new RequestError(422, 'Choose the OCR languages contained in the PDF.');
    const existing = [...jobs.values()].find((job) => job.source === book.id && ['queued', 'running', 'importing'].includes(job.state));
    if (existing) return publicJob(existing);
    if ([...jobs.values()].filter((job) => ['queued', 'running', 'importing'].includes(job.state)).length >= 10) throw new RequestError(409, 'Ten PDFs are already queued for OCR. Wait for some scans to finish.');
    const job = { id: randomUUID(), source: book.id, created: Date.now(), provider: connection.settings().provider, connection: connection.fingerprint(), languages: [...new Set(body.languages)], rotate: body.rotate !== false, mode: body.mode || 'redo', state: 'queued' };
    jobs.set(job.id, job); persist(job); void pump(); return publicJob(job);
  }
  if (!demo) void pump();
  return { status, languages, queue, pump, settings: connection.settings, save: connection.save, removeKey: connection.removeKey,
    retry(book, id) {
      const job = jobs.get(id); if (!job || job.source !== book.id) throw new RequestError(404, 'Scan not found.');
      if (job.state !== 'error') throw new RequestError(409, 'Only a failed scan needs retrying.');
      return queue(book, { languages: job.languages, rotate: job.rotate, mode: job.mode });
    },
    cancel(book, id) { const job=jobs.get(id); if (!job || job.source !== book.id) throw new RequestError(404,'Scan not found.');
      if (job.state === 'importing') throw new RequestError(409,'The completed scan is being saved. Wait for it to finish.');
      if (['queued','running'].includes(job.state)) {job.state='cancelled';job.error=null;persist(job);controllers.get(id)?.abort();} return publicJob(job); },
    close() { closed = true; clearTimeout(retryTimer); for (const controller of controllers.values()) controller.abort(); if (transport) void transport.close().catch(() => {}); } };
}
