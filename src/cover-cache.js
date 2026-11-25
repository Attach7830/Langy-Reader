import { getSettings } from './settings.js';

export function createCoverCache({ enabled = () => getSettings().cacheCovers !== false,
  owner = () => { try { return localStorage.getItem('langy-auth-account') || localStorage.getItem('langy-offline-owner') || ''; } catch { return ''; } },
  storage = () => globalThis.caches, request = (...args) => fetch(...args), limit = 120 } = {}) {
  let revision = 0; const pending = new Map();
  const urlFor = (book) => `/api/books/${encodeURIComponent(book.id)}/cover?revision=${encodeURIComponent(book.updatedAt || book.addedAt || 0)}`;
  async function source(book) {
    const url = urlFor(book), account = owner();
    if (!enabled() || !account || !storage()) return url;
    const key = `${account}:${url}`; if (pending.has(key)) return pending.get(key);
    const version = revision;
    const operation = (async () => {
      try {
        const cache = await storage().open(`langy-covers-${account}`);
        let response = await cache.match(url);
        if (!response) {
          response = await request(url, { credentials: 'same-origin', cache: 'no-cache' });
          if (!response.ok || !/^image\/(?:png|jpeg|webp|gif|avif)(?:;|$)/iu.test(response.headers.get('Content-Type') || '')) return url;
          const blob = await response.blob(); if (blob.size > 4 * 1024 ** 2) return url;
          response = new Response(blob, { headers: { 'Content-Type': blob.type } });
          if (version !== revision || owner() !== account || !enabled()) return url;
          // Remove superseded revisions of this book, then evict oldest covers.
          for (const old of await cache.keys()) if (new URL(old.url).pathname === new URL(url, 'https://local').pathname && new URL(old.url).search !== new URL(url, 'https://local').search) await cache.delete(old);
          await cache.put(url, response.clone());
          const keys = await cache.keys(); for (const old of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(old);
        }
        const bytes = new Uint8Array(await response.arrayBuffer()); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        if (version !== revision || owner() !== account) return '';
        return `data:${response.headers.get('Content-Type')};base64,${btoa(binary)}`;
      } catch { return url; } // Storage limits must never prevent showing covers.
    })().finally(() => { if (pending.get(key) === operation) pending.delete(key); });
    pending.set(key, operation); return operation;
  }
  async function clear() { revision++; pending.clear(); const store = storage(); if (store) for (const key of await store.keys()) if (key.startsWith('langy-covers-')) await store.delete(key); }
  return { source, clear };
}
export const coverCache = createCoverCache();
