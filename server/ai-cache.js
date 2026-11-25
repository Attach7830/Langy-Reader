import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

// Increment when the generation instructions or output contract change.
const version = 1;
const methods = new Map(['word', 'summary', 'bookQuestion', 'characterGuide', 'readingLevel', 'discoveryPlan', 'discoveryRecommendations'].map((name) => [name, 1]));
methods.set('vocabularyMeaning', 2);
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

export function openAICache(dir, { policy, identity }) {
  const path = join(dir, 'ai-responses.sqlite'), db = new DatabaseSync(path), context = new AsyncLocalStorage();
  chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS responses(owner TEXT NOT NULL,key TEXT NOT NULL,json TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER,
      PRIMARY KEY(owner,key)) STRICT;`);
  const pending = new Map(), epochs = new Map(); let closed = false;
  const prune = () => db.prepare('DELETE FROM responses WHERE expires IS NOT NULL AND expires<=?').run(Date.now());
  prune(); const timer = setInterval(prune, 15 * 60_000); timer.unref();
  const current = () => policy(context.getStore());
  function clear(visitor) {
    const scope = policy(visitor); if (!scope) return;
    epochs.set(scope.owner, (epochs.get(scope.owner) || 0) + 1);
    db.prepare('DELETE FROM responses WHERE owner=?').run(scope.owner);
  }
  async function generate(ai, name, args) {
    const count = methods.get(name), source = args.slice(0, count), signal = args[count];
    signal?.throwIfAborted();
    const visitor = context.getStore(), scope = policy(visitor);
    if (!scope?.enabled || scope.expires != null && scope.expires <= Date.now()) return ai[name](...source, signal);
    const model = identity(), epoch = epochs.get(scope.owner) || 0;
    const key = createHash('sha256').update(canonical([version, model, name, source])).digest('hex');
    prune();
    const row = db.prepare('SELECT json FROM responses WHERE owner=? AND key=?').get(scope.owner, key);
    if (row) { try { return JSON.parse(row.json); } catch { db.prepare('DELETE FROM responses WHERE owner=? AND key=?').run(scope.owner, key); } }
    const pendingKey = `${scope.owner}:${epoch}:${key}`;
    let task = pending.get(pendingKey);
    if (!task || task.control.signal.aborted) {
      task = { control: new AbortController(), waiters: 0 };
      const created = task;
      task.promise = Promise.resolve().then(() => { created.control.signal.throwIfAborted(); return ai[name](...source, created.control.signal); }).then((result) => {
        // Store only a completed, validated result. Disabling or clearing the
        // cache during generation also prevents the late answer being saved.
        const latest = policy(visitor), json = JSON.stringify(result);
        if (!closed && !created.control.signal.aborted && latest?.enabled && latest.owner === scope.owner
          && (latest.expires == null || latest.expires > Date.now()) && identity() === model && (epochs.get(scope.owner) || 0) === epoch
          && json && Buffer.byteLength(json) <= 1024 ** 2) {
          try { db.prepare('INSERT OR REPLACE INTO responses VALUES(?,?,?,?,?)').run(scope.owner, key, json, Date.now(), latest.expires ?? null); }
          catch { console.warn('Could not save an AI answer. Check the data drive and server permissions.'); }
        }
        return result;
      }).finally(() => { if (pending.get(pendingKey) === created) pending.delete(pendingKey); });
      pending.set(pendingKey, task);
    }
    task.waiters++;
    let stop;
    try {
      const cancelled = signal && new Promise((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); });
      const result = await (cancelled ? Promise.race([task.promise, cancelled]) : task.promise);
      return structuredClone(result);
    } finally {
      if (stop) signal.removeEventListener('abort', stop);
      if (!--task.waiters) task.control.abort();
    }
  }
  return {
    run: (visitor, task) => context.run(visitor, task), clear,
    enabled: () => Boolean(current()?.enabled),
    wrap(ai) { return new Proxy(ai, { get(target, name) { if (name === 'reuseEnabled') return () => Boolean(current()?.enabled);
      if (methods.has(name)) return (...args) => generate(target, name, args); return target[name]; } }); },
    close() { closed = true; clearInterval(timer); for (const task of pending.values()) task.control.abort(); db.close(); },
  };
}
