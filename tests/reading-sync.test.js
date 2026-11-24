import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readingProgressSync } from '../src/reading-sync.js';

const document = 'a'.repeat(32);
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Timed out waiting for sync'); await delay(5); }
}
function fixture(t, { remote = null, saved = {}, enabled = true } = {}) {
  const progress = { book: { target: 'local:1', percent: .1, ...saved } };
  const preferences = { progressSyncEnabled: enabled, syncDeviceName: 'Laptop' };
  const statuses = [], writes = [], applies = [];
  let target = progress.book.target, percent = progress.book.percent, nextRead, nextWrite, offline = false, saves = 0;
  let record = remote;
  const version = () => record?.version || 0;
  const payload = () => ({ available: true, document, version: version(), progress: record && { ...record } });
  const view = { syncPosition: () => ({ target, progress: `path:${target}`, percentage: percent }) };
  const controller = readingProgressSync({
    request: async (_url, options = {}) => {
      if (offline) throw new Error('Connection unavailable');
      if (options.method !== 'PUT') { if (nextRead) { const read = nextRead; nextRead = null; return read; } return payload(); }
      writes.push(options);
      if (nextWrite) { const write = nextWrite; nextWrite = null; await write; }
      if (options.body.baseVersion !== version()) throw Object.assign(new Error('Conflict'), { status: 409, details: { ...payload(), conflict: true } });
      record = { ...options.body, document, langyTarget: options.body.target, version: version() + 1, timestamp: 1000 };
      return payload();
    },
    progress, persist: () => saves++, preferences: () => preferences, available: () => true,
    deviceId: 'browser-test', debounce: 8, poll: 3600000,
    async applyRemote(value) {
      applies.push(value);
      target = value.langyTarget;
      percent = value.percentage;
      // The real renderer replaces the entry in its relocation callback.
      progress.book = { ...progress.book, target, percent };
      controller.changed();
      return { exact: value.exact !== false };
    },
    notify: (value) => statuses.push(value),
  });
  t.after(() => controller.stop());
  return { controller, progress, statuses, writes, applies, preferences, view,
    start: () => controller.start({ id: 'book' }, view),
    change(value, fraction = .2) { target = value; percent = fraction; progress.book = { ...progress.book, target, percent }; controller.changed(); },
    updateRemote(value, fraction = .5) { record = { document, version: version() + 1, progress: `path:${value}`, langyTarget: value, percentage: fraction, device: 'Xteink', timestamp: 1001 }; },
    get remote() { return record; }, get saves() { return saves; },
    set offline(value) { offline = value; },
    holdRead() { const value = defer(); nextRead = value.promise; return value; },
    holdWrite() { const value = defer(); nextWrite = value.promise; return value; },
  };
}
const remote = (version = 4) => ({ document, version, progress: '/body/DocFragment[2]/body/p[2]/text().8',
  langyTarget: 'device:4', percentage: .4, timestamp: 999, device: 'Xteink' });

test('closed offline books sync on reconnection, while a newer device position remains untouched for a later choice', async () => {
  const progress = { first: { syncVersion: 1, syncDirty: true, syncDocument: document, syncPayload: { target: 'one', progress: 'path:one', percentage: .2 } },
    second: { syncVersion: 1, syncDirty: true, syncDocument: document, syncPayload: { target: 'two', progress: 'path:two', percentage: .3 } } };
  const writes = [];
  const sync = readingProgressSync({ progress, persist() {}, preferences: () => ({ progressSyncEnabled: true }), available: () => true, deviceId: 'offline-test', notify() {},
    request: async (path, options = {}) => {
      if (options.method === 'PUT') { writes.push(path); return { version: 2, document }; }
      return { version: path.includes('first') ? 1 : 2, document, progress: { progress: 'different', percentage: .5 } };
    } });
  await sync.flushSaved(); assert.deepEqual(writes, ['/api/books/first/progress']);
  assert.equal(progress.first.syncDirty, false); assert.equal(progress.second.syncDirty, true); assert.equal(progress.second.syncConflict, true);
});

test('opening resumes shared progress without publishing a reflowed page start back to the server', async (t) => {
  const f = fixture(t, { remote: remote() });
  await f.start();
  assert.equal(f.progress.book.target, 'device:4');
  assert.equal(f.progress.book.syncVersion, 4);
  assert.equal(f.progress.book.syncDirty, false);
  await delay(20);
  assert.equal(f.writes.length, 0);
  f.updateRemote('device:5');
  await f.controller.check();
  assert.equal(f.statuses.at(-1).state, 'remote');
  assert.equal(f.progress.book.target, 'device:4');
  await f.controller.resume();
  assert.equal(f.progress.book.target, 'device:5');
  assert.equal(f.progress.book.syncVersion, 5);
  assert.equal(f.writes.length, 0);
});

test('page changes coalesce, use server versions, and keep offline metadata when the local entry is replaced', async (t) => {
  const f = fixture(t);
  await f.start();
  assert.equal(f.writes.length, 1);
  assert.equal(f.progress.book.syncDirty, false);
  f.change('local:2'); f.change('local:3', .3);
  await until(() => f.remote.langyTarget === 'local:3');
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].body.baseVersion, 1);
  assert.equal(f.writes[1].body.device_id, 'browser-test');
  assert.equal(f.progress.book.syncVersion, 2);
  assert.equal(f.progress.book.syncDirty, false);
});

test('CAS conflicts require a choice, and Keep this position never overwrites an intervening unseen update', async (t) => {
  const f = fixture(t, { remote: remote() });
  await f.start();
  f.change('local:2');
  f.updateRemote('device:5');
  await f.controller.flush();
  assert.equal(f.statuses.at(-1).state, 'conflict');
  assert.equal(f.progress.book.target, 'local:2');
  assert.equal(f.remote.langyTarget, 'device:5');
  f.updateRemote('device:6');
  await f.controller.keepLocal();
  assert.equal(f.remote.langyTarget, 'device:6');
  assert.equal(f.statuses.at(-1).state, 'conflict');
  await f.controller.keepLocal();
  assert.equal(f.remote.langyTarget, 'local:2');
  assert.equal(f.remote.version, 7);
  assert.equal(f.progress.book.syncDirty, false);
});

test('offline progress is retained and reconnecting offers a choice against newer device progress', async (t) => {
  const f = fixture(t, { remote: remote(), saved: { syncVersion: 3, syncDocument: document } });
  f.offline = true;
  await f.start();
  f.change('offline:2', .2);
  await f.controller.flush();
  assert.equal(f.statuses.at(-1).state, 'offline');
  assert.equal(f.progress.book.syncDirty, true);
  assert.equal(f.progress.book.target, 'offline:2');
  f.offline = false;
  await f.controller.check();
  assert.equal(f.statuses.at(-1).state, 'conflict');
  assert.equal(f.writes.length, 0);
  await f.controller.resume();
  assert.equal(f.progress.book.target, 'device:4');
  assert.equal(f.progress.book.syncDirty, false);
});

test('turning a page while the opening request is slow prevents an automatic jump', async (t) => {
  const f = fixture(t, { remote: remote() });
  const read = f.holdRead();
  const started = f.start();
  f.change('local:2');
  read.resolve({ document, version: 4, progress: remote() });
  await started;
  assert.equal(f.applies.length, 0);
  assert.equal(f.progress.book.target, 'local:2');
  assert.equal(f.statuses.at(-1).state, 'conflict');
  assert.equal(f.writes.length, 0);
});

test('edits made during an upload stay dirty and are sent after that upload finishes', async (t) => {
  const f = fixture(t);
  await f.start();
  const write = f.holdWrite();
  f.change('local:2');
  const flushed = f.controller.flush();
  await until(() => f.writes.length === 2);
  f.change('local:3', .3);
  write.resolve();
  await flushed;
  assert.equal(f.progress.book.syncDirty, true);
  await until(() => f.remote.langyTarget === 'local:3');
  assert.equal(f.progress.book.syncDirty, false);
  assert.equal(f.writes.at(-1).body.baseVersion, 2);
});

test('a disabled browser makes no requests and its reading changes survive enabling sync', async (t) => {
  const f = fixture(t, { enabled: false });
  await f.start();
  f.change('local:2');
  await f.controller.flush();
  assert.equal(f.writes.length, 0);
  assert.equal(f.progress.book.syncDirty, true);
  f.preferences.progressSyncEnabled = true;
  await f.start();
  assert.equal(f.remote.langyTarget, 'local:2');
  assert.equal(f.writes.length, 1);
});

test('a closed reader ignores a late response and flushes local changes with keepalive on leaving', async (t) => {
  const f = fixture(t);
  const read = f.holdRead();
  const started = f.start();
  f.controller.stop();
  read.resolve({ document, version: 4, progress: remote() });
  await started;
  assert.equal(f.applies.length, 0);
  await f.start();
  f.change('local:2');
  f.controller.stop();
  await until(() => !f.progress.book.syncDirty);
  assert.equal(f.writes.at(-1).keepalive, true);
  assert.equal(f.remote.langyTarget, 'local:2');
});
