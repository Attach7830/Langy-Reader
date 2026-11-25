import test from 'node:test';
import assert from 'node:assert/strict';
import { readingPreferences, fontSizeChange } from '../src/touch-preferences.js';
import { defaults, validatePreferences } from '../shared/reader-preferences.js';
import { temporaryControls } from '../src/reader-peek.js';

test('pinch size changes affect the touch reader without overwriting desktop size', () => {
  const settings = { ...defaults, size: 19, ...fontSizeChange(31, true) };
  assert.equal(readingPreferences(settings, true).size, 31); assert.equal(readingPreferences(settings, false).size, 19);
  const desktop = { ...settings, ...fontSizeChange(23, false) };
  assert.equal(readingPreferences(desktop, true).size, 31); assert.equal(readingPreferences(desktop, false).size, 23);
  assert.deepEqual(validatePreferences({ touchSize: 31, doubleTapToTurn: true }), { touchSize: 31, doubleTapToTurn: true });
  assert.throws(() => validatePreferences({ touchSize: 200 })); assert.equal(fontSizeChange(200, true).touchSize, 40);
});
test('the temporary player hides after inactivity, remains while scrubbing, and resets on leaving a book', () => {
  const callbacks = new Map(), changes = []; let id = 0;
  const player = temporaryControls({ changed: (value) => changes.push(value), setTimer: (fn) => { callbacks.set(++id, fn); return id; }, clearTimer: (value) => callbacks.delete(value) });
  player.show(); assert.equal(player.visible, true); player.hold(); assert.equal(callbacks.size, 0);
  player.release(); assert.equal(callbacks.size, 1); player.activity(); assert.equal(callbacks.size, 1);
  [...callbacks.values()][0](); assert.equal(player.visible, false); assert.deepEqual(changes, [true, false]);
  player.show(); player.reset(); assert.equal(player.visible, false); assert.equal(callbacks.size, 0);
});
