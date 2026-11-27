import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { publicDownload, downloadURL } from './public-download.js';
import { chapterByteLimit, chapterFileLimit } from './chapter-audio.js';
import { RequestError } from './books.js';
import { PROCESS_YIELD } from './process-scheduler.js';

export function ivooxEpisode(value) {
  let url; try { url = new URL(String(value).trim()); } catch { /* Validate below. */ }
  const match = url && /(?:_rf_|\/(?:rf|audio)\/)([1-9]\d{0,11})(?:_|\/|$)/u.exec(url.pathname);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
    || !/^(?:(?:www|go|[a-z]{2})\.)?ivoox\.com$/u.test(url.hostname) || !match || url.href.length > 2000) {
    throw new RequestError(422, 'Paste an HTTPS iVoox episode link. For a series, paste its episode links in chapter order, one per line.');
  }
  url.search = ''; url.hash = '';
  return { id: match[1], url: url.href };
}

// Split only at structural commas, respecting quoted strings. Nuxt state is
// treated as data: no eval, VM, browser, or remote script execution is involved.
function fields(text) {
  const result = []; let start = 0, depth = 0, quote = '', escape = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) { if (escape) escape = false; else if (char === '\\') escape = true; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if ('{[('.includes(char)) depth++;
    else if ('}])'.includes(char)) depth--;
    else if (char === ',' && !depth) { result.push(text.slice(start, i)); start = i + 1; }
  }
  result.push(text.slice(start)); return result;
}
function objectAt(text, start) {
  let depth = 0, quote = '', escape = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) { if (escape) escape = false; else if (char === '\\') escape = true; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && !--depth) return text.slice(start + 1, i);
  }
  return '';
}
export function ivooxPage(html, episode) {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu)) {
    const script = match[1];
    if (!script.includes('window.__NUXT__=')) continue;
    const parameters = /\(function\(([\w$,\s]+)\)/u.exec(script)?.[1]?.split(',').map((part) => part.trim());
    const call = script.lastIndexOf('}('), end = script.lastIndexOf('))');
    if (!parameters || call < 0 || end < call) continue;
    const bindings = new Map();
    fields(script.slice(call + 2, end)).forEach((value, index) => {
      try { bindings.set(parameters[index], JSON.parse(value.trim())); } catch { /* Objects/functions are never evaluated. */ }
    });
    const resolve = (value) => {
      value = value?.trim();
      if (bindings.has(value)) return bindings.get(value);
      try { return JSON.parse(value); } catch { return undefined; }
    };
    for (const audio of script.matchAll(/\baudio\s*:\s*\{/gu)) {
      const props = new Map(fields(objectAt(script, audio.index + audio[0].lastIndexOf('{'))).map((field) => {
        const colon = field.indexOf(':'); return [field.slice(0, colon).trim(), field.slice(colon + 1)];
      }));
      if (String(resolve(props.get('id'))) !== episode.id) continue;
      if (['audioPaid', 'hidden', 'isSample'].some((key) => Boolean(resolve(props.get(key))))) {
        throw new RequestError(422, 'This iVoox episode is restricted or a preview. Import requires a publicly downloadable full recording.');
      }
      const download = resolve(props.get('downloadUrl'));
      if (typeof download !== 'string' || !download) break;
      return { title: String(resolve(props.get('title')) || 'iVoox recording').slice(0, 120),
        url: downloadURL(new URL(download, episode.url)).href };
    }
  }
  throw new RequestError(422, 'iVoox did not expose a public download for this episode. Upload an audio file you have downloaded, or try another episode link.');
}
async function episodeDownload(episode, request, signal) {
  const response = await request(episode.url, { signal });
  if (response.statusCode !== 200) { response.destroy(); throw new RequestError(502, 'iVoox could not open this episode. Check its link and availability.'); }
  const chunks = []; let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 ** 2) { response.destroy(); throw new RequestError(502, 'The iVoox page is too large to read.'); }
    chunks.push(chunk);
  }
  return ivooxPage(Buffer.concat(chunks).toString('utf8'), episode);
}
export async function openIvoox({ db, folder, library, recordings, request = publicDownload, scheduler }) {
  db.exec(`CREATE TABLE IF NOT EXISTS ivoox_imports(
    id TEXT PRIMARY KEY, book TEXT NOT NULL REFERENCES analyses(book) ON DELETE CASCADE,
    episodes TEXT NOT NULL, state TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0, recording TEXT, error TEXT, created INTEGER NOT NULL
  ) STRICT;
  UPDATE ivoox_imports SET state='error',error='Import interrupted by a restart. Try importing again.' WHERE state IN ('queued','downloading','importing');`);
  for (const job of db.prepare('SELECT id FROM ivoox_imports').all()) await rm(join(folder, `ivoox-${job.id}`), { recursive: true, force: true });
  const active = new Map(), checkpoints = new Map();
  const publicJob = (job) => job ? { id: job.id, state: job.state, bytes: job.bytes, completed: job.completed,
    total: JSON.parse(job.episodes).length, recording: job.recording, error: job.error } : null;
  const latest = (book) => publicJob(db.prepare('SELECT * FROM ivoox_imports WHERE book=? ORDER BY created DESC,rowid DESC LIMIT 1').get(book.id));
  async function execute(job, episodes) {
    const stage = join(folder, `ivoox-${job.id}`), saved = checkpoints.get(job.id), files = saved?.files || [], control = active.get(job.id);
    const signal = AbortSignal.any([control.signal, AbortSignal.timeout(3600000)]);
    let bytes = saved?.bytes || 0, yielded = false;
    try {
      await mkdir(stage, { recursive: true });
      for (const [index, episode] of episodes.entries()) {
        if (index < files.length) continue;
        const info = await episodeDownload(episode, request, signal);
        const audio = await request(info.url, { signal });
        if (audio.statusCode !== 200 || /(?:text\/|json|xml)/iu.test(String(audio.headers['content-type'] || ''))) {
          audio.destroy(); throw new RequestError(422, 'iVoox did not supply a downloadable audio file for this episode.');
        }
        if (Number(audio.headers['content-length']) > chapterByteLimit - bytes) { audio.destroy(); throw new RequestError(413, 'The imported audiobook must total 1 GiB or less.'); }
        const path = join(stage, String(index)); let size = 0, lastUpdate = 0;
        const meter = new Transform({ transform(chunk, _encoding, callback) {
          size += chunk.length; bytes += chunk.length;
          if (bytes > chapterByteLimit) return callback(new RequestError(413, 'The imported audiobook must total 1 GiB or less.'));
          if (bytes - lastUpdate >= 256 * 1024) { db.prepare('UPDATE ivoox_imports SET bytes=? WHERE id=?').run(bytes, job.id); lastUpdate = bytes; }
          callback(null, chunk);
        } });
        await pipeline(audio, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
        const type = String(audio.headers['content-type'] || '').split(';')[0].toLowerCase();
        const extension = ({ 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/aac': 'aac' })[type] || 'mp3';
        files.push({ path, size, originalname: `${info.title.replace(/[\p{Cc}/\\]/gu, '_')}.${extension}` });
        db.prepare('UPDATE ivoox_imports SET completed=?,bytes=? WHERE id=?').run(index + 1, bytes, job.id);
        signal.throwIfAborted();
        if (scheduler?.shouldYield()) {
          checkpoints.set(job.id, { files, bytes }); yielded = true;
          db.prepare("UPDATE ivoox_imports SET state='queued' WHERE id=?").run(job.id);
          return PROCESS_YIELD;
        }
      }
      signal.throwIfAborted();
      const book = library.getBook(job.book);
      db.prepare("UPDATE ivoox_imports SET state='importing' WHERE id=?").run(job.id);
      // The common chapter importer validates every downloaded file with ffmpeg
      // before publishing a continuous recording. Multiple links retain order.
      const item = await recordings.acceptChapters(book, files, { name: job.name || (files.length === 1 ? files[0].originalname.replace(/\.[^.]+$/u, '') : `${book.title} · iVoox chapters`) });
      if (control.signal.aborted) { await recordings.remove(book, item.id); signal.throwIfAborted(); }
      db.prepare("UPDATE ivoox_imports SET state='ready',recording=? WHERE id=?").run(item.id, job.id);
    } catch (error) {
      db.prepare("UPDATE ivoox_imports SET state=?,error=? WHERE id=?").run(control.signal.aborted ? 'cancelled' : 'error',
        control.signal.aborted ? null : error instanceof RequestError ? error.message : 'iVoox import failed. Check the links and try again.', job.id);
    } finally { if (!yielded) { active.delete(job.id); checkpoints.delete(job.id); await rm(stage, { recursive: true, force: true }); } }
  }
  function queue(book, body = {}) {
    const links = typeof body.links === 'string' ? body.links.split(/\r?\n/u).map((link) => link.trim()).filter(Boolean) : [];
    if (!links.length || links.length > chapterFileLimit) throw new RequestError(422, `Paste 1–${chapterFileLimit} iVoox episode links in chapter order.`);
    const episodes = links.map(ivooxEpisode);
    if (new Set(episodes.map((episode) => episode.id)).size !== episodes.length) throw new RequestError(422, 'Remove duplicate episode links.');
    if (db.prepare("SELECT id FROM ivoox_imports WHERE book=? AND state IN ('queued','downloading','importing')").get(book.id)) throw new RequestError(409, 'Wait for the current iVoox import to finish, or cancel it first.');
    library.getBook(book.id);
    const id = randomUUID();
    const created = Date.now();
    db.prepare('INSERT INTO ivoox_imports(id,book,episodes,state,created) VALUES(?,?,?,?,?)')
      .run(id, book.id, JSON.stringify(episodes.map(({ id }) => id)), scheduler ? 'queued' : 'downloading', created);
    active.set(id, new AbortController());
    const task = async () => {
      db.prepare("UPDATE ivoox_imports SET state='downloading' WHERE id=?").run(id);
      return await execute({ id, book: book.id, name: typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '' }, episodes);
    };
    void (scheduler ? scheduler.run(`ivoox:${id}`, task, { created, valid: () => db.prepare("SELECT id FROM ivoox_imports WHERE id=? AND state='queued'").get(id) }) : task()).finally(async () => {
      active.delete(id); checkpoints.delete(id); await rm(join(folder, `ivoox-${id}`), { recursive: true, force: true });
    });
    return latest(book);
  }
  return { latest, queue,
    cancel(book) { for (const row of db.prepare("SELECT id FROM ivoox_imports WHERE book=? AND state IN ('queued','downloading','importing')").all(book.id)) {
      db.prepare("UPDATE ivoox_imports SET state='cancelled',error=NULL WHERE id=?").run(row.id); active.get(row.id)?.abort();
    } scheduler?.wake(true); },
  };
}
