import test from 'node:test';
import assert from 'node:assert/strict';
import { processHistory } from '../src/process-history.js';
import { validatePreferences } from '../shared/reader-preferences.js';

test('completed tasks expire from completion time, survive reload, and never dismiss errors or approvals', () => {
  let clock = 1000000; const saved = new Map(), storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const options = { now: () => clock, storage, key: 'reader-one' }, history = processHistory(options);
  history.update([{ id: 'long-task', state: 'running', created: 1 }, { id: 'error', state: 'failed' }, { id: 'approval', state: 'waiting', decision: 'approve' }]);
  clock += 60000; history.update([{ id: 'error', state: 'failed' }, { id: 'approval', state: 'waiting', decision: 'approve' }]);
  assert.equal(history.visible(2).length, 3);
  const reopened = processHistory(options); reopened.update([{ id: 'error', state: 'failed' }, { id: 'approval', state: 'waiting', decision: 'approve' }]);
  clock += 119999; assert.equal(reopened.visible(2).length, 3);
  clock++; assert.deepEqual(reopened.visible(2).map((job) => job.id), ['error', 'approval']);
  assert.deepEqual(processHistory({ ...options, key: 'reader-two' }).visible(2), [], 'completed task history belongs to one reader');
  const immediate = processHistory(); immediate.update([{ id: 'done', state: 'completed' }]); assert.deepEqual(immediate.visible(0), []);
  immediate.update([{ id: 'done', state: 'completed' }]); assert.deepEqual(immediate.visible(2), [], 'expired snapshots do not reappear');
});

test('auto-dismiss minutes and library layouts validate as account preferences', () => {
  for (const layout of ['auto', '1', '2', '3', '4', 'list']) assert.doesNotThrow(() => validatePreferences({ libraryLayout: layout, coversOnly: true, processDismissMinutes: 2.5 }));
  for (const processDismissMinutes of [-1, Infinity, '5', 10081]) assert.throws(() => validatePreferences({ processDismissMinutes }));
  assert.throws(() => validatePreferences({ libraryLayout: '6' }));
});

test('dismissed failures stay dismissed after reloading while new attempts and approvals remain visible', () => {
  const saved = new Map(), storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const options = { storage, key: 'one' }, job = { id: 'failed', created: 10, state: 'failed', detail: 'Old failure' };
  const first = processHistory(options); first.update([job]); first.dismiss(job); first.update([job]); assert.deepEqual(first.visible(0), []);
  const reopened = processHistory(options); reopened.update([job]); assert.deepEqual(reopened.visible(0), []);
  reopened.update([{ ...job, detail: 'New failure after retry' }, { id: 'approval', state: 'waiting', decision: 'keep' }]);
  assert.equal(reopened.visible(0).length, 2);
  assert.equal(processHistory({ storage, key: 'other-reader' }).visible(0).length, 0);
  reopened.update([{ ...job, state: 'running' }]); assert.equal(reopened.visible(0)[0].state, 'running');
  reopened.update([job]); assert.equal(reopened.visible(0)[0].state, 'failed', 'a retry clears the earlier dismissal');
});
