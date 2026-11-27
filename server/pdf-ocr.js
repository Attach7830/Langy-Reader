import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { maxUpload, RequestError } from './books.js';
import { ocrBookLanguages, preferredOCRLanguages } from '../shared/ocr-languages.js';
import { maxPdfBoxUpload } from '../shared/pdf-regions.js';
import { ocrSettings } from './ocr-settings.js';
import { ocrHTTP, ocrRequestTimeout } from './ocr-http.js';
import { consumeProcesses } from './process-scheduler.js';
import { pdfBoxImages } from './pdf-box-images.js';

export async function openPDFOCR(dir, { library, demo = false, onImport = () => {}, request,
  workerURL = process.env.READER_LANGUAGE_URL || 'http://127.0.0.1:8091', now = Date.now, progressInterval = 2000, scheduler }) {
  const transport = request ? null : ocrHTTP();
  request ||= transport.request;
  const db = new DatabaseSync(join(dir, 'pdf-ocr.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT`);
  const jobs = new Map(db.prepare('SELECT * FROM jobs ORDER BY rowid').all().map((row) => [row.id, JSON.parse(row.json)]));
  let running = false, closed = false, retryTimer, boxScan; const controllers = new Map();
  const connection = await ocrSettings(dir, { demo, request, workerURL, busy: () => running || Boolean(boxScan) });
  const persist = (job) => db.prepare('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id, JSON.stringify(job));
  for (const job of jobs.values()) {
    // Older releases imported OCR output as a separate book without a revision.
    if (job.state === 'ready' && job.result?.id) library.markOCRComplete(job.result.id);
    if (['running', 'importing'].includes(job.state)) { job.state = 'queued'; persist(job); }
  }
  const publicJob = (job) => { if (!job) return null; const { owner, expires, bytes, ...book } = job.result || {};
    return { id: job.id, state: job.state, languages: job.languages, error: job.error, errorCode: job.errorCode, notice: job.notice, retryAt: job.retryAt, startedAt: job.startedAt, updatedAt: job.updatedAt, scanProgress: job.scanProgress, book: job.result ? book : undefined, inPlace: job.result?.id === job.source, pages: job.pages, textPages: job.textPages, recognizedCharacters: job.recognizedCharacters, scannedPages: job.scannedPages, skippedPages: job.skippedPages }; };
  const status = (book) => publicJob([...jobs.values()].filter((job) => job.source === book.id).at(-1));
  const languages = () => connection.languages();
  function requestScan(selected, { pdf, languages, rotate, mode, id, signal }) {
    const url = new URL(selected.baseUrl.replace(/\/+$/u, '') + '/ocr');
    url.search = new URLSearchParams({ languages: languages.join('+'), rotate: rotate ? '1' : '0', mode });
    return request(url, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/pdf', ...(id ? { 'X-Langy-OCR-Job': id } : {}), ...(selected.apiKey ? { Authorization: `Bearer ${selected.apiKey}` } : {}) },
      body: pdf, duplex: 'half', signal });
  }

  async function extractBoxes(book, images, signal) {
    if (demo || book.format !== 'pdf') throw new RequestError(403, 'Box OCR is available for PDFs on self-hosted installations.');
    if (running || boxScan) throw new RequestError(409, 'An OCR scan is already running. Try again after it finishes.');
    const pdf = pdfBoxImages(images), controller = new AbortController();
    boxScan = controller;
    const timeout = AbortSignal.timeout(300_000);
    const scanSignal = AbortSignal.any([controller.signal, timeout, ...(signal ? [signal] : [])]);
    try {
      const selected = connection.connection();
      const available = await connection.languages(selected, scanSignal);
      const previous = (jobs.get(book.contentRevision)?.languages || []).filter((language) => available.includes(language));
      const codes = previous.length ? previous : preferredOCRLanguages(available, [book.language, ...(book.languages || [])]);
      if (!codes.length) throw new RequestError(422, 'No installed OCR model matches this book’s languages. Check its language in Book details.');
      const result = await requestScan(selected, { pdf, languages: codes, mode: 'skip', rotate: false, signal: scanSignal });
      if (!result.ok) {
        const { detail } = await result.json().catch(() => ({}));
        if (result.status === 409) throw new RequestError(409, 'The OCR service is busy. Try these boxes again after its current scan.');
        if (result.status === 422 && /^OCR found no (?:selectable|readable) text/u.test(detail || '')) return images.map(() => '');
        throw new RequestError(502, [401, 403].includes(result.status) ? 'The OCR service rejected its API key.'
          : typeof detail === 'string' ? detail.slice(0, 300) : 'The OCR service could not read these boxes.');
      }
      let size = 0;
      const parts = [];
      for await (const chunk of result.body) {
        size += chunk.length;
        if (size > 2 * maxPdfBoxUpload) throw new RequestError(413, 'The scanned boxes are too large. Try using smaller boxes.');
        parts.push(chunk);
      }
      const extracted = await request(new URL('/pdf', workerURL), { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/pdf' }, body: Buffer.concat(parts, size), signal: scanSignal });
      const body = extracted.ok ? await extracted.json() : null;
      if (!Array.isArray(body?.chapters) || body.chapters.length !== images.length || body.chapters.some((chapter) => typeof chapter?.text !== 'string')) {
        await extracted.body?.cancel?.().catch(() => {});
        throw new RequestError(502, 'The text from these boxes could not be read. Check your language service and try again.');
      }
      return body.chapters.map(({ text }) => text.trim());
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof RequestError) throw error;
      if (timeout.aborted) throw new RequestError(504, 'Box OCR took more than five minutes. Try smaller boxes.');
      throw new RequestError(503, 'Could not reach the OCR or language service. Check its connection and try again.');
    } finally {
      boxScan = null;
      void pump();
    }
  }
  function watchProgress(job, selected, signal) {
    const controller = new AbortController(); let timer, missing = 0;
    async function poll() {
      if (closed || controller.signal.aborted || job.state !== 'running') return;
      try {
        const url = new URL(selected.baseUrl.replace(/\/+$/u, '') + '/ocr/progress/' + encodeURIComponent(job.id));
        const response = await request(url, { redirect: 'error', headers: selected.apiKey ? { Authorization: `Bearer ${selected.apiKey}` } : {},
          signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(8000)]) });
        const value = response.ok ? await response.json() : null;
        if (!response.ok) await response.body?.cancel?.();
        if ([404, 405, 501].includes(response.status) && ++missing >= 3) return; // Older services remain usable.
        if (!closed && !controller.signal.aborted && job.state === 'running' && value?.job === job.id
          && Number.isSafeInteger(value.complete) && Number.isSafeInteger(value.total) && value.total > 0 && value.total <= 2000
          && value.complete >= 0 && value.complete <= value.total && ['preparing', 'scanning', 'saving'].includes(value.phase)) {
          const next = { phase: value.phase, complete: value.complete, total: value.total };
          if (JSON.stringify(next) !== JSON.stringify(job.scanProgress)) { job.scanProgress = next; job.updatedAt = now(); persist(job); }
        }
      } catch { /* An unavailable progress endpoint must never interrupt OCR. */ }
      if (!closed && !controller.signal.aborted && job.state === 'running') { timer = setTimeout(poll, progressInterval); timer.unref?.(); }
    }
    timer = setTimeout(poll, progressInterval); timer.unref?.();
    return () => { clearTimeout(timer); controller.abort(); };
  }
  async function pump() {
    if (running || boxScan || closed || demo) return;
    if (![...jobs.values()].some((job) => job.state === 'queued')) return;
    clearTimeout(retryTimer);
    running = true;
    try {
      await consumeProcesses(scheduler, () => closed || [...jobs.values()].some((job) => job.state === 'queued' && job.retryAt > now()) ? [] : [...jobs.values()].filter((job) => job.state === 'queued')
        .map((job) => ({ id: `ocr:${job.id}`, created: job.created, data: job })), async (job) => {
        const temporary = join(library.uploads, `ocr-${job.id}.pdf`);
        const controller = new AbortController(); controllers.set(job.id, controller);
        let stopProgress = () => {};
        try {
          job.state = 'running'; job.startedAt = job.updatedAt = now(); job.scanProgress = null; job.error = null; job.errorCode = null; job.notice = null; job.retryAt = null; persist(job);
          const book = library.getBook(job.source);
          if (book.contentRevision === job.id) { job.result = book; job.state = 'ready'; persist(job); try { onImport(book); } catch {} return; }
          if (job.connection && job.connection !== connection.fingerprint()) throw new RequestError(409, 'The OCR connection changed while this scan was queued. Queue the PDF again to use the new connection.');
          const selected = connection.connection(job.provider || 'builtin');
          if (selected.provider === 'paddle') stopProgress = watchProgress(job, selected, controller.signal);
          const response = await requestScan(selected, { pdf: createReadStream(library.filePath(book)), languages: job.languages,
            rotate: job.rotate, mode: job.mode || 'redo', id: job.id, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(ocrRequestTimeout)]) });
          if (!response.ok) {
            let body; try { body = await response.json(); } catch {}
            if (response.status === 409) {
              job.state = 'queued'; job.retryAt = now() + Math.min(60000, Math.max(5000, (Number(response.headers.get('Retry-After')) || 5) * 1000));
              job.notice = 'Waiting for the OCR service’s current scan to finish. This PDF remains queued.'; persist(job); return false;
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
          if (job.pages > 0) job.scanProgress = { phase: 'saving', complete: job.pages, total: job.pages };
          job.state = 'importing'; job.updatedAt = now(); persist(job);
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
        finally { stopProgress(); controllers.delete(job.id); await rm(temporary, { force: true }); }
      });
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
  return { status, languages, queue, pump, extractBoxes, settings: connection.settings, save: connection.save, removeKey: connection.removeKey,
    retry(book, id) {
      const job = jobs.get(id); if (!job || job.source !== book.id) throw new RequestError(404, 'Scan not found.');
      if (job.state !== 'error') throw new RequestError(409, 'Only a failed scan needs retrying.');
      return queue(book, { languages: job.languages, rotate: job.rotate, mode: job.mode });
    },
    cancel(book, id) { const job=jobs.get(id); if (!job || job.source !== book.id) throw new RequestError(404,'Scan not found.');
      if (job.state === 'importing') throw new RequestError(409,'The completed scan is being saved. Wait for it to finish.');
      if (['queued','running'].includes(job.state)) {job.state='cancelled';job.error=null;persist(job);controllers.get(id)?.abort();} return publicJob(job); },
    close() { closed = true; boxScan?.abort(); clearTimeout(retryTimer); for (const controller of controllers.values()) controller.abort(); if (transport) void transport.close().catch(() => {}); } };
}
