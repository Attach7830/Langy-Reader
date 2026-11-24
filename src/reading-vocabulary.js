import { textWords } from '../shared/reading-text.js';

export function displayedRanges(track, text, language) {
  const words = textWords(text, language), ranges = [];
  for (const [index, local] of track.match(words)) {
    if (!track.visible(local)) continue;
    const word = words[index], previous = ranges.at(-1);
    if (previous && word.from <= previous.to + 2) previous.to = word.to;
    else ranges.push({ from: word.from, to: word.to });
  }
  return ranges.slice(0, 1000);
}

export function readingVocabulary({ book, renderer, request, dwell = 1500, onDisplay = () => {} }) {
  const storageKey = 'langy-reading-exposures-v1';
  let pending;
  try { pending = JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch { pending = []; }
  if (!Array.isArray(pending)) pending = [];
  pending = pending.filter((entry) => typeof entry?.id === 'string' && entry.body && Array.isArray(entry.body.ranges)).slice(-200);
  const chapters = new Map(), recorded = new Set();
  let epoch = 0, timer, retry, flushing, session, sessionBook;
  const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify(pending)); } catch { /* Reading stays available if browser storage is full. */ } };
  function flush() {
    if (flushing) return flushing;
    if (!pending.length) return Promise.resolve();
    flushing = Promise.resolve().then(async () => {
      while (pending.length) {
        const entry = pending[0];
        try { await request(`/api/books/${encodeURIComponent(entry.id)}/vocabulary/seen`, { method: 'POST', body: entry.body }); }
        catch (error) {
          if (![403, 404, 410, 422].includes(error.status) && !(error.status === 409 && /text changed/iu.test(error.message))) break;
        }
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
        persist();
      }
    }).finally(() => { flushing = undefined; });
    return flushing;
  }
  async function capture(version) {
    const current = book(), currentRenderer = renderer();
    if (version !== epoch || !current || document.hidden) return;
    if (sessionBook !== current.id) {
      sessionBook = current.id;
      session = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
    const pages = currentRenderer?.vocabularyPages?.() || [currentRenderer?.audioUnit?.()].filter(Boolean);
    const displayed = [];
    for (const page of pages) {
      const key = JSON.stringify([current.id, page.key, current.language, current.languages]);
      let source = chapters.get(key);
      try {
        if (!source) source = await request(`/api/books/${encodeURIComponent(current.id)}/vocabulary/sections/${encodeURIComponent(page.key)}`);
        if (version !== epoch || book()?.id !== current.id || document.hidden) return;
        if (!(source.textReady ?? source.analysisState === 'ready')) { clearTimeout(retry); retry = setTimeout(refresh, 5000); continue; }
        chapters.set(key, source);
        if (chapters.size > 8) chapters.delete(chapters.keys().next().value);
        const ranges = displayedRanges(page.track(), source.text, current.language);
        if (!ranges.length) continue;
        const body = { key: page.key, digest: source.textHash, ranges, session };
        displayed.push({ key: page.key, digest: source.textHash, ranges });
        const signature = JSON.stringify([current.id, body]);
        if (recorded.has(signature)) continue;
        pending.push({ id: current.id, body }); pending = pending.slice(-200); persist();
        recorded.add(signature);
        if (recorded.size > 500) recorded.delete(recorded.values().next().value);
      } catch { clearTimeout(retry); retry = setTimeout(refresh, 10000); }
    }
    if (version === epoch && book()?.id === current.id && !document.hidden) onDisplay(displayed);
    void flush();
  }
  function cancel() { epoch++; clearTimeout(timer); clearTimeout(retry); }
  function stop() { cancel(); sessionBook = session = undefined; }
  function refresh() { cancel(); if (book()) { const version = epoch; timer = setTimeout(() => void capture(version), dwell); } }
  window.addEventListener('online', () => { void flush(); refresh(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); else { void flush(); refresh(); } });
  const interval = setInterval(() => { void flush(); }, 30000);
  void flush();
  return { refresh, stop, flush, destroy() { stop(); clearInterval(interval); } };
}
