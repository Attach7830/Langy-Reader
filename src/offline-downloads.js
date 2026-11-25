import { $, api, element, message, toast } from './ui.js';
import { offlineOwner, packCaches, packPrefix } from './offline-store.js';
import { readingPackQueue } from './offline-download-queue.js';
import { fetchPackResource, measuredResponse, downloadProgressLabel } from './offline-transfer.js';
import { dismissOnBackdrop } from './dialog-backdrop.js';
import { processTasks } from './process-tasks.js';
import { notifyDownloadedBooks } from './book-source.js';

let shellUpdate;
const fetchOK = fetchPackResource;
export function cacheReaderShell(progress = () => {}) {
  if (shellUpdate) return shellUpdate;
  shellUpdate = (async () => {
    const manifest = await (await fetchOK('/offline-assets.json')).json(), shell = await caches.open('langy-shell-v1');
    const previous = await shell.match('/__langy_shell_version__');
    if (previous && await previous.text() === manifest.version) return;
    const assets = manifest.assets.filter((path) => path !== '/'); let index = 0, complete = 0;
    const worker = async () => { while (index < assets.length) {
      const path = assets[index++]; if (!await shell.match(path)) await shell.put(path, await fetchOK(path));
      progress(`Saving the reader for offline use · ${++complete}/${assets.length}`, { complete, total: assets.length });
    } };
    await Promise.all(Array.from({ length: 4 }, worker));
    // Keep the last complete reader until every resource for the next version
    // exists. An interrupted upgrade must not strand already-downloaded books.
    const page = await fetchOK('/');
    if (page.headers.get('X-Langy-Cached') === '1') throw new Error('Reconnect to finish updating the offline reader.');
    await shell.put('/', page); await shell.put('/__langy_shell_version__', new Response(manifest.version));
  })().finally(() => { shellUpdate = null; }); return shellUpdate;
}
export async function refreshOfflineReader() {
  if (!globalThis.caches || !navigator.serviceWorker || !isSecureContext) return;
  if (!(await packCaches()).length) return;
  try { await cacheReaderShell(); } catch { /* The last complete reader stays available offline. */ }
}
export async function saveReadingPack(book, { recording, audio, progress = () => {}, signal }) {
  if (!navigator.serviceWorker || !isSecureContext) throw new Error('Offline packs need HTTPS, localhost or the Langy Android app.');
  await navigator.serviceWorker.ready;
  signal?.throwIfAborted();
  const owner = offlineOwner(); if (!owner) throw new Error('Load your signed-in library before saving an offline pack.');
  progress({ phase: 'preparing', label: 'Preparing text and dictionary entries…' });
  const pack = await (await fetchOK(`/api/books/${book.id}/offline${recording ? `?recording=${encodeURIComponent(recording)}` : ''}`, signal)).json();
  const name = `${packPrefix(owner)}${book.id}-${crypto.randomUUID()}`, cache = await caches.open(name);
  const json = (path, value) => cache.put(path, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));
  async function file(path, phase, label, from, to) {
    signal?.throwIfAborted();
    const response = await fetchOK(path, signal);
    await cache.put(path, measuredResponse(response, (bytes) => progress({ phase, label, ...bytes,
      percent: bytes.complete ? to : bytes.total ? from + (to - from) * Math.min(1, bytes.loaded / bytes.total) : null }), signal));
  }
  try {
    await file(`/api/books/${book.id}/file`, 'book', 'Downloading book', 5, 30);
    if (book.thumbnailType) { const response = await fetch(`/api/books/${book.id}/cover`, { signal }); if (response.ok) await cache.put(`/api/books/${book.id}/cover`, response); }
    const narration = { ...pack.narration, recordings: (pack.narration.recordings || []).filter((item) => item.id === pack.narration.audio.id) };
    if (!audio) narration.audio = { state: 'missing' };
    await json(`/api/books/${book.id}/offline-data`, pack);
    await json(`/api/books/${book.id}/narration`, narration);
    if (recording) await json(`/api/books/${book.id}/narration?recording=${encodeURIComponent(recording)}`, narration);
    if (narration.absConnected && pack.narration.audio.id) {
      const path = `/api/books/${book.id}/audiobookshelf/progress?recording=${encodeURIComponent(pack.narration.audio.id)}`;
      const response = await fetch(path, { signal }); if (response.ok) await cache.put(path, response);
    }
    let savedUnits = 0;
    for (const unit of pack.units) {
      signal?.throwIfAborted();
      const path = `/api/books/${book.id}/chapters/${encodeURIComponent(unit.key)}`;
      await json(path, unit); if (pack.narration.audio.id) await json(`${path}?recording=${encodeURIComponent(pack.narration.audio.id)}`, unit);
      await json(`/api/books/${book.id}/vocabulary/sections/${encodeURIComponent(unit.key)}`, { key: unit.key, text: unit.text, textHash: unit.textHash, languages: unit.languages, textReady: true, analysisState: unit.analysisState });
      progress({ phase: 'dictionary', label: `Saving text and dictionaries · ${++savedUnits}/${pack.units.length} sections`, percent: 30 + 20 * savedUnits / pack.units.length });
    }
    for (const path of ['/api/library', '/api/settings/reader', '/api/settings/learning', `/api/books/${book.id}/bookmarks`, `/api/books/${book.id}/learning`, `/api/books/${book.id}/recordings`, `/api/books/${book.id}/progress`]) {
      const response = await fetchOK(path, signal); await cache.put(path, response);
    }
    if (audio && pack.narration.audio.state === 'ready') {
      await file(pack.narration.audio.url, 'audio', 'Downloading complete audiobook', 50, 90);
    }
    progress({ phase: 'reader', label: 'Saving the reader for offline use…', percent: 90 });
    await cacheReaderShell((label, count) => { signal?.throwIfAborted(); progress({ phase: 'reader', label, percent: count ? 90 + 9 * count.complete / count.total : 90 }); });
    signal?.throwIfAborted();
    if (offlineOwner() !== owner) throw new Error('The signed-in account changed during this download. Retry from the current account.');
    await cache.put('/__langy_pack_ready__', new Response(JSON.stringify({ book: book.id, owner, created: Date.now() })));
    for (const old of await packCaches()) if (old !== name && await (await caches.open(old)).match(`/api/books/${book.id}/offline-data`)) await caches.delete(old);
    await navigator.storage?.persist?.(); notifyDownloadedBooks(); return pack;
  } catch (error) { await caches.delete(name); if (error.name === 'QuotaExceededError') throw new Error('This device has insufficient browser storage. Remove an offline pack or download without audio.'); throw error; }
}

export function offlineDownloads({ queue = readingPackQueue({ download: saveReadingPack }) } = {}) {
  const surface = window, dialog = $('#offline-dialog'), list = $('#offline-download-list'); let selected, epoch = 0, loading = false, authorized = false, listVersion;
  dismissOnBackdrop(dialog); dismissOnBackdrop($('#downloads-dialog'));
  const pending = (job) => ['queued', 'downloading', 'waiting'].includes(job?.state);
  const describe = (job) => `${({ queued: 'Queued', downloading: 'Downloading', waiting: 'Waiting for connection', complete: 'Downloaded', failed: 'Download failed', cancelled: 'Cancelled' })[job.state]} · ${job.error || downloadProgressLabel(job.progress)}`;
  const unsubscribe = queue.subscribe((jobs) => {
    const active = jobs.find((job) => job.state === 'downloading'), remaining = jobs.filter(pending), waiting = jobs.some((job) => job.state === 'waiting');
    processTasks.setDownloads(jobs);
    message('#offline-status', active ? `${active.book.title} · ${downloadProgressLabel(active.progress)}${remaining.length > 1 ? ` · ${remaining.length - 1} queued` : ''}`
      : waiting ? 'Book downloads are waiting for a connection. Open Process queue to retry.' : jobs.some((job) => job.state === 'failed') ? 'A book download needs attention. Open Process queue to retry.' : '');
    const version = JSON.stringify(jobs.map((job) => [job.id, job.state, job.error, job.book.title]));
    if (version !== listVersion) {
    const cards = jobs.map((job) => {
      const card = element('article', 'download-card'); card.dataset.download = job.book.id;
      const title = element('h3', '', job.book.title); title.setAttribute('data-user-content', '');
      const status = element('p', 'field-note download-status', describe(job));
      const meter = document.createElement('progress'); meter.max = 100; meter.setAttribute('aria-label', `Download progress for ${job.book.title}`);
      if (Number.isFinite(job.progress?.percent)) meter.value = job.progress.percent;
      const actions = element('div', 'download-actions');
      function action(label, callback) {
        const button = element('button', 'button quiet small', label); button.type = 'button';
        button.addEventListener('click', () => { void Promise.resolve().then(callback).catch((error) => message('#offline-download-error', error.message)); }); actions.append(button);
      }
      if (pending(job)) action('Cancel download', () => queue.cancel(job.id));
      if (['waiting', 'failed', 'cancelled'].includes(job.state)) action('Retry download', () => queue.retry(job.id));
      if (job.state === 'complete') action('Read book', () => { $('#downloads-dialog').close(); location.hash = `#read/${job.book.id}`; });
      if (['complete', 'failed', 'cancelled'].includes(job.state)) action('Dismiss', () => queue.remove(job.id));
      card.append(title, status, meter, actions); return card;
    });
    list.replaceChildren(...(cards.length ? cards : [element('p', 'field-note', 'No book downloads yet. Choose Save offline in a book’s options.')]));
    listVersion = version;
    } else {
      // Keep controls under the user's finger/focus while byte counts update.
      jobs.forEach((job, index) => {
        const card = list.children[index], meter = card.querySelector('progress');
        card.querySelector('.download-status').textContent = describe(job);
        if (Number.isFinite(job.progress?.percent)) meter.value = job.progress.percent; else meter.removeAttribute('value');
      });
    }
    if (selected) {
      const job = jobs.find((item) => item.book.id === selected.id);
      $('#offline-save').disabled = loading || pending(job);
      $('#offline-remove').disabled = pending(job);
      if (job && dialog.open) message('#offline-progress', job.error || downloadProgressLabel(job.progress));
    }
  });
  async function resume() { if (!authorized) return; try { await queue.resume(); } catch (error) { message('#offline-download-error', error.message); } }
  const accountReady = () => { authorized = true; void resume(); };
  window.addEventListener('langy-offline-account', accountReady);
  window.addEventListener('online', resume); window.addEventListener('focus', resume);
  $('#downloads-dialog').addEventListener('close', () => void resume());
  const clearFinished = () => { for (const job of queue.snapshot()) if (!pending(job)) void queue.remove(job.id).catch((error) => message('#offline-download-error', error.message)); };
  surface.addEventListener('langy-clear-finished-downloads', clearFinished);
  $('#offline-save').addEventListener('click', async () => {
    if (!selected || loading) return;
    $('#offline-save').disabled = true; message('#offline-error');
    try {
      await queue.enqueue(selected, { recording: $('#offline-recording').value, audio: $('#offline-audio').checked });
      dialog.close(); toast('Book added to Process queue');
    } catch (error) { message('#offline-error', error.message); $('#offline-save').disabled = false; }
  });
  $('#offline-remove').addEventListener('click', async () => {
    if (!selected || queue.snapshot().some((job) => job.book.id === selected.id && pending(job))) return;
    try {
      for (const name of await packCaches()) if (await (await caches.open(name)).match(`/api/books/${selected.id}/offline-data`)) await caches.delete(name);
      for (const job of queue.snapshot()) if (job.book.id === selected.id) await queue.remove(job.id);
      notifyDownloadedBooks();
      message('#offline-progress', 'Offline copy removed from this device. The server’s copy is unchanged.');
    } catch (error) { message('#offline-error', error.message); }
  });
  return { dispose() { unsubscribe(); surface.removeEventListener('langy-clear-finished-downloads', clearFinished); queue.close(); surface.removeEventListener('langy-offline-account', accountReady); surface.removeEventListener('online', resume); surface.removeEventListener('focus', resume); }, async open(book) {
    selected = book; const version = ++epoch; message('#offline-error'); message('#offline-progress'); $('#offline-book-title').textContent = book.title;
    loading = true; $('#offline-save').disabled = true; $('#offline-remove').disabled = false; $('#offline-audio').checked = false; $('#offline-recording').replaceChildren(); dialog.showModal();
    try { const result = await api(`/api/books/${book.id}/narration`); if (version !== epoch) return;
      const choices = [...new Map([...(result.audio.state === 'ready' ? [{ id: result.audio.id, name: result.audio.name || 'Generated narration' }] : []), ...(result.recordings || [])].map((item) => [item.id, item])).values()];
      $('#offline-recording').replaceChildren(...choices.map((item) => new Option(item.name, item.id))); $('#offline-audio').checked = choices.length > 0;
    } catch (error) { if (version === epoch) message('#offline-error', error.message); }
    finally { if (version === epoch) { loading = false; $('#offline-save').disabled = queue.snapshot().some((job) => job.book.id === book.id && pending(job)); } }
  } };
}
