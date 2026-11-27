import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readingPackQueue } from '../src/offline-download-queue.js';
import { measuredResponse, fetchPackResource, downloadProgressLabel } from '../src/offline-transfer.js';

const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await delay(2); } throw new Error('Download queue timed out'); }
function fixture(t, options = {}) {
  const values = new Map(), store = { all: async () => structuredClone([...values.values()]), put: async (value) => values.set(value.id, structuredClone(value)), remove: async (id) => values.delete(id) };
  let account = 'one', connected = true;
  const queue = readingPackQueue({ store, owner: () => account, online: () => connected, ...options }); t.after(() => queue.close());
  return { queue, store, values, account(value) { account = value; }, online(value) { connected = value; } };
}
const book = (id) => ({ id, title: `Book ${id}`, format: 'epub' });

test('book packs persist before starting, download serially, report progress and deduplicate repeated queue clicks', async (t) => {
  const release = gate(), calls = [], snapshots = []; let active = 0, peak = 0;
  const f = fixture(t, { async download(book, { progress }) {
    assert.ok(f.values.get(`one:${book.id}`)); active++; peak = Math.max(peak, active); calls.push(book.id);
    progress({ phase: 'book', label: 'Downloading book', loaded: 3, total: 10, percent: 8 });
    if (book.id === 'a') await release.promise; active--;
  } });
  f.queue.subscribe((jobs) => snapshots.push(jobs));
  await f.queue.enqueue(book('a'), { audio: true, recording: 'narrator' });
  await f.queue.enqueue(book('b'), { audio: false }); await f.queue.enqueue(book('a'), { audio: false });
  assert.deepEqual(calls, ['a']); assert.equal(f.queue.snapshot().length, 2); assert.equal(f.queue.snapshot()[1].state, 'queued');
  assert.ok(snapshots.some((jobs) => jobs[0]?.progress?.loaded === 3));
  assert.equal(f.values.get('one:a').options.recording, 'narrator');
  release.resolve(); await f.queue.idle();
  assert.equal(peak, 1); assert.deepEqual(calls, ['a', 'b']); assert.ok(f.queue.snapshot().every((job) => job.state === 'complete'));
  assert.ok([...f.values.values()].every((job) => job.progress.percent === 100));
});

test('interrupted downloads restart after reopening, offline jobs wait, and another account never inherits the queue', async (t) => {
  const calls = [], f = fixture(t, { async download(book) { calls.push(book.id); } });
  await f.store.put({ id: 'one:a', owner: 'one', book: book('a'), options: { audio: false }, created: 1, state: 'downloading' });
  f.online(false); await f.queue.resume(); assert.equal(f.queue.snapshot()[0].state, 'queued'); assert.deepEqual(calls, []);
  await f.queue.enqueue(book('b'), { audio: false });
  f.online(true); await f.queue.resume(); await f.queue.idle(); assert.deepEqual(calls, ['a', 'b']);
  f.online(false); await f.queue.enqueue(book('private'), { audio: false });
  f.account('two'); await f.queue.resume(); f.online(true); await f.queue.resume(); await f.queue.idle();
  assert.deepEqual(f.queue.snapshot(), []); assert.ok(f.values.size > 0); assert.equal(calls.includes('private'), false);
  f.account('one'); await f.queue.resume(); await f.queue.idle(); assert.equal(calls.at(-1), 'private');
});

test('priority switches wait for transfer cleanup, retain higher-ranked work and restart the paused book', async (t) => {
  const aborted = gate(), cleanup = gate(), calls = [], snapshots = []; let attempts = 0, active = 0, peak = 0;
  t.after(() => cleanup.resolve());
  const f = fixture(t, { async download(book, { signal }) {
    active++; peak = Math.max(peak, active); calls.push(book.id);
    try {
      if (book.id === 'a' && ++attempts === 1) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        aborted.resolve(); await cleanup.promise; throw signal.reason;
      }
    } finally { active--; }
  } });
  f.queue.subscribe((jobs) => snapshots.push(jobs));
  await f.queue.enqueue(book('a'), {}); await f.queue.enqueue(book('b'), {}); await f.queue.enqueue(book('c'), {});
  await f.queue.raisePriority('one:c'); await aborted.promise;
  assert.deepEqual(calls, ['a'], 'the next transfer must wait for temporary-cache cleanup');
  assert.equal(f.queue.snapshot().find((job) => job.book.id === 'a').pauseRequested, true);
  await f.queue.prioritize('one:b', 'top'); await f.queue.raisePriority('one:c');
  assert.ok(f.values.get('one:b').priority > f.values.get('one:c').priority, 'Raise inserts ahead of the active job without tying work already above it');
  cleanup.resolve(); await f.queue.idle();
  assert.deepEqual(calls, ['a', 'b', 'c', 'a']); assert.equal(peak, 1);
  assert.ok(snapshots.some((jobs) => jobs.some((job) => job.book.id === 'a' && job.state === 'queued' && job.paused)));
  assert.ok(snapshots.every((jobs) => jobs.every((job) => job.state !== 'cancelled')));
  assert.ok(f.queue.snapshot().every((job) => job.state === 'complete' && !job.pauseRequested));
});

test('active book downloads accept Raise, Top and Lowest and yield when moved below waiting work', async (t) => {
  const calls = []; let attempts = 0, signal;
  const f = fixture(t, { async download(book, options) {
    calls.push(book.id);
    if (book.id === 'a' && ++attempts === 1) {
      signal = options.signal;
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  } });
  await f.queue.enqueue(book('a'), {}); await until(() => signal);
  await f.queue.prioritize('one:a', 'top'); await f.queue.raisePriority('one:a');
  assert.equal(f.values.get('one:a').priority, 2); assert.equal(signal.aborted, false);
  await f.queue.enqueue(book('b'), {}); await f.queue.prioritize('one:a', 'lowest'); await f.queue.idle();
  assert.deepEqual(calls, ['a', 'b', 'a']); assert.equal(f.values.get('one:a').priority, -1);
  assert.ok(f.queue.snapshot().every((job) => job.state === 'complete'));
});

test('manual top and lowest device priorities survive reopening', async (t) => {
  const calls = [], f = fixture(t, { async download(book) { calls.push(book.id); } });
  f.online(false);
  for (const id of ['d', 'e', 'f']) await f.queue.enqueue(book(id), {});
  await f.queue.prioritize('one:e', 'top'); await f.queue.prioritize('one:d', 'lowest'); await f.queue.raisePriority('one:f');
  f.queue.close();
  const reopened = readingPackQueue({ store: f.store, owner: () => 'one', online: () => true, download: async (book) => calls.push(book.id) });
  t.after(() => reopened.close());
  await reopened.resume(); await reopened.idle(); assert.deepEqual(calls, ['f', 'e', 'd']);
});

test('a user cancellation during a priority switch wins over automatic requeuing', async (t) => {
  const aborted = gate(), cleanup = gate(), calls = []; t.after(() => cleanup.resolve());
  const f = fixture(t, { async download(book, { signal }) {
    calls.push(book.id);
    if (book.id === 'a') {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      aborted.resolve(); await cleanup.promise; throw signal.reason;
    }
  } });
  await f.queue.enqueue(book('a'), {}); await f.queue.enqueue(book('b'), {});
  await f.queue.prioritize('one:b', 'top'); await aborted.promise; await f.queue.cancel('one:a');
  cleanup.resolve(); await f.queue.idle();
  assert.deepEqual(calls, ['a', 'b']); assert.equal(f.values.get('one:a').state, 'cancelled');
  assert.equal(f.values.get('one:a').paused, false); assert.equal(f.values.get('one:b').state, 'complete');
});

test('a high-priority waiting download only interrupts active work when it becomes ready', async (t) => {
  const calls = []; let attempts = 0, signal;
  const f = fixture(t, { async download(book, options) {
    calls.push(book.id);
    if (book.id === 'a' && ++attempts === 1) {
      signal = options.signal;
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  } });
  await f.store.put({ id: 'one:waiting', owner: 'one', book: book('waiting'), options: {}, state: 'waiting', created: 1, priority: 0 });
  await f.queue.enqueue(book('a'), {}); await until(() => signal);
  await f.queue.prioritize('one:waiting', 'top'); assert.equal(signal.aborted, false); assert.deepEqual(calls, ['a']);
  await f.queue.resume(); await f.queue.idle(); assert.deepEqual(calls, ['a', 'waiting', 'a']);
});

test('a priority request during final commit does not restart a successfully completed pack', async (t) => {
  const commit = gate(), calls = []; t.after(() => commit.resolve());
  const f = fixture(t, { async download(book) { calls.push(book.id); if (book.id === 'a') await commit.promise; } });
  await f.queue.enqueue(book('a'), {}); await f.queue.enqueue(book('b'), {});
  await f.queue.prioritize('one:b', 'top'); commit.resolve(); await f.queue.idle();
  assert.deepEqual(calls, ['a', 'b']); assert.ok(f.queue.snapshot().every((job) => job.state === 'complete'));
});

test('an account cannot raise another account’s device download priority', async (t) => {
  const f = fixture(t, { async download() {} }); f.online(false);
  await f.queue.enqueue(book('private'), {}); f.account('two');
  await f.queue.raisePriority('one:private');
  assert.equal(f.values.get('one:private').priority, 0); assert.deepEqual(f.queue.snapshot(), []);
});

test('cancelling an active transfer releases the next book; connection failures wait and can be retried', async (t) => {
  let attempts = 0, started = false;
  const f = fixture(t, { async download(book, { signal }) {
    if (book.id === 'cancel') { started = true; await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    else if (++attempts === 1) throw Object.assign(new Error('Connection lost'), { retryable: true });
  } });
  const first = await f.queue.enqueue(book('cancel'), {}); await until(() => started);
  await f.queue.enqueue(book('retry'), {}); await f.queue.cancel(first.id); await f.queue.idle();
  assert.equal(f.queue.snapshot()[0].state, 'cancelled'); assert.equal(f.queue.snapshot()[1].state, 'waiting');
  await f.queue.resume(); await f.queue.idle(); assert.equal(attempts, 2); assert.equal(f.queue.snapshot()[1].state, 'complete');
  await f.queue.cancel('one:retry'); assert.equal(f.queue.snapshot()[1].state, 'complete', 'late Cancel cannot undo a completed pack');
});

test('streaming progress follows bytes actually consumed and cancellation stops caching incomplete data', async () => {
  const events = [], chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  const response = new Response(new ReadableStream({ pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); } }), { headers: { 'Content-Length': '5' } });
  assert.equal((await measuredResponse(response, (event) => events.push(event)).arrayBuffer()).byteLength, 5);
  assert.deepEqual(events.filter((event) => !event.complete).map((event) => event.loaded), [0, 3, 5]); assert.equal(events.at(-1).complete, true);
  assert.ok(events.every((event) => event.total === 5));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(measuredResponse(new Response('incomplete'), () => {}, abort.signal).arrayBuffer(), { name: 'AbortError' });
  const encoded = []; await measuredResponse(new Response('decoded body', { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '4' } }), (event) => encoded.push(event)).text();
  assert.ok(encoded.every((event) => event.total === 0), 'compressed Content-Length is not a false total for decoded bytes');
  assert.match(downloadProgressLabel({ label: 'Downloading book', loaded: 3 * 1024 ** 2, total: 10 * 1024 ** 2 }), /3\.0 MiB \/ 10\.0 MiB/u);
});

test('a cached service-worker fallback cannot masquerade as a fresh successful download', async (t) => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => new Response('{}', { headers: { 'X-Langy-Cached': '1' } });
  await assert.rejects(fetchPackResource('/api/books/a/offline'), (error) => error.retryable === true);
  globalThis.fetch = async () => Response.json({ error: 'Sign in again' }, { status: 401 });
  await assert.rejects(fetchPackResource('/api/books/a/offline'), (error) => error.message === 'Sign in again' && error.retryable === false);
});
