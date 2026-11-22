import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { textWords } from '../shared/reading-text.js';
import { RequestError } from './books.js';
import { synchronizeChunk } from './audio-timing.js';
import { chapterAudio } from './chapter-audio.js';
import { sectionLanguages } from './language-voices.js';

const run = promisify(execFile);
export const maxAudioUpload = 1024 * 1024 ** 2;
const formats = 'mp3,mov,ogg,wav,flac,aac';
const pending = new Set(['queued', 'syncing', 'assembling']);

export function uploadedAudio({ db, folder, library, languageCall, wake, isRescanning = () => false }) {
  db.exec(`CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY, book TEXT NOT NULL REFERENCES analyses(book) ON DELETE CASCADE,
    name TEXT NOT NULL, originalName TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
    duration REAL NOT NULL, state TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
    quality TEXT, parts TEXT NOT NULL DEFAULT '[]', error TEXT, created INTEGER NOT NULL
  ) STRICT;
  UPDATE recordings SET state='queued' WHERE state='syncing';`);
  const chapters = chapterAudio({ db, folder, library, wake });
  const source = (id) => join(folder, `${id}.source`);
  const transcript = (id) => join(folder, `${id}.transcript.json`);
  const row = (book, id) => {
    const recording = db.prepare('SELECT * FROM recordings WHERE id=? AND book=?').get(id, book.id);
    if (!recording) throw new RequestError(404, 'Recording not found.');
    return recording;
  };
  const publicRow = (item) => ({ id: item.id, name: item.name, state: item.state, bytes: item.bytes,
    duration: item.duration, progress: item.progress, error: item.error,
    quality: item.quality ? JSON.parse(item.quality) : null,
    sourceChapters: JSON.parse(item.sourceChapters || '[]').map(({ index, title, name, start, end }) => ({ index, title, name, start, end,
      url: `/api/books/${item.book}/recordings/${item.id}/chapters/${index}/file` })),
    downloadUrl: `/api/books/${item.book}/recordings/${item.id}/file` });

  async function accept(book, file, body) {
    if (!file) throw new RequestError(422, 'Choose an audiobook file.');
    const id = randomUUID();
    let saved = false;
    try {
      if (file.size > maxAudioUpload) throw new RequestError(413, 'Audio files must be 1 GiB or smaller.');
      let probe;
      try {
        probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats,
          '-select_streams', 'a:0', '-show_entries', 'stream=codec_type:format=duration,format_name', '-of', 'json', file.path], { timeout: 30000 })).stdout);
      } catch { throw new RequestError(415, 'Choose a playable MP3, M4A, M4B, OGG, WAV, FLAC or AAC file.'); }
      const duration = Number(probe.format?.duration);
      if (!probe.streams?.length || !Number.isFinite(duration) || duration <= 0 || duration > 72 * 3600) {
        throw new RequestError(422, 'The audiobook needs a valid duration of up to 72 hours.');
      }
      library.getBook(book.id);
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : basename(file.originalname).slice(0, 120);
      const type = String(probe.format.format_name).split(',')[0];
      const mime = ({ mp3: 'audio/mpeg', mov: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac' })[type] || 'application/octet-stream';
      await rename(file.path, source(id));
      db.prepare('INSERT INTO recordings(id,book,name,originalName,mime,bytes,duration,state,created) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, book.id, name, basename(file.originalname).slice(0, 240), mime, file.size, duration, 'uploaded', Date.now());
      saved = true;
      return publicRow(row(book, id));
    } finally {
      if (!saved) await Promise.allSettled([rm(file.path, { force: true }), rm(source(id), { force: true })]);
    }
  }

  function queue(book, id) {
    const recording = row(book, id);
    if (db.prepare('SELECT state FROM analyses WHERE book=?').get(book.id)?.state !== 'ready') throw new RequestError(409, 'Wait for book analysis to finish before syncing a recording.');
    if (isRescanning(id)) throw new RequestError(409, 'Wait for the missed-word rescan to finish, or cancel it first.');
    if (pending.has(recording.state)) return publicRow(recording);
    db.prepare('UPDATE recordings SET state=?,error=NULL WHERE id=?').run(recording.duration > 0 ? 'queued' : 'assembling', id);
    wake();
    return publicRow(row(book, id));
  }

  async function process(job) {
    if (job.state === 'assembling') return chapters.assemble(job);
    const owner = db.prepare('SELECT owner FROM analyses WHERE book=?').get(job.book)?.owner;
    const book = library.getBook(job.book, { id: owner });
    const sections = db.prepare('SELECT key,title,text,digest,markers,languages FROM chapters WHERE book=? ORDER BY ordinal').all(job.book);
    const languages = [...new Set(sectionLanguages(sections, book.language))];
    const recognitionLanguage = languages.length > 1 ? 'mul' : languages[0];
    const words = sections.flatMap((section) => textWords(section.text, book.language).map((word) => ({ ...word, key: section.key })));
    if (!words.length) throw new RequestError(422, 'This book has no selectable text to sync.');
    const valid = () => db.prepare("SELECT id FROM recordings WHERE id=? AND state='syncing'").get(job.id);
    db.prepare("UPDATE recordings SET state='syncing' WHERE id=?").run(job.id);
    const temporary = join(folder, `recording-${job.id}`);
    await mkdir(temporary, { recursive: true });
    try {
      const playback = join(folder, `${job.id}.mp3`);
      try { await access(playback); }
      catch {
        const target = join(temporary, 'recording.mp3');
        await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats,
          '-i', source(job.id), '-vn', '-map', '0:a:0', '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', target], { timeout: 1800000 });
        if (!valid()) return;
        await rename(target, playback);
        if (!valid()) { await rm(playback, { force: true }); return; }
      }
      let checkpoint = { offset: 0, heard: [], language: recognitionLanguage };
      try {
        const saved = JSON.parse(await readFile(transcript(job.id), 'utf8'));
        if (saved.language === recognitionLanguage) checkpoint = saved;
      } catch { /* A new recording starts without a transcript. */ }
      for (let offset = checkpoint.offset; offset < job.duration; offset += 59) {
        if (!valid()) return;
        const chunk = join(temporary, 'chunk.wav');
        await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(offset), '-i', playback, '-t', '60',
          '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', chunk], { timeout: 90000 });
        const result = await languageCall('/transcribe', { audio: (await readFile(chunk)).toString('base64'), words: [], language: recognitionLanguage });
        if (!valid()) return;
        for (const word of result.heard || []) {
          const start = Number(word.start) + offset, end = Number(word.end) + offset;
          if (typeof word.word !== 'string' || !Number.isFinite(start) || !Number.isFinite(end) || end <= start
            || end > job.duration + .2 || start < (checkpoint.heard.at(-1)?.end ?? 0) - .03) continue;
          checkpoint.heard.push({ word: word.word, start, end });
        }
        checkpoint.offset = offset + 59;
        const save = join(temporary, 'transcript.json');
        await writeFile(save, JSON.stringify(checkpoint));
        await rename(save, transcript(job.id));
        if (!valid()) { await rm(transcript(job.id), { force: true }); return; }
        db.prepare('UPDATE recordings SET progress=? WHERE id=?').run(Math.min(.95, (offset + 59) / job.duration * .95), job.id);
        // Give book analysis and other queued work a turn between transcription chunks.
        if (checkpoint.offset < job.duration) return;
      }
      const aligned = await languageCall('/match-recording', { words: words.map((word) => word.word), heard: checkpoint.heard });
      if (!valid()) return;
      const characters = words.reduce((sum, word) => sum + [...word.word].length, 0);
      if (aligned.matchedWords < Math.min(8, Math.max(1, Math.ceil(words.length * .5))) || aligned.matchedSpeechRatio < .35
        || aligned.strongMatchCharacters < Math.min(32, Math.max(1, characters * .5))) {
        throw new RequestError(422, 'Not enough of this recording matches the book. Check its language and edition, or upload a recording of the same text.');
      }
      publish(book, job, sections, words, aligned);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  function publish(book, job, sections, words, aligned, onSave = () => {}) {
    const previous = db.prepare('SELECT * FROM book_audio WHERE id=? AND book=?').get(job.id, book.id);
    const oldSegments = JSON.parse(previous?.segments || '[]');
    const selected = sections.filter((section) => words.some((word, index) => word.key === section.key && aligned.timings[index]) || oldSegments.some((part) => part.key === section.key));
    const segments = [], markers = [], parts = [];
    const quality = { matchedWords: aligned.matchedWords, totalWords: words.length,
      textPercent: Math.round(aligned.matchedWords / words.length * 100), speechPercent: Math.round(aligned.matchedSpeechRatio * 100) };
    db.exec('BEGIN IMMEDIATE');
    try {
      const old = JSON.parse(row(book, job.id).parts);
      for (const { id } of old) db.prepare('DELETE FROM audio WHERE id=?').run(id);

      for (const [ordinal, section] of selected.entries()) {
        const indices = words.flatMap((word, index) => word.key === section.key ? [index] : []);
        const next = selected[ordinal + 1];
        const nextStart = next ? words.findIndex((word, index) => word.key === next.key && aligned.timings[index]) : -1;
        const first = indices.find((index) => aligned.timings[index]);
        const start = ordinal ? aligned.timings[first]?.start ?? oldSegments.find((part) => part.key === section.key)?.start ?? 0 : 0;
        const end = nextStart >= 0 ? aligned.timings[nextStart].start : next ? oldSegments.find((part) => part.key === next.key)?.start ?? job.duration : job.duration;
        const sectionWords = indices.map((index) => words[index]);
        const stamps = indices.map((index) => aligned.timings[index] ? { ...aligned.timings[index],
          start: Math.max(0, aligned.timings[index].start - start), end: Math.min(end - start, aligned.timings[index].end - start) } : null);
        const timings = synchronizeChunk(sectionWords, stamps, end - start);
        const id = randomUUID(), options = JSON.stringify({ source: 'uploaded', recording: job.id });
        db.prepare('INSERT INTO audio(id,book,chapter,digest,options,state,timings,duration,created) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(id, job.book, section.key, section.digest, options, 'ready', JSON.stringify(timings), end - start, Date.now());
        parts.push({ key: section.key, id, digest: section.digest });
        segments.push({ key: section.key, title: section.title, start, end, scale: 1, audioId: id, textHash: section.digest,
          approximate: timings.some((word) => word.estimated) });
        for (const marker of JSON.parse(section.markers || '[]')) {
          const word = timings.find((word) => word.from >= marker.from && word.start != null);
          markers.push({ key: section.key, title: marker.title, from: marker.from, time: start + (word?.start ?? 0) });
        }
        if (!markers.length) markers.push({ key: section.key, title: section.title, from: 0, time: start });
      }
      const sourceChapters = JSON.parse(job.sourceChapters || '[]');
      if (sourceChapters.length) {
        markers.length = 0;
        for (const chapter of sourceChapters) {
          const segment = segments.find((part) => chapter.start >= part.start && chapter.start < part.end) || segments[0];
          markers.push({ title: chapter.title, time: chapter.start, key: segment.key, from: 0 });
        }
      }
      const chapters = markers.sort((a, b) => a.time - b.time).filter((marker, index, all) => !index || marker.time > all[index - 1].time + .001);
      db.prepare('INSERT INTO book_audio(id,book,digest,options,state,parts,segments,markers,duration,created,kind,name,quality) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest, state=excluded.state,parts=excluded.parts,segments=excluded.segments,markers=excluded.markers,quality=excluded.quality,alignmentRevision=book_audio.alignmentRevision+1')
        .run(job.id, job.book, createHash('sha256').update(JSON.stringify(sections.map(({ key, digest, markers }) => [key, digest, markers]))).digest('hex'), '{}', 'ready', JSON.stringify(parts), JSON.stringify(segments), JSON.stringify(chapters),
          job.duration, job.created, 'uploaded', job.name, JSON.stringify(quality));
      db.prepare("UPDATE recordings SET state='ready',progress=1,quality=?,parts=?,error=NULL WHERE id=?")
        .run(JSON.stringify(quality), JSON.stringify(parts), job.id);
      onSave();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function files(book) {
    return db.prepare('SELECT id FROM recordings WHERE book=?').all(book).flatMap(({ id }) =>
      [source(id), transcript(id), join(folder, `${id}.mp3`), join(folder, `recording-${id}`), ...chapters.files(id)]);
  }
  return {
    accept, queue, process, files, publish,
    async acceptChapters(book, files, body) { const id = await chapters.accept(book, files, body); return publicRow(row(book, id)); },
    originalChapter: chapters.original,
    list: (book) => db.prepare('SELECT * FROM recordings WHERE book=? ORDER BY created,id').all(book.id).map(publicRow),
    next: () => db.prepare("SELECT * FROM recordings WHERE state IN ('queued','syncing','assembling') ORDER BY created,id LIMIT 1").get(),
    fail(job, message) { db.prepare("UPDATE recordings SET state='error',error=? WHERE id=?").run(message, job.id); },
    original(book, id) { const item = row(book, id); return { path: source(id), name: item.originalName, mime: item.mime }; },
    async remove(book, id) {
      const item = row(book, id);
      db.prepare('DELETE FROM book_audio WHERE id=? AND book=?').run(id, book.id);
      for (const part of JSON.parse(item.parts)) db.prepare('DELETE FROM audio WHERE id=? AND book=?').run(part.id, book.id);
      const paths = [source(id), transcript(id), join(folder, `${id}.mp3`), join(folder, `recording-${id}`), ...chapters.files(id)];
      db.prepare('DELETE FROM recordings WHERE id=?').run(id);
      await Promise.allSettled(paths.map((path) => rm(path, { recursive: true, force: true })));
    },
  };
}
