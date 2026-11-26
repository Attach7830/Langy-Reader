import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { offlineChanges } from '../src/offline-store.js';
import { offlineRequest, flushOfflineChanges, setOfflineAccount } from '../src/offline.js';

test('offline packs show only downloaded books, bookmarks survive lost acknowledgements, and accounts cannot inherit another reader’s changes', async (t) => {
  const dom = new JSDOM('', { url: 'https://langy.test' }), originals = new Map();
  const changeMap = new Map(), cacheMap = new Map();
  const cacheStorage = { keys: async () => [...cacheMap.keys()], delete: async (key) => cacheMap.delete(key), async open(key) {
    if (!cacheMap.has(key)) cacheMap.set(key, new Map()); const map = cacheMap.get(key);
    return { async match(path) { return map.get(path)?.clone(); }, async put(path, value) { map.set(path, value.clone()); } };
  } };
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, indexedDB: {}, caches: cacheStorage })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const previousMethods = { ...offlineChanges }, previousFetch = globalThis.fetch;
  Object.assign(offlineChanges, { all: async () => [...changeMap.values()], put: async (value) => changeMap.set(value.id, value), remove: async (id) => changeMap.delete(id) });
  t.after(() => { Object.assign(offlineChanges, previousMethods); globalThis.fetch = previousFetch; dom.window.close(); for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  localStorage.setItem('langy-offline-owner', 'first'); const cache = await caches.open('langy-pack-first-book');
  const put = (path, value) => cache.put(path, Response.json(value));
  await put('/__langy_pack_ready__', { book: 'book', owner: 'first' });
  await put('/api/books/book/offline-data', { book: { id: 'book' }, analysis: { state: 'ready' } });
  await put('/api/books/book/bookmarks', { bookmarks: [] });
  await put('/api/library', { books: [{ id: 'book' }, { id: 'not-downloaded' }] });
  const loading = [];
  assert.deepEqual((await offlineRequest('/api/library', { onProgress: (event) => loading.push(event) })).books.map((book) => book.id), ['book']);
  assert.deepEqual(loading.filter((event) => event.label === 'Loading saved books…').map(({ complete, total }) => [complete, total]), [[0, 1], [1, 1]]);
  const base = '/api/books/book/bookmarks', body = { target: 'epubcfi(/6/2!/4/2/1:7)', label: 'My passage', note: 'A note' };
  const saved = await offlineRequest(base, { method: 'POST', body }); assert.equal(saved.queued, true); assert.equal(saved.bookmarks[0].label, 'My passage');
  let loseAck = true, requests = 0; const remote = new Map();
  globalThis.fetch = async (_path, options) => {
    requests++; const value = JSON.parse(options.body); remote.set(value.target, { ...value, id: 'server-id' });
    if (loseAck) { loseAck = false; throw new Error('Connection lost after save'); }
    return Response.json({ bookmarks: [...remote.values()] });
  };
  await flushOfflineChanges(); assert.equal(changeMap.size, 1); await flushOfflineChanges(); assert.equal(changeMap.size, 0); assert.equal(remote.size, 1); assert.equal(requests, 2);
  const listed = await offlineRequest(base); assert.equal(listed.bookmarks[0].id, 'server-id');
  await offlineRequest(base + '/server-id', { method: 'DELETE' }); assert.equal((await offlineRequest(base)).bookmarks.length, 0);
  assert.equal([...changeMap.values()][0].path, base + '/remove');
  await offlineRequest('/api/books/book/currently-reading', { method: 'PATCH', body: { currentlyReading: true } });
  assert.ok((await offlineRequest('/api/library')).books[0].starredAt);
  await offlineRequest('/api/books/book/set-aside', { method: 'PATCH', body: { setAside: true } });
  const changed = (await offlineRequest('/api/library')).books[0]; assert.ok(changed.setAsideAt); assert.equal(changed.starredAt, null);
  const exposure = await offlineRequest('/api/books/book/vocabulary/seen', { method: 'POST', body: { key: 'epub:0', digest: 'd', session: 'reading', ranges: [{ from: 0, to: 10 }] } });
  assert.equal(exposure.queued, true); assert.equal(exposure.saved, true);
  const readingTime = await offlineRequest('/api/books/book/reading-time', { method: 'POST', body: { accountId: 'first', events: [{ id: 'offline-time', start: 1000, end: 2000 }] } });
  assert.equal(readingTime.queued, true); assert.equal([...changeMap.values()].filter((item) => item.kind === 'reading-statistic').length, 2);
  const retained = changeMap.size;
  await setOfflineAccount('second'); assert.equal(changeMap.size, retained); assert.deepEqual(await caches.keys(), ['langy-pack-first-book']);
  await assert.rejects(offlineRequest('/api/library'), /Download a book/u);
  await setOfflineAccount('first'); assert.equal((await offlineRequest('/api/library')).books[0].id, 'book'); assert.equal(changeMap.size, retained);
  let finishRegistration; const messages = [];
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: () => new Promise((resolve) => { finishRegistration = resolve; }), controller: { postMessage: (message) => messages.push(message) } } });
  const setup = setOfflineAccount('first'); localStorage.removeItem('langy-offline-owner'); finishRegistration(); await setup;
  assert.deepEqual(messages, [], 'a delayed registration must not reactivate downloads after sign-out');
});
