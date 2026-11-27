import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';
import { audiobookshelfProgress } from '../src/audiobookshelf-progress.js';

async function settle() { for (let n = 0; n < 8; n++) await delay(0); }
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await delay(5); } throw new Error('Progress did not settle'); }
function fixture(t) {
  const dom = new JSDOM('<audio id="narration-audio"></audio><div id="abs-sync-notice" hidden><p id="abs-sync-message"></p><button id="abs-sync-resume"></button><button id="abs-sync-keep"></button></div><p id="abs-sync-status" hidden></p>', { url: 'https://langy.test' });
  const old = new Map(['window', 'document', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of old.keys()) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  const previousInterval = globalThis.setInterval; let poll, sync;
  globalThis.setInterval = callback => { poll = callback; return 0; };
  t.after(() => { sync?.stop(); globalThis.setInterval = previousInterval; dom.window.close(); for (const [name, value] of old) if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; });
  localStorage.setItem('langy-offline-owner', 'owner');
  let audioState = null, readingState = null, held, heldWrite, online = true, target;
  const remote = { scope: 'connection-item-one', version: 'v1', percentage: .4, updated: 1000, automatic: true };
  const writes = [], reads = [];
  const payload = recording => ({ ...remote, linked: true, recording, duration: recording === 'reading' ? 1 : 100,
    currentTime: remote.percentage * (recording === 'reading' ? 1 : 100), approximate: recording === 'reading' });
  sync = audiobookshelfProgress({
    audio: { playbackPosition: () => audioState, async resumeAt(time) { audioState.time = time; if (target) audioState.readingTarget = target(time); } },
    reading: { playbackPosition: () => readingState, hasSavedPosition: () => Boolean((audioState || readingState)?.hasSavedPosition), async resumeAt(time) { readingState.time = time; } },
    async request(path, options = {}) {
      if (!online) throw new Error('Offline');
      const recording = options.body?.recording || new URL(path, 'https://langy.test').searchParams.get('recording');
      if (options.method === 'PUT') {
        assert.equal(options.body.baseVersion, remote.version, 'writes must retain the server revision check'); writes.push(options.body);
        remote.percentage = options.body.currentTime / (recording === 'reading' ? 1 : 100); remote.version = 'saved-' + writes.length; remote.updated++;
        const result = payload(recording), wait = heldWrite; heldWrite = null; if (wait) await wait; return result;
      }
      reads.push(recording); const result = payload(recording), wait = held; held = null; if (wait) await wait; return result;
    },
  });
  const state = (recording, time, readingTarget = 'source-page') => ({ book: 'book', recording, time, duration: recording === 'reading' ? 1 : 100, absConnected: true, readingTarget });
  return { dom, sync, remote, writes, reads, state,
    get audio() { return audioState; }, set audio(value) { audioState = value; },
    get reading() { return readingState; }, set reading(value) { readingState = value; },
    offline(value) { online = !value; }, resumeTarget(fn) { target = fn; },
    async start() { sync.start(); await settle(); }, async poll() { poll(); await settle(); },
    holdNext() { let release; held = new Promise(resolve => { release = resolve; }); return release; },
    holdWrite() { let release; heldWrite = new Promise(resolve => { release = resolve; }); return release; },
    changed() { sync.changed(); }, hidden: () => document.querySelector('#abs-sync-notice').hidden,
    click: id => document.querySelector('#abs-sync-' + id).click(),
  };
}

test('timestamp-only updates are acknowledged during listening and after reopening without a conflict or duplicate write', async t => {
  const f = fixture(t); f.audio = f.state('recording', 0); await f.start(); assert.equal(f.audio.time, 40);
  f.remote.version = 'metadata-only'; f.remote.updated++; await f.poll(); assert.equal(f.hidden(), true); assert.equal(f.writes.length, 0);
  f.audio.time = 45; f.changed(); f.remote.version = 'another-metadata-update'; f.remote.updated++; await f.poll();
  assert.equal(f.hidden(), true); assert.equal(f.writes.length, 1); assert.equal(f.remote.percentage, .45);
  f.sync.stop(); f.audio = f.state('recording', 0); f.remote.version = 'reopened-metadata'; f.remote.updated++; await f.start();
  assert.equal(f.audio.time, 45); assert.equal(f.hidden(), true); assert.equal(f.writes.length, 1);
});

test('resuming audio saves the actual followed page and restores its exact clock before checking ABS again', async t => {
  const f = fixture(t); f.resumeTarget(time => 'page-at-' + time); f.audio = f.state('recording', 0, 'old-page'); await f.start();
  const key = 'langy-listening-owner-book-recording', saved = JSON.parse(localStorage.getItem(key));
  assert.equal(saved.readingTarget, 'page-at-40'); assert.equal(saved.time, 40);
  f.sync.stop(); f.audio = f.state('recording', 30, 'page-at-40'); f.remote.version = 'metadata'; await f.start();
  assert.equal(f.audio.time, 40); assert.equal(f.hidden(), true); assert.equal(f.writes.length, 0);
});

test('switching from an acknowledged reading position to narration and back does not offer that same ABS position again', async t => {
  const f = fixture(t); f.reading = f.state('reading', 0); await f.start(); assert.equal(f.reading.time, .4);
  f.audio = { ...f.state('recording', 39), hasSavedPosition: true }; f.changed(); await settle();
  assert.equal(f.hidden(), true); assert.equal(f.audio.time, 40); assert.equal(f.writes.length, 0);
  f.audio.time = 45; f.changed(); await f.poll(); assert.equal(f.remote.percentage, .45);
  f.sync.stop(); f.audio = null; f.reading = { ...f.state('reading', .44), hasSavedPosition: true }; await f.start();
  assert.equal(f.hidden(), true); assert.equal(f.writes.length, 1, 'opening a rounded reading page cannot overwrite the listening clock');
});

test('genuine remote changes still require a choice, and both keep and resume choices survive subsequent opens', async t => {
  const f = fixture(t); f.audio = f.state('recording', 0); await f.start();
  f.audio.time = 45; f.changed(); Object.assign(f.remote, { percentage: .8, version: 'other-device', updated: 2000 }); await f.poll();
  assert.equal(f.hidden(), false); assert.equal(f.audio.time, 45); assert.equal(f.writes.length, 0);
  f.click('keep'); await settle(); assert.equal(f.remote.percentage, .45); assert.equal(f.hidden(), true);
  f.sync.stop(); f.audio = f.state('recording', 0); await f.start(); assert.equal(f.audio.time, 45); assert.equal(f.hidden(), true);
  Object.assign(f.remote, { percentage: .7, version: 'other-device-again', updated: 3000 }); await f.poll(); assert.equal(f.hidden(), false);
  f.click('resume'); await settle(); assert.equal(f.audio.time, 70); assert.equal(f.hidden(), true);
  f.sync.stop(); f.audio = f.state('recording', 0); f.remote.version = 'timestamp-after-resume'; await f.start();
  assert.equal(f.audio.time, 70); assert.equal(f.hidden(), true); assert.equal(f.writes.length, 1);
});

test('choosing keep while an ABS check is in flight flushes the decision without waiting for a poll', async t => {
  const f = fixture(t); f.audio = f.state('recording', 0); await f.start();
  Object.assign(f.remote, { percentage: .8, version: 'other-device', updated: 2000 }); await f.poll(); assert.equal(f.hidden(), false);
  const release = f.holdNext(), before = f.reads.length;
  void f.poll(); await until(() => f.reads.length > before); f.click('keep'); release();
  await until(() => f.writes.length === 1); assert.equal(f.remote.percentage, .4); assert.equal(f.hidden(), true);
});

test('an old reading outbox cannot fight active narration or overwrite a newer saved listening position after closing', async t => {
  const f = fixture(t); f.reading = f.state('reading', 0); await f.start();
  f.offline(true); f.reading.time = .41; f.reading.readingTarget = 'new-page'; f.changed();
  f.audio = f.state('recording', 41.5, 'new-page'); f.changed(); await settle(); f.offline(false);
  await f.sync.syncSaved(); assert.equal(f.writes.length, 0, 'inactive modes of the active book must wait');
  f.audio.time = 50; f.changed(); await f.poll(); assert.equal(f.remote.percentage, .5);
  f.sync.stop(); f.audio = null; f.reading = null; await f.sync.syncSaved();
  assert.equal(f.writes.length, 1); assert.equal(f.remote.percentage, .5);
  assert.equal(JSON.parse(localStorage.getItem('langy-listening-owner-book-reading')).dirty, false);
});

test('a changed ABS target or reader account cannot reuse another scope’s acknowledgement', async t => {
  const f = fixture(t); f.audio = f.state('recording', 0); await f.start();
  f.audio.hasSavedPosition = true; Object.assign(f.remote, { scope: 'connection-item-two', percentage: .8 }); await f.poll();
  assert.equal(f.hidden(), false); assert.equal(f.audio.time, 40); f.click('resume'); await settle();
  f.sync.stop(); localStorage.setItem('langy-offline-owner', 'another-reader'); f.audio = { ...f.state('recording', 20), hasSavedPosition: true }; await f.start();
  assert.equal(f.hidden(), false); assert.equal(f.audio.time, 20); assert.equal(f.writes.length, 0);
});

test('a passive acknowledgement in another mode does not authorize overwriting a real remote change with closed offline work', async t => {
  const f = fixture(t); f.audio = f.state('recording', 0); await f.start();
  f.offline(true); f.audio.time = 45; f.changed(); f.sync.stop(); f.audio = null; f.offline(false);
  Object.assign(f.remote, { percentage: .75, version: 'external' });
  localStorage.setItem('langy-abs-ack-owner-book', JSON.stringify({ scope: f.remote.scope, version: 'external', fraction: .75 }));
  await f.sync.syncSaved(); assert.equal(f.writes.length, 0); assert.equal(f.remote.percentage, .75);
  const saved = JSON.parse(localStorage.getItem('langy-listening-owner-book-recording')); assert.equal(saved.dirty, true); assert.equal(saved.conflict, true);
});

test('closed offline modes synchronize the newest local change first and retire older positions for the same ABS item', async t => {
  const f = fixture(t);
  for (const [recording, time, changeId] of [['reading', .3, 5], ['recording', 60, 6]]) localStorage.setItem('langy-listening-owner-book-' + recording, JSON.stringify({
    ...f.state(recording, time), owner: 'owner', dirty: true, absLinked: true, scope: f.remote.scope, version: 'v1', remoteTime: recording === 'reading' ? .4 : 40, changeId,
  }));
  await f.sync.syncSaved(); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].recording, 'recording'); assert.equal(f.remote.percentage, .6);
  assert.equal(JSON.parse(localStorage.getItem('langy-listening-owner-book-reading')).dirty, false);
});

test('movement during an in-flight save remains pending and is sent after closing the book', async t => {
  const f = fixture(t); f.audio = f.state('recording', 0); await f.start();
  f.audio.time = 45; f.changed(); const release = f.holdWrite(); void f.poll();
  await until(() => f.writes.length === 1);
  f.audio.time = 50; f.changed(); release();
  await until(() => JSON.parse(localStorage.getItem('langy-listening-owner-book-recording')).version === 'saved-1');
  const saved = JSON.parse(localStorage.getItem('langy-listening-owner-book-recording'));
  assert.equal(saved.dirty, true); assert.equal(saved.time, 50);
  f.sync.stop(); f.audio = null; await f.sync.syncSaved();
  assert.equal(f.remote.percentage, .5); assert.equal(f.writes.length, 2);
});
