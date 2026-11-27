import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProcesses } from '../server/processes.js';
import { openProcessScheduler } from '../server/process-scheduler.js';

test('process overview filters book ownership and projects only status fields from every worker queue', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-processes-')), db = new DatabaseSync(join(dir, 'learning.sqlite'));
  db.exec(`CREATE TABLE analyses(book,state,error); CREATE TABLE estimates(book,state,error,queuedAt);
    CREATE TABLE book_audio(id,book,state,error,created,parts); CREATE TABLE audio(id,book,state,error,created);
    CREATE TABLE worker_progress(id,book,json);
    CREATE TABLE recordings(id,book,name,state,error,created,progress); CREATE TABLE audio_rescans(id,book,state,error,created,cursor,windows);
    CREATE TABLE ivoox_imports(id,book,state,error,created,bytes); CREATE TABLE import_narration(book,due,minutes,state,error);`);
  const stamp = Date.now();
  for (const book of ['one', 'two']) {
    db.prepare('INSERT INTO import_narration VALUES(?,?,?,?,?)').run(book, stamp + 60000, 1, 'waiting', null);
    db.prepare('INSERT INTO analyses VALUES(?,?,?)').run(book, 'running', null);
    db.prepare('INSERT INTO estimates VALUES(?,?,?,?)').run(book, 'queued', null, stamp);
    db.prepare('INSERT INTO book_audio VALUES(?,?,?,?,?,?)').run(book, book, 'queued', null, stamp, JSON.stringify([{ id: book }]));
    db.prepare('INSERT INTO audio VALUES(?,?,?,?,?)').run(book, book, 'generating', null, stamp);
    db.prepare('INSERT INTO recordings VALUES(?,?,?,?,?,?,?)').run(book, book, 'Recording', 'syncing', null, stamp, .4);
    db.prepare('INSERT INTO audio_rescans VALUES(?,?,?,?,?,?,?)').run(book, book, 'running', null, stamp, 1, '[{},{}]');
    db.prepare('INSERT INTO ivoox_imports VALUES(?,?,?,?,?,?)').run(book, book, 'downloading', null, stamp, 1024);
  }
  const handles = [db];
  for (const [file, field] of [['pdf-ocr.sqlite', 'source'], ['audiobookshelf.sqlite', 'book']]) {
    const next = new DatabaseSync(join(dir, file)); handles.push(next); next.exec('CREATE TABLE jobs(json TEXT)');
    for (const book of ['one', 'two']) next.prepare('INSERT INTO jobs VALUES(?)').run(JSON.stringify({ id: book, [field]: book, state: 'queued', apiKey: 'must-not-leak', kind: 'export', server: 'private-server' }));
  }
  let calls = 0;
  const scheduler = openProcessScheduler(dir, { paused: true });
  const process = openProcesses(dir, { library: { snapshot(visitor) { calls++; return { books: [{ id: visitor.id, title: 'Owned book' }] }; } },
    account: (visitor) => visitor, discovery: { status: () => ({}) }, learning: { textProcesses: () => [{ book: 'one', state: 'running' }, { book: 'two', state: 'running' }] },
    scheduler,
    archive: { list: () => [{ id: 'download', state: 'retry_wait', nextAttempt: stamp + 10000, details: { title: 'Queued book' }, apiKey: 'must-not-leak', source: 'private-url' },
      { id: 'queued', state: 'queued', created: stamp, details: { title: 'Ready to download' } },
      { id: 'finished', state: 'complete', created: stamp }, { id: 'cancelled', state: 'cancelled', created: stamp }, { id: 'failed', state: 'error', created: stamp, error: 'Retry me' }] } });
  t.after(async () => { await scheduler.close(); process.close(); handles.forEach((handle) => handle.close()); await rm(dir, { recursive: true, force: true }); });
  const result = process.list({ id: 'one' }); assert.equal(result.unavailable, false); assert.equal(calls, 1);
  assert.ok(result.jobs.every((job) => !job.bookId || job.bookId === 'one'));
  assert.equal(result.jobs.find((job) => job.kind === 'recording').progress, 40); assert.equal(result.jobs.find((job) => job.kind === 'repair').progress, 50);
  assert.deepEqual(result.jobs.find((job) => job.kind === 'repair').counter, { complete: 1, total: 2, unit: 'windows' });
  assert.equal(result.jobs.find((job) => job.kind === 'narration').state, 'running', 'active child narration must not appear queued');
  db.prepare('INSERT INTO worker_progress VALUES(?,?,?)').run('audio:one', 'one', JSON.stringify({ phase: 'aligning', complete: 2, total: 8, unit: 'passages', startedAt: stamp, updatedAt: stamp + 1000 }));
  db.prepare('INSERT INTO worker_progress VALUES(?,?,?)').run('audio:two', 'two', JSON.stringify({ phase: 'aligning', complete: 7, total: 8, unit: 'passages', startedAt: stamp, privateField: 'must-not-leak' }));
  const narrated = process.list({ id: 'one' }).jobs.find((job) => job.kind === 'narration');
  assert.equal(narrated.progress, 25); assert.equal(narrated.phase, 'aligning');
  assert.deepEqual(narrated.counter, { complete: 0, total: 1, unit: 'sections' });
  assert.equal(narrated.activity.complete, 2); assert.equal(narrated.activity.total, 8);
  assert.equal(narrated.startedAt, stamp);
  assert.equal(JSON.stringify(process.list({ id: 'one' })).includes('must-not-leak'), false);
  handles[1].prepare('UPDATE jobs SET json=? WHERE rowid=1').run(JSON.stringify({ id: 'one', source: 'one', state: 'running', startedAt: stamp,
    scanProgress: { phase: 'scanning', complete: 12, total: 51 } }));
  const scanning = process.list({ id: 'one' }).jobs.find((job) => job.kind === 'ocr');
  assert.equal(scanning.counter.complete, 12); assert.equal(scanning.counter.total, 51); assert.equal(scanning.counter.unit, 'pages');
  assert.equal(scanning.progress, 12 / 51 * 100);
  assert.equal(result.jobs.find((job) => job.id === 'archive:download').state, 'waiting');
  assert.equal(result.jobs.some((job) => job.kind === 'audio-section'), false, 'parent audiobook already represents its constituent jobs');
  for (const kind of ['analysis', 'estimate', 'scheduled-narration', 'narration', 'recording', 'repair', 'ivoox', 'indexing', 'archive', 'ocr', 'audiobookshelf']) assert.ok(result.jobs.some((job) => job.kind === kind), kind);
  assert.equal(/must-not-leak|private-server|private-url/u.test(JSON.stringify(result)), false);
  assert.equal(result.jobs.some((job) => ['archive:finished', 'archive:cancelled'].includes(job.id)), false);
  assert.equal(result.jobs.find((job) => job.id === 'archive:failed').state, 'failed');
  db.prepare("UPDATE ivoox_imports SET state='ready' WHERE book='one'").run();
  assert.equal(process.list({ id: 'one' }).jobs.some((job) => job.kind === 'ivoox'), false, 'completed downloads clear on the next refresh');
  handles[1].prepare('UPDATE jobs SET json=? WHERE rowid=1').run(JSON.stringify({ id: 'old', source: 'one', state: 'error', created: 1, error: 'Old failure' }));
  handles[1].prepare('INSERT INTO jobs VALUES(?)').run(JSON.stringify({ id: 'new', source: 'one', state: 'error', created: 2, error: 'Current failure' }));
  const failures = process.list({ id: 'one' }).jobs.filter((job) => job.kind === 'ocr');
  assert.equal(failures.length, 1); assert.equal(failures[0].retryOcr, 'new');
  handles[1].prepare('INSERT INTO jobs VALUES(?)').run(JSON.stringify({ id: 'successful', source: 'one', state: 'ready', created: 3 }));
  assert.equal(process.list({ id: 'one' }).jobs.some((job) => job.kind === 'ocr'), false, 'a successful retry supersedes previous failures');
  const tasks = [scheduler.run('estimate:one', () => {}, { created: 1 }), scheduler.run('archive:queued', () => {}, { created: 2 })];
  const queued = process.list({ id: 'one' }).jobs.filter((job) => job.queuePosition);
  assert.deepEqual(queued.map((job) => [job.id, job.queuePosition, job.topPriority]), [
    ['archive:queued', 1, true], ['estimate:one', 2, false],
  ], 'the process overview exposes the same automatic priority and order used by the scheduler');
  assert.ok(queued.every((job) => job.canPrioritize), 'both categories retain manual priority controls');
  scheduler.top('estimate:one');
  assert.deepEqual(process.list({ id: 'one' }).jobs.filter((job) => job.queuePosition).map((job) => job.id), ['estimate:one','archive:queued']);
  scheduler.resume(); await Promise.all(tasks);
  const demo = openProcesses(dir, { library: { snapshot: () => ({ books: [{ id: 'two' }] }) }, account: (visitor) => visitor, discovery: { status: () => ({}) }, learning: { textProcesses: () => [] }, demo: true });
  assert.ok(demo.list({ id: 'two' }).jobs.every((job) => job.bookId === 'two')); demo.close();
});
