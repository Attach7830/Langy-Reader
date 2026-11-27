import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { openArchive } from '../server/annas-archive.js';
import { openLibrary } from '../server/books.js';
import { openProcessScheduler } from '../server/process-scheduler.js';
import { sampleBook } from '../server/sample.js';

const gate = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
async function until(check) {
  for (let count = 0; count < 500; count++) { if (check()) return; await delay(10); }
  throw new Error('The archive continuation did not advance');
}
const response = (body) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { statusCode: 200, headers: {} });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-archive-continuation-')), library = await openLibrary(dir);
  const slowBytes = await sampleBook(), zip = await JSZip.loadAsync(slowBytes);
  zip.file('edition.txt', 'other queued edition');
  const fastBytes = await zip.generateAsync({ type: 'nodebuffer' });
  const slowMD5 = createHash('md5').update(slowBytes).digest('hex'), fastMD5 = createHash('md5').update(fastBytes).digest('hex');
  const scheduler = openProcessScheduler(dir), metadata = [], downloads = [], imported = [], streams = [], operations = [], releases = [];
  let active = 0, peak = 0, slowAttempts = 0;
  const directURL = 'https://files.example.test/slow.epub?token=original-link';
  const request = async (value, { signal }) => {
    const url = new URL(value);
    if (url.pathname === '/dyn/api/fast_download.json') {
      const md5 = url.searchParams.get('md5'); metadata.push(md5);
      if (md5 === slowMD5 && metadata.filter((item) => item === slowMD5).length === 1)
        return Object.assign(response({ error: 'quota_exceeded' }), { statusCode: 429 });
      return response({ download_url: `https://files.example.test/member/${md5}` });
    }
    downloads.push(url.href);
    const direct = url.pathname === '/slow.epub', bytes = direct || url.pathname.endsWith(slowMD5) ? slowBytes : fastBytes;
    const stalled = direct && ++slowAttempts === 1;
    let started = false, counted = false, ended = false;
    const prefix = Math.min(32, bytes.length);
    const stream = new Readable({
      read() {
        if (started) return;
        started = counted = true; active++; peak = Math.max(peak, active);
        this.push(stalled ? bytes.subarray(0, prefix) : bytes);
        if (!stalled) { ended = true; this.push(null); }
      },
      destroy(error, done) { if (counted) { counted = false; active--; } done(error); },
    });
    const abort = () => stream.destroy(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    stream.once('close', () => signal.removeEventListener('abort', abort));
    stream.release = () => {
      if (started && !ended && !stream.destroyed) { ended = true; stream.push(bytes.subarray(prefix)); stream.push(null); }
    };
    streams.push(stream);
    return Object.assign(stream, { statusCode: 200, headers: { 'content-length': String(bytes.length) } });
  };
  const archive = await openArchive(dir, { library, scheduler, request, autoStart: false, onImport: (book) => imported.push(book.id) });
  await archive.save({ apiKey: 'synthetic-test-key' });
  t.after(async () => {
    releases.forEach((release) => release()); streams.forEach((stream) => stream.release()); archive.close();
    await Promise.allSettled(operations);
    await until(() => !scheduler.snapshot().active); await scheduler.close(); await rm(dir, { recursive: true, force: true });
  });
  const slow = archive.queue({ reference: slowMD5 }); await archive.pump();
  assert.equal(archive.job(slow.id).state, 'needs_action');
  const blocker = gate(); releases.push(blocker.release);
  operations.push(scheduler.run('analysis:initial', () => blocker.promise));
  await until(() => scheduler.snapshot().active?.id === 'analysis:initial');
  const fast = archive.queue({ reference: fastMD5 }), work = archive.pump(); operations.push(work);
  assert.ok(scheduler.snapshot().queued.some((job) => job.id === `archive:${fast.id}`));
  archive.continue(slow.id, { url: directURL }); scheduler.top(`archive:${slow.id}`); blocker.release();
  await until(() => active === 1 && slowAttempts === 1);
  const urgent = gate(); releases.push(urgent.release);
  const promoted = scheduler.run('analysis:urgent', () => urgent.promise); operations.push(promoted); scheduler.top('analysis:urgent');
  await until(() => scheduler.snapshot().active?.id === 'analysis:urgent');
  assert.equal(active, 0, 'the old stream must finish closing before the promoted task runs');
  return { archive, scheduler, library, slow, fast, work, promoted, urgent, metadata, downloads, imported, directURL, slowMD5, fastMD5,
    peak: () => peak, slowAttempts: () => slowAttempts };
}

test('a paused slow continuation keeps exclusive ownership while the generic archive pump is pending', { timeout: 10000 }, async (t) => {
  const f = await fixture(t), paused = f.scheduler.snapshot().queued.filter((job) => job.id === `archive:${f.slow.id}`);
  assert.equal(paused.length, 1, 'the generic pump must not register the continuation a second time');
  assert.equal(paused[0].paused, true);
  assert.equal(f.archive.job(f.slow.id).source, 'slow');
  f.urgent.release(); await Promise.all([f.work, f.promoted]);
  await until(() => !f.scheduler.snapshot().active && !f.scheduler.snapshot().queued.length);
  const slow = f.archive.job(f.slow.id), fast = f.archive.job(f.fast.id);
  assert.equal(slow.state, 'ready', slow.error); assert.equal(slow.source, 'slow'); assert.equal(fast.state, 'ready', fast.error);
  assert.deepEqual(f.metadata, [f.slowMD5, f.fastMD5], 'the paused slow job must not retry the membership API');
  assert.deepEqual(f.downloads, [f.directURL, f.directURL, `https://files.example.test/member/${f.fastMD5}`]);
  assert.deepEqual(f.imported, [slow.book.id, fast.book.id], 'each edition must be imported exactly once');
  assert.equal(f.peak(), 1); assert.deepEqual(await readdir(f.library.uploads), []);
});

test('cancelling a paused slow continuation releases its ownership without replaying the download', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  assert.equal(f.archive.job(f.slow.id).state, 'queued');
  f.archive.cancel(f.slow.id);
  assert.equal(f.scheduler.snapshot().queued.some((job) => job.id === `archive:${f.slow.id}`), false);
  f.urgent.release(); await Promise.all([f.work, f.promoted]);
  await until(() => !f.scheduler.snapshot().active && !f.scheduler.snapshot().queued.length);
  assert.equal(f.archive.job(f.slow.id).state, 'cancelled'); assert.equal(f.slowAttempts(), 1);
  assert.deepEqual(f.imported, [f.archive.job(f.fast.id).book.id]); assert.deepEqual(await readdir(f.library.uploads), []);
  const replacement = f.archive.queue({ reference: f.slowMD5, downloadMode: 'slow' }); await f.archive.pump();
  f.archive.continue(replacement.id, { url: f.directURL });
  await until(() => f.archive.job(replacement.id).state === 'ready');
  assert.equal(f.archive.job(replacement.id).source, 'slow');
  assert.equal(f.slowAttempts(), 2); assert.equal(f.peak(), 1);
});
