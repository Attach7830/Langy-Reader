import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmed, rescanWindows, coalesceRescanWindows, mergeRescan } from '../server/rescan-timing.js';

test('rescan windows cover missing and estimated words without changing confirmed anchors', () => {
  const words = ['uno', 'dos', 'tres', 'cuatro'];
  const stamps = [{ start: 0, end: .5 }, { start: .5, end: 1, estimated: true }, null, { start: 2, end: 3 }];
  const baseline = confirmed(stamps, 4), windows = rescanWindows(words, stamps, 4);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].from, 1); assert.equal(windows[0].to, 3);
  const result = mergeRescan(baseline, windows[0], [
    { start: 0, end: .2 }, { start: .6, end: 1 }, { start: 1.2, end: 1.8 }, { start: 2.5, end: 3 },
  ], 4);
  assert.equal(result.added, 2);
  assert.deepEqual(result.timings[0], baseline[0]); assert.deepEqual(result.timings[3], baseline[3]);
  assert.equal(result.timings[1].estimated, undefined);
  assert.equal(stamps[1].estimated, true);
});

test('long gaps stay bounded and reject hallucinations, overlaps, low confidence and out-of-section matches', () => {
  const windows = rescanWindows(['only'], [null], 150);
  assert.ok(windows.length >= 4);
  assert.ok(windows.every((window) => window.end - window.start <= 49));
  assert.equal(windows[0].start, 0); assert.equal(windows.at(-1).end, 150);
  const baseline = [{ start: 0, end: 1 }, null, null, { start: 3, end: 4 }];
  const window = { from: 1, to: 3, contextFrom: 0, start: 0, end: 5, left: 1, right: 3 };
  for (const stamp of [{ start: .5, end: 2 }, { start: 2, end: 3.5 }, { start: 2, end: 2.5, review: true },
    { start: 2, end: 2.5, estimated: true }, { start: NaN, end: 2.5 }]) {
    assert.equal(mergeRescan(baseline, window, [null, stamp], 5).added, 0);
  }
  const first = mergeRescan(baseline, window, [null, null, { start: 2, end: 2.5 }], 5).timings;
  const second = mergeRescan(first, window, [null, { start: 1.5, end: 2.2 }], 5);
  assert.equal(second.added, 0, 'a retry cannot overlap an earlier recovered anchor');
  assert.equal(mergeRescan(baseline, window, [null, { start: 1.5, end: 2 }], 5, () => false).added, 0);
});

test('hundreds of nearby gaps share bounded clips while retaining the same confirmed and recovered word timings', () => {
  const words = Array.from({ length: 1200 }, (_, i) => String(i));
  const truth = words.map((_, i) => ({ start: i * .2 + .02, end: i * .2 + .14 }));
  const baseline = truth.map((stamp, i) => i % 3 === 1 ? null : stamp);
  const windows = rescanWindows(words, baseline, 240);
  assert.ok(windows.length < 20, `${windows.length} clips for 400 gaps`);
  assert.ok(windows.every((window) => window.end - window.start <= 49 && window.to - window.from <= 140));
  let repaired = baseline;
  for (const window of windows) repaired = mergeRescan(repaired, window, truth.slice(window.contextFrom, window.contextTo)
    .map((stamp) => ({ start: stamp.start - window.start, end: stamp.end - window.start })), 240).timings;
  for (let i = 0; i < truth.length; i++) {
    assert.ok(Math.abs(repaired[i].start - truth[i].start) < 1e-10); assert.ok(Math.abs(repaired[i].end - truth[i].end) < 1e-10);
    if (baseline[i]) assert.deepEqual(repaired[i], baseline[i]);
  }
  assert.deepEqual(coalesceRescanWindows(windows), windows, 'rebatching is stable');
});
