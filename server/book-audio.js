import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RequestError } from './books.js';
import { hasUsableTimings } from './audio-timing.js';
import { narrationOptions, sectionLanguages } from './language-voices.js';

const run = promisify(execFile);
const pending = new Set(['queued', 'generating', 'aligning']);
const active = new Set(['queued', 'assembling']);
const digest = (rows) => createHash('sha256').update(JSON.stringify(rows.map(({ key, digest, markers }) => [key, digest, markers]))).digest('hex');
const escapeMetadata = (text) => String(text).replace(/[\r\n]/gu, ' ').replace(/[\\=;#]/gu, '\\$&');

export function bookNarration({ db, folder, library, demo, previewAudio = false, configuration, queuePart, wake }) {
  db.function('has_spoken_text', { deterministic: true }, (text) => Number(/[\p{L}\p{N}]/u.test(text)));
  db.exec(`CREATE TABLE IF NOT EXISTS book_audio (
    id TEXT PRIMARY KEY, book TEXT NOT NULL REFERENCES analyses(book) ON DELETE CASCADE,
    digest TEXT NOT NULL, options TEXT NOT NULL, state TEXT NOT NULL, parts TEXT NOT NULL,
    segments TEXT, markers TEXT, duration REAL, error TEXT, created INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS book_audio_book ON book_audio(book, created);
  UPDATE book_audio SET state='queued' WHERE state='assembling';`);
  for (const [name, definition] of [['kind', "TEXT NOT NULL DEFAULT 'generated'"], ['name', "TEXT NOT NULL DEFAULT ''"], ['quality', 'TEXT'], ['alignmentRevision', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!db.prepare('PRAGMA table_info(book_audio)').all().some((column) => column.name === name)) db.exec(`ALTER TABLE book_audio ADD COLUMN ${name} ${definition}`);
  }

  const hasLanguages = db.prepare('PRAGMA table_info(chapters)').all().some((column) => column.name === 'languages');
  const sections = (book) => db.prepare(`SELECT key,title,digest,markers,${hasLanguages ? 'languages' : "'[]' AS languages"},length(trim(text)) AS characters,has_spoken_text(text) AS narratable FROM chapters WHERE book=? ORDER BY ordinal`).all(book.id);
  const newest = (book) => db.prepare("SELECT * FROM book_audio WHERE book=? AND kind='generated' ORDER BY created DESC,rowid DESC LIMIT 1").get(book.id);

  function publicRecording(row) {
    if (!row) return { state: 'missing' };
    const parts = JSON.parse(row.parts);
    const complete = parts.filter(({ id }) => db.prepare("SELECT id FROM audio WHERE id=? AND state='ready'").get(id)).length;
    const segments = row.state === 'ready' ? JSON.parse(row.segments) : [];
    return {
      id: row.id, state: row.state, error: row.error, complete, total: parts.length, duration: row.duration,
      kind: row.kind, name: row.name, quality: row.quality ? JSON.parse(row.quality) : null, alignmentRevision: row.alignmentRevision,
      ...(row.state === 'ready' ? {
        url: `/api/books/${row.book}/audio/${row.id}`,
        segments, markers: JSON.parse(row.markers), approximateSections: segments.filter((part) => part.approximate).length,
      } : {}),
    };
  }

  function status(book, selected) {
    const latest = () => db.prepare('SELECT * FROM book_audio WHERE book=? ORDER BY created DESC,rowid DESC LIMIT 1').get(book.id);
    const row = selected ? db.prepare("SELECT * FROM book_audio WHERE book=? AND id=? AND state='ready'").get(book.id, selected) || latest() : latest();
    const current = sections(book);
    return { connected: Boolean(configuration().baseUrl), previewAudio, audio: publicRecording(row && row.digest === digest(current) ? row : null) };
  }

  function queue(book, replace = false) {
    if (previewAudio) throw new RequestError(422, 'Narration is not connected in this demo. Connect Kokoro on your self-hosted installation.');
    const analysis = db.prepare('SELECT state FROM analyses WHERE book=?').get(book.id);
    if (analysis?.state !== 'ready') throw new RequestError(409, 'Wait for the book analysis to finish, then generate audio.');
    const all = sections(book);
    const readable = all.filter(({ narratable }) => narratable);
    if (!readable.length) throw new RequestError(422, 'This book has no selectable text for narration.');
    if (demo && readable.some(({ characters }) => characters > 20000)) {
      throw new RequestError(422, 'Demo narration supports sections of up to 20,000 characters.');
    }
    const current = newest(book);
    const config = configuration();
    const options = JSON.stringify(narrationOptions(config, sectionLanguages(all, book.language)));
    const sourceHash = digest(all);
    if (current && current.digest === sourceHash && active.has(current.state)) return publicRecording(current);
    if (!replace && current?.state === 'ready' && current.digest === sourceHash && current.options === options) return publicRecording(current);
    if (!config.baseUrl) throw new RequestError(422, 'Connect a Kokoro server in Settings → Narration.');
    const parts = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const section of readable) {
        const part = queuePart(book, section.key, replace);
        parts.push({ key: section.key, id: part.id, digest: section.digest });
      }
      db.prepare('INSERT INTO book_audio(id,book,digest,options,state,parts,created) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), book.id, sourceHash, options, 'queued', JSON.stringify(parts), Date.now());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    wake();
    return publicRecording(newest(book));
  }

  function segment(book, key, recording) {
    const row = db.prepare("SELECT * FROM book_audio WHERE id=? AND book=? AND state='ready'").get(recording, book.id);
    if (!row) throw new RequestError(404, 'The complete book recording was not found.');
    return JSON.parse(row.segments).find((part) => part.key === key);
  }

  async function assemble(job) {
    const owner = db.prepare('SELECT owner FROM analyses WHERE book=?').get(job.book)?.owner;
    const book = library.getBook(job.book, { id: owner });
    const all = sections(book);
    if (digest(all) !== job.digest) throw new RequestError(409, 'The book text changed. Generate book audio again.');
    const parts = JSON.parse(job.parts).map((part) => {
      const row = db.prepare('SELECT * FROM audio WHERE id=? AND book=?').get(part.id, job.book);
      if (!row || row.digest !== part.digest || row.options !== job.options || !['ready', ...pending].includes(row.state)) {
        throw new RequestError(502, row?.error || 'A section could not be narrated. Retry book audio to resume.');
      }
      return row;
    });
    if (parts.some((part) => part.state !== 'ready')) return;
    db.prepare("UPDATE book_audio SET state='assembling',error=NULL WHERE id=? AND state='queued'").run(job.id);
    const temporary = join(folder, `book-${job.id}`);
    await mkdir(temporary, { recursive: true });
    const pcm = join(temporary, 'book.pcm');
    const segments = [], markers = [];
    const hasMarkers = all.some((section) => JSON.parse(section.markers || '[]').length);
    let samples = 0;
    const valid = () => db.prepare("SELECT id FROM book_audio WHERE id=? AND state='assembling'").get(job.id);
    try {
      await writeFile(pcm, '');
      for (const [index, part] of parts.entries()) {
        if (!valid()) return;
        if (!Number.isFinite(part.duration) || part.duration <= 0) throw new Error('Invalid section duration.');
        const decoded = join(temporary, `part-${index}.pcm`);
        await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', join(folder, `${part.id}.mp3`),
          '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', decoded], { timeout: 600000 });
        const length = (await stat(decoded)).size / 2;
        if (!Number.isInteger(length) || length <= 0) throw new Error('Invalid decoded narration.');
        const start = samples / 24000;
        samples += length;
        const end = samples / 24000;
        const scale = (end - start) / part.duration;
        const section = all.find(({ key }) => key === part.chapter);
        if (!hasUsableTimings(part.timings, part.duration)) {
          const error = `No usable synchronization in “${section.title}”. Retry book audio to rebuild this section.`;
          db.prepare("UPDATE audio SET state='error',error=? WHERE id=?").run(error, part.id);
          throw new RequestError(502, error);
        }
        const timings = JSON.parse(part.timings);
        segments.push({ key: part.chapter, title: section.title, start, end, scale, audioId: part.id,
          textHash: part.digest, approximate: timings.some((word) => word.estimated) });
        const timed = timings.filter((word) => word.start != null);
        for (const marker of JSON.parse(section.markers || '[]')) {
          const word = timed.find((word) => word.from >= marker.from);
          const time = marker.from === 0 ? start : start + (word?.start ?? 0) * scale;
          markers.push({ key: part.chapter, title: marker.title, from: marker.from, time });
        }
        if (!hasMarkers || !index && !markers.length) markers.push({ key: part.chapter, title: section.title, from: 0, time: start });
        await pipeline(createReadStream(decoded), createWriteStream(pcm, { flags: 'a' }));
        await rm(decoded, { force: true });
      }
      const duration = samples / 24000;
      markers.sort((a, b) => a.time - b.time || a.from - b.from);
      const chapters = markers.filter((marker, index) => !index || marker.time > markers[index - 1].time + .001);
      const metadata = [';FFMETADATA1', `title=${escapeMetadata(book.title)}`, ...chapters.flatMap((marker, index) => [
        '[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.floor(marker.time * 1000)}`,
        `END=${Math.max(Math.floor(marker.time * 1000) + 1, Math.floor((chapters[index + 1]?.time ?? duration) * 1000))}`,
        `title=${escapeMetadata(marker.title)}`,
      ])].join('\n');
      const metadataPath = join(temporary, 'chapters.ffmeta');
      await writeFile(metadataPath, metadata);
      const output = join(temporary, 'book.mp3');
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm,
        '-f', 'ffmetadata', '-i', metadataPath, '-map_metadata', '1', '-map_chapters', '1',
        '-c:a', 'libmp3lame', '-b:a', '96k', '-id3v2_version', '3', output], { timeout: 1800000 });
      if (!valid()) return;
      await rename(output, join(folder, `${job.id}.mp3`));
      db.prepare("UPDATE book_audio SET state='ready',segments=?,markers=?,duration=?,error=NULL WHERE id=?")
        .run(JSON.stringify(segments), JSON.stringify(chapters), duration, job.id);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  function cancel(book) {
    const row = newest(book);
    if (!row || !active.has(row.state)) return 0;
    db.prepare("UPDATE book_audio SET state='cancelled' WHERE id=?").run(row.id);
    for (const { id } of JSON.parse(row.parts)) db.prepare("UPDATE audio SET state='cancelled' WHERE id=? AND state='queued'").run(id);
    return 1;
  }

  function files(bookId) {
    return db.prepare('SELECT id FROM book_audio WHERE book=?').all(bookId)
      .flatMap(({ id }) => [join(folder, `${id}.mp3`), join(folder, `book-${id}`)]);
  }

  return {
    status, queue, segment, assemble, cancel, files,
    next: () => db.prepare(`SELECT * FROM book_audio WHERE state='queued' AND kind='generated'
      AND NOT EXISTS (SELECT 1 FROM json_each(book_audio.parts) part JOIN audio a ON a.id=json_extract(part.value,'$.id')
        WHERE a.state IN ('queued','generating','aligning')) ORDER BY created,rowid LIMIT 1`).get(),
    fail(job, message) { db.prepare("UPDATE book_audio SET state='error',error=? WHERE id=? AND state!='cancelled'").run(message, job.id); },
    audioFile(book, id) { return db.prepare("SELECT id FROM book_audio WHERE book=? AND id=? AND state='ready'").get(book.id, id) ? join(folder, `${id}.mp3`) : null; },
  };
}
