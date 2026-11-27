import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { audioRescans } from '../server/audio-rescan.js';
import { textWords } from '../shared/reading-text.js';

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'langy-repair-batched-')), path = join(folder, 'learning.sqlite');
  const db = new DatabaseSync(path), other = new DatabaseSync(path);
  t.after(async () => { other.close(); db.close(); await rm(folder, { recursive: true, force: true }); });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE analyses(book TEXT PRIMARY KEY,owner TEXT,state TEXT);
    CREATE TABLE chapters(book TEXT,key TEXT,title TEXT,text TEXT,digest TEXT,markers TEXT,languages TEXT,ordinal INTEGER);
    CREATE TABLE audio(id TEXT PRIMARY KEY,book TEXT,digest TEXT,state TEXT,timings TEXT,duration REAL);
    CREATE TABLE book_audio(id TEXT PRIMARY KEY,book TEXT,digest TEXT,state TEXT,parts TEXT,segments TEXT,markers TEXT,duration REAL,kind TEXT,quality TEXT,alignmentRevision INTEGER DEFAULT 0);
    INSERT INTO analyses VALUES('book','','ready');`);
  const names = Array.from({ length: 600 }, (_, i) => 'palabra' + String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26));
  const text = names.join(' '), words = textWords(text, 'es'), markers = '[{"title":"Section","from":0}]';
  db.prepare('INSERT INTO chapters VALUES(?,?,?,?,?,?,?,?)').run('book','epub:0','Section',text,'text-digest',markers,'[]',0);
  const original = words.map((word, i) => ({ ...word, start: i * .2 + .02, end: i * .2 + .14, ...(i % 3 === 1 ? { estimated: true } : {}) }));
  db.prepare('INSERT INTO audio VALUES(?,?,?,?,?,?)').run('part','book','text-digest','ready',JSON.stringify(original),120);
  const digest = createHash('sha256').update(JSON.stringify([['epub:0','text-digest',markers]])).digest('hex');
  db.prepare('INSERT INTO book_audio(id,book,digest,state,parts,segments,markers,duration,kind) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('recording','book',digest,'ready','[{"id":"part"}]','[{"key":"epub:0","audioId":"part","start":0,"end":120,"scale":1}]',markers,120,'generated');
  await promisify(execFile)('ffmpeg', ['-nostdin','-v','error','-y','-f','lavfi','-i','sine=frequency=330:duration=120','-ar','8000','-b:a','32k',join(folder,'recording.mp3')]);
  let reads = 0, calls = 0, beforeReply = async () => {};
  const prepare = db.prepare.bind(db); db.prepare = (sql) => { if (sql.includes('SELECT key,title,text,digest,markers,languages FROM chapters')) reads++; return prepare(sql); };
  const scanner = audioRescans({ db, folder, library: { getBook: () => ({ id: 'book', language: 'es' }) }, wake() {}, languageCall: async (_url, body) => {
    calls++; const job = db.prepare("SELECT windows,cursor FROM audio_rescans WHERE state='running'").get(), window = JSON.parse(job.windows)[job.cursor];
    await beforeReply(); return { timings: body.words.map((word) => {
      const i = names.indexOf(word); return { start: i * .2 + .02 - window.start, end: i * .2 + .14 - window.start };
    }) };
  } });
  const book = { id: 'book', language: 'es' };
  return { scanner, db, other, book, original, get reads() { return reads; }, get calls() { return calls; }, beforeReply(fn) { beforeReply = fn; },
    run: async () => { for (let i = 0; i < 30; i++) { const job = scanner.next(); if (!job) return; await scanner.process(job); } throw new Error('Repair did not finish'); },
    bytes: () => readFile(join(folder,'recording.mp3')) };
}

test('batched repairs cache source reads, keep anchors and audio bytes, and recover all synthetic gaps', async (t) => {
  const f = await fixture(t), bytes = await f.bytes(); f.scanner.queue(f.book, 'recording'); await f.run();
  const result = f.scanner.status(f.book, 'recording'); assert.equal(result.state, 'ready'); assert.equal(result.added, 200);
  assert.ok(f.calls < 10, `${f.calls} recognition calls for 200 gaps`); assert.equal(f.reads, 2, 'source is read at queue time and once for the running pass');
  const stamps = JSON.parse(f.db.prepare("SELECT timings FROM audio WHERE id='part'").get().timings);
  for (let i = 0; i < stamps.length; i++) if (!f.original[i].estimated) {
    assert.equal(stamps[i].start, f.original[i].start); assert.equal(stamps[i].end, f.original[i].end);
  }
  assert.deepEqual(await f.bytes(), bytes);
});

test('cached repair detects source changes from another database connection before accepting results', async (t) => {
  const f = await fixture(t); f.scanner.queue(f.book, 'recording');
  f.beforeReply(async () => f.other.prepare("UPDATE chapters SET digest='changed' WHERE book='book'").run());
  await assert.rejects(f.scanner.process(f.scanner.next()), /book text changed|recording or text changed/iu);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM rescan_matches').get().n, 0);
  assert.equal(f.db.prepare("SELECT alignmentRevision FROM book_audio WHERE id='recording'").get().alignmentRevision, 0);
});

test('a paused legacy repair batches its remaining plan and resumes saved matches without revisiting completed windows', async (t) => {
  const f = await fixture(t); f.scanner.queue(f.book, 'recording');
  const job = f.scanner.next(), batched = JSON.parse(job.windows), first = batched[0];
  const single = [];
  for (let i = first.from; i < first.to; i++) if (f.original[i].estimated) single.push({ ...first, from: i, to: i + 1 });
  const legacy = [...single, ...batched.slice(1)];
  const recovered = single[0].from;
  f.db.prepare('INSERT INTO rescan_matches VALUES(?,?,?,?)').run(job.id,recovered,f.original[recovered].start,f.original[recovered].end);
  f.db.prepare('UPDATE audio_rescans SET windows=?,cursor=1,added=1,planningVersion=1 WHERE id=?').run(JSON.stringify(legacy),job.id);
  await f.run();
  const result = f.scanner.status(f.book,'recording'); assert.equal(result.state,'ready'); assert.equal(result.added,200);
  assert.ok(result.windows < legacy.length); assert.equal(result.completed,result.windows);
});

test('a source edit during snapshot validation cannot be mistaken for a validated revision', async (t) => {
  const f = await fixture(t); f.scanner.queue(f.book, 'recording');
  let editDuringRead = false;
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.startsWith('SELECT * FROM audio WHERE')) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const row = get(...args);
        if (editDuringRead) {
          editDuringRead = false;
          f.other.prepare("UPDATE chapters SET digest='changed-during-validation' WHERE book='book'").run();
        }
        return row;
      };
    }
    return statement;
  };
  f.beforeReply(async () => {
    f.other.prepare("UPDATE analyses SET owner=owner WHERE book='book'").run();
    editDuringRead = true;
  });
  await assert.rejects(f.scanner.process(f.scanner.next()), /recording or text changed/iu);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM rescan_matches').get().n, 0);
});
