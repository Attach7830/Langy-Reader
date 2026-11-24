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
const identifier = (value) => typeof value === 'string' && /^[\w-]{1,120}$/u.test(value);
export function progressVersion(progress) { return progress ? hash([progress.lastUpdate, progress.currentTime, progress.duration, progress.isFinished]) : 'none'; }

export async function openAudiobookshelf(dir, { library, learning, demo = false, request = fetch, autoStart = true }) {
  const settingsPath = join(dir, 'audiobookshelf-settings.json');
  let config = { baseUrl: '', apiKey: '', libraryId: '', folderId: '' }, writing = Promise.resolve(), running = false, closed = false;
  if (!demo) { try { config = { ...config, ...JSON.parse(await readFile(settingsPath, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  const db = new DatabaseSync(join(dir, 'audiobookshelf.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS links(server TEXT NOT NULL,book TEXT NOT NULL,recording TEXT NOT NULL,item TEXT NOT NULL,PRIMARY KEY(server,book,recording)) STRICT;
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;`);
  const server = () => hash([config.baseUrl, config.apiKey]);
  const jobs = new Map(db.prepare('SELECT * FROM jobs ORDER BY rowid').all().map((row) => [row.id, JSON.parse(row.json)]));
  const persist = (job) => db.prepare('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id, JSON.stringify(job));
  for (const job of jobs.values()) if (job.state === 'running') { job.state = job.kind === 'export' ? 'needs_review' : 'error'; job.error = 'The server restarted during this transfer. Check the destination before retrying.'; persist(job); }
  const settings = () => ({ configurable: !demo, connected: !demo && Boolean(config.baseUrl && config.apiKey), baseUrl: config.baseUrl,
    hasKey: Boolean(config.apiKey), libraryId: config.libraryId, folderId: config.folderId });
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
      const next = { baseUrl: url.href.replace(/\/+$/u, ''), apiKey, libraryId: body.libraryId || '', folderId: body.folderId || '' };
      if (apiKey) await json('/api/libraries', {}, next);
      const temp = `${settingsPath}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); await rename(temp, settingsPath); config = next; }
      finally { await rm(temp, { force: true }); }
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
  async function runExport(job, book) {
    const recording = recordingFor(book, job.recording), data = new FormData();
    for (const [key, value] of Object.entries({ title: book.title, author: book.author, library: config.libraryId, folder: config.folderId })) data.set(key, value);
    const audioPath = learning.audioFile(book, recording.id);
    data.set('audio', await openAsBlob(audioPath, { type: 'audio/mpeg' }), `langy-${recording.id}.mp3`);
    data.set('ebook', await openAsBlob(library.filePath(book)), `langy-${book.id}.${book.format}`);
    if (book.thumbnailType) data.set('cover', await openAsBlob(library.coverPath(book), { type: book.thumbnailType }), `cover${({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' })[book.thumbnailType] || '.jpg'}`);
    // The MP3 already contains chapter metadata; metadata.json also retains it for ABS.
    data.set('metadata', new Blob([JSON.stringify({ title: book.title, authors: book.author ? [book.author] : [], language: book.language,
      chapters: (recording.markers || []).map((marker, index, all) => ({ id: index, start: marker.time, end: all[index + 1]?.time ?? recording.duration, title: marker.title })) })], { type: 'application/json' }), 'metadata.json');
    await call('/api/upload', { method: 'POST', body: data, signal: AbortSignal.timeout(1800000) });
    job.state = 'exported'; job.notice = 'Exported. Let Audiobookshelf scan the new files, then select its title and link the matching recording below.';
  }
  async function pump() {
    if (running || closed || demo) return; running = true;
    try { for (const job of jobs.values()) {
      if (!['queued', 'syncing'].includes(job.state) || closed) continue;
      try {
        if (job.server !== server()) throw new RequestError(409, 'The Audiobookshelf connection changed. Retry this transfer.');
        if (job.state === 'syncing') {
          const book = library.getBook(job.book), recording = learning.recordings.list(book).find((item) => item.id === job.recording);
          if (!recording) throw new RequestError(404, 'The imported recording was removed.');
          if (recording.state === 'error') throw new RequestError(422, recording.error || 'Audio alignment failed.');
          if (recording.state === 'ready') { job.state = 'ready'; job.notice = 'Audio imported, aligned and linked to Audiobookshelf.'; }
          else if (recording.state === 'uploaded' && learning.info(book).state === 'ready') learning.recordings.queue(book, recording.id);
          continue;
        }
        job.state = 'running'; job.error = null; persist(job);
        const book = library.getBook(job.book);
        if (job.kind === 'export') await runExport(job, book); else await runImport(job, book);
      } catch (error) { job.state = 'error'; job.error = error instanceof RequestError ? error.message : 'Audiobookshelf transfer failed. Check the connection and retry.'; }
      finally { persist(job); }
    } } finally { running = false; }
  }
  function queue(book, kind, body) {
    if (demo) throw new RequestError(403, 'Audiobookshelf requires your personal installation.');
    originURL('/api/libraries');
    if (body.recording != null && body.recording !== '' && !identifier(body.recording)) throw new RequestError(422, 'Choose a valid recording.');
    let selected = body.recording || null;
    if (kind === 'export') {
      if (!identifier(config.libraryId) || !identifier(config.folderId)) throw new RequestError(422, 'Choose the destination ABS library and folder in Settings → Devices.');
      selected = recordingFor(book, body.recording).id;
    } else if (!identifier(body.item)) throw new RequestError(422, 'Choose an Audiobookshelf title.');
    const existing = [...jobs.values()].find((job) => job.book === book.id && ['queued', 'running', 'syncing'].includes(job.state));
    if (existing) return publicJob(existing);
    if ([...jobs.values()].filter((job) => ['queued', 'running'].includes(job.state)).length >= 5) throw new RequestError(409, 'Five transfers are already queued.');
    const job = { id: randomUUID(), book: book.id, server: server(), kind, item: body.item, recording: selected, state: 'queued' };
    jobs.set(job.id, job); persist(job); if (autoStart) void pump(); return publicJob(job);
  }
  function publicJob({ server: _server, ...job }) { return job; }
  const timer = autoStart && !demo ? setInterval(() => void pump(), 3000) : null; timer?.unref();
  if (autoStart) void pump();
  return { settings, save, libraries, items, attach, remote, push, queue, pump,
    status: (book) => ({ ...settings(), jobs: [...jobs.values()].filter((job) => job.book === book.id && job.server === server()).slice(-10).map(publicJob) }),
    close() { closed = true; clearInterval(timer); if (!running) db.close(); } };
}
