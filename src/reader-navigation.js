// Keep a small amount of deliberate input while a page renders. Holding a key
// cannot create a long backlog, and audio jumps never overtake a manual turn.
export function pageTurnQueue({ perform, busy = () => {}, maxPending = 2 }) {
  let pending = [], running = false, generation = 0;
  async function drain(epoch) {
    running = true; busy(true);
    try {
      while (pending.length && epoch === generation) {
        const item = pending.shift();
        try { item.resolve(await perform(item.direction, item.target, item.context)); }
        catch (error) { item.reject(error); }
      }
    } finally { if (epoch === generation) { running = false; busy(false); } }
  }
  return {
    request(direction, target, context) {
      if (running && target != null) return Promise.resolve(false);
      if (pending.length >= maxPending) return Promise.resolve(false);
      return new Promise((resolve, reject) => { pending.push({ direction, target, context, resolve, reject }); if (!running) void drain(generation); });
    },
    reset() { generation++; pending.splice(0).forEach((item) => item.resolve(false)); running = false; busy(false); },
  };
}

export async function readerDeadline(task, { signal, milliseconds = 16000 } = {}) {
  let timer, stop;
  try {
    signal?.throwIfAborted();
    return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DOMException('The page renderer stopped responding.', 'TimeoutError')), milliseconds);
      if (signal) { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); }
    })]);
  } finally { clearTimeout(timer); if (stop) signal.removeEventListener('abort', stop); }
}

export function serializeRenderer(result, { signal, stalled, milliseconds } = {}) {
  let tail = Promise.resolve(), failed;
  const run = (action) => {
    const task = tail.catch(() => {}).then(() => {
      signal?.throwIfAborted(); if (failed) throw failed;
      return readerDeadline(action, { signal, milliseconds });
    }).catch((error) => { if (error?.name === 'TimeoutError') { failed = error; stalled?.(); } throw error; });
    tail = task; return task;
  };
  for (const name of ['move', 'go', 'apply', 'setZoom', 'revealWord']) if (result[name]) {
    const action = result[name]; result[name] = (...args) => run(() => action(...args));
  }
  return { renderer: result, run };
}
