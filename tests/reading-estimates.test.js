import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { readingEstimates } from '../server/reading-estimates.js';
import { openLearning } from '../server/learning.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

function fixture(t, ai, timeoutMs = 1000) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE analyses(book TEXT PRIMARY KEY,state TEXT,metrics TEXT);
    CREATE TABLE chapters(book TEXT,ordinal INTEGER,text TEXT);
    CREATE TABLE estimates(book TEXT PRIMARY KEY,state TEXT,json TEXT,error TEXT);
    INSERT INTO analyses VALUES('one','ready',NULL),('two','ready',NULL);`);
  for (const id of ['one', 'two']) db.prepare('INSERT INTO chapters VALUES(?,?,?)').run(id, 0, 'People read books in the library. They enjoyed the story and talked about the characters afterwards. '.repeat(3));
  return { db, estimates: readingEstimates({ db, ai, timeoutMs }) };
}

test('reading estimates have an independent single-request lane with explicit queued/running/ready states', async (t) => {
  let release, calls = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const { estimates } = fixture(t, { async readingLevel() { calls++; if (calls === 1) return held; return { band: 'Advanced', text: 'Second result.' }; } });
  estimates.queue('one'); estimates.queue('two');
  assert.equal(estimates.status('one').state, 'queued');
  const pending = estimates.pump(); await delay(0);
  assert.equal(estimates.status('one').state, 'running');
  assert.ok(estimates.status('one').deadline > estimates.status('one').startedAt);
  await estimates.pump(); assert.equal(calls, 1, 'the lane has only one active LLM call');
  assert.equal(estimates.status('two').state, 'queued');
  release({ band: 'Intermediate', text: 'First result.' }); await pending;
  assert.equal(estimates.status('one').state, 'ready');
  await estimates.pump(); assert.equal(estimates.status('two').band, 'Advanced');
});

test('a model that never settles reaches a hard deadline and cannot block the next estimate', async (t) => {
  let signal;
  const ai = { readingLevel(_sample, value) { signal = value; return new Promise(() => {}); } };
  const { estimates } = fixture(t, ai, 20);
  estimates.queue('one'); await estimates.pump();
  assert.equal(estimates.status('one').state, 'error');
  assert.match(estimates.status('one').error, /timed out/u); assert.equal(signal.aborted, true);
  ai.readingLevel = async () => ({ band: 'Intermediate', text: 'Recovered.' });
  estimates.queue('two'); await estimates.pump(); assert.equal(estimates.status('two').text, 'Recovered.');
});

test('retry aborts the stale request and a late response cannot overwrite the new estimate', async (t) => {
  let release, signal;
  const ai = { readingLevel(_sample, value) { signal = value; return new Promise((resolve) => { release = resolve; }); } };
  const { estimates } = fixture(t, ai);
  estimates.queue('one'); const pending = estimates.pump(); await delay(0);
  estimates.queue('one'); assert.equal(signal.aborted, true); await pending;
  assert.equal(estimates.status('one').state, 'queued');
  ai.readingLevel = async () => ({ band: 'Advanced', text: 'New estimate.' });
  await estimates.pump(); release({ band: 'Novice', text: 'Obsolete result.' }); await delay(0);
  assert.equal(estimates.status('one').text, 'New estimate.');
});

test('legacy interrupted estimates recover on startup and short text does not receive an invented reading level', async (t) => {
  const { db } = fixture(t, { async readingLevel() { throw new Error('No LLM call expected'); } });
  db.prepare("INSERT INTO estimates(book,state) VALUES('one','running')").run();
  db.prepare("UPDATE chapters SET text='A short heading.' WHERE book='one'").run();
  const estimates = readingEstimates({ db, ai: { async readingLevel() { throw new Error('No LLM call expected'); } } });
  assert.equal(estimates.status('one').state, 'queued');
  await estimates.pump(); assert.equal(estimates.status('one').state, 'ready'); assert.equal(estimates.status('one').band, null);
  db.prepare("UPDATE analyses SET state='running' WHERE book='two'").run();
  assert.throws(() => estimates.queue('two'), { status: 409 });
});

test('the application starts a reading estimate while an audio job is still waiting on Kokoro', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-estimate-lane-'));
  const oldFetch = globalThis.fetch, oldURL = process.env.READER_KOKORO_URL;
  process.env.READER_KOKORO_URL = 'http://kokoro.test/v1';
  const wav = join(folder, 'sample.wav');
  await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', '-ar', '24000', wav]);
  const speech = await readFile(wav);
  let release, started;
  const held = new Promise((resolve) => { release = resolve; }), generating = new Promise((resolve) => { started = resolve; });
  globalThis.fetch = async (url, options) => {
    if (new URL(url).pathname === '/v1/audio/speech') { started(); await held; return new Response(speech); }
    if (new URL(url).pathname === '/align') {
      const words = JSON.parse(options.body).words;
      return Response.json({ timings: words.map((_, index) => ({ start: index / words.length, end: (index + .8) / words.length })) });
    }
    throw new Error('Unexpected request');
  };
  const books = { audio: { id: 'audio', title: 'Audio book', language: 'en' }, reading: { id: 'reading', title: 'Reading book', language: 'en' } };
  const learning = await openLearning(folder, { getBook: (id) => books[id] }, false,
    { async readingLevel() { return { band: 'Intermediate', text: 'Completed while audio was pending.' }; } });
  const db = new DatabaseSync(join(folder, 'learning.sqlite'));
  const until = async (check) => { for (let n = 0; n < 300; n++) { if (check()) return; await delay(20); } throw new Error('Background lane timed out'); };
  t.after(async () => {
    release();
    try { await until(() => ['ready', 'error'].includes(db.prepare("SELECT state FROM audio WHERE id='held-audio'").get()?.state)); }
    finally {
      await learning.remove('audio'); await learning.remove('reading'); db.close(); globalThis.fetch = oldFetch;
      if (oldURL === undefined) delete process.env.READER_KOKORO_URL; else process.env.READER_KOKORO_URL = oldURL;
      await rm(folder, { recursive: true, force: true });
    }
  });
  const text = 'People read books in the library. They enjoyed the story and talked about the characters afterwards.';
  for (const id of ['audio', 'reading']) {
    db.prepare("INSERT INTO analyses(book,owner,language,state,languageSelection,textVersion) VALUES(?,'','en','ready','[\"en\"]',1)").run(id);
    db.prepare('INSERT INTO chapters(book,key,ordinal,title,text,digest,tokens,lemmas) VALUES(?,?,?,?,?,?,?,?)').run(id, 'epub:0', 0, 'Chapter', text, id, '[]', '[]');
  }
  const options = { voice: 'ef_dora', model: 'kokoro', speed: 1, baseUrl: process.env.READER_KOKORO_URL };
  db.prepare('INSERT INTO audio(id,book,chapter,digest,options,state,created) VALUES(?,?,?,?,?,?,?)').run('held-audio', 'audio', 'epub:0', 'audio', JSON.stringify(options), 'queued', Date.now());
  learning.ensure(books.audio); await generating;
  learning.estimates.queue(books.reading);
  await until(() => learning.estimates.status(books.reading)?.state === 'ready');
  assert.equal(db.prepare("SELECT state FROM audio WHERE id='held-audio'").get().state, 'generating');
  assert.equal(learning.estimates.status(books.reading).text, 'Completed while audio was pending.');
});
