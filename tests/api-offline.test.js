import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from '../src/ui.js';
import { processTasks } from '../src/process-tasks.js';

test('slow offline book-tool checks disappear from the process queue while explicit server actions retain their error', async (t) => {
  const original = new Map(['fetch', 'caches', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { keys: async () => [] } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => key === 'langy-offline-owner' ? 'reader' : null } });
  t.after(() => { processTasks.clearFinished(); for (const [key, descriptor] of original) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  for (const method of ['GET', 'POST']) {
    let fail;
    globalThis.fetch = () => new Promise((_resolve, reject) => { fail = reject; });
    const pending = api('/api/books/book/narration', { method }).catch((error) => error);
    for (let n = 0; n < 100 && !processTasks.snapshot().tasks.length; n++) await delay(10);
    assert.equal(processTasks.snapshot().tasks[0].state, 'running');
    fail(new TypeError('The server is unreachable'));
    const error = await pending; assert.equal(error.offline, true); assert.match(error.message, /connection to your Langy server/u);
    if (method === 'GET') assert.deepEqual(processTasks.snapshot().tasks, [], 'background status reads must not become repeated attention alerts');
    else assert.equal(processTasks.snapshot().tasks[0].state, 'failed', 'a requested server action must still report its failure');
  }
});
