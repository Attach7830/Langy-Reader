import { offlineChanges, offlineOwner, packCaches, cachedResponse, cacheJSON, savedPack } from './offline-store.js';
import { offlineLookup } from './offline-data.js';
import { learningLanguages } from '../shared/learning-languages.js';

let activeBook, flushing, notifiedOwner;
function statusChange(book, operation, body, created) {
  if (operation === 'read-status') book.readAt = body.read ? created : null;
  if (operation === 'currently-reading') { book.starredAt = body.currentlyReading ? created : null; if (body.currentlyReading) book.setAsideAt = null; }
  if (operation === 'set-aside') { book.setAsideAt = body.setAside ? created : null; if (body.setAside) book.starredAt = null; }
}
async function rememberStatus(id, result) {
  for (const name of await packCaches()) {
    const cache = await caches.open(name), response = await cache.match('/api/library'); if (!response) continue;
    const snapshot = await response.json(), book = snapshot.books.find((entry) => entry.id === id);
    if (book) Object.assign(book, result);
    await cache.put('/api/library', Response.json(snapshot));
  }
}
export const setOfflineBook = (id) => { activeBook = id; };
export async function setOfflineAccount(id) {
  if (!globalThis.caches || !id) return;
  const previous = offlineOwner();
  localStorage.setItem('langy-offline-owner', id);
  const registration = await navigator.serviceWorker?.getRegistration?.();
  (navigator.serviceWorker?.controller || registration?.active)?.postMessage({ type: 'ACCOUNT', id });
  if (previous && previous !== id) {
    for (const name of await caches.keys()) if (name.startsWith('langy-pack-') && !name.startsWith(`langy-pack-${id}-`)) await caches.delete(name);
    for (const change of await offlineChanges.all()) if (change.owner !== id) await offlineChanges.remove(change.id);
  }
  if (notifiedOwner !== id && typeof window !== 'undefined' && window.CustomEvent) {
    notifiedOwner = id; window.dispatchEvent(new window.CustomEvent('langy-offline-account', { detail: { id } }));
  }
}
async function bookmarkList(path) {
  const response = await cachedResponse(path), entries = response ? (await response.json()).bookmarks : [];
  const queued = (await offlineChanges.all()).filter((item) => item.owner === offlineOwner() && item.base === path).sort((a, b) => a.created - b.created);
  let result = entries;
  for (const item of queued) {
    result = result.filter((entry) => entry.target !== item.body.target);
    if (item.kind === 'bookmark-save') result = [{ id: item.id, ...item.body, created: item.created }, ...result];
  }
  return { bookmarks: result };
}
export async function offlineRequest(path, { body, method = body ? 'POST' : 'GET' } = {}) {
  if (!globalThis.caches || !offlineOwner()) throw new Error('Connect to Langy and download an offline reading pack first.');
  const bookmark = /^\/api\/books\/([^/]+)\/bookmarks(?:\/([^/]+))?$/u.exec(path);
  if (method === 'GET') {
    if (path === '/api/library') {
      const response = await cachedResponse(path); if (!response) throw new Error('Download a book for offline reading first.');
      const snapshot = await response.json(), ids = new Set();
      for (const name of await packCaches()) { const entry = await (await caches.open(name)).match('/__langy_pack_ready__'); if (entry) ids.add((await entry.json()).book); }
      let native = ''; try { native = JSON.parse(localStorage.getItem('langy-settings-v1') || '{}').nativeLanguage || ''; } catch {}
      const books = [];
      const queued = (await offlineChanges.all()).filter((item) => item.owner === offlineOwner() && item.kind === 'book-status').sort((a, b) => a.created - b.created);
      for (const book of snapshot.books.filter((item) => ids.has(item.id))) { const pack = await savedPack(book.id), current = { ...book, learning: learningLanguages(pack.analysis, native) };
        for (const change of queued.filter((item) => item.book === book.id)) statusChange(current, change.operation, change.body, change.created);
        books.push(current);
      }
      return { ...snapshot, books, archive: { available: false, jobs: [], job: null }, offline: true };
    }
    if (bookmark && !bookmark[2]) return bookmarkList(path);
    if (path.includes('/search?')) { const id = /^\/api\/books\/([^/]+)/u.exec(path)?.[1], pack = id && await savedPack(id); if (pack) return offlineLookup(pack, path); }
    const response = await cachedResponse(path); if (response) return response.json();
  }
  const lifecycle = /^\/api\/books\/([^/]+)\/(read-status|currently-reading|set-aside)$/u.exec(path);
  const statistic = /^\/api\/books\/([^/]+)\/(reading-time|vocabulary\/seen)$/u.exec(path);
  if (method === 'POST' && statistic && await savedPack(statistic[1])) {
    if ((await offlineChanges.all()).length >= 100000) throw new Error('Reconnect to sync saved reading activity before continuing offline tracking.');
    // Persist before acknowledging to the small browser outboxes. Long offline
    // books must not lose earlier pages when those bounded outboxes roll over.
    await offlineChanges.put({ id: crypto.randomUUID(), owner: offlineOwner(), created: Date.now(), kind: 'reading-statistic', path, method, body });
    return { saved: true, queued: true };
  }
  if (method === 'PATCH' && lifecycle && await savedPack(lifecycle[1])) {
    const field = { 'read-status': 'read', 'currently-reading': 'currentlyReading', 'set-aside': 'setAside' }[lifecycle[2]];
    if (typeof body?.[field] !== 'boolean') throw new Error('Choose a valid book status.');
    const created = Date.now(), change = { id: crypto.randomUUID(), owner: offlineOwner(), created, kind: 'book-status', book: lifecycle[1], operation: lifecycle[2], path, method, body };
    const existing = await offlineChanges.all(); if (existing.length >= 2000) throw new Error('Reconnect to sync pending changes first.');
    await offlineChanges.put(change);
    const result = { id: lifecycle[1], queued: true }; statusChange(result, lifecycle[2], body, created); return result;
  }
  if (bookmark && ['POST', 'DELETE'].includes(method)) {
    const base = `/api/books/${bookmark[1]}/bookmarks`;
    const previous = await bookmarkList(base), target = method === 'POST' ? body.target : previous.bookmarks.find((entry) => entry.id === bookmark[2])?.target;
    if (target == null) return previous;
    const changes = await offlineChanges.all(); if (changes.length >= 2000) throw new Error('Reconnect to sync pending offline changes before adding more.');
    await offlineChanges.put({ id: crypto.randomUUID(), owner: offlineOwner(), created: Date.now(), base, kind: method === 'POST' ? 'bookmark-save' : 'bookmark-remove',
      path: method === 'POST' ? base : `${base}/remove`, method: 'POST', body: method === 'POST' ? body : { target } });
    return { ...await bookmarkList(base), queued: true };
  }
  if (['/api/ai/word', '/api/mandarin/word', '/api/mandarin/pinyin', '/api/mandarin/readings'].includes(path)) {
    const pack = activeBook && await savedPack(activeBook); if (pack) return offlineLookup(pack, path, body);
  }
  throw new Error('This feature needs a connection to your Langy server. Your reading position and statistics stay on this device until it reconnects.');
}
export async function flushOfflineChanges() {
  if (flushing || !globalThis.indexedDB || !offlineOwner()) return flushing;
  flushing = (async () => {
    let changes; try { changes = await offlineChanges.all(); } catch { return; }
    let synced = 0;
    for (const change of changes.sort((a, b) => a.created - b.created)) {
      if (change.owner !== offlineOwner()) continue;
      let response;
      try { response = await fetch(change.path, { method: change.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change.body) }); } catch { break; }
      if (!response.ok) {
        let detail; try { detail = await response.json(); } catch {}
        if ([404, 410].includes(response.status) || change.kind === 'reading-statistic' && (response.status === 422 || response.status === 409 && /text changed/iu.test(detail?.error || ''))) {
          await offlineChanges.remove(change.id); continue;
        }
        break;
      }
      const result = await response.json(); if (result.bookmarks) await cacheJSON(change.base, result);
      if (change.kind === 'book-status') await rememberStatus(change.book, result);
      await offlineChanges.remove(change.id);
      synced++;
    }
    if (synced && typeof window !== 'undefined' && window.CustomEvent) window.dispatchEvent(new window.CustomEvent('langy-offline-synced', { detail: { synced } }));
  })().finally(() => { flushing = undefined; }); return flushing;
}
export async function offlineStatus() { return { packs: await packCaches(), pending: (await offlineChanges.all()).filter((item) => item.owner === offlineOwner()).length }; }
