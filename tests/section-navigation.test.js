import test from 'node:test';
import assert from 'node:assert/strict';
import { adjacentSection } from '../src/section-navigation.js';
import { readingShortcut } from '../src/reader-shortcuts.js';
import { defaults } from '../src/settings.js';

test('section navigation follows logical boundaries and stops at the ends', () => {
  const entries = [0, 2, 7].map((position) => ({ position, target: position }));
  assert.equal(adjacentSection(entries, 3, 1), 7); assert.equal(adjacentSection(entries, 3, -1), 0);
  assert.equal(adjacentSection(entries, 0, -1), null); assert.equal(adjacentSection(entries, 8, 1), null);
});
test('Ctrl arrows skip sections while plain arrows, editing and shift selection retain their behavior', () => {
  const event = (values = {}) => ({ key: 'ArrowRight', ctrlKey: true, preventDefault() { this.defaultPrevented = true; }, ...values });
  assert.equal(readingShortcut(event(), defaults), 'nextSection'); assert.equal(readingShortcut(event({ key: 'ArrowLeft' }), defaults), 'previousSection');
  assert.equal(readingShortcut(event({ ctrlKey: false }), defaults), 'next');
  for (const values of [{ repeat: true }, { shiftKey: true }, { metaKey: true }, { target: { closest: () => true } }, { target: { ownerDocument: { getSelection: () => 'selected words' } } }]) assert.equal(readingShortcut(event(values), defaults), null);
});
