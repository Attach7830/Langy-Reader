import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessTasks, requestProcessLabel } from '../src/process-tasks.js';

test('process tracking ignores quick requests, reports slow work and failures, and clears account-specific data', () => {
  const timers = new Map(); let id = 0;
  const tasks = createProcessTasks({ setTimer(callback) { timers.set(++id, callback); return id; }, clearTimer(key) { timers.delete(key); } });
  const fast = tasks.begin('Fast'); fast(); assert.equal(tasks.snapshot().tasks.length, 0);
  const finish = tasks.begin('Slow'); [...timers.values()][0](); assert.equal(tasks.snapshot().tasks[0].state, 'running');
  finish(); assert.equal(tasks.snapshot().tasks[0].state, 'completed');
  const failed = tasks.begin('Failure'); [...timers.values()][0](); failed(new Error('Retry')); failed(); assert.equal(tasks.snapshot().tasks.at(-1).state, 'failed');
  const aborted = tasks.begin('Cancelled'); [...timers.values()][0](); aborted(new DOMException('Cancelled', 'AbortError')); assert.equal(tasks.snapshot().tasks.length, 2);
  tasks.setAccount('one'); tasks.setDownloads([{ state: 'downloading' }]); tasks.setAccount('two'); assert.deepEqual(tasks.snapshot(), { tasks: [], downloads: [] });
  assert.equal(requestProcessLabel('/api/processes'), ''); assert.equal(requestProcessLabel('/api/ai/status'), ''); assert.equal(requestProcessLabel('/api/ai/phrase', 'POST'), 'Explain selected phrase');
});
