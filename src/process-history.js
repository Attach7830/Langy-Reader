const done = (job) => ['complete', 'completed', 'cancelled'].includes(job.state);
export const processKey = (job) => `${job.id}:${job.created || 0}`;

// Completion time belongs to the transition, not to the task's creation time.
// Workers expose active work only, so a task disappearing after a successful
// status refresh also counts as completion.
export function processHistory({ now = Date.now, storage, key = '' } = {}) {
  let previous = new Map(), finished = new Map(), dismissed = new Map(); const expired = new Set();
  try { finished = new Map(JSON.parse(storage?.getItem(key) || '[]').filter(([, job]) => done(job) && Number.isFinite(job.finished))); } catch {}
  try { dismissed = new Map(JSON.parse(storage?.getItem(`${key}-dismissed`) || '[]')); } catch {}
  const failure = (job) => JSON.stringify([job.state, job.detail, job.phase]);
  function persist() { try { storage?.setItem(key, JSON.stringify([...finished].slice(-100))); storage?.setItem(`${key}-dismissed`, JSON.stringify([...dismissed].slice(-200))); } catch {} }
  return {
    update(jobs, { completeMissing = true } = {}) {
      const next = new Map(jobs.map((job) => [processKey(job), job]));
      if (completeMissing) for (const [id, job] of previous) if (!next.has(id) && !['failed', 'awaiting_confirmation'].includes(job.state) && !job.decision) finished.set(id, { ...job, state: 'completed', detail: '', progress: 100, finished: now() });
      for (const [id, job] of next) {
        if (job.state !== 'failed') dismissed.delete(id);
        if (done(job)) { if (!expired.has(id)) finished.set(id, { ...job, finished: job.finished || finished.get(id)?.finished || now() }); }
        else { finished.delete(id); expired.delete(id); }
      }
      previous = new Map([...next].filter(([, job]) => !done(job))); persist();
    },
    visible(minutes) {
      const duration = Math.max(0, Number(minutes) || 0) * 60000;
      for (const [id, job] of finished) if (!duration || now() - job.finished >= duration) { finished.delete(id); expired.add(id); }
      persist(); return [...previous.values(), ...finished.values()].filter((job) => job.state !== 'failed' || dismissed.get(processKey(job)) !== failure(job));
    },
    dismiss(job) { const id = processKey(job); if (job.state === 'failed') dismissed.set(id, failure(job)); previous.delete(id); finished.delete(id); expired.add(id); persist(); },
    expiresIn(minutes) { return finished.size ? Math.max(1, Math.min(...[...finished.values()].map((job) => job.finished + minutes * 60000 - now()))) : null; },
  };
}
