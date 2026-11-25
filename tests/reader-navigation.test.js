import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { pageTurnQueue, serializeRenderer } from '../src/reader-navigation.js';

test('rapid page turns keep a bounded queue, respect order and do not let audio jumps overtake manual navigation', async () => {
  let finish; const first = new Promise((resolve) => { finish = resolve; }), calls = [], states = [];
  const queue = pageTurnQueue({ async perform(direction) { calls.push(direction); if (calls.length === 1) await first; return true; }, busy: (state) => states.push(state) });
  const a = queue.request(1), b = queue.request(1), c = queue.request(-1);
  assert.equal(await queue.request(1), false); assert.equal(await queue.request(0, { index: 5 }, { audio: true }), false); assert.deepEqual(calls, [1]);
  finish(); assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]); assert.deepEqual(calls, [1, 1, -1]);
  assert.deepEqual(states, [true, false]);
});

test('closing a book discards queued turns and late callbacks cannot unlock a new book’s render', async () => {
  let finish; const first = new Promise((resolve) => { finish = resolve; }), calls = [], states = [];
  const queue = pageTurnQueue({ async perform(direction) { calls.push(direction); if (calls.length === 1) await first; return true; }, busy: (state) => states.push(state) });
  const active = queue.request(1), stale = queue.request(1); queue.reset(); assert.equal(await stale, false);
  assert.equal(await queue.request(-1), true); finish(); await active;
  assert.deepEqual(calls, [1, -1]); assert.deepEqual(states, [true, false, true, false]);
});

test('an explicit section or hyperlink jump replaces waiting page turns and runs after the active render', async () => {
  let finish; const first = new Promise((resolve) => { finish = resolve; }), calls = [];
  const queue = pageTurnQueue({ async perform(direction, target) { calls.push(target ?? direction); if (calls.length === 1) await first; return true; } });
  const active = queue.request(1), discarded = queue.request(1), jump = queue.request(0, { index: 5 });
  assert.equal(await discarded, false); finish();
  assert.deepEqual(await Promise.all([active, jump]), [true, true]); assert.deepEqual(calls, [1, { index: 5 }]);
});

test('layout changes, page turns and source jumps never render concurrently, and a failure releases the next task', async () => {
  let active = 0, peak = 0; const calls = [];
  const operation = (name, fail = false) => async () => { active++; peak = Math.max(peak, active); calls.push(name); await delay(5); active--; if (fail) throw new Error('Bad target'); };
  const { renderer } = serializeRenderer({ move: operation('turn'), apply: operation('resize'), go: operation('jump', true) });
  const results = await Promise.allSettled([renderer.move(1), renderer.apply({}), renderer.go('bad'), renderer.move(-1)]);
  assert.equal(peak, 1); assert.deepEqual(calls, ['turn', 'resize', 'jump', 'turn']); assert.equal(results[2].status, 'rejected'); assert.equal(results[3].status, 'fulfilled');
});

test('a stalled renderer times out, is destroyed, and cannot strand the navigation lock', async () => {
  let destroyed = 0;
  const { renderer } = serializeRenderer({ move: () => new Promise(() => {}) }, { milliseconds: 15, stalled: () => destroyed++ });
  let busy = false; const queue = pageTurnQueue({ perform: () => renderer.move(1), busy: (value) => { busy = value; } });
  await assert.rejects(queue.request(1), { name: 'TimeoutError' });
  await delay(0); assert.equal(busy, false); assert.equal(destroyed, 1);
  await assert.rejects(queue.request(1), { name: 'TimeoutError' }); assert.equal(busy, false);
});
