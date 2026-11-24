let dbPromise;
function database() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('langy-offline', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('changes', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function transaction(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('changes', mode), request = action(tx.objectStore('changes'));
    tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export const offlineChanges = { all: () => transaction('readonly', (store) => store.getAll()),
  put: (value) => transaction('readwrite', (store) => store.put(value)), remove: (id) => transaction('readwrite', (store) => store.delete(id)) };
export const offlineOwner = () => { try { return localStorage.getItem('langy-offline-owner') || ''; } catch { return ''; } };
export const packPrefix = (owner = offlineOwner()) => `langy-pack-${owner}-`;
export async function packCaches() { const names = (await caches.keys()).filter((key) => key.startsWith(packPrefix()));
  return (await Promise.all(names.map(async (name) => await (await caches.open(name)).match('/__langy_pack_ready__') ? name : null))).filter(Boolean); }
export async function savedPack(id) {
  for (const name of await packCaches()) { const response = await (await caches.open(name)).match(`/api/books/${id}/offline-data`); if (response) return response.json(); }
}
export async function cachedResponse(path) {
  for (const name of (await packCaches()).reverse()) { const response = await (await caches.open(name)).match(path); if (response) return response; }
}
export async function cacheJSON(path, value) {
  for (const name of await packCaches()) { const cache = await caches.open(name); if (await cache.match(path)) await cache.put(path, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })); }
}
