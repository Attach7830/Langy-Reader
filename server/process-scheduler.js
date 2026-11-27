import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { RequestError } from './books.js';

// Archive downloads lead the automatic queue. Explicit positive/negative
// priorities let the user move any task above/below those defaults.
const archivePriority = (job) => job.priority === 0 && job.id.startsWith('archive:');
const rank = (job) => job.priority > 0 ? job.priority + 1 : job.priority || Number(archivePriority(job));
const compare = (a, b) => rank(b) - rank(a) || a.queuedAt - b.queuedAt || a.id.localeCompare(b.id);
export const PROCESS_YIELD = Symbol('process-yield');

// One admission slot for background workers. Their own databases remain the
// source of truth for resumable work; this database stores queue order only.
export function openProcessScheduler(dir, { paused = false, now = Date.now } = {}) {
  const db = new DatabaseSync(join(dir, 'process-queue.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS ordering(
    id TEXT PRIMARY KEY, priority INTEGER NOT NULL, queuedAt INTEGER NOT NULL
  ) STRICT;`);
  const ordering = new Map(db.prepare('SELECT * FROM ordering').all().map((row) => [row.id, row]));
  const pending = new Set(), context = new AsyncLocalStorage(), suspended = new Set(), started = new Map();
  let active, scheduled = false, closed = false;
  function order(job) {
    if (!ordering.has(job.id)) {
      const value = { id: job.id, priority: 0, queuedAt: Number.isFinite(job.created) && job.created > 0 ? job.created : now() };
      db.prepare('INSERT INTO ordering VALUES(?,?,?)').run(value.id, value.priority, value.queuedAt); ordering.set(job.id, value);
    }
    return ordering.get(job.id);
  }
  function queueState() {
    const result = [];
    for (const entry of pending) {
      let jobs; try { jobs = entry.candidates() || []; } catch { jobs = []; }
      jobs = jobs.filter((job) => job?.id && job.id !== active?.id);
      if (!jobs.length) { if (entry !== active?.entry) { pending.delete(entry); entry.resolve(undefined); } continue; }
      for (const job of jobs) result.push({ ...job, entry, ...order(job) });
    }
    // A promoted task also promotes its prerequisite text extraction, including
    // while that prerequisite is running. Otherwise it can yield to lower work
    // and immediately be selected again at its inherited priority.
    const running = active ? { ...active, ...order(active) } : null;
    const all = [...result, ...(running ? [running] : [])];
    const priorities = new Map(all.map((job) => [job.id, job.priority]));
    for (let turn = 0; turn < all.length; turn++) {
      let changed = false;
      for (const job of all) for (const id of job.dependencies || []) {
        // An explicit Lowest priority choice also applies to prerequisites.
        // Their consumers remain blocked until that extraction eventually runs.
        if (priorities.has(id) && priorities.get(id) >= 0 && priorities.get(id) < priorities.get(job.id)) {
          priorities.set(id, priorities.get(job.id)); changed = true;
        }
      }
      if (!changed) break;
    }
    for (const job of all) job.priority = priorities.get(job.id);
    return { jobs: result.sort(compare), running };
  }
  const choices = () => queueState().jobs;
  function shouldYield() {
    if (!active || context.getStore() !== active.lease || active.lease.children.size) return false;
    const { jobs, running } = queueState(), next = jobs.find((job) => job.ready !== false);
    return Boolean(next && compare(next, running) < 0);
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
    const lease = { id: job.id, children: new Set() };
    if (!started.has(job.id)) started.set(job.id, now());
    active = { ...job, startedAt: started.get(job.id), lease }; suspended.delete(job.id);
    let yielded = false;
    try {
      const result = await context.run(lease, () => job.entry.execute(job.data));
      yielded = result === PROCESS_YIELD;
      if (yielded) suspended.add(job.id);
      else job.entry.resolve({ job, result });
    }
    catch (error) { job.entry.reject(error); }
    finally {
      // A worker yields only after its callback has saved a checkpoint and
      // unwound. Keep the provider promise pending so even a sibling task can
      // take the slot, without overlapping worker state or losing queue order.
      if (!yielded) {
        pending.delete(job.entry); suspended.delete(job.id); started.delete(job.id);
        if (!closed) { db.prepare('DELETE FROM ordering WHERE id=?').run(job.id); ordering.delete(job.id); }
      }
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
    const { jobs, running } = queueState(), ranked = [...jobs, ...(running ? [running] : [])].sort(compare);
    const positions = new Map(ranked.map((job, index) => [job.id, index + 1]));
    const status = (job) => ({ id: job.id, priority: job.priority, topPriority: archivePriority(job), position: positions.get(job.id) });
    const next = jobs.find((job) => job.ready !== false);
    return { active: running ? { ...status(running), startedAt: running.startedAt, children: [...running.lease.children],
      pauseRequested: Boolean(next && compare(next, running) < 0) } : null,
      queued: jobs.map((job) => ({ ...status(job), paused: suspended.has(job.id), ready: job.ready !== false })) };
  }
  function prioritize(id, action) {
    const { jobs, running } = queueState(); if (running) jobs.push(running);
    const job = jobs.find((item) => item.id === id);
    if (!job) throw new RequestError(409, 'This task is no longer active or queued.');
    const maximum = Math.max(0, ...jobs.map((item) => item.priority));
    const priority = action === 'lowest' ? Math.min(0, ...jobs.map((item) => item.priority)) - 1
      : action === 'top' ? maximum + 1 : Math.max(0, job.priority, running ? running.priority : maximum) + 1;
    const updates = action === 'raise' ? jobs.filter((item) => item.id !== id && order(item).priority >= priority)
      .map((item) => ({ id: item.id, priority: order(item).priority + 1 })) : [];
    updates.push({ id, priority });
    db.exec('BEGIN');
    try {
      for (const value of updates) db.prepare('UPDATE ordering SET priority=? WHERE id=?').run(value.priority, value.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    for (const value of updates) ordering.get(value.id).priority = value.priority;
    wake(); return { priority };
  }
  const timer = setInterval(wake, 250); timer.unref();
  return { runNext, run, join: joinTask, snapshot, wake, shouldYield, outside: (task) => context.exit(task),
    resume() { paused = false; wake(); },
    raise: (id) => prioritize(id, 'raise'),
    top: (id) => prioritize(id, 'top'),
    lowest: (id) => prioritize(id, 'lowest'),
    async close() {
      closed = true; clearInterval(timer);
      for (const entry of pending) entry.resolve(undefined); pending.clear();
      // Callers close workers after their active operation has settled.
      if (active) throw new Error('Wait for the active background task before closing its scheduler.');
      db.close();
    },
  };
}

// Cancellable transfers can stop between chunks and restart safely. The
// callback runs in the worker's async context; never use it around an atomic
// library save or an upload whose remote outcome cannot be confirmed.
export function watchProcessPriority(scheduler, interrupt, canInterrupt = () => true) {
  if (!scheduler) return () => {};
  const timer = setInterval(() => {
    if (canInterrupt() && scheduler.shouldYield()) { clearInterval(timer); interrupt(); }
  }, 100);
  timer.unref();
  return () => clearInterval(timer);
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
