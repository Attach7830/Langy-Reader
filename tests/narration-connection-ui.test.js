import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { narration } from '../src/narration.js';
import { defaults } from '../src/settings.js';

test('reader preference changes preserve the ABS connection even without local narration or with audio disabled', async (t) => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test' });
  const saved = new Map(), previousFetch = globalThis.fetch;
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, Option: dom.window.Option, navigator: dom.window.navigator, cancelAnimationFrame() {} })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  dom.window.HTMLMediaElement.prototype.pause = function () {};
  dom.window.HTMLMediaElement.prototype.load = function () {};
  let current, preferences = { ...defaults, audioEnabled: true };
  t.after(() => { current?.stop(); globalThis.fetch = previousFetch; dom.window.close(); for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  globalThis.fetch = async (path) => { assert.equal(path, '/api/books/book/narration'); return Response.json({ connected: false, absConnected: true, recordings: [], audio: { state: 'missing' } }); };
  current = narration({ preferences: () => preferences, renderer: () => null, book: () => ({ id: 'book' }), navigate() {}, changePreferences() {} });
  await current.refresh(); assert.equal(current.absConnected, true); assert.equal(current.ready, false);
  current.apply(); await Promise.resolve(); assert.equal(current.absConnected, true);
  preferences = { ...preferences, audioToolbarHidden: true }; current.apply(); assert.equal(current.absConnected, true);
  preferences = { ...preferences, audioEnabled: false }; current.apply(); assert.equal(current.absConnected, true);
  current.stop(); assert.equal(current.absConnected, false, 'closing a book clears its connection state');
});
