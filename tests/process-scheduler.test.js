import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { consumeProcesses, openProcessScheduler, PROCESS_YIELD } from '../server/process-scheduler.js';
import { openPDFOCR } from '../server/pdf-ocr.js';
import { openBookImports } from '../server/book-imports.js';
import { openLibrary } from '../server/books.js';
import { openLearning } from '../server/learning.js';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const gate = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); } throw new Error('Background queue did not advance'); }
async function fixture(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-scheduler-')), queue = openProcessScheduler(dir, options);
  t.after(async () => { await queue.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, queue };
}

test('one shared slot finishes the current task, then selects a promoted task from the middle of a provider queue', async (t) => {
  const { queue } = await fixture(t), held = gate(), started = gate(), events = [];
  const current = queue.run('ocr:current', async () => { events.push('current'); started.release(); await held.promise; events.push('current done'); });
  await started.promise;
  const jobs = [{ id: 'narration:first', created: 1 }, { id: 'narration:second', created: 2 }];
  const narration = consumeProcesses(queue, () => jobs.map((job) => ({ ...job, data: job })), async (job) => { events.push(job.id); });
  const other = queue.run('web-import:other', async () => events.push('web-import:other'), { created: 3 });
  queue.raise('narration:second');
  assert.equal(queue.snapshot().active.id, 'ocr:current'); assert.equal(queue.snapshot().queued[0].id, 'narration:second');
  await delay(10); assert.deepEqual(events, ['current']);
  held.release(); await Promise.all([current, narration, other]);
  assert.deepEqual(events, ['current', 'current done', 'narration:second', 'narration:first', 'web-import:other']);
});

test('Archive downloads take priority by default but an ordinary task can be raised above them and the current task', async (t) => {
  const { queue } = await fixture(t), held = gate(), started = gate(), events = [];
  const current = queue.run('ocr:current', async () => { events.push('current'); started.release(); await held.promise; events.push('current done'); });
  await started.promise;
  const other = queue.run('narration:older', () => events.push('narration'), { created: 1 });
  const download = queue.run('archive:new', () => events.push('download'), { created: 100 });
  try {
    const snapshot = queue.snapshot();
    assert.equal(snapshot.active.id, 'ocr:current');
    assert.deepEqual(snapshot.queued.map((job) => job.id), ['archive:new', 'narration:older']);
    assert.equal(snapshot.queued[0].topPriority, true);
    assert.equal(snapshot.queued[1].topPriority, false);
    queue.raise('narration:older');
    const raised = queue.snapshot();
    assert.deepEqual(raised.queued.map((job) => job.id), ['narration:older', 'archive:new']);
    assert.equal(raised.queued[0].position, 1);
    assert.equal(raised.active.pauseRequested, true);
    await delay(10); assert.deepEqual(events, ['current']);
  } finally { held.release(); await Promise.all([current, other, download]); }
  // This atomic worker has no safe checkpoint before finishing its operation.
  assert.deepEqual(events, ['current', 'current done', 'narration', 'download']);
});

test('bulk Archive downloads retain FIFO order and explicit top priority can override their default', async (t) => {
  const { queue } = await fixture(t, { paused: true }), events = [];
  const jobs = ['first', 'second', 'third'].map((name, index) => ({ id: `archive:${name}`, created: index + 10 }));
  const downloads = consumeProcesses(queue, () => jobs.map((job) => ({ ...job, data: job.id })), (id) => events.push(id));
  const ordinary = queue.run('web-import:older', () => events.push('web-import:older'), { created: 1 });
  try {
    assert.deepEqual(queue.snapshot().queued.map((job) => job.id), ['archive:first', 'archive:second', 'archive:third', 'web-import:older']);
    queue.raise('archive:third');
    assert.deepEqual(queue.snapshot().queued.map((job) => job.id), ['archive:third', 'archive:first', 'archive:second', 'web-import:older']);
    queue.top('web-import:older');
    assert.deepEqual(queue.snapshot().queued.map((job) => job.id), ['web-import:older', 'archive:third', 'archive:first', 'archive:second']);
    assert.equal(queue.snapshot().queued.find((job) => job.id === 'archive:third').topPriority, false);
  } finally { queue.resume(); await Promise.all([downloads, ordinary]); }
  assert.deepEqual(events, ['web-import:older', 'archive:third', 'archive:first', 'archive:second']);
});

test('a worker yields to a promoted sibling and resumes its saved checkpoint without overlapping work', { timeout: 10000 }, async (t) => {
  const { queue } = await fixture(t, { paused: true }), firstStarted = gate(), holdFirst = gate(), holdSecond = gate(), events = [];
  const jobs = ['narration:first', 'narration:second'].map((id, index) => ({ id, created: index + 1 }));
  const completed = new Map(jobs.map((job) => [job.id, 0])); let concurrent = 0, maximum = 0;
  const work = consumeProcesses(queue, () => jobs.map((job) => ({ ...job, data: job.id })), async (id) => {
    while (completed.get(id) < 2) {
      const step = completed.get(id);
      concurrent++; maximum = Math.max(maximum, concurrent);
      try {
        events.push(`${id}:${step}`);
        if (id === 'narration:first' && step === 0) { firstStarted.release(); await holdFirst.promise; }
        if (id === 'narration:second' && step === 0) await holdSecond.promise;
        completed.set(id, step + 1);
      } finally { concurrent--; }
      if (completed.get(id) < 2 && queue.shouldYield()) return PROCESS_YIELD;
    }
    events.push(`${id}:done`);
  });
  queue.resume(); await firstStarted.promise;
  try {
    queue.raise('narration:second');
    assert.equal(queue.snapshot().active.pauseRequested, true);
    assert.deepEqual(events, ['narration:first:0']);
    holdFirst.release();
    await until(() => events.includes('narration:second:0'));
    const snapshot = queue.snapshot();
    assert.equal(snapshot.active.id, 'narration:second');
    assert.equal(snapshot.queued.find((job) => job.id === 'narration:first').paused, true);
    assert.equal(completed.get('narration:first'), 1);
  } finally { holdFirst.release(); holdSecond.release(); await work; }
  assert.equal(maximum, 1);
  assert.deepEqual(events, ['narration:first:0', 'narration:second:0', 'narration:second:1', 'narration:second:done', 'narration:first:1', 'narration:first:done']);
});

test('raise preserves jobs already above the active task and top and lowest also work on the active task', async (t) => {
  const { queue } = await fixture(t), held = gate(), started = gate(), events = [];
  const current = queue.run('ocr:current', async () => { started.release(); await held.promise; events.push('current'); });
  await started.promise;
  // The older target must not jump ahead of a newer job already above current.
  const older = queue.run('narration:older', () => events.push('older'), { created: 1 });
  const higher = queue.run('narration:higher', () => events.push('higher'), { created: 3 });
  try {
    queue.top('ocr:current'); queue.top('narration:higher'); queue.raise('narration:older');
    let snapshot = queue.snapshot();
    assert.deepEqual(snapshot.queued.map((job) => job.id), ['narration:higher', 'narration:older']);
    assert.equal(snapshot.active.position, 3);
    assert.equal(snapshot.active.pauseRequested, true);
    queue.lowest('narration:higher'); queue.lowest('ocr:current');
    snapshot = queue.snapshot();
    assert.deepEqual(snapshot.queued.map((job) => job.id), ['narration:older', 'narration:higher']);
    assert.equal(snapshot.active.position, 3);
    queue.top('ocr:current');
    snapshot = queue.snapshot();
    assert.equal(snapshot.active.position, 1);
    assert.equal(snapshot.active.pauseRequested, false);
    const previous = snapshot.active.priority; queue.raise('ocr:current');
    assert.ok(queue.snapshot().active.priority > previous);
  } finally { held.release(); await Promise.all([current, older, higher]); }
  assert.deepEqual(events, ['current', 'older', 'higher']);
});

test('a blocked top-priority download cannot force yielding and takes its place once ready', async (t) => {
  const { queue } = await fixture(t, { paused: true }), held = gate(), started = gate(), events = []; let ready = false;
  const download = queue.runNext(() => [{ id: 'archive:retry', ready, created: 1 }], () => events.push('download'));
  const first = queue.run('ocr:ready', async () => {
    started.release(); await held.promise;
    assert.equal(queue.shouldYield(), false, 'waiting for retry time cannot preempt eligible work');
    events.push('first');
  }, { created: 2 });
  queue.resume(); await started.promise;
  try {
    queue.top('archive:retry');
    assert.equal(queue.snapshot().active.pauseRequested, false);
  } finally { held.release(); await first; }
  assert.deepEqual(events, ['first']);
  assert.equal(queue.snapshot().queued.find((job) => job.id === 'archive:retry').ready, false);
  const next = queue.run('narration:next', () => events.push('next'), { created: 3 });
  ready = true; queue.wake();
  await Promise.all([download, next]);
  assert.deepEqual(events, ['first', 'download', 'next']);
});

test('saved manual priorities survive restart and override automatic Archive priority in both directions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-archive-priority-'));
  // A queue database from before Archive downloads had automatic priority.
  const saved = new DatabaseSync(join(dir, 'process-queue.sqlite'));
  saved.exec('CREATE TABLE ordering(id TEXT PRIMARY KEY, priority INTEGER NOT NULL, queuedAt INTEGER NOT NULL) STRICT;');
  const insert = saved.prepare('INSERT INTO ordering VALUES(?,?,?)');
  insert.run('ocr:old', 0, 1);
  insert.run('narration:promoted', 1000000, 2);
  insert.run('archive:first', 0, 3);
  insert.run('archive:lowest', -1, 4);
  saved.close();
  const queue = openProcessScheduler(dir, { paused: true }), events = [];
  t.after(async () => { await queue.close(); await rm(dir, { recursive: true, force: true }); });
  const jobs = ['ocr:old', 'narration:promoted', 'archive:first', 'archive:lowest'];
  const tasks = jobs.map((id) => queue.run(id, () => events.push(id)));
  assert.deepEqual(queue.snapshot().queued.map((job) => job.id), ['narration:promoted', 'archive:first', 'ocr:old', 'archive:lowest']);
  queue.resume(); await Promise.all(tasks);
  assert.deepEqual(events, ['narration:promoted', 'archive:first', 'ocr:old', 'archive:lowest']);
});

test('queued priority survives restart and completed work does not retain a priority override', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-priority-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let queue = openProcessScheduler(dir, { paused: true });
  const waiting = [queue.run('first', () => {}, { created: 1 }), queue.run('second', () => {}, { created: 2 })];
  queue.raise('second'); await queue.close(); await Promise.all(waiting);
  queue = openProcessScheduler(dir, { paused: true }); const order = [];
  const tasks = [queue.run('first', () => order.push('first')), queue.run('second', () => order.push('second'))];
  assert.equal(queue.snapshot().queued[0].id, 'second'); queue.resume(); await Promise.all(tasks);
  assert.deepEqual(order, ['second', 'first']); await queue.close();
  queue = openProcessScheduler(dir, { paused: true });
  const again = queue.run('second', () => {}); assert.equal(queue.snapshot().queued[0].priority, 0);
  await queue.close(); await again;
});

test('another task from the currently running provider remains available for reprioritization', async (t) => {
  const { queue } = await fixture(t), held = gate(), started = gate(), order = [];
  const consume = consumeProcesses(queue, () => ['first','second'].map((id) => ({ id, data: id })), async (id) => {
    order.push(id); if (id === 'first') { started.release(); await held.promise; }
  });
  await started.promise;
  assert.ok(queue.snapshot().queued.some((job) => job.id === 'second'));
  assert.ok(queue.raise('second').priority > 0);
  held.release(); await consume; assert.deepEqual(order, ['first','second']);
});

test('queued cancellation and worker failures release admission without interrupting another task', async (t) => {
  const { queue } = await fixture(t), held = gate(), started = gate(); let valid = true, ran = false;
  const first = queue.run('active', async () => { started.release(); await held.promise; }); await started.promise;
  const cancelled = queue.run('cancelled', () => { ran = true; }, { valid: () => valid });
  valid = false; queue.wake(true); await cancelled; assert.equal(ran, false);
  held.release(); await first;
  const failed = assert.rejects(queue.run('failure', () => { throw new Error('Synthetic worker failure'); }), /Synthetic/u);
  const next = queue.run('next', () => 42); await failed; assert.equal(await next, 42);
});

test('a task can await already-queued text extraction inside its own slot without deadlocking', async (t) => {
  const { queue } = await fixture(t, { paused: true }); let text; const events = [];
  const analysis = queue.run('analysis:book', async () => { events.push('analysis'); await queue.join('indexing:book', text); events.push('finished'); }, { created: 1 });
  text = queue.run('indexing:book', () => events.push('text'), { created: 2 });
  const other = queue.run('ocr:other', () => events.push('other'), { created: 3 });
  queue.resume(); await Promise.all([analysis, text, other]); assert.deepEqual(events, ['analysis', 'text', 'finished', 'other']);
});

test('promoting blocked analysis promotes its prerequisite while still waiting for text to be ready', async (t) => {
  const { queue } = await fixture(t, { paused: true }); let textReady = false; const events = [];
  const analysis = queue.runNext(() => [{ id: 'analysis:book', created: 1, ready: textReady, dependencies: ['indexing:book'] }], () => events.push('analysis'));
  const other = queue.run('ocr:other', () => events.push('other'), { created: 2 });
  const text = queue.run('indexing:book', () => { textReady = true; events.push('text'); }, { created: 3 });
  queue.raise('analysis:book'); queue.resume(); await Promise.all([analysis, other, text]);
  assert.deepEqual(events, ['text', 'analysis', 'other']);
});

test('an active prerequisite retains inherited priority and another task can be raised above it', async (t) => {
  const { queue } = await fixture(t, { paused: true }), started = gate(), held = gate(), events = [];
  let textReady = false, attempts = 0, wouldYield;
  const analysis = queue.runNext(() => [{ id: 'analysis:book', created: 1, ready: textReady, dependencies: ['indexing:book'] }], () => events.push('analysis'));
  const text = queue.run('indexing:book', async () => {
    events.push(`text:${++attempts}`);
    if (attempts === 1) {
      wouldYield = queue.shouldYield(); started.release(); await held.promise;
      if (queue.shouldYield()) return PROCESS_YIELD;
    }
    textReady = true;
  }, { created: 2 });
  const archive = queue.run('archive:other', () => events.push('archive'), { created: 3 });
  queue.top('analysis:book'); queue.resume(); await started.promise;
  try {
    const snapshot = queue.snapshot();
    assert.equal(snapshot.active.id, 'indexing:book');
    assert.equal(snapshot.active.priority, snapshot.queued.find((job) => job.id === 'analysis:book').priority);
    assert.equal(wouldYield, false, 'default Archive priority must not interrupt a promoted prerequisite');
    assert.equal(snapshot.active.pauseRequested, false);
    queue.raise('archive:other');
    const raised = queue.snapshot();
    assert.ok(raised.queued.find((job) => job.id === 'archive:other').priority > raised.active.priority);
    assert.equal(raised.active.pauseRequested, true);
  } finally { held.release(); await Promise.all([analysis, text, archive]); }
  assert.deepEqual(events, ['text:1', 'archive', 'text:2', 'analysis']);
});

test('lowest priority explicitly demotes a running prerequisite without allowing its dependent to run early', async (t) => {
  const { queue } = await fixture(t, { paused: true }), started = gate(), held = gate(), events = [];
  let textReady = false, attempts = 0;
  const analysis = queue.runNext(() => [{ id: 'analysis:book', created: 1, ready: textReady, dependencies: ['indexing:book'] }], () => {
    assert.equal(textReady, true); events.push('analysis');
  });
  const text = queue.run('indexing:book', async () => {
    events.push(`text:${++attempts}`);
    if (attempts === 1) { started.release(); await held.promise; if (queue.shouldYield()) return PROCESS_YIELD; }
    textReady = true;
  }, { created: 2 });
  const archive = queue.run('archive:other', () => events.push('archive'), { created: 3 });
  queue.top('analysis:book'); queue.resume(); await started.promise;
  try {
    queue.lowest('indexing:book');
    const snapshot = queue.snapshot();
    assert.ok(snapshot.active.priority < 0);
    assert.equal(snapshot.active.position, 3);
    assert.equal(snapshot.active.pauseRequested, true);
    assert.equal(snapshot.queued.find((job) => job.id === 'analysis:book').ready, false);
  } finally { held.release(); await Promise.all([analysis, text, archive]); }
  assert.deepEqual(events, ['text:1', 'archive', 'text:2', 'analysis']);
});

test('real OCR and web-import workers share the slot and a promoted second download starts first', async (t) => {
  const { dir, queue } = await fixture(t, { paused: true }), library = await openLibrary(dir);
  const source = Buffer.from('%PDF-1.4\nsynthetic searchable PDF\n%%EOF'), path = join(library.uploads, 'source.pdf');
  await writeFile(path, source); const book = await library.importBook('source', { path, size: source.length, originalname: 'source.pdf' }, { title: 'Source book' });
  const held = gate(), started = gate(), downloads = [];
  const ocr = await openPDFOCR(dir, { library, scheduler: queue, request: async (_url, options) => {
    for await (const chunk of options.body) void chunk;
    started.release(); await held.promise; return new Response(source);
  } });
  const imports = await openBookImports(dir, { library, scheduler: queue, request: async (url) => {
    assert.equal(ocr.status(book).state, 'ready', 'OCR must finish saving before a download starts'); downloads.push(String(url));
    const body = Readable.from([source]); body.statusCode = 200; body.headers = { 'content-length': String(source.length) }; return body;
  } });
  t.after(() => { ocr.close(); imports.close(); });
  ocr.queue(book, { languages: ['eng'] }); queue.resume(); await started.promise;
  const first = imports.queue({ url: 'https://books.example.org/first.pdf' }), second = imports.queue({ url: 'https://books.example.org/second.pdf' });
  queue.raise(`web-import:${second.id}`); await delay(10); assert.deepEqual(downloads, []);
  held.release();
  await until(() => imports.list().filter((job) => [first.id, second.id].includes(job.id)).every((job) => job.state === 'ready'));
  await until(() => !queue.snapshot().active && !queue.snapshot().queued.length);
  assert.deepEqual(downloads, ['https://books.example.org/second.pdf', 'https://books.example.org/first.pdf']);
});

test('a promoted audiobook finishes all sections and final assembly before the other book starts', async (t) => {
  const { dir, queue } = await fixture(t, { paused: true }), originalFetch = globalThis.fetch, originalURL = process.env.READER_KOKORO_URL;
  process.env.READER_KOKORO_URL = 'http://kokoro.test/v1';
  const wav = join(dir, 'sample.wav');
  await promisify(execFile)('ffmpeg', ['-nostdin','-v','error','-y','-f','lavfi','-i','sine=frequency=220:duration=1','-ar','24000',wav]);
  const speech = await readFile(wav), order = [], books = { one: { id: 'one', language: 'en' }, two: { id: 'two', language: 'en' } };
  let db;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (new URL(url).pathname === '/v1/audio/speech') {
      if (body.input.startsWith('one')) assert.equal(db.prepare("SELECT state FROM book_audio WHERE book='two'").get().state, 'ready', 'final assembly must finish before the next audiobook');
      order.push(body.input); return new Response(speech);
    }
    if (new URL(url).pathname === '/align') return Response.json({ timings: body.words.map((_, index) => ({ start: index / body.words.length, end: (index + .8) / body.words.length })) });
    throw new Error('Unexpected request');
  };
  const learning = await openLearning(dir, { getBook: (id) => books[id] }, false, {}, { scheduler: queue, autoRepair: false });
  db = new DatabaseSync(join(dir, 'learning.sqlite'));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalURL === undefined) delete process.env.READER_KOKORO_URL; else process.env.READER_KOKORO_URL = originalURL;
    await learning.remove('one'); await learning.remove('two'); db.close();
  });
  for (const id of ['one','two']) {
    db.prepare("INSERT INTO analyses(book,owner,language,state,languageSelection,textVersion) VALUES(?,'','en','ready','[\"en\"]',1)").run(id);
    for (const index of [0,1]) db.prepare('INSERT INTO chapters(book,key,ordinal,title,text,digest,tokens,lemmas) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, `epub:${index}`, index, 'Section', `${id} section ${index} has a short sentence.`, `${id}-${index}`, '[]', '[]');
  }
  learning.queueBook(books.one); const promoted = learning.queueBook(books.two);
  queue.raise(`narration:${promoted.id}`); queue.resume();
  for (let i = 0; i < 600; i++) {
    const statuses = ['one','two'].map((id) => learning.narration(books[id]).audio);
    assert.ok(statuses.every((item) => item.state !== 'error'), JSON.stringify(statuses));
    if (statuses.every((item) => item.state === 'ready')) break;
    await delay(20);
  }
  assert.equal(learning.narration(books.one).audio.state, 'ready');
  await until(() => !queue.snapshot().active);
  assert.deepEqual(order.map((text) => text.split(' ')[0]), ['two','two','one','one']);
});
