import test from 'node:test';
import assert from 'node:assert/strict';
import { saveReadingPack } from '../src/offline-downloads.js';

test('an interrupted replacement preserves the existing offline book, and a successful retry publishes the whole pack atomically', async (t) => {
  const values = new Map(), previous = new Map();
  const caches = { async keys() { return [...values.keys()]; }, async delete(name) { return values.delete(name); }, async open(name) {
    if (!values.has(name)) values.set(name, new Map()); const entries = values.get(name);
    return { match: async (path) => entries.get(path)?.clone(), async put(path, response) {
      const bytes = await response.arrayBuffer(); entries.set(path, new Response(bytes, { status: response.status, headers: response.headers }));
    } };
  } };
  for (const [name, value] of Object.entries({ document: { getElementById: (id) => id === 'android-app-controls' ? {} : null }, caches, isSecureContext: true, navigator: { serviceWorker: { ready: Promise.resolve() }, storage: { persist: async () => true } }, localStorage: { getItem: () => 'owner' } })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const fetchBefore = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchBefore; for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  const old = await caches.open('langy-pack-owner-old');
  await old.put('/__langy_pack_ready__', Response.json({ book: 'book', owner: 'owner' })); await old.put('/api/books/book/offline-data', Response.json({ old: true }));
  const pack = { book: { id: 'book' }, units: [{ key: 'epub:0', text: 'Reading offline' }], narration: { audio: { state: 'ready', id: 'voice', url: '/book-audio.mp3' }, recordings: [] } };
  let fail = true;
  globalThis.fetch = async (path) => {
    if (path.startsWith('/api/books/book/offline')) return Response.json(pack);
    if (path === '/api/books/book/file') return new Response('epub payload', { headers: { 'Content-Length': '12' } });
    if (path === '/book-audio.mp3') return fail ? new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('Audio connection lost')); } })) : new Response('complete audiobook', { headers: { 'Content-Length': '18' } });
    if (path === '/offline-assets.json') return Response.json({ version: 'queue-test', assets: ['/', '/reader.js'] });
    if (path.startsWith('/api/')) return Response.json({});
    return new Response('reader resource');
  };
  const updates = [];
  await assert.rejects(saveReadingPack({ id: 'book' }, { audio: true, recording: 'voice', progress: (item) => updates.push(item) }));
  assert.ok(values.has('langy-pack-owner-old')); assert.equal((await caches.keys()).filter((name) => name.startsWith('langy-pack-')).length, 1);
  assert.ok(updates.some((item) => item.phase === 'book' && item.loaded === 12));
  fail = false; await saveReadingPack({ id: 'book' }, { audio: true, recording: 'voice' });
  assert.equal(values.has('langy-pack-owner-old'), false);
  const names = (await caches.keys()).filter((name) => name.startsWith('langy-pack-')); assert.equal(names.length, 1);
  const complete = await caches.open(names[0]);
  assert.ok(await complete.match('/__langy_pack_ready__')); assert.equal(await (await complete.match('/book-audio.mp3')).text(), 'complete audiobook');
  assert.ok(await complete.match('/api/books/book/vocabulary/sections/epub%3A0')); assert.ok(await complete.match('/api/books/book/bookmarks'));
});
