import { offlineDownloadJobs, offlineOwner } from './offline-store.js';

// The queue lives on the reading device. A completed pack is only replaced by
// saveReadingPack after every resource is cached; interrupted jobs restart safely.
export function readingPackQueue({ download, store = offlineDownloadJobs, owner = offlineOwner,
  online = () => globalThis.navigator?.onLine !== false, now = Date.now }) {
  let jobs = [], account, loading, running, controller, generation = 0, disposed = false;
  let writes = Promise.resolve();
  const listeners = new Set();
  const pending = (job) => ['queued', 'downloading', 'waiting'].includes(job.state);
  const priority = (job) => Number.isFinite(job?.priority) ? job.priority : 0;
  const compare = (a, b) => priority(b) - priority(a) || a.created - b.created || a.id.localeCompare(b.id);
  const prioritySwitch = Object.assign(new Error('Paused for higher-priority work'), { name: 'AbortError' });
  const snapshot = () => jobs.map((job) => structuredClone(job));
  const emit = () => { for (const listener of listeners) listener(snapshot()); };
  const persist = (job) => { const copy = structuredClone(job); return writes = writes.catch(() => {}).then(() => { if (!disposed && owner() === copy.owner) return store.put(copy); }); };
  async function load() {
    const current = owner();
    if (!current || disposed) return false;
    if (current === account && loading) return loading;
    if (current === account) return true;
    const epoch = ++generation; controller?.abort(); running = undefined; account = current;
    jobs = []; emit();
    loading = (async () => {
      await writes.catch(() => {});
      const saved = await store.all();
      if (epoch !== generation || owner() !== current) return false;
      jobs = saved.filter((job) => job.owner === current).sort((a, b) => a.created - b.created);
      for (const job of jobs) if (job.state === 'downloading') {
        job.state = 'queued'; job.paused = Boolean(job.pauseRequested); job.pauseRequested = false;
        job.progress = { label: 'Queued after the app was closed', percent: 0 }; await persist(job);
      }
      // Retain other accounts' queues without loading or running their jobs.
      emit(); return true;
    })().finally(() => { if (epoch === generation) loading = undefined; });
    return loading;
  }
  function requestPrioritySwitch() {
    const current = jobs.find((job) => job.state === 'downloading'), next = jobs.filter((job) => job.state === 'queued').sort(compare)[0];
    if (!current || !next || priority(next) <= priority(current) || !controller || controller.signal.aborted) return;
    current.pauseRequested = true; void persist(current).catch(() => {}); emit();
    // Keep the current worker until its aborted transfer has cleaned up its
    // temporary cache. The next book must never overlap that cleanup.
    controller.abort(prioritySwitch);
  }
  async function prioritize(id, action = 'raise') {
    if (!['raise', 'top', 'lowest'].includes(action)) throw new Error('Choose Raise priority, Top priority or Lowest priority.');
    if (!await load()) return;
    const job = jobs.find((item) => item.id === id);
    if (!job || job.owner !== owner() || !pending(job)) return;
    const waiting = jobs.filter(pending), current = waiting.find((item) => item.state === 'downloading'), changed = [];
    let value;
    if (action === 'lowest') value = Math.min(0, ...waiting.map(priority)) - 1;
    else if (action === 'top' || !current) value = Math.max(0, ...waiting.map(priority)) + 1;
    else {
      value = Math.max(0, priority(job), priority(current)) + 1;
      for (const other of waiting) if (other !== job && priority(other) >= value) { other.priority = priority(other) + 1; changed.push(other); }
    }
    job.priority = value;
    await Promise.all([...changed, job].map(persist));
    if (job.owner !== owner() || job.owner !== account) return;
    emit(); requestPrioritySwitch(); kick(); return structuredClone(job);
  }
  function kick() {
    if (running || disposed || !online() || owner() !== account) return;
    const epoch = generation;
    running = (async () => {
      while (!disposed && epoch === generation && online() && owner() === account) {
        const job = jobs.filter((item) => item.state === 'queued').sort(compare)[0]; if (!job) break;
        controller = new AbortController(); const signal = controller.signal;
        job.state = 'downloading'; job.error = ''; job.paused = false; job.pauseRequested = false;
        job.progress = { label: 'Preparing reading pack…', percent: 0 }; emit();
        try {
          await persist(job);
          signal.throwIfAborted();
          let lastEmit = 0, lastWrite = 0, phase;
          await download(job.book, { ...job.options, signal, progress(update) {
            if (signal.aborted || epoch !== generation || owner() !== job.owner) return;
            job.progress = typeof update === 'string' ? { label: update } : update;
            const changed = phase !== job.progress.phase; phase = job.progress.phase;
            if (changed || now() - lastEmit >= 100) { lastEmit = now(); emit(); }
            if (changed || now() - lastWrite >= 750) { lastWrite = now(); void persist(job).catch(() => {}); }
          } });
          if (epoch !== generation || owner() !== job.owner) return;
          // A late request can arrive after the completed pack was committed.
          // A successful download stays complete; only an aborted one restarts.
          if (job.state === 'cancelled') continue;
          job.state = 'complete'; job.progress = { label: 'Available offline on this device', percent: 100 };
        } catch (error) {
          if (epoch !== generation || owner() !== job.owner) return;
          if (signal.aborted && signal.reason === prioritySwitch && job.state !== 'cancelled') {
            job.state = 'queued'; job.paused = true; job.error = ''; job.progress = { label: 'Queued', percent: 0 };
          } else if (signal.aborted) job.state = 'cancelled';
          else { job.state = error.retryable || !online() ? 'waiting' : 'failed'; job.error = error.message; }
        } finally {
          if (epoch === generation && owner() === job.owner) {
            job.pauseRequested = false;
            if (['complete', 'cancelled'].includes(job.state)) job.finished = now();
            await persist(job).catch(() => {}); emit();
          }
        }
      }
    })().finally(() => { if (epoch === generation) { running = undefined; controller = undefined; if (jobs.some((job) => job.state === 'queued')) kick(); } });
    // Persistent-storage failures are shown by enqueue/retry, never as an
    // unhandled background rejection that stops all subsequent downloads.
    void running.catch(() => {});
  }
  return {
    snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    async resume() {
      if (!await load()) return;
      if (online()) for (const job of jobs) if (job.state === 'waiting') { job.state = 'queued'; await persist(job); }
      emit(); requestPrioritySwitch(); kick();
    },
    async enqueue(book, options) {
      if (!await load()) throw new Error('Load your signed-in library before queuing a download.');
      const existing = jobs.find((job) => job.book.id === book.id);
      if (existing && ['queued', 'downloading', 'waiting'].includes(existing.state)) return structuredClone(existing);
      const job = { id: `${account}:${book.id}`, owner: account, book: { id: book.id, title: book.title, format: book.format, thumbnailType: book.thumbnailType },
        options: { audio: Boolean(options.audio), recording: options.recording || '' }, created: now(), priority: 0, state: 'queued', progress: { label: 'Queued', percent: 0 } };
      await persist(job);
      if (job.owner !== owner() || job.owner !== account) { await store.remove(job.id); throw new Error('The signed-in account changed. Queue the book from the current library.'); }
      jobs = jobs.filter((item) => item.id !== job.id); jobs.push(job); emit(); requestPrioritySwitch(); kick(); return structuredClone(job);
    },
    prioritize,
    raisePriority: (id) => prioritize(id, 'raise'),
    async cancel(id) {
      const job = jobs.find((item) => item.id === id); if (!job || job.owner !== owner() || !['queued', 'downloading', 'waiting'].includes(job.state)) return;
      if (job.state === 'downloading') controller?.abort();
      job.state = 'cancelled'; job.paused = false; job.pauseRequested = false;
      job.finished = now(); job.progress = { label: 'Download cancelled', percent: 0 }; await persist(job); emit();
    },
    async retry(id) {
      const job = jobs.find((item) => item.id === id); if (!job || job.owner !== owner() || ['queued', 'downloading'].includes(job.state)) return;
      job.state = 'queued'; job.error = ''; job.progress = { label: 'Queued', percent: 0 }; await persist(job); emit(); requestPrioritySwitch(); kick();
    },
    async remove(id) {
      const job = jobs.find((item) => item.id === id); if (!job || job.owner !== owner() || job.state === 'downloading') return;
      await store.remove(id); jobs = jobs.filter((item) => item.id !== id); emit();
    },
    async idle() { while (running) await running; await writes; },
    close() { disposed = true; generation++; controller?.abort(); listeners.clear(); },
  };
}
