import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessTasks, requestProcessLabel } from '../src/process-tasks.js';

test('process tracking ignores quick requests, reports slow work and failures, and clears account-specific data', () => {
  const timers = new Map(); let id = 0;
  const tasks = createProcessTasks({ setTimer(callback) { timers.set(++id, callback); return id; }, clearTimer(key) { timers.delete(key); } });
  const fast = tasks.begin('Fast'); fast(); assert.equal(tasks.snapshot().tasks.length, 0);
  const finish = tasks.begin('Slow'); [...timers.values()][0](); assert.equal(tasks.snapshot().tasks[0].state, 'running');
  finish(); assert.deepEqual(tasks.snapshot().tasks, [], 'successful work disappears without dismissing it');
  const failed = tasks.begin('Failure'); [...timers.values()][0](); failed(new Error('Retry')); failed(); assert.equal(tasks.snapshot().tasks.at(-1).state, 'failed');
  const aborted = tasks.begin('Cancelled'); [...timers.values()][0](); aborted(new DOMException('Cancelled', 'AbortError')); assert.equal(tasks.snapshot().tasks.length, 1);
  tasks.setDownloads([{ state: 'complete' }, { state: 'cancelled' }, { state: 'failed' }, { state: 'downloading' }]);
  assert.deepEqual(tasks.snapshot().downloads.map((job) => job.state), ['failed', 'downloading']);
  tasks.setAccount('one'); tasks.setDownloads([{ state: 'downloading' }]); tasks.setAccount('two'); assert.deepEqual(tasks.snapshot(), { tasks: [], downloads: [] });
  assert.equal(requestProcessLabel('/api/processes'), ''); assert.equal(requestProcessLabel('/api/ai/status'), ''); assert.equal(requestProcessLabel('/api/ai/phrase', 'POST'), 'Explain selected phrase');
});

test('the process X cancels a slow request once and exposes no executable callback in queue data',()=>{
  let show,calls=0;const tasks=createProcessTasks({setTimer(callback){show=callback;return 1;},clearTimer(){}});
  const finish=tasks.begin('Slow lookup',{cancel(){calls++;}});show();const job=tasks.snapshot().tasks[0];assert.equal(job.cancellable,true);assert.equal('cancel' in job,false);
  tasks.cancel(job.id);tasks.cancel(job.id);assert.equal(calls,1);assert.equal(tasks.snapshot().tasks[0].state,'cancelled');finish(new DOMException('Cancelled','AbortError'));assert.equal(tasks.snapshot().tasks.length,0);
});

test('background actions appear immediately and retain even a quick failure after their dialog closes', () => {
  const tasks = createProcessTasks({ setTimer() { assert.fail('Immediate work does not wait for the slow-request timer'); } });
  const finish = tasks.begin('Import book cover', { immediate: true, kind: 'cover', bookId: 'one', title: 'A book' });
  assert.equal(tasks.snapshot().tasks[0].state, 'running');
  finish(new Error('Image could not be imported.'));
  assert.equal(tasks.snapshot().tasks[0].state, 'failed');
  assert.equal(tasks.snapshot().tasks[0].bookId, 'one');
  assert.equal(tasks.snapshot().tasks[0].detail, 'Image could not be imported.');
  tasks.clearFinished(); assert.deepEqual(tasks.snapshot().tasks, []);
});
