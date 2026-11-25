import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';
import { credentialRemoval } from '../src/credential-removal.js';

test('credential buttons confirm before removal, cancel safely and preserve other draft keys on success or failure', async (t) => {
  const dom = new JSDOM('<form><button type="submit">Save</button>' + ['ai', 'learning', 'archive', 'audiobookshelf'].map((service) => `<input id="${service}-input" value="draft"><button type="button" id="${service}">Remove</button><p id="${service}-status"></p>`).join('') + '</form><div id="toast"></div>', { url: 'https://langy.test' });
  const previous = new Map(['window', 'document'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])), fetchBefore = globalThis.fetch;
  for (const key of previous.keys()) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  t.after(() => { globalThis.fetch = fetchBefore; dom.window.close(); for (const [key, value] of previous) if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; });
  const calls = []; let approve = false, fail = false, changed = 0;
  dom.window.confirm = () => approve;
  globalThis.fetch = async (path, options) => { calls.push({ path, method: options.method }); return fail ? Response.json({ error: 'Removal failed' }, { status: 500 }) : Response.json({ hasKey: false }); };
  for (const service of ['ai', 'learning', 'archive', 'audiobookshelf']) {
    const button = document.getElementById(service), input = document.getElementById(service + '-input');
    credentialRemoval({ button, input, endpoint: `/api/settings/${service}/key`, changed() { changed++; }, status: `#${service}-status` }).refresh({ hasKey: true });
    button.click(); await delay(0); assert.equal(calls.length, changed, 'cancel never sends a request'); assert.equal(input.value, 'draft');
    approve = true; button.click(); await delay(0); assert.equal(input.value, ''); assert.equal(button.hidden, true);
    assert.deepEqual(calls.at(-1), { path: `/api/settings/${service}/key`, method: 'DELETE' }); assert.equal(document.querySelector('[type="submit"]').disabled, false);
    approve = false;
  }
  assert.equal(changed, 4);
  const button = document.getElementById('ai'), input = document.getElementById('ai-input'); button.hidden = false; input.value = 'keep draft'; fail = approve = true;
  button.click(); await delay(0); assert.equal(input.value, 'keep draft'); assert.equal(button.disabled, false); assert.match(document.getElementById('ai-status').textContent, /Removal failed/u);
});
