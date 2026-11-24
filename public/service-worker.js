import { cachedRange } from './offline-range.js';
const shell = 'langy-shell-v1', control = 'langy-offline-control';
const accountURL = '/__langy_offline_account__';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACCOUNT' && typeof event.data.id === 'string') event.waitUntil(caches.open(control).then((cache) => cache.put(accountURL, new Response(event.data.id))));
});
async function fallback(request) {
  const url = new URL(request.url), account = await (await caches.open(control)).match(accountURL), id = account && await account.text();
  if (id) for (const name of await caches.keys()) if (name.startsWith(`langy-pack-${id}-`)) {
    const cache = await caches.open(name); if (!await cache.match('/__langy_pack_ready__')) continue;
    const response = await cache.match(request.url, { ignoreVary: true });
    if (response) { const headers = new Headers(response.headers); headers.set('X-Langy-Cached', '1');
      return cachedRange(new Response(response.body, { status: response.status, headers }), request.headers.get('Range')); }
  }
  const app = await caches.open(shell), cached = await app.match(request.mode === 'navigate' ? '/' : url.href);
  if (cached) { const headers = new Headers(cached.headers); headers.set('X-Langy-Cached', '1'); return new Response(cached.body, { status: cached.status, headers }); }
  return new Response('Offline. Download this book in Langy while online first.', { status: 503, headers: { 'Content-Type': 'text/plain', 'X-Langy-Offline': '1' } });
}
self.addEventListener('fetch', (event) => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.headers.get('X-Langy-Offline') === '1') return fallback(request);
      if (response.ok && !request.headers.has('Range') && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/pdf-assets/'))) {
        const copy = response.clone(); event.waitUntil(caches.open(shell).then((cache) => cache.put(url.pathname === '/' ? '/' : url.href, copy)));
      }
      return response;
    } catch { return fallback(request); }
  })());
});
