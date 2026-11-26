export function requestProcessLabel(path, method = 'GET') {
  if (/\/audiobookshelf\/progress(?:\?|$)/u.test(path)) return '';
  if (/^\/api\/(processes|ai\/status)(?:\?|$)/u.test(path)) return '';
  if (/\/api\/ai\/phrase$/u.test(path)) return 'Explain selected phrase';
  if (/\/api\/ai\/summary$/u.test(path)) return 'Generate page explanation';
  if (/\/api\/ai\/word$/u.test(path)) return 'Look up word meaning';
  if (/\/api\/mandarin\/pinyin$/u.test(path) || /\/pinyin$/u.test(path)) return 'Prepare pinyin';
  if (/\/api\/audiobookshelf\/libraries/u.test(path)) return 'Load Audiobookshelf library';
  if (/\/api\/settings/u.test(path)) return method === 'GET' ? 'Load settings' : method === 'DELETE' ? 'Remove saved key' : 'Save settings';
  if (/\/recommendations/u.test(path)) return 'Compare book vocabulary';
  if (/\/(?:character-guide|question)$/u.test(path)) return 'Explain book passage';
  if (/\/api\/books$/u.test(path) && method === 'POST') return 'Import book';
  if (/\/api\/books\/[^/]+\/cover$/u.test(path) && method === 'POST') return 'Import book cover';
  if (path === '/api/fonts' && method === 'POST') return 'Import font';
  if (path === '/api/discovery' && method === 'GET') return '';
  if (/\/api\/discovery/u.test(path)) return 'Prepare book recommendations';
  if (/\/api\/imports/u.test(path)) return 'Prepare book download';
  if (/\/api\/books\/[^/]+\/recordings/u.test(path)) return method === 'GET' ? 'Load audiobook recordings' : 'Prepare audiobook recording';
  if (/\/api\/books\/[^/]+\/(?:learning|narration|ivoox|ocr|audiobookshelf)/u.test(path)) return method === 'GET' ? 'Load book tools' : 'Prepare book processing';
  return path.startsWith('/api/') ? method === 'GET' ? 'Load library data' : 'Save changes' : '';
}

export function createProcessTasks({ delay = 450, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const tasks = new Map(), listeners = new Set(), cancellations = new Map(); let sequence = 0, downloads = [], owner = '';
  const snapshot = () => ({ tasks: [...tasks.values()].filter((task) => task.visible).map(({ timer, visible, ...task }) => task), downloads });
  const emit = () => { const value = snapshot(); for (const listener of listeners) listener(value); };
  function begin(label, detail = {}) {
    const {cancel,immediate=false,...metadata}=detail;
    const id = `request:${++sequence}`, task = { id, label, ...metadata, cancellable:typeof cancel === 'function', created: now(), state: 'running', visible: immediate };
    if (cancel) cancellations.set(id,cancel);
    if (!immediate) { task.timer = setTimer(() => { if (tasks.has(id)) { task.visible = true; emit(); } }, delay); task.timer?.unref?.(); }
    tasks.set(id, task); if (immediate) emit();
    let ended = false;
    return (error) => {
      if (ended || !tasks.has(id)) return; ended = true;
      clearTimer(task.timer); delete task.timer;
      cancellations.delete(id);
      if (!error || !task.visible || error.name === 'AbortError') tasks.delete(id);
      else { task.state = 'failed'; task.detail = error.message; task.finished = now(); }
      const finished = [...tasks.values()].filter((item) => item.state !== 'running');
      for (const item of finished.slice(0, Math.max(0, finished.length - 40))) tasks.delete(item.id);
      emit();
    };
  }
  return { begin, snapshot, cancel(id) { const task=tasks.get(id), cancel=cancellations.get(id); if (!task || !cancel || task.state !== 'running') return;
    task.state='cancelled';task.finished=now();cancellations.delete(id);cancel();emit(); }, subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    setDownloads(jobs, { includeFinished = false } = {}) { downloads = includeFinished ? jobs : jobs.filter((job) => !['complete', 'completed', 'cancelled'].includes(job.state)); emit(); },
    setAccount(id) { if (owner && id !== owner) { for (const cancel of cancellations.values()) cancel(); cancellations.clear(); for (const task of tasks.values()) clearTimer(task.timer); tasks.clear(); downloads = []; } owner = id; emit(); },
    clearFinished() { for (const task of tasks.values()) if (task.state !== 'running') tasks.delete(task.id); emit(); },
  };
}
export const processTasks = createProcessTasks();
