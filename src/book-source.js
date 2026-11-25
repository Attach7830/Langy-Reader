import { offlineOwner, packPrefix, packCaches } from './offline-store.js';

export async function downloadedBooks() {
  const ids = new Set();
  if (!globalThis.caches || !offlineOwner()) return ids;
  try { for (const name of await packCaches()) {
    const ready = await (await caches.open(name)).match('/__langy_pack_ready__');
    if (ready) ids.add((await ready.json()).book);
  } } catch { /* Reading online still works if device storage is unavailable. */ }
  return ids;
}
export async function savedReadingFile(path, { signal } = {}) {
  signal?.throwIfAborted();
  const match = /^\/api\/books\/([^/]+)\/file$/u.exec(path);
  if (!match || !globalThis.caches || !offlineOwner()) return null;
  const prefix = `${packPrefix()}${match[1]}-`;
  try {
    for (const name of (await caches.keys()).filter((entry) => entry.startsWith(prefix)).reverse()) {
      const cache = await caches.open(name);
      if (!await cache.match('/__langy_pack_ready__')) continue;
      const file = await cache.match(path); signal?.throwIfAborted(); if (file) return file;
    }
  } catch (error) { if (signal?.aborted) throw error; }
  return null;
}
export async function readingFile(path, options) { return await savedReadingFile(path, options) || fetch(path, options); }
export function notifyDownloadedBooks() {
  if (typeof window !== 'undefined' && window.CustomEvent) window.dispatchEvent(new window.CustomEvent('langy-packs-changed'));
}
