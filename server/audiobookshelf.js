import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RequestError } from './books.js';
import { maxAudioUpload } from './uploaded-audio.js';

const encode = encodeURIComponent;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameDestination = (a, b) => a?.libraryId === b?.libraryId && a?.folderId === b?.folderId;
const titleKey = (value) => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim() : '';
const identifier = (value) => typeof value === 'string' && /^[\w-]{1,120}$/u.test(value);
export function progressVersion(progress) { return progress ? hash([progress.lastUpdate, progress.currentTime, progress.duration, progress.isFinished]) : 'none'; }

export async function openAudiobookshelf(dir, { library, learning, demo = false, request = fetch, autoStart = true, now = Date.now }) {
  const settingsPath = join(dir, 'audiobookshelf-settings.json');
  let config = { baseUrl: '', apiKey: '', libraryId: '', folderId: '', categoryDestinations: {}, autoExport: true }, writing = Promise.resolve(), running = false, closed = false;
  if (!demo) { try { config = { ...config, ...JSON.parse(await readFile(settingsPath, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  const db = new DatabaseSync(join(dir, 'audiobookshelf.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS links(server TEXT NOT NULL,book TEXT NOT NULL,recording TEXT NOT NULL,item TEXT NOT NULL,PRIMARY KEY(server,book,recording)) STRICT;
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;`);
  const server = () => hash([config.baseUrl, config.apiKey]);
  const jobs = new Map(db.prepare('SELECT * FROM jobs ORDER BY rowid').all().map((row) => [row.id, JSON.parse(row.json)]));
  const persist = (job) => db.prepare('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id, JSON.stringify(job));
  for (const job of jobs.values()) if (job.state === 'running') { job.state = job.kind === 'export' ? job.phase === 'checking' ? 'queued' : 'needs_review' : 'error'; job.error = 'The server restarted during this transfer. Check the destination before retrying.'; persist(job); }
  const settings = () => ({ configurable: !demo, connected: !demo && Boolean(config.baseUrl && config.apiKey), baseUrl: config.baseUrl,
    hasKey: Boolean(config.apiKey), libraryId: config.libraryId, folderId: config.folderId, autoExport: config.autoExport !== false,
    categoryDestinations: structuredClone(config.categoryDestinations || {}) });
  function destinationFor(book, automatic = false) {
    const key = book.categoryId || 'uncategorized', mappings = config.categoryDestinations || {};
    const selected = Object.hasOwn(mappings, key) ? mappings[key] : automatic ? null : config;
    return { libraryId: selected?.libraryId, folderId: selected?.folderId };
  }
  const validDestination = (destination) => identifier(destination?.libraryId) && identifier(destination?.folderId);
  function refreshAutomaticDestination(job, book) {
    const destination = destinationFor(book, true);
    if (!validDestination(destination)) {
      job.state = 'cancelled'; job.notice = 'Automatic export waiting: map this book’s category to an Audiobookshelf library and folder in Settings → Devices.';
      return false;
    }
    if (!sameDestination(job.destination, destination) || job.categoryId !== (book.categoryId || 'uncategorized')) job.retryAt = null;
    job.destination = destination; job.categoryId = book.categoryId || 'uncategorized'; return true;
  }
  function automaticDestinationChanged(job) {
    if (!job.automatic) return false;
    const current = library.getBook(job.book);
    if (job.categoryId === (current.categoryId || 'uncategorized') && sameDestination(job.destination, destinationFor(current, true))) return false;
    job.state = 'cancelled'; job.notice = 'The book’s category changed before upload. Automatic export will use its current category mapping.';
    return true;
  }
  function mappings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 500) throw new RequestError(422, 'Choose valid Audiobookshelf destinations for your categories.');
    return Object.fromEntries(Object.entries(value).map(([category, destination]) => {
      if (!identifier(category) || !destination || !identifier(destination.libraryId) || !identifier(destination.folderId)) throw new RequestError(422, 'Each mapped category needs an Audiobookshelf library and folder.');
      return [category, { libraryId: destination.libraryId, folderId: destination.folderId }];
    }));
  }
  function originURL(path, current = config) {
    if (!current.baseUrl || !current.apiKey) throw new RequestError(422, 'Connect Audiobookshelf in Settings → Devices.');
    const base = new URL(current.baseUrl + '/');
    const relative = base.pathname !== '/' && path.startsWith(base.pathname) ? path.slice(base.pathname.length) : path.replace(/^\//u, '');
    const url = new URL(relative, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password) throw new RequestError(422, 'Audiobookshelf returned a file URL outside the configured server.');
    return url;
  }
  async function call(path, options = {}, current = config) {
    if (demo) throw new RequestError(403, 'Audiobookshelf connections are available on self-hosted installations.');
    let response;
    try { response = await request(originURL(path, current), { ...options, redirect: 'error',
      headers: { ...options.headers, Authorization: `Bearer ${current.apiKey}` }, signal: options.signal || AbortSignal.timeout(20000) }); }
    catch (error) { if (error instanceof RequestError) throw error; throw new RequestError(502, 'Could not reach Audiobookshelf. Check its URL, port and network connection.'); }
    if (!response.ok && !(options.allow404 && response.status === 404)) throw new RequestError(502, [401, 403].includes(response.status)
      ? 'Audiobookshelf rejected the API key or its permissions.' : `Audiobookshelf returned HTTP ${response.status}.`);
    return response;
  }
  async function json(path, options, current) { const response = await call(path, options, current); if (response.status === 404) return null; return response.json(); }
  function save(body) {
    const operation = writing.then(async () => {
      if (demo) throw new RequestError(403, 'Audiobookshelf is available on personal installations.');
      if (running) throw new RequestError(409, 'Wait for the Audiobookshelf transfer to finish before changing its connection.');
      if (typeof body.baseUrl !== 'string') throw new RequestError(422, 'Enter your Audiobookshelf server URL, including its port when needed.');
      let url;
      try { url = new URL(body.baseUrl); } catch { throw new RequestError(422, 'Enter a valid Audiobookshelf HTTP or HTTPS URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new RequestError(422, 'Use a server URL without embedded credentials, a query or a fragment.');
      const apiKey = body.clearKey ? '' : typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : config.apiKey;
      if (apiKey.length > 4096 || /[\s\x00-\x1f]/u.test(apiKey)) throw new RequestError(422, 'Enter a valid Audiobookshelf API key.');
      for (const key of ['libraryId', 'folderId']) if (body[key] && !identifier(body[key])) throw new RequestError(422, 'Choose a valid Audiobookshelf library and folder.');
      const baseUrl = url.href.replace(/\/+$/u, '');
      const categoryDestinations = mappings(body.categoryDestinations === undefined
        ? baseUrl === config.baseUrl ? config.categoryDestinations || {} : {} : body.categoryDestinations);
      if (body.autoExport !== undefined && typeof body.autoExport !== 'boolean') throw new RequestError(422, 'Choose whether to export audiobooks automatically.');
      const next = { baseUrl, apiKey, libraryId: body.libraryId || '', folderId: body.folderId || '', categoryDestinations, autoExport: body.autoExport ?? config.autoExport };
      if (Boolean(next.libraryId) !== Boolean(next.folderId)) throw new RequestError(422, 'Choose both a default export library and folder, or leave both empty.');
      if (apiKey) {
        const remote = await json('/api/libraries', {}, next);
        const destinations = [...Object.values(categoryDestinations), ...(next.libraryId ? [next] : [])];
        for (const destination of destinations) {
          const target = (remote.libraries || []).find((item) => item.id === destination.libraryId && item.mediaType === 'book');
          if (!target?.folders?.some((folder) => folder.id === destination.folderId)) throw new RequestError(422, 'An export folder is no longer available in its selected Audiobookshelf library. Choose another destination.');
        }
      }
      const temp = `${settingsPath}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); await rename(temp, settingsPath); config = next; }
      finally { await rm(temp, { force: true }); }
      for (const job of jobs.values()) if (job.automatic && job.state === 'queued') {
        let destination; try { destination = destinationFor(library.getBook(job.book), true); } catch {}
        if (!config.autoExport || job.server !== server() || !sameDestination(job.destination, destination)) {
          job.state = 'cancelled'; job.notice = 'Automatic export settings changed. The current destination will be used for pending audio.'; persist(job);
        }
      }
      if (autoStart) queueMicrotask(() => void pump());
      return settings();
    });
    writing = operation.catch(() => {}); return operation;
  }
  async function libraries() { const result = await json('/api/libraries'); return { libraries: (result.libraries || []).filter((item) => item.mediaType === 'book') }; }
  async function items(libraryId, page = 0) {
    if (!identifier(libraryId) || !Number.isInteger(page) || page < 0 || page > 10000) throw new RequestError(422, 'Choose a library and a valid page.');
    const result = await json(`/api/libraries/${encode(libraryId)}/items?limit=100&page=${page}&sort=media.metadata.title`);
    return { total: result.total, page, results: (result.results || []).map((item) => ({ id: item.id, title: item.media?.metadata?.title || 'Untitled', author: item.media?.metadata?.authorName || '', duration: item.media?.duration })) };
  }
  function link(book, recording, item) {
    db.prepare('INSERT INTO links VALUES(?,?,?,?) ON CONFLICT(server,book,recording) DO UPDATE SET item=excluded.item').run(server(), book.id, recording, item);
  }
  const getLink = (book, recording) => db.prepare('SELECT item FROM links WHERE server=? AND book=? AND recording=?').get(server(), book.id, recording)?.item;
  function recordingFor(book, selected) {
    const recording = learning.narration(book, selected).audio;
    if (recording.state !== 'ready' || selected && recording.id !== selected) throw new RequestError(409, 'Choose a complete, synced recording first.');
    return recording;
  }
  async function attach(book, body) {
    if (!identifier(body.item)) throw new RequestError(422, 'Choose an Audiobookshelf title.');
    const recording = recordingFor(book, body.recording), item = await json(`/api/items/${encode(body.item)}?expanded=1`);
    const duration = item.media?.duration;
    if (item.mediaType !== 'book' || !Number.isFinite(duration) || Math.abs(duration - recording.duration) > Math.max(2, duration * .001)) throw new RequestError(422, 'These recording durations differ. Import the matching Audiobookshelf audio and sync it with this book first.');
    if (body.sameRecording !== true) throw new RequestError(422, 'Confirm that both apps use the same recording before linking timestamps.');
    link(book, recording.id, item.id); return { linked: true, item: item.id, recording: recording.id };
  }
  async function remote(book, selected) {
    const recording = recordingFor(book, selected), item = getLink(book, recording.id);
    if (!item) return { linked: false, recording: recording.id };
    const value = await json(`/api/me/progress/${encode(item)}`, { allow404: true });
    return { linked: true, recording: recording.id, item, version: progressVersion(value), currentTime: Math.min(recording.duration, Math.max(0, Number(value?.currentTime) || 0)),
      updated: value?.lastUpdate || 0, duration: recording.duration };
  }
  const locks = new Map();
  async function push(book, body) {
    const key = `${book.id}:${body.recording}`, previous = locks.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const state = await remote(book, body.recording);
      if (!state.linked) throw new RequestError(409, 'Link this recording to Audiobookshelf first.');
      if (typeof body.baseVersion !== 'string' || !Number.isFinite(body.currentTime) || body.currentTime < 0 || body.currentTime > state.duration + .5) throw new RequestError(422, 'Choose a valid recording position.');
      if (body.baseVersion !== state.version) return { conflict: true, ...state };
      const time = Math.min(state.duration, body.currentTime);
      await call(`/api/me/progress/${encode(state.item)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentTime: time, duration: state.duration,
        progress: time / state.duration, isFinished: time >= state.duration - .5 }) });
      return remote(book, body.recording);
    });
    locks.set(key, operation); try { return await operation; } finally { if (locks.get(key) === operation) locks.delete(key); }
  }
  async function download(path, destination, budget) {
    const response = await call(path, { signal: AbortSignal.timeout(1800000) });
    if (Number(response.headers.get('content-length')) > budget.remaining) throw new RequestError(413, 'Audiobookshelf audio exceeds the 1 GiB recording limit.');
    const meter = new Transform({ transform(chunk, _encoding, callback) { budget.remaining -= chunk.length; callback(budget.remaining < 0 ? new RequestError(413, 'Audiobookshelf audio exceeds 1 GiB.') : null, chunk); } });
    await pipeline(response.body, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    return (await stat(destination)).size;
  }
  async function runImport(job, book) {
    const item = await json(`/api/items/${encode(job.item)}?expanded=1`), tracks = item.media?.tracks;
    if (item.mediaType !== 'book' || !Array.isArray(tracks) || !tracks.length || tracks.length > 200) throw new RequestError(422, 'Choose an audiobook with 1 to 200 audio tracks.');
    const files = [], cleanup = [], budget = { remaining: maxAudioUpload };
    try {
      for (const [index, track] of tracks.slice().sort((a, b) => a.index - b.index).entries()) {
        if (typeof track.contentUrl !== 'string') throw new RequestError(422, 'Audiobookshelf did not return a usable audio file URL.');
        const path = join(library.uploads, `abs-${job.id}-${index}.part`); cleanup.push(path);
        const size = await download(track.contentUrl, path, budget);
        const originalname = basename(track.metadata?.filename || track.title || `Chapter ${index + 1}.mp3`);
        files.push({ path, originalname, size, mimetype: track.mimeType || 'audio/mpeg' });
      }
      learning.ensure(book);
      const body = { name: item.media.metadata?.title || book.title };
      const recording = files.length === 1 ? await learning.recordings.accept(book, files[0], body) : await learning.recordings.acceptChapters(book, files, body);
      job.recording = recording.id; link(book, recording.id, item.id);
      job.state = 'syncing'; job.notice = 'Audio imported. Preparing and aligning it with your book automatically…';
    } finally { await Promise.all(cleanup.map((path) => rm(path, { force: true }))); }
  }
  async function matchingTitle(book, destination) {
    const title = titleKey(book.title);
    if (!title) throw new RequestError(422, 'Add a title before exporting this audiobook.');
    const signal = AbortSignal.timeout(120000), catalog = await json('/api/libraries', { signal });
    if (!Array.isArray(catalog?.libraries)) throw new RequestError(502, 'Audiobookshelf did not return its libraries. The duplicate check will retry.');
    const selected = catalog.libraries.find((item) => item.id === destination.libraryId && item.mediaType === 'book');
    if (!selected?.folders?.some((folder) => folder.id === destination.folderId)) throw new RequestError(422, 'The selected export folder is unavailable in its Audiobookshelf library. Choose another destination; the default folder will not be used.');
    for (const library of catalog.libraries.filter((item) => item.mediaType === 'book')) {
      if (!identifier(library.id)) throw new RequestError(502, 'Audiobookshelf returned an invalid library.');
      let seen = 0;
      for (let page = 0; ; page++) {
        const result = await json(`/api/libraries/${encode(library.id)}/items?limit=500&page=${page}&minified=1&sort=media.metadata.title`, { signal });
        if (!Array.isArray(result?.results) || !Number.isSafeInteger(result.total) || result.total < seen + result.results.length || (!result.results.length && seen < result.total)) {
          throw new RequestError(502, 'Audiobookshelf returned an incomplete catalog. Export is waiting until duplicate checking succeeds.');
        }
        const match = result.results.find((item) => titleKey(item.media?.metadata?.title) === title);
        if (match) return { item: match.id, library: library.id };
        seen += result.results.length;
        if (seen >= result.total) break;
        signal.throwIfAborted();
      }
    }
    return null;
  }
  function enqueueAutomatic() {
    if (demo || config.autoExport === false || !config.baseUrl || !config.apiKey) return;
    for (const candidate of learning.readyAudiobooks?.() || []) {
      if ([...jobs.values()].filter((job) => ['queued', 'running'].includes(job.state)).length >= 5) break;
      try {
        const book = library.getBook(candidate.book), destination = destinationFor(book, true);
        if (!identifier(destination.libraryId) || !identifier(destination.folderId) || getLink(book, candidate.recording)) continue;
        const handled = [...jobs.values()].some((job) => job.server === server() && job.kind === 'export' && job.state !== 'cancelled'
          && job.book === candidate.book && job.recording === candidate.recording
          && (job.state !== 'error' || sameDestination(job.destination, destination) && job.titleKey === titleKey(book.title)));
        if (handled) continue;
        queue(book, 'export', { recording: candidate.recording }, true);
      } catch { /* A removed/stale recording or an in-progress import is checked on the next pass. */ }
    }
  }
  async function runExport(job, book) {
    const recording = recordingFor(book, job.recording), data = new FormData();
    job.titleKey = titleKey(book.title); job.phase = 'checking'; persist(job);
    const match = await matchingTitle(book, job.destination || destinationFor(book));
    if (automaticDestinationChanged(job)) return;
    if (match) {
      job.state = 'skipped'; job.item = match.item; job.matchLibrary = match.library;
      job.notice = 'Skipped export: a matching title already exists in Audiobookshelf. Its files and listening position were left unchanged.';
      return;
    }
    const previous = [...jobs.values()].find((entry) => entry.id !== job.id && entry.server === job.server && entry.kind === 'export'
      && entry.titleKey === job.titleKey && (entry.state === 'exported' || job.automatic && entry.state === 'needs_review'));
    if (previous) {
      job.state = previous.state === 'exported' ? 'skipped' : 'needs_review';
      job.notice = previous.state === 'exported' ? 'Skipped export: this title was already uploaded by Langy. Audiobookshelf may still be indexing it.'
        : 'A previous upload of this title was interrupted. Check Audiobookshelf before exporting again.';
      return;
    }
    const destination = job.destination || destinationFor(book);
    for (const [key, value] of Object.entries({ title: book.title, author: book.author, library: destination.libraryId, folder: destination.folderId })) data.set(key, value);
    const audioPath = learning.audioFile(book, recording.id);
    data.set('audio', await openAsBlob(audioPath, { type: 'audio/mpeg' }), `langy-${recording.id}.mp3`);
    data.set('ebook', await openAsBlob(library.filePath(book)), `langy-${book.id}.${book.format}`);
    if (book.thumbnailType) data.set('cover', await openAsBlob(library.coverPath(book), { type: book.thumbnailType }), `cover${({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' })[book.thumbnailType] || '.jpg'}`);
    // The MP3 already contains chapter metadata; metadata.json also retains it for ABS.
    data.set('metadata', new Blob([JSON.stringify({ title: book.title, authors: book.author ? [book.author] : [], language: book.language,
      chapters: (recording.markers || []).map((marker, index, all) => ({ id: index, start: marker.time, end: all[index + 1]?.time ?? recording.duration, title: marker.title })) })], { type: 'application/json' }), 'metadata.json');
    if (automaticDestinationChanged(job)) return;
    job.phase = 'uploading'; persist(job);
    await call('/api/upload', { method: 'POST', body: data, signal: AbortSignal.timeout(1800000) });
    job.state = 'exported'; job.exportedAt = now(); job.notice = 'Exported. Let Audiobookshelf scan the new files, then select its title and link the matching recording below.';
  }
  async function pump() {
    if (running || closed || demo) return;
    running = true;
    try {
      enqueueAutomatic();
      for (const job of jobs.values()) {
        if (!['queued', 'syncing'].includes(job.state) || closed) continue;
        try {
          if (job.server !== server()) { job.state = 'cancelled'; job.notice = 'The Audiobookshelf connection changed.'; continue; }
          if (job.automatic && config.autoExport === false) { job.state = 'cancelled'; job.notice = 'Automatic export disabled.'; continue; }
          if (job.automatic && !refreshAutomaticDestination(job, library.getBook(job.book))) continue;
          if (job.retryAt > now()) continue;
          if (job.state === 'syncing') {
            const book = library.getBook(job.book), recording = learning.recordings.list(book).find((item) => item.id === job.recording);
            if (!recording) throw new RequestError(404, 'The imported recording was removed.');
            if (recording.state === 'error') throw new RequestError(422, recording.error || 'Audio alignment failed.');
            if (recording.state === 'ready') { job.state = 'ready'; job.notice = 'Audio imported, aligned and linked to Audiobookshelf.'; }
            else if (recording.state === 'uploaded' && learning.info(book).state === 'ready') learning.recordings.queue(book, recording.id);
            continue;
          }
          job.state = 'running'; job.error = null; job.phase = 'checking'; job.retryAt = null; persist(job);
          const book = library.getBook(job.book);
          if (job.kind === 'export') await runExport(job, book); else await runImport(job, book);
        } catch (error) {
          job.error = error instanceof RequestError ? error.message : 'Audiobookshelf transfer failed. Check the connection and retry.';
          if (job.kind === 'export' && job.phase === 'uploading') {
            job.state = 'needs_review'; job.error = 'The upload outcome could not be confirmed. Check Audiobookshelf before retrying to avoid a duplicate.';
          } else if (job.automatic && (!(error instanceof RequestError) || error.status >= 500)) {
            job.state = 'queued'; job.attempts = (job.attempts || 0) + 1;
            job.retryAt = now() + Math.min(300000, 15000 * 2 ** Math.min(5, job.attempts - 1));
          } else job.state = 'error';
        } finally { persist(job); }
      }
    } finally { running = false; if (closed) db.close(); }
  }
  function queue(book, kind, body, automatic = false) {
    if (demo) throw new RequestError(403, 'Audiobookshelf requires your personal installation.');
    originURL('/api/libraries');
    if (body.recording != null && body.recording !== '' && !identifier(body.recording)) throw new RequestError(422, 'Choose a valid recording.');
    let selected = body.recording || null, destination;
    if (kind === 'export') {
      destination = automatic ? destinationFor(book, true) : body.destination === undefined ? destinationFor(book) : body.destination;
      if (!destination || !identifier(destination.libraryId) || !identifier(destination.folderId)) throw new RequestError(422, 'Choose a default export destination or map this category in Settings → Devices → Audiobookshelf.');
      destination = { libraryId: destination.libraryId, folderId: destination.folderId };
      selected = recordingFor(book, body.recording).id;
    } else if (!identifier(body.item)) throw new RequestError(422, 'Choose an Audiobookshelf title.');
    const existing = [...jobs.values()].find((job) => job.book === book.id && ['queued', 'running', 'syncing'].includes(job.state));
    if (existing) {
      const different = kind !== existing.kind || destination && !sameDestination(destination, existing.destination);
      if (different && !automatic && existing.automatic && existing.state === 'queued') { existing.state = 'cancelled'; existing.notice = 'Replaced by the selected manual export destination.'; persist(existing); }
      else if (different && !automatic) throw new RequestError(409, 'A transfer for this book is already in progress. Wait for it to finish before choosing a different destination.');
      else return publicJob(existing);
    }
    if ([...jobs.values()].filter((job) => ['queued', 'running'].includes(job.state)).length >= 5) throw new RequestError(409, 'Five transfers are already queued.');
    const job = { id: randomUUID(), book: book.id, server: server(), kind, item: body.item, recording: selected, state: 'queued', ...(automatic ? { automatic: true, categoryId: book.categoryId || 'uncategorized' } : {}), ...(destination ? { destination, titleKey: titleKey(book.title) } : {}) };
    jobs.set(job.id, job); persist(job); if (autoStart) void pump(); return publicJob(job);
  }
  function publicJob({ server: _server, ...job }) { return job; }
  const timer = autoStart && !demo ? setInterval(() => void pump(), 3000) : null; timer?.unref();
  if (autoStart) void pump();
  return { settings, save, libraries, items, attach, remote, push, queue, pump,
    status: (book) => ({ ...settings(), destination: destinationFor(book),
      automaticExportNotice: config.autoExport !== false && !validDestination(destinationFor(book, true)) ? 'Automatic export waiting: map this book’s category to an Audiobookshelf library and folder in Settings → Devices.' : '',
      jobs: [...jobs.values()].filter((job) => job.book === book.id && job.server === server()).slice(-10).map(publicJob) }),
    close() { if (closed) return; closed = true; clearInterval(timer); if (!running) db.close(); } };
}
