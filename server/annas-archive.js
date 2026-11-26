import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, rename, rm, readdir, open } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { maxUpload, normalizeLanguage, RequestError } from './books.js';
import { publicDownload, downloadURL } from './public-download.js';
import { importNarrationOptions } from './import-narration.js';
import { consumeProcesses } from './process-scheduler.js';

const mirrors = ['https://annas-archive.gl', 'https://annas-archive.pk', 'https://annas-archive.gd'];
const pending = new Set(['queued', 'downloading', 'importing']);
export const archiveRetryDelay = 6 * 60 * 60 * 1000;
export const archiveBulkLimit = 50;

export function archiveMD5(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^[a-f0-9]{32}$/iu.test(text)) return text.toLowerCase();
  let url;
  try { url = new URL(text); } catch { /* Validate below. */ }
  if (text.length <= 2000 && url?.protocol === 'https:' && !url.username && !url.password
    && /^(?:www\.)?annas-archive\.[a-z]{2,24}$/iu.test(url.hostname)) {
    const match = /^\/(?:md5|fast_download|slow_download)\/([a-f0-9]{32})(?:\/\d+(?:\/\d+)?)?\/?$/iu.exec(url.pathname);
    if (match) return match[1].toLowerCase();
  }
  throw new RequestError(422, 'Paste an Anna’s Archive book link or a 32-character MD5.');
}

function membershipError(status, data) {
  const error = typeof data?.error === 'string' ? data.error.toLowerCase() : '';
  if (status >= 500) return new RequestError(502, 'Anna’s Archive is temporarily unavailable. The import can be retried.');
  if (status === 429 || /limit|quota|too many/u.test(error)) return new RequestError(429, 'Anna’s Archive’s download allowance has been reached. Try again when your membership allowance resets.');
  if ([401, 402, 403].includes(status) || /key|member|donat|auth|expired/u.test(error)) return new RequestError(401, 'Check your Anna’s Archive membership key and membership status in Settings → Book sources.');
  if (status === 404 || /md5|not found|unavailable|no fast download/u.test(error)) return new RequestError(404, 'This book has no available member download. Choose another EPUB or PDF edition.');
  return new RequestError(502, 'Anna’s Archive could not provide a download link. Try again later or select another mirror in Book sources.');
}

function filename(headers, md5, format) {
  const disposition = String(headers['content-disposition'] || '');
  let name = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  try { name = name && decodeURIComponent(name); } catch { name = ''; }
  name ||= /filename="([^"]+)"/iu.exec(disposition)?.[1] || /filename=([^;]+)/iu.exec(disposition)?.[1];
  const clean = basename(String(name || md5).replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/gu, '').trim().slice(0, 240);
  return (basename(clean, extname(clean)) || md5) + '.' + format;
}

export async function openArchive(dir, { library, demo = false, request = publicDownload, onImport = () => {}, now = Date.now, autoStart = true,
  canUseShared = () => true, visitorForOwner = (id) => id ? { id } : undefined, activeOwner = () => true, scheduler }) {
  const path = join(dir, 'archive-settings.json');
  const profilesPath = join(dir, 'archive-users.json'); let profiles = {};
  let current = { baseUrl: mirrors[0], apiKey: '', slowFallback: true, retryUnavailable: true };
  if (!demo) {
    try { current = { ...current, ...JSON.parse(await readFile(path, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { profiles = JSON.parse(await readFile(profilesPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of await readdir(library.uploads)) {
    if (/^aa-[a-f0-9-]{36}\.part$/u.test(name)) await rm(join(library.uploads, name), { force: true });
  }
  const personal = (visitor) => Boolean(visitor?.authenticated && visitor.role !== 'admin');
  function effective(visitor) {
    if (!activeOwner(visitor?.id || '')) throw new RequestError(403, 'This account is no longer active.');
    if (!personal(visitor)) return { ...current, apiKey: canUseShared(visitor) ? current.apiKey : '' };
    const profile = profiles[visitor.id] || {}, shared = profile.useShared ?? !profile.apiKey;
    return { ...current, apiKey: shared ? canUseShared(visitor) ? current.apiKey : '' : profile.apiKey || '' };
  }
  const settings = (visitor) => demo ? { configurable: false, hasKey: false }
    : { configurable: true, baseUrl: current.baseUrl, hasKey: Boolean(effective(visitor).apiKey),
      ...(personal(visitor) ? { personal: true, hasPersonalKey: Boolean(profiles[visitor.id]?.apiKey), sharedAllowed: Boolean(canUseShared(visitor)),
        sharedAvailable: Boolean(canUseShared(visitor) && current.apiKey), useShared: profiles[visitor.id]?.useShared ?? !profiles[visitor.id]?.apiKey } : {}),
      slowFallback: current.slowFallback, retryUnavailable: current.retryUnavailable, retryHours: 6, bulkLimit: archiveBulkLimit, mirrors };
  let writes = Promise.resolve();
  function save(body, visitor) {
    if (demo) throw new RequestError(403, 'Anna’s Archive connections are available on self-hosted installations.');
    const operation = writes.then(async () => {
      // Resolve key-only changes inside the serialized write, preserving newer settings.
      if (typeof body === 'function') body = body();
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.replace(/\/+$/u, '') : current.baseUrl;
      if (!mirrors.includes(baseUrl)) throw new RequestError(422, 'Choose one of the listed Anna’s Archive mirrors.');
      const input = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (input.length > 4096 || /[^\x21-\x7e]/u.test(input)) throw new RequestError(422, 'Enter a valid membership key without spaces.');
      if (personal(visitor)) {
        if (body.useShared !== undefined && typeof body.useShared !== 'boolean') throw new RequestError(422, 'Choose which membership key to use.');
        if (body.useShared === true && !canUseShared(visitor)) throw new RequestError(403, 'Your administrator has not granted access to the shared membership key. Save your own key instead.');
        const old = profiles[visitor.id] || {}, profile = { apiKey: body.clearKey === true ? '' : input || old.apiKey || '', useShared: body.useShared ?? (input ? false : old.useShared ?? !old.apiKey) };
        const next = { ...profiles, [visitor.id]: profile }, temporary = `${profilesPath}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); await rename(temporary, profilesPath); profiles = next; }
        finally { await rm(temporary, { force: true }); }
        return settings(visitor);
      }
      if (body.slowFallback !== undefined && typeof body.slowFallback !== 'boolean') throw new RequestError(422, 'Choose whether slow-download fallback is enabled.');
      if (body.retryUnavailable !== undefined && typeof body.retryUnavailable !== 'boolean') throw new RequestError(422, 'Choose whether unavailable downloads should retry.');
      const next = { baseUrl, apiKey: body.clearKey === true ? '' : input || current.apiKey,
        slowFallback: body.slowFallback ?? current.slowFallback, retryUnavailable: body.retryUnavailable ?? current.retryUnavailable };
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
        current = next;
        if (!current.retryUnavailable) for (const job of jobs.values()) if (job.nextAttempt) {
          job.nextAttempt = null; if (job.state === 'retry_wait') job.state = 'error'; persist(job);
        }
      } finally { await rm(temporary, { force: true }); }
      return settings(visitor);
    });
    writes = operation.catch(() => {});
    return operation;
  }
  const db = new DatabaseSync(join(dir, 'archive-jobs.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT');
  const jobs = new Map(demo ? [] : db.prepare('SELECT id,json FROM jobs ORDER BY rowid').all().map((row) => [row.id, JSON.parse(row.json)]));
  let running = false, closed = false;
  const controllers = new Map();
  function persist(job) { db.prepare('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id, JSON.stringify(job)); }
  for (const job of jobs.values()) if (pending.has(job.state)) { job.state = 'queued'; job.bytes = 0; persist(job); }
  const publicJob = (job) => ({ id: job.id, state: job.state, bytes: job.bytes, total: job.total, error: job.error, book: job.book,
    source: job.source, notice: job.notice, reference: job.md5, details: job.details, batchId: job.batchId,
    nextAttempt: job.nextAttempt || null, attempts: job.attempts || 0, ...(job.source === 'slow' ? { bookUrl: job.bookUrl } : {}) });
  const owned = (job, visitor) => !visitor || (job.owner || '') === (visitor.id || '');
  const findJob = (id, visitor) => { const job = jobs.get(id); if (!job || !owned(job, visitor)) throw new RequestError(404, 'Import not found.'); return job; };
  const latest = (visitor) => { const all = [...jobs.values()].filter((job) => owned(job, visitor)); const job = all.find((item) => pending.has(item.state)) || all.find((item) => ['needs_action', 'retry_wait'].includes(item.state)) || all.at(-1); return job ? publicJob(job) : null; };
  const signal = (job, timeout) => AbortSignal.any([controllers.get(job.id)?.signal || new AbortController().signal, AbortSignal.timeout(timeout)]);
  function fail(job, error) {
    if (job.state === 'cancelled') return;
    job.error = error instanceof RequestError ? error.message : 'Anna’s Archive could not be reached. The import can be retried.';
    const retryable = !(error instanceof RequestError) || error.status >= 500 || error.status === 429;
    job.nextAttempt = current.retryUnavailable && job.queueUnavailable !== false && retryable && job.mode !== 'slow' ? now() + archiveRetryDelay : null;
    job.state = job.source === 'slow' ? 'needs_action' : job.nextAttempt ? 'retry_wait' : 'error';
    persist(job);
  }

  function slow(job, config, reason) {
    job.source = 'slow'; job.state = 'needs_action'; job.bookUrl = `${config.baseUrl}/md5/${job.md5}`;
    job.notice = reason || 'Continue with a free slow download. Complete the browser check and any wait on Anna’s Archive, then provide the final file link or upload the downloaded book.';
    job.nextAttempt = reason && config.retryUnavailable && job.queueUnavailable !== false && config.apiKey && job.mode !== 'slow' ? now() + archiveRetryDelay : null;
    persist(job);
  }

  async function importFile(job, temporary, headers = {}) {
    const digest = createHash('md5');
    for await (const chunk of createReadStream(temporary)) digest.update(chunk);
    if (digest.digest('hex') !== job.md5) throw new RequestError(422, 'The file did not match the requested MD5. Nothing was imported; choose the same edition or retry its download.');
    const handle = await open(temporary, 'r'), prefix = Buffer.alloc(1024);
    let bytesRead;
    try { ({ bytesRead } = await handle.read(prefix)); } finally { await handle.close(); }
    const format = /%PDF-\d\.\d/u.test(prefix.toString('latin1', 0, bytesRead)) ? 'pdf'
      : prefix.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) ? 'epub' : null;
    if (!format) throw new RequestError(415, 'This download is not a supported EPUB or PDF. Choose another edition.');
    job.state = 'importing';
    job.outputBook ||= randomUUID(); persist(job);
    const book = await library.importBook(job.outputBook, { path: temporary, size: job.bytes,
      originalname: filename(headers, job.md5, format) }, job.details, { id: job.owner || '' });
    job.book = book; job.state = 'ready'; job.error = null; job.nextAttempt = null; persist(job);
    try { onImport(book, job.details); } catch { /* Library refresh can start analysis again. */ }
  }

  async function downloadFile(job, url) {
    const temporary = join(library.uploads, `aa-${job.id}.part`);
    try {
      job.state = 'downloading'; job.bytes = 0; job.total = null; job.error = null;
      persist(job);
      const download = await request(url, { signal: signal(job, job.source === 'slow' ? 6 * 3_600_000 : 600_000) });
      if (download.statusCode !== 200 || /text\/html/iu.test(download.headers['content-type'] || '')) {
        download.destroy(); throw new RequestError(502, job.source === 'slow'
          ? 'The link needs a browser check, wait, or a fresh file URL. Complete the slow download in your browser, then upload its EPUB/PDF here or paste the final file link.'
          : 'The book download server is unavailable. Try importing again.');
      }
      const length = Number(download.headers['content-length']);
      if (Number.isFinite(length) && length > maxUpload) { download.destroy(); throw new RequestError(413, `Books must be ${maxUpload / 1024 ** 2} MiB or smaller.`); }
      job.total = Number.isFinite(length) && length > 0 ? length : null;
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        job.bytes += chunk.length;
        if (job.bytes > maxUpload) return callback(new RequestError(413, `Books must be ${maxUpload / 1024 ** 2} MiB or smaller.`));
        callback(null, chunk);
      } });
      await pipeline(download, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      await importFile(job, temporary, download.headers);
    } catch (error) {
      await rm(temporary, { force: true });
      fail(job, error);
    } finally { await rm(temporary, { force: true }); }
  }

  async function run(job, config, md5, body) {
    try {
      if (job.outputBook) { try { job.book = library.getBook(job.outputBook); job.state = 'ready'; job.error = null; job.nextAttempt = null; persist(job); return; } catch {} }
      if (body.downloadMode === 'slow' || !config.apiKey && config.slowFallback) return slow(job, config);
      const endpoint = new URL('/dyn/api/fast_download.json', config.baseUrl);
      endpoint.search = new URLSearchParams({ md5, key: config.apiKey }).toString();
      const response = await request(endpoint, { signal: signal(job, 30_000), redirects: 0 });
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 128 * 1024) { response.destroy(); throw new RequestError(502, 'Anna’s Archive returned an unreadable response.'); }
        chunks.push(chunk);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { throw new RequestError(502, 'Anna’s Archive returned an unreadable response. Try another mirror in Book sources.'); }
      if (![200, 204].includes(response.statusCode) || !data.download_url) {
        const error = membershipError(response.statusCode, data);
        if (error.status === 429 && config.slowFallback && body.downloadMode !== 'fast') return slow(job, config, 'Fast-download allowance reached. Continue with a free slow download below.');
        throw error;
      }
      await downloadFile(job, data.download_url);
    } catch (error) {
      // Do not expose upstream URLs, signed links, keys, or raw transport errors.
      fail(job, error);
    }
  }

  function makeJob(body, batchId, visitor) {
    if (demo) throw new RequestError(403, 'Anna’s Archive imports are available on self-hosted installations.');
    const mode = body.downloadMode || 'auto';
    if (body.queueUnavailable !== undefined && typeof body.queueUnavailable !== 'boolean') throw new RequestError(422, 'Choose whether an unavailable download stays queued.');
    if (!['auto', 'fast', 'slow'].includes(mode)) throw new RequestError(422, 'Choose automatic, fast, or slow download.');
    const connection = effective(visitor);
    if (!connection.apiKey && mode !== 'slow' && (mode === 'fast' || !connection.slowFallback)) throw new RequestError(422, 'Add your membership key in Settings → Book sources first, or choose a free slow download.');
    const md5 = archiveMD5(body.reference);
    const language = typeof body.language === 'string' ? body.language.trim() : '';
    if (language && !normalizeLanguage(language)) throw new RequestError(422, 'Enter a valid book language code.');
    if (body.categoryId && !library.snapshot(visitor).categories.some(({ id }) => id === body.categoryId)) throw new RequestError(422, 'Choose a category that exists.');
    const details = Object.fromEntries(['title', 'author', 'language', 'languages', 'categoryId', 'coverStyle', 'coverUrl', 'shared', 'series', 'seriesIndex'].filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
    Object.assign(details, importNarrationOptions(body));
    return { id: randomUUID(), owner: visitor?.id || '', md5, details, mode, batchId, queueUnavailable: body.queueUnavailable ?? true, created: now(), source: 'fast', state: 'queued', bytes: 0, total: null, error: null, nextAttempt: null, attempts: 0 };
  }
  function insert(batch) {
    if (batch.some((item) => [...jobs.values()].some((job) => job.md5 === item.md5 && (job.owner || '') === (item.owner || '') && ['queued', 'downloading', 'importing', 'needs_action', 'retry_wait'].includes(job.state)))) throw new RequestError(409, 'This edition is already running or queued. Continue, retry, or cancel its current import.');
    if ([...jobs.values()].filter((job) => ['queued', 'downloading', 'importing', 'needs_action', 'retry_wait'].includes(job.state)).length + batch.length > 100) throw new RequestError(409, 'The import queue has 100 unfinished books. Finish or cancel some before adding more.');
    db.exec('BEGIN');
    try { for (const job of batch) persist(job); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    for (const job of batch) jobs.set(job.id, job);
    for (const job of [...jobs.values()]) if (jobs.size > 150 && ['ready', 'error', 'cancelled'].includes(job.state)) { jobs.delete(job.id); db.prepare('DELETE FROM jobs WHERE id=?').run(job.id); }
    if (autoStart) void pump();
  }
  function queue(body, visitor) { const job = makeJob(body, undefined, visitor); insert([job]); return publicJob(job); }
  function queueBatch(body, visitor) {
    if (!Array.isArray(body.books) || !body.books.length || body.books.length > archiveBulkLimit) throw new RequestError(422, `Add between 1 and ${archiveBulkLimit} books.`);
    if (body.sameAuthor !== undefined && typeof body.sameAuthor !== 'boolean') throw new RequestError(422, 'Choose whether all authors are the same.');
    const batchId = randomUUID();
    const batch = body.books.map((book) => {
      if (!book || typeof book !== 'object') throw new RequestError(422, 'Enter a link for each book.');
      return makeJob({ language: body.language, languages: body.languages, categoryId: body.categoryId, coverStyle: body.coverStyle, coverUrl: body.coverUrl, downloadMode: body.downloadMode, queueUnavailable: body.queueUnavailable,
        autoAudiobook: body.autoAudiobook, audiobookDelayMinutes: body.audiobookDelayMinutes, shared: body.shared, series: book.series ?? body.series, seriesIndex: book.seriesIndex ?? body.seriesIndex,
        reference: book.reference, title: book.title, author: body.sameAuthor ? body.author : book.author }, batchId, visitor);
    });
    if (new Set(batch.map((job) => job.md5)).size !== batch.length) throw new RequestError(422, 'Each row must refer to a different book edition.');
    insert(batch); return { batchId, jobs: batch.map(publicJob) };
  }
  async function pump() {
    if (running || controllers.size || closed || demo) return;
    if (![...jobs.values()].some((job) => job.state === 'queued' || current.retryUnavailable && job.queueUnavailable !== false
      && ['retry_wait','needs_action'].includes(job.state) && job.nextAttempt && job.nextAttempt <= now())) return;
    running = true;
    try {
      await consumeProcesses(scheduler, () => closed ? [] : [...jobs.values()].filter((job) => job.state === 'queued'
        || current.retryUnavailable && job.queueUnavailable !== false && ['retry_wait', 'needs_action'].includes(job.state) && job.nextAttempt && job.nextAttempt <= now())
        .map((job) => ({ id: `archive:${job.id}`, created: job.created, data: job })), async (job) => {
        controllers.set(job.id, new AbortController()); job.state = 'queued'; job.source = 'fast'; job.error = null; job.nextAttempt = null; job.attempts++; persist(job);
        try {
          const connection = effective(visitorForOwner(job.owner || ''));
          if (job.mode === 'slow' || !connection.apiKey && connection.slowFallback && job.mode !== 'fast') slow(job, connection);
          else if (!connection.apiKey) throw new RequestError(403, 'Membership key unavailable. Save your own key or ask the administrator for shared access.');
          else await run(job, connection, job.md5, { downloadMode: job.mode });
        } catch (error) { fail(job, error); }
        finally { controllers.delete(job.id); }
      });
    } finally { running = false; }
  }
  function resumable(id, visitor) {
    if (demo) throw new RequestError(403, 'Anna’s Archive imports are available on self-hosted installations.');
    const job = findJob(id, visitor);
    if (!job || job.source !== 'slow') throw new RequestError(404, 'Slow import not found. Start a new import if the server restarted.');
    if (job.state !== 'needs_action' || controllers.size) throw new RequestError(409, 'Wait for the current import to finish.');
    return job;
  }
  function updateDetails(job, details) {
    if (details === undefined) return;
    if (typeof details === 'string') { try { details = JSON.parse(details); } catch { throw new RequestError(422, 'Invalid book details.'); } }
    if (!details || typeof details !== 'object' || Array.isArray(details)) throw new RequestError(422, 'Invalid book details.');
    const options = importNarrationOptions({ ...job.details, ...details });
    for (const key of ['title', 'author', 'language', 'languages', 'categoryId', 'coverStyle', 'coverUrl', 'shared', 'series', 'seriesIndex']) if (Object.hasOwn(details, key)) job.details[key] = details[key];
    if (Object.hasOwn(details, 'autoAudiobook') || Object.hasOwn(details, 'audiobookDelayMinutes')) {
      job.details.autoAudiobook = Boolean(options); if (options) job.details.audiobookDelayMinutes = options.audiobookDelayMinutes;
    }
  }
  const timer = !demo && autoStart ? setInterval(() => { void pump(); }, 60_000) : null;
  timer?.unref();
  if (autoStart && !demo) void pump();
  return {
    settings, save, removeKey: (visitor) => save(() => ({ clearKey: true, ...(personal(visitor) && !canUseShared(visitor) ? { useShared: false } : {}) }), visitor), queue, queueBatch, latest, list: (visitor) => [...jobs.values()].filter((job) => owned(job, visitor)).map(publicJob), pump,
    continue(id, body, visitor) { const job = resumable(id, visitor), url = downloadURL(body?.url); updateDetails(job, body?.details);
      job.nextAttempt = null; persist(job);
      running = true; controllers.set(id, new AbortController());
      const task = () => downloadFile(job, url);
      void (scheduler ? scheduler.run(`archive:${id}`, task, { created: job.created, valid: () => !closed && job.state !== 'cancelled' }) : task())
        .finally(() => { controllers.delete(id); running = false; if (autoStart) void pump(); }); return publicJob(job); },
    async accept(id, file, details, visitor) {
      const temporary = file?.path;
      try {
        const job = resumable(id, visitor);
        if (!file) throw new RequestError(422, 'Choose the downloaded EPUB or PDF.');
        if (file.size > maxUpload) throw new RequestError(413, `Books must be ${maxUpload / 1024 ** 2} MiB or smaller.`);
        updateDetails(job, details);
        running = true;
        job.state = 'importing'; job.bytes = file.size; job.error = null;
        try { const task = () => importFile(job, temporary); await (scheduler ? scheduler.run(`archive:${id}`, task, { created: job.created, valid: () => !closed && job.state !== 'cancelled' }) : task()); }
        catch (error) { job.state = 'needs_action'; job.error = error instanceof RequestError ? error.message : 'The downloaded file could not be imported.'; persist(job); throw error; }
        finally { running = false; if (autoStart) void pump(); }
        return publicJob(job);
      } finally { if (temporary) await rm(temporary, { force: true }); }
    },
    retry(id, visitor) {
      const job = findJob(id, visitor); if (!job) throw new RequestError(404, 'Import not found.');
      if (!['error', 'retry_wait', 'needs_action'].includes(job.state)) throw new RequestError(409, 'This import is already queued or complete.');
      job.state = 'queued'; job.nextAttempt = null; job.error = null; persist(job); if (autoStart) void pump(); return publicJob(job);
    },
    cancel(id, visitor) {
      const job = findJob(id, visitor); if (!job) throw new RequestError(404, 'Import not found.');
      if (job.state === 'importing' || job.state === 'ready') throw new RequestError(409, 'This book is already being added or complete.');
      job.state = 'cancelled'; job.nextAttempt = null; job.error = null; persist(job); controllers.get(id)?.abort(); return publicJob(job);
    },
    close() { closed = true; clearInterval(timer); for (const controller of controllers.values()) controller.abort(); },
    job(id, visitor) {
      const job = findJob(id, visitor);
      if (!job) throw new RequestError(404, 'Import not found. The server may have restarted; check your library before retrying.');
      return publicJob(job);
    },
  };
}
