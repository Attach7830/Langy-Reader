import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { audiobookshelfProgress } from '../src/audiobookshelf-progress.js';

const settle = async () => { for (let n = 0; n < 4; n++) await new Promise((resolve) => setTimeout(resolve, 0)); };
test('ABS listening starts syncing automatically, syncs closed offline recordings, and retains newer-device conflicts', async (t) => {
  const dom = new JSDOM('<audio id="narration-audio"></audio><p id="abs-sync-status" hidden></p>', { url: 'https://langy.test' });
  const original = new Map();
  for (const name of ['window', 'document', 'localStorage']) { original.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] }); }
  const previousInterval = globalThis.setInterval, intervals = [];
  globalThis.setInterval = (...args) => { const timer = previousInterval(...args); intervals.push(timer); return timer; };
  t.after(() => { intervals.forEach(clearInterval); globalThis.setInterval = previousInterval; dom.window.close(); for (const [name, value] of original) if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; });
  localStorage.setItem('langy-offline-owner', 'owner');
  let state = { book: 'book', recording: 'recording', duration: 100, time: 0, absConnected: true, readingTarget: 'saved-page' }, remote = { linked: true, recording: 'recording', currentTime: 40, version: 'v1', updated: 1000, duration: 100 }, online = true, writes = 0;
  const audio = { playbackPosition: () => state, async resumeAt(time) { state.time = time; } };
  let offer = null;
  const sync = audiobookshelfProgress({ audio, notify: (value) => { offer = value; }, request: async (_path, options = {}) => {
    if (!online) throw new Error('offline');
    if (options.method === 'PUT') { assert.equal(options.body.baseVersion, remote.version); writes++; remote = { ...remote, currentTime: options.body.currentTime, version: `v${writes + 1}` }; }
    return { ...remote };
  } });
  window.dispatchEvent(new dom.window.Event('langy-recording-ready')); await settle();
  assert.equal(offer, null); assert.equal(state.time, 40); assert.equal(writes, 0, 'initial link resumes ABS without overwriting its progress');
  online = false; state.time = 50; document.querySelector('audio').dispatchEvent(new dom.window.Event('timeupdate')); sync.stop();
  document.querySelector('audio').dispatchEvent(new dom.window.Event('pause')); state = null;
  online = true; await sync.syncSaved(); assert.equal(remote.currentTime, 50); assert.equal(writes, 1);
  const key = Object.keys(localStorage).find((name) => name.startsWith('langy-listening-'));
  assert.equal(JSON.parse(localStorage.getItem(key)).dirty, false);
  const saved = JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify({ ...saved, time: 55, dirty: true }));
  remote = { ...remote, version: 'another-device', currentTime: 75 }; await sync.syncSaved();
  assert.equal(remote.currentTime, 75); assert.equal(writes, 1); assert.equal(JSON.parse(localStorage.getItem(key)).dirty, true);
  state = { book: 'book', recording: 'recording', duration: 100, time: 0, absConnected: true, readingTarget: 'saved-page' };
  window.dispatchEvent(new dom.window.Event('langy-recording-ready')); await settle(); assert.equal(state.time, 55); assert.equal(offer.label, '1:15');
  await offer.keep(); assert.equal(offer, null); assert.equal(remote.currentTime, 55); assert.equal(writes, 2);
  sync.stop();
  state = { ...state, time: 80, readingTarget: 'newer-reading-page' };
  window.dispatchEvent(new dom.window.Event('langy-recording-ready')); await settle();
  assert.equal(state.time, 80, 'an old listening position cannot override a newer page chosen in the reader');
  sync.stop();
  state = { book: 'new-export', recording: 'new-recording', time: 30, duration: 100, absConnected: true, readingTarget: 'page' };
  remote = { linked: true, recording: 'new-recording', version: 'none', updated: 0, currentTime: 0, duration: 100 };
  window.dispatchEvent(new dom.window.Event('langy-recording-ready')); await settle();
  assert.equal(remote.currentTime, 30, 'a freshly exported title starts syncing its local clock without a linking confirmation'); assert.equal(offer, null);
  sync.stop();
  state = { ...state, book: 'indexing-export', recording: 'indexing-recording', time: 10 }; remote = { ...remote, linked: false, recording: 'indexing-recording', version: 'none', currentTime: 0 };
  window.dispatchEvent(new dom.window.Event('langy-recording-ready')); await settle(); state.time = 20; document.querySelector('audio').dispatchEvent(new dom.window.Event('timeupdate')); sync.stop(); state = null;
  remote.linked = true; await sync.syncSaved(); assert.equal(remote.currentTime, 20, 'closed-book progress sync retries when background indexing establishes a new link');
});

test('reading-only books sync fractional progress on desktop or mobile and retain offline page changes', async (t) => {
  const dom = new JSDOM('<audio id="narration-audio"></audio><p id="abs-sync-status" hidden></p>', { url: 'https://langy.test' });
  const original = new Map();
  for (const name of ['window', 'document', 'localStorage']) { original.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] }); }
  let poll;
  const previousInterval = globalThis.setInterval; globalThis.setInterval = (callback) => { poll = callback; return 0; };
  t.after(() => { globalThis.setInterval = previousInterval; dom.window.close(); for (const [name, value] of original) if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; });
  localStorage.setItem('langy-offline-owner', 'owner');
  let state = { book: 'book', recording: 'reading', duration: 1, time: .1, absConnected: true, readingTarget: 'page-1' };
  let remote = { linked: true, recording: 'reading', currentTime: .2, version: 'v1', updated: 1000, approximate: true }, writes = 0, roundPosition = false;
  let offer = null;
  const sync = audiobookshelfProgress({ audio: { playbackPosition: () => null }, notify: (value) => { offer = value; },
    reading: { playbackPosition: () => state, async resumeAt(time) { state.time = roundPosition ? Math.floor(time * 100) / 100 : time; } }, request: async (_path, options = {}) => {
    if (options.method === 'PUT') { assert.equal(options.body.recording, 'reading'); assert.equal(options.body.baseVersion, remote.version); writes++; remote = { ...remote, currentTime: options.body.currentTime, version: 'v' + (writes + 1) }; }
    return { ...remote };
  } });
  sync.start(); await settle(); assert.equal(state.time, .2); assert.equal(writes, 0);
  state.time = .22; state.readingTarget = 'page-22'; sync.changed(); sync.stop(); state = null;
  await sync.syncSaved(); assert.equal(remote.currentTime, .22); assert.equal(writes, 1, 'small fractional page changes must not be discarded as sub-second audio differences');
  state = { book: 'book', recording: 'reading', duration: 1, time: .22, absConnected: true, readingTarget: 'page-22' };
  remote = { ...remote, currentTime: .8, version: 'another-device' }; sync.start(); await settle();
  assert.equal(offer.label, '80%');
  assert.equal(remote.currentTime, .8); await offer.keep(); assert.equal(remote.currentTime, .22);
  const syncedWrites = writes;
  remote = { ...remote, version: 'same-position' };
  poll(); await settle();
  assert.equal(offer, null, 'a new server version at the same position needs no confirmation');
  assert.equal(writes, syncedWrites);
  sync.stop();
  state = { ...state, book: 'existing-book', time: .7, hasSavedPosition: true }; remote = { ...remote, automatic: true, currentTime: .1, version: 'first-auto-link' };
  sync.start(); await settle(); assert.equal(state.time, .7); assert.equal(offer.label, '10%', 'first automatic matching must preserve a different existing reading position');
  await offer.resume(); assert.equal(offer, null); assert.equal(state.time, .1); sync.stop();
  state = { ...state, book: 'rounded-book', time: 0, hasSavedPosition: false }; roundPosition = true;
  remote = { ...remote, currentTime: .235, version: 'rounded-position' };
  const previousWrites = writes; sync.start(); await settle(); assert.equal(state.time, .23);
  poll(); await settle(); assert.equal(writes, previousWrites, 'page rounding during a remote resume must not create a local change'); sync.stop();
});
