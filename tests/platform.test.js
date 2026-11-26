import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { androidApp, watchAppCapability } from '../src/platform.js';
import { saveReadingPack, offlineDownloads } from '../src/offline-downloads.js';
import { readFile } from 'node:fs/promises';

test('offline downloads require the app connection rather than a phone browser or installed web app', async (t) => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test' });
  const saved = new Map();
  for (const name of ['window', 'document', 'Option']) { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] }); }
  t.after(() => { dom.window.close(); for (const [name, value] of saved) if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; });
  let resumes = 0, downloads = 0; const states = [];
  const unwatch = watchAppCapability((enabled) => states.push(enabled)); t.after(unwatch);
  const ui = offlineDownloads({ queue: { subscribe(callback) { callback([]); return () => {}; }, snapshot: () => [], close() {}, async resume() { resumes++; }, async enqueue() { downloads++; } } }); t.after(() => ui.dispose());
  assert.equal(androidApp(), false);
  await assert.rejects(ui.open({ id: 'book' }), /Android app/u);
  await assert.rejects(saveReadingPack({ id: 'book' }, {}), /Android app/u);
  window.dispatchEvent(new dom.window.Event('langy-offline-account'));
  assert.equal(resumes, 0); assert.equal(downloads, 0); assert.equal(document.querySelector('#sign-out-remove-downloads').closest('label').hidden, true);
  const controls = document.createElement('fieldset'); controls.id = 'android-app-controls'; document.querySelector('[data-settings-panel="devices"]').append(controls);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(androidApp(), true); assert.deepEqual(states, [false, true]); assert.equal(resumes, 1);
  assert.equal(document.querySelector('#sign-out-remove-downloads').closest('label').hidden, false);
  controls.remove(); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(androidApp(), false); assert.equal(document.querySelector('#sign-out-remove-downloads').closest('label').hidden, true);
});
