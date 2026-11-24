import { $, api, message } from './ui.js';
import { offlineOwner, packCaches, packPrefix } from './offline-store.js';

const downloads = new Map();
let shellUpdate;
async function fetchOK(path) {
  const response = await fetch(path);
  if (!response.ok || response.headers.get('X-Langy-Offline') === '1') throw new Error(`Could not download ${path.includes('/audio/') ? 'book audio' : 'the reading pack'}. Reconnect to Langy and retry.`);
  return response;
}
export function cacheReaderShell(progress = () => {}) {
  if (shellUpdate) return shellUpdate;
  shellUpdate = (async () => {
    const manifest = await (await fetchOK('/offline-assets.json')).json(), shell = await caches.open('langy-shell-v1');
    const previous = await shell.match('/__langy_shell_version__');
    if (previous && await previous.text() === manifest.version) return;
    const assets = manifest.assets.filter((path) => path !== '/'); let index = 0, complete = 0;
    const worker = async () => { while (index < assets.length) {
      const path = assets[index++]; if (!await shell.match(path)) await shell.put(path, await fetchOK(path));
      progress(`Saving the reader for offline use · ${++complete}/${assets.length}`);
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
export async function saveReadingPack(book, { recording, audio, progress = () => {} }) {
  if (!navigator.serviceWorker || !isSecureContext) throw new Error('Offline packs need HTTPS, localhost or the Langy Android app.');
  await navigator.serviceWorker.ready;
  const owner = offlineOwner(); if (!owner) throw new Error('Load your signed-in library before saving an offline pack.');
  progress('Preparing text and dictionary entries…');
  const pack = await (await fetchOK(`/api/books/${book.id}/offline${recording ? `?recording=${encodeURIComponent(recording)}` : ''}`)).json();
  const name = `${packPrefix(owner)}${book.id}-${crypto.randomUUID()}`, cache = await caches.open(name);
  const json = (path, value) => cache.put(path, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));
  try {
    progress('Downloading book…'); await cache.put(`/api/books/${book.id}/file`, await fetchOK(`/api/books/${book.id}/file`));
    if (book.thumbnailType) { const response = await fetch(`/api/books/${book.id}/cover`); if (response.ok) await cache.put(`/api/books/${book.id}/cover`, response); }
    const narration = { ...pack.narration, recordings: (pack.narration.recordings || []).filter((item) => item.id === pack.narration.audio.id) };
    if (!audio) narration.audio = { state: 'missing' };
    await json(`/api/books/${book.id}/offline-data`, pack);
    await json(`/api/books/${book.id}/narration`, narration);
    if (recording) await json(`/api/books/${book.id}/narration?recording=${encodeURIComponent(recording)}`, narration);
    if (narration.absConnected && pack.narration.audio.id) {
      const path = `/api/books/${book.id}/audiobookshelf/progress?recording=${encodeURIComponent(pack.narration.audio.id)}`;
      const response = await fetch(path); if (response.ok) await cache.put(path, response);
    }
    for (const unit of pack.units) {
      const path = `/api/books/${book.id}/chapters/${encodeURIComponent(unit.key)}`;
      await json(path, unit); if (pack.narration.audio.id) await json(`${path}?recording=${encodeURIComponent(pack.narration.audio.id)}`, unit);
      await json(`/api/books/${book.id}/vocabulary/sections/${encodeURIComponent(unit.key)}`, { key: unit.key, text: unit.text, textHash: unit.textHash, languages: unit.languages, textReady: true, analysisState: unit.analysisState });
    }
    for (const path of ['/api/library', '/api/settings/reader', '/api/settings/learning', `/api/books/${book.id}/bookmarks`, `/api/books/${book.id}/learning`, `/api/books/${book.id}/recordings`, `/api/books/${book.id}/progress`]) {
      const response = await fetch(path); if (response.ok) await cache.put(path, response);
    }
    if (audio && pack.narration.audio.state === 'ready') {
      progress('Downloading the complete audiobook…'); await cache.put(pack.narration.audio.url, await fetchOK(pack.narration.audio.url));
    }
    progress('Saving the reader for offline use…');
    await cacheReaderShell(progress);
    if (offlineOwner() !== owner) throw new Error('The signed-in account changed during this download. Retry from the current account.');
    await cache.put('/__langy_pack_ready__', new Response(JSON.stringify({ book: book.id, owner, created: Date.now() })));
    for (const old of await packCaches()) if (old !== name && await (await caches.open(old)).match(`/api/books/${book.id}/offline-data`)) await caches.delete(old);
    await navigator.storage?.persist?.(); return pack;
  } catch (error) { await caches.delete(name); if (error.name === 'QuotaExceededError') throw new Error('This device has insufficient browser storage. Remove an offline pack or download without audio.'); throw error; }
}

export function offlineDownloads() {
  const dialog = $('#offline-dialog'); let selected, epoch = 0;
  $('#offline-save').addEventListener('click', () => {
    if (!selected || downloads.has(selected.id)) return;
    const book = selected; $('#offline-save').disabled = true; message('#offline-error');
    const update = (text) => { message('#offline-status', `${book.title} · ${text}`); if (selected?.id === book.id && dialog.open) message('#offline-progress', text); };
    const task = saveReadingPack(book, { recording: $('#offline-recording').value, audio: $('#offline-audio').checked, progress: update })
      .then(() => update('Available offline on this device.'))
      .catch((error) => { update(error.message); if (selected?.id === book.id) message('#offline-error', error.message); })
      .finally(() => { downloads.delete(book.id); if (selected?.id === book.id) $('#offline-save').disabled = false; });
    downloads.set(book.id, task);
  });
  $('#offline-remove').addEventListener('click', async () => {
    if (!selected || downloads.has(selected.id)) return;
    for (const name of await packCaches()) if (await (await caches.open(name)).match(`/api/books/${selected.id}/offline-data`)) await caches.delete(name);
    message('#offline-progress', 'Offline copy removed from this device. The server’s copy is unchanged.');
  });
  return { async open(book) {
    selected = book; const version = ++epoch; message('#offline-error'); message('#offline-progress'); $('#offline-book-title').textContent = book.title;
    $('#offline-save').disabled = downloads.has(book.id); $('#offline-recording').replaceChildren(); dialog.showModal();
    try { const result = await api(`/api/books/${book.id}/narration`); if (version !== epoch) return;
      const choices = [...(result.audio.state === 'ready' ? [{ id: result.audio.id, name: result.audio.name || 'Generated narration' }] : []), ...(result.recordings || [])];
      $('#offline-recording').replaceChildren(...choices.map((item) => new Option(item.name, item.id))); $('#offline-audio').checked = choices.length > 0;
    } catch (error) { if (version === epoch) message('#offline-error', error.message); }
  } };
}
