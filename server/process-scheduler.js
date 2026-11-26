import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { RequestError } from './books.js';

// One admission slot for background workers. Their own databases remain the
// source of truth for resumable work; this database stores queue order only.
export function openProcessScheduler(dir, { paused = false, now = Date.now } = {}) {
  const db = new DatabaseSync(join(dir, 'process-queue.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS ordering(
    id TEXT PRIMARY KEY, priority INTEGER NOT NULL, queuedAt INTEGER NOT NULL
  ) STRICT;`);
  const ordering = new Map(db.prepare('SELECT * FROM ordering').all().map((row) => [row.id, row]));
  const pending = new Set(), context = new AsyncLocalStorage();
  let active, scheduled = false, closed = false;
  function order(job) {
    if (!ordering.has(job.id)) {
      const value = { id: job.id, priority: 0, queuedAt: Number.isFinite(job.created) && job.created > 0 ? job.created : now() };
      db.prepare('INSERT INTO ordering VALUES(?,?,?)').run(value.id, value.priority, value.queuedAt); ordering.set(job.id, value);
    }
    return ordering.get(job.id);
  }
  function choices() {
    const result = [];
    for (const entry of pending) {
      let jobs; try { jobs = entry.candidates() || []; } catch { jobs = []; }
      jobs = jobs.filter((job) => job?.id && job.id !== active?.id);
      if (!jobs.length) { if (entry !== active?.entry) { pending.delete(entry); entry.resolve(undefined); } continue; }
      for (const job of jobs) result.push({ ...job, entry, ...order(job) });
    }
    // A promoted task also promotes its prerequisite text extraction.
    const priorities = new Map(result.map((job) => [job.id, job.priority]));
    for (let turn = 0; turn < result.length; turn++) {
      let changed = false;
      for (const job of result) for (const id of job.dependencies || []) {
        if (priorities.has(id) && priorities.get(id) < priorities.get(job.id)) { priorities.set(id, priorities.get(job.id)); changed = true; }
      }
      if (!changed) break;
    }
    for (const job of result) job.priority = priorities.get(job.id);
    return result.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
  }
  function wake(reconcile = false) {
    if (reconcile === true && !closed) choices();
    if (closed || paused || active || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void drain(); });
  }
  async function drain() {
    if (closed || paused || active) return;
    const job = choices().find((candidate) => candidate.ready !== false);
    if (!job) return;
    const lease = { id: job.id, children: new Set() }; active = { ...job, startedAt: now(), lease };
    try { const result = await context.run(lease, () => job.entry.execute(job.data)); job.entry.resolve({ job, result }); }
    catch (error) { job.entry.reject(error); }
    finally {
      pending.delete(job.entry);
      if (!closed) { db.prepare('DELETE FROM ordering WHERE id=?').run(job.id); ordering.delete(job.id); }
      active = undefined; wake();
    }
  }
  function runNext(candidates, execute) {
    if (closed) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => { pending.add({ candidates, execute, resolve, reject }); wake(); });
  }
  function run(id, execute, metadata = {}) {
    return runNext(() => metadata.valid && !metadata.valid() ? [] : [{ ...metadata, id, data: null }], execute).then((value) => value?.result);
  }
  async function joinTask(id, promise) {
    // Text may already have been queued by the library before a worker needs
    // it. Execute that dependency inside the current slot instead of deadlocking.
    const lease = context.getStore();
    if (lease && active?.lease === lease) {
      const job = choices().find((candidate) => candidate.id === id);
      if (job) {
        pending.delete(job.entry); lease.children.add(id);
        try { const result = await job.entry.execute(job.data); job.entry.resolve({ job, result }); }
        catch (error) { job.entry.reject(error); }
        finally { lease.children.delete(id); db.prepare('DELETE FROM ordering WHERE id=?').run(id); ordering.delete(id); }
      }
    }
    return promise;
  }
  function snapshot() {
    const jobs = choices();
    return { active: active ? { id: active.id, startedAt: active.startedAt, children: [...active.lease.children] } : null,
      queued: jobs.map((job, index) => ({ id: job.id, priority: job.priority, position: index + 1, ready: job.ready !== false })) };
  }
  const timer = setInterval(wake, 250); timer.unref();
  return { runNext, run, join: joinTask, snapshot, wake, outside: (task) => context.exit(task),
    resume() { paused = false; wake(); },
    raise(id) {
      const jobs = choices(), job = jobs.find((item) => item.id === id);
      if (!job) throw new RequestError(409, 'This task is already running or no longer queued.');
      const priority = Math.max(0, ...jobs.map((item) => item.priority)) + 1;
      db.prepare('UPDATE ordering SET priority=? WHERE id=?').run(priority, id); ordering.get(id).priority = priority; wake();
      return { priority };
    },
    async close() {
      closed = true; clearInterval(timer);
      for (const entry of pending) entry.resolve(undefined); pending.clear();
      // Callers close workers after their active operation has settled.
      if (active) throw new Error('Wait for the active background task before closing its scheduler.');
      db.close();
    },
  };
}

export async function consumeProcesses(scheduler, candidates, execute) {
  const visited = new Set();
  const remaining = () => candidates().filter((job) => !visited.has(job.id));
  for (;;) {
    const value = scheduler ? await scheduler.runNext(remaining, execute) : await (async () => {
      const job = remaining().find((entry) => entry.ready !== false); return job ? { job, result: await execute(job.data) } : undefined;
    })();
    if (!value) break;
    visited.add(value.job.id);
    if (value.result === false) break;
  }
}
