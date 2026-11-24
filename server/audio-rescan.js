import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { textWords } from '../shared/reading-text.js';
import { synchronizeChunk } from './audio-timing.js';
import { confirmed, rescanWindows, mergeRescan } from './rescan-timing.js';
import { RequestError } from './books.js';
import { sectionLanguages } from './language-voices.js';
const run = promisify(execFile);
const hash = (data) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const pending = new Set(['queued', 'running']);

export function audioRescans({ db, folder, library, languageCall, publishUploaded, wake }) {
  db.exec(`CREATE TABLE IF NOT EXISTS audio_rescans(
    id TEXT PRIMARY KEY, book TEXT NOT NULL REFERENCES analyses(book) ON DELETE CASCADE,
    recording TEXT NOT NULL UNIQUE, signature TEXT NOT NULL, state TEXT NOT NULL,
    windows TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0,
    matchedBefore INTEGER NOT NULL, totalWords INTEGER NOT NULL, error TEXT, created INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS rescan_matches(
    job TEXT NOT NULL REFERENCES audio_rescans(id) ON DELETE CASCADE,
    word INTEGER NOT NULL, start REAL NOT NULL, end REAL NOT NULL, PRIMARY KEY(job,word)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS auto_rescans(recording TEXT PRIMARY KEY,signature TEXT NOT NULL,version INTEGER NOT NULL) STRICT;
  UPDATE audio_rescans SET state='queued' WHERE state='running';`);
  function status(book, recording) {
    const value = db.prepare('SELECT * FROM audio_rescans WHERE book=? AND recording=?').get(book.id, recording);
    if (!value) return null;
    const count = JSON.parse(value.windows).length;
    return { state: value.state, added: value.added, matchedBefore: value.matchedBefore, totalWords: value.totalWords,
      completed: value.cursor, windows: count, progress: count ? value.cursor / count : 1, error: value.error };
  }
  const busy = (id) => pending.has(db.prepare('SELECT state FROM audio_rescans WHERE recording=?').get(id)?.state);
  function snapshot(book, id) {
    if (db.prepare('SELECT state FROM analyses WHERE book=?').get(book.id)?.state !== 'ready') throw new RequestError(409, 'Wait for book analysis to finish before rescanning audio.');
    const recording = db.prepare("SELECT * FROM book_audio WHERE book=? AND id=? AND state='ready'").get(book.id, id);
    if (!recording) throw new RequestError(404, 'Choose a complete, synchronized recording to rescan.');
    if (recording.kind === 'uploaded' && db.prepare('SELECT state FROM recordings WHERE id=?').get(id)?.state !== 'ready') throw new RequestError(409, 'Wait for recording synchronization to finish.');
    const sections = db.prepare('SELECT key,title,text,digest,markers,languages FROM chapters WHERE book=? ORDER BY ordinal').all(book.id);
    if (recording.digest !== hash(sections.map(({ key, digest, markers }) => [key, digest, markers]))) throw new RequestError(409, 'The book text changed. Sync this recording with the book again first.');
    const segments = JSON.parse(recording.segments), raw = [], parts = new Map();
    for (const segment of segments) {
      const part = db.prepare("SELECT * FROM audio WHERE book=? AND id=? AND state='ready'").get(book.id, segment.audioId);
      if (!part || part.digest !== sections.find((item) => item.key === segment.key)?.digest) throw new RequestError(409, 'The audio alignment changed. Sync this recording again first.');
      const timing = JSON.parse(part.timings);
      parts.set(segment.key, { part, segment, stamps: new Map(timing.map((stamp) => [stamp.from, stamp])) });
      raw.push([part.id, part.timings, part.duration]);
    }
    const words = sections.flatMap((section) => textWords(section.text, book.language).map((word) => ({ ...word, key: section.key })));
    if (!words.length || words.length > 500000) throw new RequestError(422, 'Rescanning supports books with up to 500,000 selectable words.');
    const timings = confirmed(words.map((word) => {
      const data = parts.get(word.key), stamp = data?.stamps.get(word.from);
      if (!stamp || stamp.word !== word.word || stamp.start == null || stamp.end == null) return null;
      return { start: data.segment.start + stamp.start * data.segment.scale,
        end: data.segment.start + stamp.end * data.segment.scale, estimated: stamp.estimated, review: stamp.review };
    }), recording.duration);
    return { recording, sections, segments, parts, words, timings,
      signature: hash([recording.digest, recording.parts, recording.segments, raw]) };
  }
  function queue(book, id) {
    const data = snapshot(book, id);
    const old = db.prepare('SELECT * FROM audio_rescans WHERE recording=?').get(id);
    if (old && pending.has(old.state)) return status(book, id);
    if (old?.state === 'error' && old.signature === data.signature) {
      db.prepare("UPDATE audio_rescans SET state='queued',error=NULL WHERE id=?").run(old.id);
    } else {
      db.prepare('DELETE FROM audio_rescans WHERE recording=?').run(id);
      db.prepare("INSERT INTO audio_rescans(id,book,recording,signature,state,windows,matchedBefore,totalWords,created) VALUES(?,?,?,?,'queued',?,?,?,?)")
        .run(randomUUID(), book.id, id, data.signature, JSON.stringify(rescanWindows(data.words, data.timings, data.recording.duration)),
          data.timings.filter(Boolean).length, data.words.length, Date.now());
    }
    wake(); return status(book, id);
  }
  function finish(job, book, data, timings) {
    const done = () => db.prepare("UPDATE audio_rescans SET state='ready',error=NULL WHERE id=? AND state='running'").run(job.id);
    if (!job.added) { done(); return; }
    const matchedWords = timings.filter(Boolean).length;
    if (data.recording.kind === 'uploaded') {
      const item = db.prepare('SELECT * FROM recordings WHERE id=?').get(job.recording);
      const quality = JSON.parse(item.quality || '{}');
      publishUploaded(book, item, data.sections, data.words, { timings, matchedWords,
        matchedSpeechRatio: (quality.speechPercent || 0) / 100 }, done);
      return;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const markers = JSON.parse(data.recording.markers);
      const segments = data.segments.map((segment) => {
        const { part } = data.parts.get(segment.key);
        const indices = data.words.flatMap((word, index) => word.key === segment.key ? [index] : []);
        const stamps = indices.map((index) => timings[index] ? { ...timings[index],
          start: (timings[index].start - segment.start) / segment.scale,
          end: (timings[index].end - segment.start) / segment.scale } : null);
        const local = synchronizeChunk(indices.map((index) => data.words[index]), stamps, part.duration);
        db.prepare('UPDATE audio SET timings=? WHERE id=?').run(JSON.stringify(local), part.id);
        for (const marker of markers.filter((item) => item.key === segment.key && item.from > 0)) {
          const word = local.find((item) => item.from >= marker.from && item.start != null);
          if (word) marker.time = segment.start + word.start * segment.scale;
        }
        return { ...segment, approximate: local.some((word) => word.estimated) };
      });
      // Recording bytes and chapter boundaries stay fixed; refreshed word data
      // updates in-player marker positions and page following on the next poll.
      db.prepare('UPDATE book_audio SET segments=?,markers=?,quality=?,alignmentRevision=alignmentRevision+1 WHERE id=?')
        .run(JSON.stringify(segments), JSON.stringify(markers.sort((a, b) => a.time - b.time)), JSON.stringify({ matchedWords, totalWords: timings.length,
          textPercent: Math.round(matchedWords / timings.length * 100) }), job.recording);
      done(); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async function process(job) {
    const analysis = db.prepare('SELECT owner FROM analyses WHERE book=?').get(job.book);
    const book = library.getBook(job.book, { id: analysis?.owner });
    const data = snapshot(book, job.recording);
    if (data.signature !== job.signature) throw new RequestError(409, 'The recording or text changed during rescanning. Start a new rescan.');
    const valid = () => db.prepare("SELECT id FROM audio_rescans WHERE id=? AND state='running'").get(job.id);
    db.prepare("UPDATE audio_rescans SET state='running' WHERE id=?").run(job.id);
    const timings = data.timings;
    for (const match of db.prepare('SELECT word,start,end FROM rescan_matches WHERE job=? ORDER BY word').all(job.id)) timings[match.word] = { start: match.start, end: match.end, review: false };
    const windows = JSON.parse(job.windows), window = windows[job.cursor];
    if (!window) {
      finish(job, book, data, timings);
      if (db.prepare('SELECT recording FROM auto_rescans WHERE recording=?').get(job.recording))
        db.prepare('UPDATE auto_rescans SET signature=? WHERE recording=?').run(snapshot(book, job.recording).signature, job.recording);
      return;
    }
    const temporary = join(folder, `rescan-${job.id}`);
    await mkdir(temporary, { recursive: true });
    try {
      const path = join(temporary, 'gap.wav');
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(window.start), '-i', join(folder, `${job.recording}.mp3`),
        '-t', String(window.end - window.start), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', path], { timeout: 90000 });
      const result = await languageCall('/rescan', { audio: (await readFile(path)).toString('base64'),
        words: data.words.slice(window.contextFrom, window.contextTo).map((word) => word.word),
        language: new Set(sectionLanguages(data.sections, book.language)).size > 1 ? 'mul' : sectionLanguages(data.sections, book.language)[0] });
      if (!valid()) return;
      if (snapshot(book, job.recording).signature !== job.signature) throw new RequestError(409, 'The recording or text changed during rescanning. Start a new rescan.');
      const merged = mergeRescan(timings, window, result.timings, data.recording.duration, (index, start, end) => {
        if (data.recording.kind === 'uploaded') return true;
        const segment = data.parts.get(data.words[index].key)?.segment;
        return segment && start >= segment.start && end <= segment.end;
      });
      db.exec('BEGIN IMMEDIATE');
      try {
        for (let index = window.from; index < window.to; index++) {
          if (timings[index] || !merged.timings[index]) continue;
          const stamp = merged.timings[index];
          db.prepare('INSERT OR IGNORE INTO rescan_matches VALUES(?,?,?,?)').run(job.id, index, stamp.start, stamp.end);
        }
        db.prepare("UPDATE audio_rescans SET cursor=cursor+1,added=added+?,state='queued' WHERE id=?").run(merged.added, job.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  function automatic(book, id) {
    const data = snapshot(book, id), previous = db.prepare('SELECT * FROM auto_rescans WHERE recording=?').get(id);
    if (previous?.version === 2 && previous.signature === data.signature || busy(id)) return;
    db.prepare('INSERT INTO auto_rescans VALUES(?,?,2) ON CONFLICT(recording) DO UPDATE SET signature=excluded.signature,version=2').run(id, data.signature);
    if (data.timings.some((stamp) => !stamp)) queue(book, id);
  }
  return { status, queue, busy, process, automatic,
    next: () => db.prepare("SELECT * FROM audio_rescans WHERE state='queued' ORDER BY created LIMIT 1").get(),
    fail(job, error) { db.prepare("UPDATE audio_rescans SET state='error',error=? WHERE id=? AND state!='cancelled'").run(error, job.id); },
    cancel(book, recording) { db.prepare("UPDATE audio_rescans SET state='cancelled',error=NULL WHERE book=? AND recording=? AND state IN ('queued','running')").run(book.id, recording); return status(book, recording); },
    files: (book) => db.prepare('SELECT id FROM audio_rescans WHERE book=?').all(book).map(({ id }) => join(folder, `rescan-${id}`)),
  };
}
