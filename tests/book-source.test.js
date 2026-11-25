import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadedBooks, readingFile } from '../src/book-source.js';

test('download labels and cache-first book opens use only completed packs belonging to the current account', async (t) => {
  const saved = new Map(), originals = new Map(['caches', 'localStorage', 'fetch'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let owner = 'one', calls = 0;
  const caches = { async keys() { return [...saved.keys()]; }, async open(name) { const files = saved.get(name); return { async match(path) { return files?.get(path)?.clone(); } }; } };
  const values = { caches, localStorage: { getItem: () => owner }, fetch: async () => { calls++; return new Response('network'); } };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  t.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  function pack(name, book, ready = true) { const files = new Map([[`/api/books/${book}/file`, new Response(name)]]); if (ready) files.set('/__langy_pack_ready__', Response.json({ book })); saved.set(name, files); }
  pack('langy-pack-one-book-v1', 'book'); pack('langy-pack-one-incomplete-v1', 'incomplete', false); pack('langy-pack-two-private-v1', 'private');
  assert.deepEqual([...await downloadedBooks()], ['book']);
  assert.equal(await (await readingFile('/api/books/book/file')).text(), 'langy-pack-one-book-v1'); assert.equal(calls, 0, 'online opens do not wait for a network response');
  assert.equal(await (await readingFile('/api/books/incomplete/file')).text(), 'network');
  assert.equal(await (await readingFile('/api/books/private/file')).text(), 'network'); assert.equal(calls, 2);
  owner = 'two'; assert.deepEqual([...await downloadedBooks()], ['private']); assert.equal(await (await readingFile('/api/books/book/file')).text(), 'network');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readingFile('/api/books/private/file', { signal: controller.signal }), { name: 'AbortError' });
  owner = ''; assert.equal(await (await readingFile('/api/books/private/file')).text(), 'network');
});
