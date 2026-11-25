import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { settingsPage } from '../src/ui-settings.js';
import { audiobookshelfBook } from '../src/audiobookshelf-ui.js';
import { defaults } from '../src/settings.js';

async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await delay(10); } throw new Error('Audiobookshelf controls did not become ready'); }
async function fixture(t) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test', pretendToBeVisual: true });
  const originals = new Map();
  for (const name of ['window', 'document', 'Option', 'Event', 'CustomEvent', 'location', 'localStorage', 'navigator']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  const oldFetch = globalThis.fetch, writes = []; let librariesUnavailable = false;
  let config = { configurable: true, connected: true, baseUrl: 'https://abs.test', hasKey: true, libraryId: 'books', folderId: 'default', categoryDestinations: {} };
  const libraries = [{ id: 'books', name: 'Books', folders: [{ id: 'default', path: '/books' }, { id: 'spanish-folder', path: '/books/es' }] },
    { id: 'chinese-library', name: 'Chinese library', folders: [{ id: 'chinese-folder', path: '/chinese' }] }];
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/settings/audiobookshelf') {
      if (options.method === 'PUT') { const body = JSON.parse(options.body); writes.push(body); config = { ...config, ...body }; delete config.apiKey; }
      return Response.json(config);
    }
    if (path === '/api/audiobookshelf/libraries') return librariesUnavailable ? Response.json({ error: 'ABS is unavailable' }, { status: 503 }) : Response.json({ libraries });
    if (path === '/api/library') return Response.json({ categories: [{ id: 'spanish', name: 'Spanish' }, { id: 'chinese', name: 'Mandarin' }] });
    if (path === '/api/settings/opds' || path === '/api/settings/sync') return Response.json({ available: false });
    if (path === '/api/books/book/narration') return Response.json({ audio: { state: 'ready', id: 'recording' }, recordings: [] });
    if (path.startsWith('/api/audiobookshelf/libraries/')) return Response.json({ results: [], total: 0 });
    if (path === '/api/books/book/audiobookshelf') return Response.json({ jobs: [] });
    assert.fail('Unexpected request: ' + path);
  };
  t.after(() => {
    globalThis.fetch = oldFetch; dom.window.close();
    for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  });
  return { dom, writes, failLibraries() { librariesUnavailable = true; }, config(value) { config = { ...config, ...value }; } };
}

test('the Settings page saves distinct category folders through its main Save settings button', async (t) => {
  const f = await fixture(t); let returned = 0;
  const page = settingsPage({ preferences: () => ({ ...defaults, keys: { ...defaults.keys } }), apply() {},
    navigate(tab) { page.open(tab); }, back() { returned++; page.leave(); } });
  page.setDemo(false); page.open('devices');
  await until(() => document.querySelectorAll('[data-abs-category]').length === 3);
  function choose(category, library, folder) {
    const row = document.querySelector(`[data-abs-category="${category}"]`), lib = row.querySelector('[data-abs-library]');
    lib.value = library; lib.dispatchEvent(new f.dom.window.Event('change'));
    row.querySelector('[data-abs-folder]').value = folder;
  }
  choose('spanish', 'books', 'spanish-folder'); choose('chinese', 'chinese-library', 'chinese-folder');
  const form = document.querySelector('#settings-form'); form.dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  await until(() => returned === 1);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].categoryDestinations, { spanish: { libraryId: 'books', folderId: 'spanish-folder' }, chinese: { libraryId: 'chinese-library', folderId: 'chinese-folder' } });
  assert.equal(f.writes[0].libraryId, 'books'); assert.equal(f.writes[0].folderId, 'default');
  assert.equal(f.writes[0].apiKey, '');
  page.open('devices'); await until(() => document.querySelector('[aria-label="Mandarin export folder"]')?.value === 'chinese-folder');
  assert.equal(document.querySelector('[aria-label="Spanish export folder"]').value, 'spanish-folder');
  assert.equal(document.querySelector('#abs-key').value, '');
});

test('book exports preview their mapped destination and do not offer unavailable destinations', async (t) => {
  const f = await fixture(t);
  f.config({ categoryDestinations: { chinese: { libraryId: 'chinese-library', folderId: 'chinese-folder' } } });
  document.querySelector('#learning-dialog').open = true;
  const book = { id: 'book', categoryId: 'chinese' }, panel = audiobookshelfBook({ book: () => book, changed() {} });
  await panel.show();
  assert.equal(document.querySelector('#abs-book-library').value, 'chinese-library');
  assert.match(document.querySelector('#abs-export-destination').textContent, /Chinese library.*\/chinese/u);
  assert.equal(document.querySelector('#abs-export').disabled, false);
  f.config({ categoryDestinations: { chinese: { libraryId: 'chinese-library', folderId: 'removed-folder' } } });
  await panel.show(); assert.equal(document.querySelector('#abs-export').disabled, true);
  assert.match(document.querySelector('#abs-export-destination').textContent, /Settings/u);
});


test('saving another Settings preference preserves destinations when ABS libraries cannot load', async (t) => {
  const f = await fixture(t); let returned = 0;
  f.config({ categoryDestinations: { spanish: { libraryId: 'books', folderId: 'spanish-folder' } } }); f.failLibraries();
  const page = settingsPage({ preferences: () => ({ ...defaults, keys: { ...defaults.keys } }), apply() {},
    navigate(tab) { page.open(tab); }, back() { returned++; page.leave(); } });
  page.setDemo(false); page.open('devices');
  await until(() => document.querySelector('#abs-settings-status').textContent.includes('unavailable'));
  document.querySelector('#settings-form').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  await until(() => returned === 1);
  assert.equal(f.writes.length, 0, 'unavailable library choices must not clear existing destinations');
});
