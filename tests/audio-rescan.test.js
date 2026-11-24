import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { openLearning } from '../server/learning.js';
import { audioRescans } from '../server/audio-rescan.js';
const run = promisify(execFile);
const texts = ['uno dos tres cuatro', 'cinco seis siete ocho', 'nueve diez once doce'];
const words = texts.join(' ').split(' ');
async function until(check) { for (let i = 0; i < 600; i++) { const value = check(); if (value) return value; await delay(20); } throw new Error('Background operation timed out'); }
async function fixture(t, duration = 12, { autoRepair = false } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'langy-rescan-'));
  const original = globalThis.fetch;
  const book = { id: 'book', title: 'Capítulos', language: 'es' };
  const learning = await openLearning(folder, { getBook: () => book }, false, {}, { autoRepair });
  const db = new DatabaseSync(join(folder, 'learning.sqlite'));
  db.prepare('INSERT INTO analyses(book,owner,language,state) VALUES(?,?,?,?)').run(book.id, 'owner', 'es', 'ready');
  for (const [index, text] of texts.entries()) db.prepare('INSERT INTO chapters(book,key,ordinal,title,text,digest,tokens,lemmas,markers) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(book.id, `epub:${index}`, index, `Capítulo ${index + 1}`, text, String(index), '[]', '[]', JSON.stringify([{ title: `Capítulo ${index + 1}`, from: 0 }]));
  const sample = join(folder, 'sample.wav');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${duration}`, '-ar', '24000', sample]);
  let rescans = 0, fail = false, wait;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body), path = new URL(url).pathname;
    if (path === '/transcribe') return Response.json({ heard: [{ word: 'recording', start: 0, end: duration }] });
    const time = (word) => (words.indexOf(word) + .25) * duration / 12;
    if (path === '/match-recording') return Response.json({ timings: body.words.map((word, index) => index >= 4 && index < 8 ? null : { start: time(word), end: time(word) + duration / 24 }),
      matchedWords: 8, matchedSpeechRatio: 1, strongMatchCharacters: 100 });
    if (path === '/rescan') {
      rescans++;
      if (wait) await wait;
      if (fail) throw new Error('language service unavailable');
      const job = db.prepare("SELECT windows,cursor FROM audio_rescans WHERE state='running'").get();
      const window = JSON.parse(job.windows)[job.cursor];
      return Response.json({ timings: body.words.map((word) => ({ start: time(word) - window.start, end: time(word) + duration / 24 - window.start, review: false })) });
    }
    throw new Error('Unexpected request: ' + path);
  };
  t.after(async () => { globalThis.fetch = original; await learning.remove(book.id); db.close(); await rm(folder, { recursive: true, force: true }); });
  async function upload(name) { const path = join(folder, name + '.wav'); await copyFile(sample, path); return learning.recordings.accept(book, { path, size: (await stat(path)).size, originalname: name + '.wav' }, { name }); }
  const ready = (id, states = ['ready', 'error']) => until(() => { const value = learning.recordings.list(book).find((item) => item.id === id); return states.includes(value?.state) && value; });
  const rescanReady = (id) => until(() => { const value = learning.rescans.status(book, id); return ['ready', 'error', 'cancelled'].includes(value?.state) && value; });
  function anchors(id) {
    const row = db.prepare('SELECT segments FROM book_audio WHERE id=?').get(id);
    return JSON.parse(row.segments).flatMap((segment) => JSON.parse(db.prepare('SELECT timings FROM audio WHERE id=?').get(segment.audioId).timings)
      .filter((word) => !word.estimated && word.start != null).map((word) => ({ word: word.word, start: segment.start + word.start * segment.scale, end: segment.start + word.end * segment.scale })));
  }
  return { folder, db, book, learning, upload, sample, ready, rescanReady, anchors,
    get rescanCalls() { return rescans; }, set fail(value) { fail = value; }, set wait(value) { wait = value; } };
}

test('fresh rescan recovers a wholly unmatched chapter, preserves known global timestamps and audio bytes, and refreshes playback metadata', async (t) => {
  const f = await fixture(t);
  const first = await f.upload('Narradora'), other = await f.upload('Other narrator');
  f.learning.recordings.queue(f.book, first.id); assert.equal((await f.ready(first.id)).state, 'ready');
  f.learning.recordings.queue(f.book, other.id); await f.ready(other.id);
  const old = f.anchors(first.id), untouched = f.anchors(other.id);
  const audio = await readFile(f.learning.audioFile(f.book, first.id));
  assert.equal(old.length, 8);
  assert.equal(f.learning.narration(f.book, first.id).audio.segments.length, 2);
  f.learning.rescans.queue(f.book, first.id);
  const result = await f.rescanReady(first.id);
  assert.equal(result.state, 'ready', result.error);
  assert.equal(result.added, 4);
  assert.equal(f.rescanCalls, 1);
  const current = f.anchors(first.id);
  assert.equal(current.length, 12);
  assert.deepEqual(current.filter((word) => old.some((item) => item.word === word.word)), old);
  assert.deepEqual(f.anchors(other.id), untouched);
  assert.deepEqual(await readFile(f.learning.audioFile(f.book, first.id)), audio);
  assert.equal(f.learning.narration(f.book, first.id).audio.segments.length, 3);
  assert.ok(f.learning.narration(f.book, first.id).audio.alignmentRevision > 0);
  f.learning.rescans.queue(f.book, first.id);
  const repeated = await f.rescanReady(first.id);
  assert.equal(repeated.added, 0); assert.equal(f.rescanCalls, 1);
  // Generated narration uses fixed section boundaries and its own timing rows.
  const source = f.db.prepare('SELECT * FROM book_audio WHERE id=?').get(first.id);
  const segments = JSON.parse(source.segments), parts = JSON.parse(source.parts);
  for (const [index, segment] of segments.entries()) {
    const part = f.db.prepare('SELECT * FROM audio WHERE id=?').get(segment.audioId);
    const stamps = JSON.parse(part.timings);
    if (!index) stamps[1].estimated = true;
    const id = 'generated-part-' + index;
    f.db.prepare('INSERT INTO audio(id,book,chapter,digest,options,state,timings,duration,created) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, f.book.id, part.chapter, part.digest, '{}', 'ready', JSON.stringify(stamps), part.duration, Date.now());
    segment.audioId = id; parts[index].id = id;
  }
  f.db.prepare('INSERT INTO book_audio(id,book,digest,options,state,parts,segments,markers,duration,created,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('generated-copy', f.book.id, source.digest, '{}', 'ready', JSON.stringify(parts), JSON.stringify(segments), source.markers, source.duration, Date.now(), 'generated');
  await copyFile(f.learning.audioFile(f.book, first.id), join(f.folder, 'narration', 'generated-copy.mp3'));
  const generatedBefore = f.anchors('generated-copy');
  f.learning.rescans.queue(f.book, 'generated-copy');
  const generatedResult = await f.rescanReady('generated-copy');
  assert.equal(generatedResult.state, 'ready', generatedResult.error);
  assert.equal(generatedResult.added, 1);
  assert.equal(f.anchors('generated-copy').length, 12);
  assert.deepEqual(f.anchors('generated-copy').filter((word) => generatedBefore.some((item) => item.word === word.word)), generatedBefore);
  assert.deepEqual(f.anchors(first.id), current);
  assert.deepEqual(await readFile(f.learning.audioFile(f.book, 'generated-copy')), audio);
});

test('completed synchronization automatically repairs missing positions once and does not loop on its own updated alignment', async (t) => {
  const f = await fixture(t, 12, { autoRepair: true });
  const recording = await f.upload('Automatic repair'); f.learning.recordings.queue(f.book, recording.id);
  assert.equal((await f.ready(recording.id)).state, 'ready');
  const result = await f.rescanReady(recording.id);
  assert.equal(result.state, 'ready', result.error); assert.equal(result.added, 4); assert.equal(f.rescanCalls, 1);
  assert.equal(f.anchors(recording.id).length, 12);
  f.learning.rescans.automatic(f.book, recording.id); await delay(50);
  assert.equal(f.rescanCalls, 1, 'the completed automatic pass records the final signature, preventing repeated rescans');
});

test('failed rescans retain working alignment, retry freshly, survive restart checkpoints, and cancel safely', async (t) => {
  const f = await fixture(t);
  const recording = await f.upload('Retry');
  f.learning.recordings.queue(f.book, recording.id); await f.ready(recording.id);
  const old = f.anchors(recording.id);
  f.fail = true; f.learning.rescans.queue(f.book, recording.id);
  assert.equal((await f.rescanReady(recording.id)).state, 'error');
  assert.deepEqual(f.anchors(recording.id), old);
  f.fail = false;
  let release; f.wait = new Promise((resolve) => { release = resolve; });
  f.learning.rescans.queue(f.book, recording.id);
  await until(() => f.rescanCalls === 2);
  f.learning.rescans.cancel(f.book, recording.id);
  release(); f.wait = null;
  assert.equal((await f.rescanReady(recording.id)).state, 'cancelled');
  assert.deepEqual(f.anchors(recording.id), old);
  await delay(50); // Let the cancelled request unwind before simulating a process restart.
  // Initialization restores a persisted interrupted job to the queue.
  f.db.prepare("UPDATE audio_rescans SET state='running' WHERE recording=?").run(recording.id);
  audioRescans({ db: f.db, folder: join(f.folder, 'narration'), library: {}, languageCall() {}, wake() {} });
  assert.equal(f.learning.rescans.status(f.book, recording.id).state, 'queued');
  const recovered = await f.rescanReady(recording.id);
  assert.equal(recovered.state, 'ready', recovered.error);
  assert.equal(f.anchors(recording.id).length, 12);
});

test('chapter uploads retain explicit order and originals, create continuous audio and file chapter markers', async (t) => {
  const f = await fixture(t, 1);
  const files = [];
  for (const name of ['02-first.wav', '01-second.wav']) {
    const path = join(f.folder, name); await copyFile(f.sample, path);
    files.push({ path, originalname: name, size: (await stat(path)).size });
  }
  const item = await f.learning.recordings.acceptChapters(f.book, files, { name: 'Full audiobook' });
  const assembled = await f.ready(item.id, ['uploaded', 'error']);
  assert.equal(assembled.state, 'uploaded', assembled.error);
  assert.deepEqual(assembled.sourceChapters.map((chapter) => chapter.name), ['02-first.wav', '01-second.wav']);
  assert.equal(assembled.duration, 2);
  assert.equal(assembled.sourceChapters[1].start, 1);
  const joined = f.learning.recordings.original(f.book, item.id);
  const metadata = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', joined.path])).stdout);
  assert.deepEqual(metadata.chapters.map((chapter) => chapter.tags.title), ['02-first', '01-second']);
  assert.deepEqual(metadata.chapters.map((chapter) => Number(chapter.start_time)), [0, 1]);
  const original = f.learning.recordings.originalChapter(f.book, item.id, 0);
  assert.deepEqual(await readFile(original.path), await readFile(f.sample));
  assert.throws(() => f.learning.recordings.originalChapter({ id: 'other-book' }, item.id, 0), /not found/u);
  f.learning.recordings.queue(f.book, item.id);
  assert.equal((await f.ready(item.id)).state, 'ready');
  const audio = f.learning.narration(f.book, item.id).audio;
  assert.deepEqual(audio.markers.map((marker) => marker.title), ['02-first', '01-second']);
  assert.deepEqual(audio.markers.map((marker) => marker.time), [0, 1]);
  assert.ok((await readFile(f.learning.audioFile(f.book, item.id))).length > 0);
});
