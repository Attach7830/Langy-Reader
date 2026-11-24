import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheReaderShell } from '../src/offline-downloads.js';

test('an interrupted reader update retains the old offline entry page until all new resources are available', async (t) => {
  const saved = new Map([['/', new Response('old reader')], ['/__langy_shell_version__', new Response('old')]]), calls = [];
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches'), originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { async open() { return {
    match: async (key) => saved.get(key)?.clone(), put: async (key, value) => saved.set(key, value.clone()),
  }; } } });
  t.after(() => { globalThis.fetch = originalFetch; if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches); else delete globalThis.caches; });
  let fail = true;
  globalThis.fetch = async (path) => {
    calls.push(path);
    if (path === '/offline-assets.json') return Response.json({ version: 'new', assets: ['/', '/new-reader.js', '/new-font.woff2'] });
    if (path === '/new-font.woff2' && fail) throw new Error('Connection lost');
    return new Response(path === '/' ? 'new reader' : 'asset');
  };
  await assert.rejects(cacheReaderShell()); assert.equal(await saved.get('/').clone().text(), 'old reader'); assert.equal(await saved.get('/__langy_shell_version__').clone().text(), 'old');
  fail = false; await cacheReaderShell(); assert.equal(await saved.get('/').clone().text(), 'new reader');
  assert.equal(await saved.get('/__langy_shell_version__').clone().text(), 'new');
  assert.ok(calls.lastIndexOf('/') > calls.lastIndexOf('/new-font.woff2'));
});
