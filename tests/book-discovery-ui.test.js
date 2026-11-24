import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { discoveryScreen } from '../src/ui-discovery.js';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function until(check) { for (let n = 0; n < 200; n++) { if (check()) return; await delay(5); } throw new Error('Discovery UI timed out'); }
async function fixture(t) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test', pretendToBeVisual: true });
  const names = ['window', 'document'], originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
  t.after(() => { dom.window.close(); for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const initial = { state: 'idle', id: null, busy: false, error: null, result: null, libraryCount: 2, language: 'es', focus: '', model: 'qwen3:8b', provider: 'ollama', stale: false };
  const result = { text: 'Related fiction from verified book records.', interests: 'Tentative interest in literary memory.', generatedAt: 1000, scannedBooks: 2, sampledBooks: 2, language: 'es', queries: ['related Mexican fiction'], warnings: [], books: [
    { title: '<img src=x onerror=alert(1)>', authors: ['Elena Garro'], year: 1963, reason: 'A related approach to memory.', basedOn: [{ id: 'one', title: 'Pedro Páramo' }], sources: [{ title: 'Open Library record', url: 'https://openlibrary.org/works/OL2W' }, { title: 'unsafe', url: 'javascript:alert(1)' }] },
  ] };
  const form = document.querySelector('#discovery-form'), submit = () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  return { dom, initial, result, form, submit };
}

test('the discovery page submits normalized preferences once, follows job stages, and renders safe source-linked recommendations', async (t) => {
  const f = await fixture(t), held = deferred(), calls = []; let state = f.initial, waitingReads = 0;
  const ui = discoveryScreen({ pollMs: 5, async request(path, options) {
    assert.equal(path, '/api/discovery'); calls.push(options || { method: 'GET' });
    if (options?.method === 'POST') { await held.promise; state = { ...state, id: 'job', busy: true, state: 'searching' }; return state; }
    if (state.busy && ++waitingReads === 2) state = { ...state, busy: false, state: 'ready', result: f.result };
    return state;
  } }); t.after(() => ui.leave());
  await ui.open(); assert.match(document.querySelector('#discovery-connection').textContent, /qwen3:8b/);
  document.querySelector('#discovery-language').value = 'Spanish'; document.querySelector('#discovery-focus').value = 'Short novels';
  f.submit(); f.submit(); assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(document.querySelector('#generate-discovery').disabled, true);
  held.resolve(); await until(() => !document.querySelector('#discovery-results').hidden);
  const body = calls.find((call) => call.method === 'POST').body; assert.equal(body.language, 'es'); assert.equal(body.focus, 'Short novels');
  assert.equal(document.querySelectorAll('.discovery-card').length, 1); assert.equal(document.querySelector('.discovery-card img'), null);
  assert.equal(document.querySelector('.discovery-card h2').textContent, f.result.books[0].title);
  const links = document.querySelectorAll('.discovery-sources a'); assert.equal(links.length, 2);
  assert.equal(links[1].href, 'https://openlibrary.org/works/OL2W'); assert.equal(links[1].rel, 'noopener noreferrer');
  const archive = new URL(links[0].href); assert.equal(archive.pathname, '/api/archive/search'); assert.equal(archive.searchParams.get('title'), f.result.books[0].title);
  assert.match(document.querySelector('.discovery-card').textContent, /Connected to: Pedro Páramo/);
  assert.equal(document.querySelector('#generate-discovery').textContent, 'Refresh recommendations');
});

test('cancelling discovery stops polling, preserves editable preferences, and discards late page responses after leaving', async (t) => {
  const f = await fixture(t), late = deferred(); let state = { ...f.initial, id: 'job', busy: true, state: 'ranking', focus: 'Memory' }, hold = false, reads = 0;
  const ui = discoveryScreen({ pollMs: 10, async request(_path, options) {
    if (options?.method === 'DELETE') return state = { ...state, busy: false, state: 'cancelled' };
    reads++; if (hold) return late.promise; return state;
  } }); t.after(() => ui.leave());
  await ui.open(); assert.equal(document.querySelector('#discovery-focus').value, 'Memory');
  assert.equal(document.querySelector('#cancel-discovery').hidden, false);
  document.querySelector('#cancel-discovery').click(); await until(() => document.querySelector('#cancel-discovery').hidden);
  assert.match(document.querySelector('#discovery-status').textContent, /cancelled/);
  const stopped = reads; await delay(30); assert.equal(reads, stopped);
  document.querySelector('#discovery-focus').value = 'History'; f.form.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  hold = true; const opening = ui.open(); ui.leave(); late.resolve({ ...f.initial, state: 'ready', result: f.result }); await opening;
  assert.equal(document.querySelector('#discovery-results').hidden, true); assert.equal(document.querySelector('#discovery-focus').value, 'History');
});

test('invalid preferences, empty libraries and a failed request provide a retryable user-facing state', async (t) => {
  const f = await fixture(t); let state = f.initial, posts = 0;
  const ui = discoveryScreen({ async request(_path, options) { if (options?.method === 'POST') { posts++; throw new Error('The AI server is unavailable.'); } return state; } }); t.after(() => ui.leave());
  await ui.open(); document.querySelector('#discovery-language').value = 'not a language'; f.submit();
  assert.equal(posts, 0); assert.match(document.querySelector('#discovery-error').textContent, /valid language/);
  document.querySelector('#discovery-language').value = ''; f.submit(); await until(() => posts === 1 && !document.querySelector('#generate-discovery').disabled);
  assert.match(document.querySelector('#discovery-error').textContent, /AI server is unavailable/);
  state = { ...f.initial, libraryCount: 0 }; await ui.open(); assert.equal(document.querySelector('#generate-discovery').disabled, true);
});
