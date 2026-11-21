import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUsableTimings, synchronizeChunk } from '../server/audio-timing.js';
import { textWords } from '../shared/reading-text.js';

test('page timing preserves speech anchors and clearly marks estimates between them', () => {
  const words = textWords('First missing words last', 'en');
  const timings = synchronizeChunk(words, [
    { start: .2, end: .6 }, null, null, { start: 2, end: 2.5 },
  ], 3);
  assert.equal(timings[0].start, .2);
  assert.equal(timings[0].end, .6);
  assert.equal(timings[3].start, 2);
  assert.ok(timings.slice(1, 3).every((word) => word.estimated && word.review));
  assert.equal(timings[1].start, .6);
  assert.equal(timings[2].end, 2);
  assert.equal(timings[0].estimated, undefined);
  assert.ok(timings.every((word, index) => word.end > word.start && (!index || word.start >= timings[index - 1].end)));
});

test('numeric headings have page targets; no-match chunks get bounded, labelled estimates', () => {
  const words = textWords('42 ２０２６', 'es');
  assert.equal(words.length, 2);
  const timings = synchronizeChunk(words, [null, null], 1.5);
  assert.equal(timings[0].start, 0);
  assert.equal(timings.at(-1).end, 1.5);
  assert.ok(timings.every((word) => word.estimated && word.end > word.start));
  assert.deepEqual(textWords('*** —', 'es'), []);
});

test('invalid cached timestamps and invalid or nonmonotonic recognition are rejected', () => {
  for (const value of ['[]', 'null', 'not JSON', '[{}]', '[{"start":null,"end":1}]', '[{"start":0,"end":9}]']) {
    assert.equal(hasUsableTimings(value, 2), false, value);
  }
  assert.equal(hasUsableTimings('[{"start":0,"end":1}]', 2), true);
  const timings = synchronizeChunk(textWords('uno dos tres', 'es'), [
    { start: 0, end: 1 }, { start: .5, end: .8 }, { start: NaN, end: 2 },
  ], 3);
  assert.equal(timings[0].estimated, undefined);
  assert.ok(timings.slice(1).every((word) => word.estimated && word.start >= 1 && word.end <= 3));
});
