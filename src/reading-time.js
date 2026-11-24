export function activeReadingClock({ emit, eligible, monotonic = () => performance.now(), wall = Date.now, idleMs = 120000, maxGap = 15000 }) {
  let last = monotonic(), lastWall = wall(), until = -Infinity, context = null, active = false;
  function tick(force = false) {
    const next = monotonic(), stamp = wall(), delta = next - last, elapsed = stamp - lastWall;
    if (delta < 0 || elapsed < 0 || delta > maxGap || Math.abs(delta - elapsed) > 1000) until = -Infinity;
    else if (context && active && (force || eligible())) {
      const amount = Math.floor(Math.max(0, Math.min(delta, elapsed, until - last)));
      if (amount) emit({ context, start: lastWall, end: lastWall + amount });
    }
    last = next; lastWall = stamp; active = Boolean(eligible());
  }
  return { tick,
    activity() { tick(); until = monotonic() + idleMs; active = Boolean(eligible()); },
    context(value) { tick(); context = value; },
    pause() { tick(true); until = -Infinity; active = false; },
    stop() { tick(true); context = null; until = -Infinity; active = false; },
  };
}

export function readingTime({ book, renderer, request, eligible = () => !document.hidden && document.hasFocus() && !document.querySelector('dialog[open]'),
  storage, monotonic, wall, trusted = (event) => event.isTrusted, automatic = true }) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
  const storageKey = 'langy-reading-time-v1'; let saved;
  try { saved = JSON.parse(storage?.getItem(storageKey) || 'null'); } catch {}
  let accountId = typeof saved?.accountId === 'string' ? saved.accountId : null;
  let pending = Array.isArray(saved?.pending) ? saved.pending.filter((entry) => entry?.book && entry.event?.id && Number.isSafeInteger(entry.event.start) && Number.isSafeInteger(entry.event.end)).slice(-4096) : [];
  let flushing, initialized = false, currentBook, context, sequence = 0, destroyed = false;
  const documents = new Map(), controls = [];
  const persist = () => { try { storage?.setItem(storageKey, JSON.stringify({ accountId, pending })); } catch {} };
  const clock = activeReadingClock({ eligible, monotonic, wall, emit({ context, start, end }) {
    if (!initialized || destroyed || !context) return;
    const signature = JSON.stringify(context), previous = pending.at(-1);
    if (previous && !previous.sent && previous.signature === signature && previous.event.end === start && end - previous.event.start <= 30000) previous.event.end = end;
    else pending.push({ book: context.book, signature, event: { id: globalThis.crypto?.randomUUID?.() || `time-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`, start, end, pages: context.pages } });
    pending = pending.slice(-4096); persist();
  } });
  function setAccount(id) {
    if (typeof id !== 'string' || !id) return;
    if (accountId !== id) { clock.stop(); pending = []; currentBook = context = null; }
    accountId = id; initialized = true; persist(); void flush();
  }
  function flush({ keepalive = false } = {}) {
    if (!initialized || destroyed) return Promise.resolve();
    if (flushing) return flushing;
    flushing = Promise.resolve().then(async () => {
      while (pending.length && !destroyed) {
        const owner = accountId, first = pending[0], batch = [];
        for (const entry of pending) {
          if (entry.book !== first.book || batch.length >= 8 || JSON.stringify([...batch.map((item) => item.event), entry.event]).length > (keepalive ? 45000 : 200000)) break;
          batch.push(entry);
        }
        if (!batch.length) batch.push(first);
        for (const entry of batch) entry.sent = true; persist();
        try { await request(`/api/books/${encodeURIComponent(first.book)}/reading-time`, { method: 'POST', keepalive, body: { accountId: owner, events: batch.map((entry) => entry.event) } }); }
        catch (error) {
          if (owner !== accountId) break;
          if (error.status === 409 && error.details?.accountChanged) { pending = []; initialized = false; persist(); break; }
          if (![403, 404, 410, 422].includes(error.status) && !(error.status === 409 && /text changed/iu.test(error.message))) break;
        }
        if (owner !== accountId) break;
        const ids = new Set(batch.map((entry) => entry.event.id)); pending = pending.filter((entry) => !ids.has(entry.event.id)); persist();
      }
    }).finally(() => { flushing = undefined; });
    return flushing;
  }
  function activity() { if (book() && !destroyed && eligible()) clock.activity(); }
  const input = (event) => { if (trusted(event) && (event.type !== 'pointermove' || event.buttons)) activity(); };
  function bind() {
    const pages = renderer()?.vocabularyPages?.() || [renderer()?.audioUnit?.()].filter(Boolean);
    const targets = new Set([document, ...pages.map((page) => page.root?.ownerDocument).filter(Boolean)]);
    const names = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart', 'touchmove'];
    for (const [doc, cleanup] of documents) if (!targets.has(doc)) { cleanup(); documents.delete(doc); }
    for (const doc of targets) if (!documents.has(doc)) {
      for (const name of names) doc.addEventListener(name, input, { capture: true, passive: true });
      documents.set(doc, () => { for (const name of names) doc.removeEventListener(name, input, true); });
    }
  }
  function refresh() {
    const active = book(); if (!active) return stop();
    const opening = currentBook !== active.id; currentBook = active.id; context = { book: active.id, pages: [] }; clock.context(context); bind();
    if (opening) activity();
  }
  function evidence(pages) {
    if (!book() || currentBook !== book().id) return;
    let budget = 2000;
    const visible = [];
    for (const { key, digest, ranges } of pages.slice(0, 16)) {
      const bounded = ranges.slice(0, Math.min(1000, budget));
      if (bounded.length) visible.push({ key, digest, ranges: bounded });
      budget -= bounded.length;
      if (!budget) break;
    }
    context = { book: currentBook, pages: visible }; clock.context(context); bind();
  }
  function stop() { clock.stop(); currentBook = context = null; void flush(); for (const cleanup of documents.values()) cleanup(); documents.clear(); }
  function listen(target, name, callback) { target.addEventListener(name, callback); controls.push(() => target.removeEventListener(name, callback)); }
  listen(window, 'blur', () => { clock.pause(); void flush(); });
  listen(window, 'focus', () => { activity(); void flush(); });
  listen(document, 'visibilitychange', () => { if (document.hidden) clock.pause(); else activity(); void flush({ keepalive: document.hidden }); });
  listen(window, 'pagehide', () => { clock.pause(); void flush({ keepalive: true }); });
  listen(window, 'online', () => void flush());
  let ticks = 0;
  const timer = automatic ? setInterval(() => { clock.tick(); if (++ticks % 3 === 0) void flush(); }, 5000) : null;
  return { setAccount, refresh, evidence, activity, tick: clock.tick, flush, stop,
    destroy() { stop(); destroyed = true; clearInterval(timer); for (const cleanup of controls) cleanup(); } };
}
