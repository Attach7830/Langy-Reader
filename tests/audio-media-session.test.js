import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceMediaControls } from '../src/audio-media-session.js';

test('device media controls report position and clear actions without requiring browser support', () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalMetadata = Object.getOwnPropertyDescriptor(globalThis, 'MediaMetadata');
  const handlers = new Map(), positions = [];
  const session = { setActionHandler(name, action) { handlers.set(name, action); }, setPositionState(state) { positions.push(state); } };
  let skips = 0;
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaSession: session } });
    Object.defineProperty(globalThis, 'MediaMetadata', { configurable: true, value: class { constructor(value) { Object.assign(this, value); } } });
    const media = deviceMediaControls({ seekforward() { skips += 10; } });
    const snapshot = { active: true, title: 'A book', author: 'An author', chapter: 'Chapter 2', duration: 60, position: 20, rate: 1.5, paused: false };
    media.update(snapshot);
    handlers.get('seekforward')();
    assert.equal(skips, 10);
    assert.equal(session.metadata.title, 'A book');
    assert.equal(session.metadata.album, 'Chapter 2');
    assert.equal(session.playbackState, 'playing');
    assert.deepEqual(positions.at(-1), { duration: 60, playbackRate: 1.5, position: 20 });
    media.update({ ...snapshot, paused: true, position: 99 });
    assert.equal(session.playbackState, 'paused');
    assert.equal(positions.at(-1).position, 60);
    media.clear();
    assert.equal(handlers.get('seekforward'), null);
    assert.equal(session.metadata, null);
    assert.equal(session.playbackState, 'none');

    navigator.mediaSession = { setActionHandler() { throw new Error('Unsupported action'); }, setPositionState() { throw new Error('Unsupported position reporting'); } };
    assert.doesNotThrow(() => { const partial = deviceMediaControls({ seekforward() {} }); partial.update(snapshot); partial.clear(); });
    navigator.mediaSession = undefined;
    assert.doesNotThrow(() => { const absent = deviceMediaControls({ play() {} }); absent.update(snapshot); absent.clear(); });
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
    if (originalMetadata) Object.defineProperty(globalThis, 'MediaMetadata', originalMetadata); else delete globalThis.MediaMetadata;
  }
});
