import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { audiobookshelfProgress } from '../src/audiobookshelf-progress.js';

const settle = async () => { for (let n = 0; n < 4; n++) await new Promise((resolve) => setTimeout(resolve, 0)); };
test('ABS listening starts syncing automatically, syncs closed offline recordings, and retains newer-device conflicts', async (t) => {
  const dom = new JSDOM('<audio id="narration-audio"></audio><div id="abs-sync-notice" hidden><p id="abs-sync-message"></p><button id="abs-sync-resume"></button><button id="abs-sync-keep"></button></div><p id="abs-sync-status" hidden></p>', { url: 'https://langy.test' });
  const original = new Map();
  for (const name of ['window', 'document', 'localStorage']) { original.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] }); }
  const previousInterval = globalThis.setInterval, intervals = [];
  globalThis.setInterval = (...args) => { const timer = previousInterval(...args); intervals.push(timer); return timer; };
  t.after(() => { intervals.forEach(clearInterval); globalThis.setInterval = previousInterval; dom.window.close(); for (const [name, value] of original) if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; });
  localStorage.setItem('langy-offline-owner', 'owner');
  let state = { book: 'book', recording: 'recording', duration: 100, time: 0, absConnected: true, readingTarget: 'saved-page' }, remote = { linked: true, recording: 'recording', currentTime: 40, version: 'v1', updated: 1000, duration: 100 }, online = true, writes = 0;
  const audio = { playbackPosition: () => state, async resumeAt(time) { state.time = time; } };
  const sync = audiobookshelfProgress({ audio, request: async (_path, options = {}) => {
    if (!online) throw new Error('offline');
    if (options.method === 'PUT') { assert.equal(options.body.baseVersion, remote.version); writes++; remote = { ...remote, currentTime: options.body.currentTime, version: `v${writes + 1}` }; }
    return { ...remote };
  } });
  window.dispatchEvent(new dom.window.Event('langy-recording-ready')); await settle();
  assert.equal(document.querySelector('#abs-sync-notice').hidden, true); assert.equal(state.time, 40); assert.equal(writes, 0, 'initial link resumes ABS without overwriting its progress');
  online = false; state.time = 50; document.querySelector('audio').dispatchEvent(new dom.window.Event('timeupdate')); sync.stop();
  document.querySelector('audio').dispatchEvent(new dom.window.Event('pause')); state = null;
  online = true; await sync.syncSaved(); assert.equal(remote.currentTime, 50); assert.equal(writes, 1);
  const key = Object.keys(localStorage).find((name) => name.startsWith('langy-listening-'));
  assert.equal(JSON.parse(localStorage.getItem(key)).dirty, false);
  const saved = JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify({ ...saved, time: 55, dirty: true }));
  remote = { ...remote, version: 'another-device', currentTime: 75 }; await sync.syncSaved();
  assert.equal(remote.currentTime, 75); assert.equal(writes, 1); assert.equal(JSON.parse(localStorage.getItem(key)).dirty, true);
  state = { book: 'book', recording: 'recording', duration: 100, time: 0, absConnected: true, readingTarget: 'saved-page' };
  window.dispatchEvent(new dom.window.Event('langy-recording-ready')); await settle(); assert.equal(state.time, 55); assert.equal(document.querySelector('#abs-sync-notice').hidden, false);
  document.querySelector('#abs-sync-keep').click(); await settle(); assert.equal(remote.currentTime, 55); assert.equal(writes, 2);
  sync.stop();
  state = { ...state, time: 80, readingTarget: 'newer-reading-page' };
  window.dispatchEvent(new dom.window.Event('langy-recording-ready')); await settle();
  assert.equal(state.time, 80, 'an old listening position cannot override a newer page chosen in the reader');
  sync.stop();
  state = { book: 'new-export', recording: 'new-recording', time: 30, duration: 100, absConnected: true, readingTarget: 'page' };
  remote = { linked: true, recording: 'new-recording', version: 'none', updated: 0, currentTime: 0, duration: 100 };
  window.dispatchEvent(new dom.window.Event('langy-recording-ready')); await settle();
  assert.equal(remote.currentTime, 30, 'a freshly exported title starts syncing its local clock without a linking confirmation'); assert.equal(document.querySelector('#abs-sync-notice').hidden, true);
  sync.stop();
  state = { ...state, book: 'indexing-export', recording: 'indexing-recording', time: 10 }; remote = { ...remote, linked: false, recording: 'indexing-recording', version: 'none', currentTime: 0 };
  window.dispatchEvent(new dom.window.Event('langy-recording-ready')); await settle(); state.time = 20; document.querySelector('audio').dispatchEvent(new dom.window.Event('timeupdate')); sync.stop(); state = null;
  remote.linked = true; await sync.syncSaved(); assert.equal(remote.currentTime, 20, 'closed-book progress sync retries when background indexing establishes a new link');
});
