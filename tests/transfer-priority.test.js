import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';
import { openBookImports } from '../server/book-imports.js';
import { openArchive } from '../server/annas-archive.js';
import { openProcessScheduler } from '../server/process-scheduler.js';

const gate = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
async function until(check) { for (let i = 0; i < 500; i++) { if (check()) return; await delay(10); } throw new Error('The transfer queue did not advance'); }

function transfer(bytes, signal, stalled, counters, events) {
  let started = false, held = stalled, ended = false, counted = false;
  const prefix = Math.min(32, bytes.length);
  const stream = new Readable({
    read() {
      if (started) return;
      started = counted = true; counters.active++; counters.peak = Math.max(counters.peak, counters.active);
      events.push('transfer started');
      this.push(held ? bytes.subarray(0, prefix) : bytes);
      if (!held) { ended = true; this.push(null); }
    },
    destroy(error, done) {
      if (counted) { counted = false; counters.active--; events.push('transfer closed'); }
      done(error);
    },
  });
  const abort = () => stream.destroy(signal.reason || new DOMException('Aborted', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  stream.once('close', () => signal.removeEventListener('abort', abort));
  stream.release = () => {
    held = false;
    if (started && !ended && !stream.destroyed) { ended = true; stream.push(bytes.subarray(prefix)); stream.push(null); }
  };
  return Object.assign(stream, { statusCode: 200, headers: { 'content-length': String(bytes.length) } });
}

async function fixture(t, kind) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-transfer-priority-')), library = await openLibrary(dir), bytes = await sampleBook();
  const initialBooks = library.snapshot().books.length;
  const scheduler = openProcessScheduler(dir), counters = { active: 0, peak: 0, attempts: 0 }, events = [], streams = [], imports = [], operations = [], releases = [];
  const request = async (value, { signal }) => {
    const url = new URL(value);
    if (url.pathname === '/dyn/api/fast_download.json') return Object.assign(Readable.from([Buffer.from(JSON.stringify({ download_url: 'https://files.example.test/book.epub' }))]), { statusCode: 200, headers: {} });
    const stream = transfer(bytes, signal, ++counters.attempts === 1, counters, events);
    streams.push(stream); return stream;
  };
  const options = { library, scheduler, autoStart: false, request, onImport: (book) => { imports.push(book.id); events.push('imported'); } };
  const service = kind === 'archive' ? await openArchive(dir, options) : await openBookImports(dir, options);
  if (kind === 'archive') await service.save({ apiKey: 'synthetic-test-key' });
  const job = service.queue(kind === 'archive' ? { reference: createHash('md5').update(bytes).digest('hex') } : { url: 'https://books.example.test/book.epub' });
  const id = `${kind === 'archive' ? 'archive' : 'web-import'}:${job.id}`;
  const status = () => service.list().find((item) => item.id === job.id);
  t.after(async () => {
    releases.forEach((release) => release()); streams.forEach((stream) => stream.release()); service.close();
    await Promise.allSettled(operations); await scheduler.close(); await rm(dir, { recursive: true, force: true });
  });
  return { dir, library, initialBooks, bytes, scheduler, counters, events, streams, imports, operations, releases, service, job, id, status };
}

for (const kind of ['web', 'archive']) {
  test(`${kind} download yields after stream cleanup, resumes, and imports exactly once`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, kind), held = gate(); f.releases.push(held.release);
    const work = f.service.pump(); f.operations.push(work);
    await until(() => f.counters.active === 1);
    let observed;
    const promoted = f.scheduler.run('analysis:promoted', async () => {
      f.events.push('promoted');
      observed = { activeTransfers: f.counters.active, status: f.status(), snapshot: f.scheduler.snapshot() };
      await held.promise;
    });
    f.operations.push(promoted); f.scheduler.top('analysis:promoted');
    try {
      await until(() => observed);
      assert.equal(observed.activeTransfers, 0, 'the original stream must close before another task starts');
      assert.equal(observed.status.state, 'queued');
      assert.equal(observed.status.error, null);
      assert.equal(observed.snapshot.queued.find((job) => job.id === f.id).paused, true);
      assert.equal(f.imports.length, 0);
      assert.equal(f.counters.attempts, 1);
    } finally { held.release(); f.streams.forEach((stream) => stream.release()); }
    await Promise.all([work, promoted]);
    const done = f.status(), book = kind === 'archive' ? done.book : f.library.getBook(done.book);
    assert.equal(done.state, 'ready', done.error);
    assert.equal(done.error, null);
    assert.equal(f.counters.attempts, 2);
    assert.equal(f.counters.peak, 1);
    assert.deepEqual(f.imports, [book.id]);
    assert.equal(f.library.snapshot().books.length, f.initialBooks + 1);
    assert.deepEqual(await readFile(f.library.filePath(book)), f.bytes);
    assert.deepEqual(await readdir(f.library.uploads), []);
    assert.deepEqual(f.events, ['transfer started', 'transfer closed', 'promoted', 'transfer started', 'transfer closed', 'imported']);
  });

  test(`cancelling a ${kind} download while priority changes never requeues or imports it`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, kind), work = f.service.pump(); f.operations.push(work);
    await until(() => f.counters.active === 1);
    let activeWhenPromoted;
    const promoted = f.scheduler.run('analysis:promoted', () => { activeWhenPromoted = f.counters.active; });
    f.operations.push(promoted); f.scheduler.top('analysis:promoted'); f.service.cancel(f.job.id);
    await Promise.all([work, promoted]);
    assert.equal(activeWhenPromoted, 0);
    assert.equal(f.status().state, 'cancelled');
    assert.equal(f.status().error, null);
    assert.equal(f.counters.attempts, 1);
    assert.equal(f.counters.peak, 1);
    assert.deepEqual(f.imports, []);
    assert.equal(f.library.snapshot().books.length, f.initialBooks);
    assert.deepEqual(await readdir(f.library.uploads), []);
  });
}
