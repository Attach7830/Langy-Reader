import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverCache } from '../src/cover-cache.js';

test('cover caching reuses images, refreshes revisions, bounds storage, and isolates accounts', async () => {
  let owner = 'one', enabled = true, requests = 0; const stored = new Map();
  const normalize = (key) => typeof key === 'string' ? new URL(key, 'https://langy.test').href : key.url;
  const storage = { async keys() { return [...stored.keys()]; }, async delete(key) { return stored.delete(key); }, async open(name) {
    if (!stored.has(name)) stored.set(name, new Map()); const files = stored.get(name);
    return { async match(key) { return files.get(normalize(key))?.clone(); }, async put(key, response) { files.set(normalize(key), response.clone()); }, async delete(key) { return files.delete(normalize(key)); }, async keys() { return [...files.keys()].map((url) => ({ url })); } };
  } };
  const cache = createCoverCache({ owner: () => owner, enabled: () => enabled, storage: () => storage, limit: 2,
    async request() { requests++; return new Response('COVER', { headers: { 'Content-Type': 'image/png' } }); } });
  const book = { id: 'book', updatedAt: 1 };
  const first = await cache.source(book); assert.ok(first.startsWith('data:image/png;base64,')); assert.equal(requests, 1);
  assert.equal(await cache.source(book), first); assert.equal(requests, 1);
  owner = 'two'; await cache.source(book); assert.equal(requests, 2);
  await cache.source({ ...book, updatedAt: 2 }); assert.equal(requests, 3); assert.equal(stored.get('langy-covers-two').size, 1, 'superseded covers are removed');
  await cache.source({ id: 'second' }); await cache.source({ id: 'third' }); assert.equal(stored.get('langy-covers-two').size, 2);
  enabled = false; assert.ok((await cache.source(book)).startsWith('/api/books/book/cover?')); assert.equal(requests, 5);
  await cache.clear(); assert.equal(stored.size, 0);
});

test('disabled or unavailable cover storage falls back to normal image loading', async () => {
  const cache = createCoverCache({ owner: () => '', storage: () => undefined });
  assert.equal(await cache.source({ id: 'book', addedAt: 10 }), '/api/books/book/cover?revision=10');
});
