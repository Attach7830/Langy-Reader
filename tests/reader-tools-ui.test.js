import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { libraryScreen } from '../src/ui-library.js';
import { deviceSettings } from '../src/ui-device-settings.js';
import { phraseHelp } from '../src/phrase-help.js';
import { offlineDownloads } from '../src/offline-downloads.js';
import { processTasks } from '../src/process-tasks.js';
import { processQueue } from '../src/process-queue.js';
import { saveSettings } from '../src/settings.js';
import { folderAudiobookshelf } from '../src/folder-audiobookshelf.js';

async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); } throw new Error('Reader tool did not update'); }
async function browser(t) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test', pretendToBeVisual: true });
  const names = ['window', 'document', 'localStorage', 'navigator', 'Option', 'Node', 'location', 'CustomEvent', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])), originalFetch = globalThis.fetch;
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  t.after(() => { globalThis.fetch = originalFetch; dom.window.close(); for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  return dom;
}

test('Analysis & audio reveals ready controls while an unrelated iVoox request remains pending; empty Uncategorized is hidden', async (t) => {
  const dom = await browser(t); let release, books = [{ id: 'book', title: 'My book', author: '', language: 'es', format: 'epub', categoryId: 'folder', addedAt: 1 }], ocrJob = { state: 'queued', notice: 'Waiting for the OCR worker' };
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (path) => {
    if (path === '/api/library') return Response.json({ books, categories: [{ id: 'folder', name: 'Spanish' }], maxUpload: 1000000, demo: false, storage: { available: false }, vocabulary: { byLanguage: [] } });
    if (path === '/api/books/book/learning') return Response.json({ analysis: { state: 'ready', wordCount: 20, lemmaCount: 5, reading: { state: 'ready', band: 'Intermediate' }, counts: { words: 20 } }, chapters: [], narration: { audio: { state: 'missing' } } });
    if (path === '/api/books/book/recordings') return Response.json({ available: true, recordings: [] });
    if (path === '/api/books/book/ocr') return Response.json({ available: true, languages: ['spa'], job: ocrJob });
    if (path === '/api/books/book/ivoox') { await held; return Response.json({ job: null }); }
    if (path === '/api/settings/audiobookshelf') return Response.json({ connected: false });
    throw new Error('Unexpected path ' + path);
  };
  const ui = libraryScreen({ progress: {}, onRemove() {} }); t.after(() => ui.dispose()); await ui.refresh();
  assert.equal([...document.querySelectorAll('#categories button')].some((item) => item.textContent.includes('Uncategorized')), false);
  assert.equal([...document.querySelectorAll('#mobile-category option')].some((item) => item.value === 'uncategorized'), false);
  document.querySelector('[aria-label="Analysis and audio for My book"]').click();
  await until(() => !document.querySelector('#upload-audio-form').hidden && document.querySelector('#learning-stats').textContent.includes('5 unique lemmas'));
  assert.equal(document.querySelector('#find-similar-books').disabled, false, 'slow import status must not block vocabulary tools');
  release(); await delay(20); document.querySelector('#learning-dialog').close();
  books[0].categoryId = ''; books[0].format = 'pdf'; await ui.refresh();
  assert.equal([...document.querySelectorAll('#categories button')].some((item) => item.textContent.includes('Uncategorized')), true);
  window.dispatchEvent(new dom.window.CustomEvent('langy-open-process', { detail: { kind: 'ocr', bookId: 'book' } }));
  await until(() => document.querySelector('#ocr-dialog').open && document.querySelector('#ocr-progress').textContent.includes('Waiting for the OCR worker'));
  assert.equal(document.querySelector('#learning-dialog').open, false, 'OCR Details opens the scan status instead of unrelated audio tools');
  document.querySelector('#ocr-dialog').close();
  ocrJob = { state: 'ready', inPlace: true, book: { id: 'book' }, pages: 51, textPages: 51, recognizedCharacters: 0, scannedPages: 51, skippedPages: 0 };
  window.dispatchEvent(new dom.window.CustomEvent('langy-open-process', { detail: { kind: 'ocr', bookId: 'book' } }));
  await until(() => document.querySelector('#ocr-progress').textContent.includes('0 new characters recognized'));
  assert.match(document.querySelector('#ocr-progress').textContent, /51\/51 pages have text.*0 new characters recognized.*51 pages scanned/u);
  await delay(0); document.querySelector('#ocr-dialog').close();
});

test('Devices displays OPDS connection independently of slow progress sync', async (t) => {
  await browser(t); let release;
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (path) => {
    if (path === '/api/settings/audiobookshelf') return Response.json({ configurable: false, connected: false });
    if (path === '/api/settings/opds') return Response.json({ available: true, path: '/opds', authenticated: true, username: 'reader' });
    if (path === '/api/settings/sync') { await held; return Response.json({ available: true, deviceAvailable: true, path: '/kosync', username: 'reader' }); }
    throw new Error('Unexpected path');
  };
  const ui = deviceSettings(), loaded = ui.load();
  await until(() => !document.querySelector('#opds-connection').hidden);
  assert.equal(document.querySelector('#sync-connection').hidden, true); assert.match(document.querySelector('#opds-url').value, /\/opds$/u);
  release(); await loaded; assert.equal(document.querySelector('#sync-connection').hidden, false);
});

test('selecting a phrase offers one explicit contextual AI action and closes or aborts safely', async (t) => {
  const dom = await browser(t), root = document.createElement('article'); root.innerHTML = '<p>La viajera tenía muchas ganas de leer esta historia.</p>'; document.body.append(root);
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 30, top: 100, bottom: 125 });
  const calls = []; let selected = 0, pending;
  const ui = phraseHelp({ book: () => ({ id: 'book', language: 'es' }), preferences: () => ({ translationLanguage: 'pt' }), onSelection() { selected++; },
    async request(path, options) { calls.push({ path, ...options }); return pending ? await pending : { text: 'Significa estar com muita vontade de ler.' }; } });
  const unbind = ui.bind(root); t.after(unbind);
  const range = document.createRange(); range.setStart(root.firstChild.firstChild, 17); range.setEnd(root.firstChild.firstChild, 28); const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new dom.window.Event('selectionchange'));
  await until(() => !document.querySelector('#phrase-help').hidden);
  assert.equal(calls.length, 0, 'selection itself must not spend tokens'); assert.equal(selected, 1);
  document.querySelector('[data-explain-phrase]').click(); await until(() => document.querySelector('[data-phrase-answer]').textContent.includes('Significa'));
  assert.equal(calls[0].path, '/api/ai/phrase'); assert.equal(calls[0].body.translationLanguage, 'pt'); assert.ok(calls[0].body.context.includes(calls[0].body.phrase));
  let resolve; pending = new Promise((done) => { resolve = done; }); document.querySelector('[data-explain-phrase]').click(); await delay(0);
  ui.clear(); assert.equal(calls.at(-1).signal.aborted, true); resolve({ text: 'Late answer' }); await delay(0); assert.equal(document.querySelector('#phrase-help').hidden, true); assert.equal(document.querySelector('[data-phrase-answer]').textContent, '');
});

test('format and shared-book filters combine, persist in preferences and expose completed OCR labels', async (t) => {
  const dom = await browser(t); let preferences = { quietLibrary: true, showSharedBooks: true }, saved;
  const books = [{ id: 'own', title: 'Own shared book', author: '', language: 'es', format: 'pdf', ocrComplete: true, shared: true, sharedWithMe: false, canEdit: true },
    { id: 'theirs', title: 'Received shared book', author: '', language: 'es', format: 'epub', shared: true, sharedWithMe: true, canEdit: false }];
  globalThis.fetch = async (path) => {
    if (path === '/api/library') return Response.json({ books, categories: [], sharingAvailable: true, maxUpload: 1000000, demo: false, storage: { available: false } });
    throw new Error('Unexpected path ' + path);
  };
  const ui = libraryScreen({ progress: {}, onRemove() {}, preferences: () => preferences, changePreferences(value) { saved = value; preferences = { ...preferences, ...value }; } }); t.after(() => ui.dispose()); await ui.refresh();
  assert.equal(document.querySelector('#shared-books-control').hidden, false); assert.equal(document.querySelectorAll('#books .book-card').length, 2);
  assert.equal(document.querySelector('[aria-label="Edit Received shared book"]'), null);
  const toggle = document.querySelector('#show-shared-books'); toggle.checked = false; toggle.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(saved, { showSharedBooks: false }); assert.equal(document.querySelectorAll('#books .book-card').length, 1); assert.match(document.querySelector('#books').textContent, /Own shared book/u);
  assert.equal(document.querySelector('#books .book-format').textContent, 'PDF · OCR');
  const format = document.querySelector('#book-format-filter'); format.value = 'epub'; format.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.querySelectorAll('#books .book-card').length, 0); assert.equal(document.querySelector('#empty-title').textContent, 'No matching books');
  toggle.checked = true; toggle.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.querySelector('#books .book-format').textContent, 'EPUB');
  format.value = 'pdf'; format.dispatchEvent(new dom.window.Event('change')); assert.deepEqual(saved, { libraryFormat: 'pdf' });
  await ui.refresh(); assert.equal(format.value, 'pdf'); assert.equal(document.querySelectorAll('#books .book-card').length, 1);
  format.value = ''; format.dispatchEvent(new dom.window.Event('change')); assert.equal(document.querySelectorAll('#books .book-card').length, 2);
  document.querySelector('[aria-label="Edit Own shared book"]').click(); assert.equal(document.querySelector('#book-sharing-controls').hidden, false); assert.equal(document.querySelector('#book-form').elements.shared.checked, true);
  document.querySelector('#book-dialog').close(); document.querySelector('#import-book').click(); assert.equal(document.querySelector('#book-form').elements.shared.checked, false, 'new books are private by default');
});

test('completed offline downloads leave the queue automatically without removing the downloaded book', async (t) => {
  await browser(t); let publish, removed = 0;
  const native = document.createElement('fieldset'); native.id = 'android-app-controls'; document.querySelector('[data-settings-panel="devices"]').append(native);
  const job = { id: 'pack', book: { id: 'book', title: 'My offline book' }, state: 'downloading', progress: { percent: 40 } };
  const queue = { subscribe(listener) { publish = listener; listener([job]); return () => {}; }, snapshot: () => [job], close() {}, remove() { removed++; } };
  const ui = offlineDownloads({ queue }); t.after(() => ui.dispose());
  assert.equal(document.querySelectorAll('#offline-download-list .download-card').length, 1);
  job.state = 'complete'; publish([job]);
  assert.equal(document.querySelectorAll('#offline-download-list .download-card').length, 0);
  assert.deepEqual(processTasks.snapshot().downloads, []); assert.equal(removed, 0, 'clearing the queue must not delete the downloaded pack');
  job.state = 'failed'; job.error = 'Reconnect and retry'; publish([job]);
  assert.equal(document.querySelectorAll('#offline-download-list .download-card').length, 1);
  assert.match(document.querySelector('#offline-download-list').textContent, /Retry download/u);
});

test('the process panel refreshes active server tasks and removes completed tasks without dismissal', async (t) => {
  let panel; t.after(() => panel?.dispose());
  await browser(t); processTasks.clearFinished(); processTasks.setDownloads([]); let state = 'running';
  globalThis.fetch = async () => Response.json({ accountId: 'queue-reader', jobs: [{ id: 'server-task', state, label: 'Work in progress' }] });
  panel = processQueue(); panel.setAccount('queue-reader');
  document.querySelector('#open-process-queue').click();
  await until(() => Boolean(document.querySelector('[data-process="server-task"]')));
  state = 'completed'; window.dispatchEvent(new window.CustomEvent('langy-processes-changed'));
  await until(() => !document.querySelector('[data-process="server-task"]'));
  assert.equal(document.querySelector('#process-empty').hidden, false);
});

test('library format labels and every selected layout render independently of the covers-only preference', async (t) => {
  const dom = await browser(t); let prefs = { libraryLayout: 'auto', coversOnly: false, quietLibrary: true };
  globalThis.fetch = async (path) => {
    assert.equal(path, '/api/library'); return Response.json({ books: ['epub', 'pdf'].map((format) => ({ id: format, title: `${format} book`, format, language: 'es', addedAt: 1 })), categories: [], storage: { available: false } });
  };
  const ui = libraryScreen({ progress: {}, onRemove() {}, preferences: () => prefs, changePreferences(change) { prefs = { ...prefs, ...change }; } }); t.after(() => ui.dispose()); await ui.refresh();
  assert.deepEqual([...document.querySelectorAll('.book-format')].map((node) => node.textContent), ['EPUB', 'PDF']);
  for (const layout of ['1', '2', '3', '4', 'list']) {
    const input = document.querySelector('#library-layout'); input.value = layout; input.dispatchEvent(new dom.window.Event('change'));
    assert.equal(document.querySelector('#books').dataset.layout, layout); assert.equal(prefs.libraryLayout, layout);
  }
  const covers = document.querySelector('#library-covers-only'); covers.checked = true; covers.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.querySelector('#books').dataset.coversOnly, 'true'); assert.equal(document.querySelectorAll('.book-cover').length, 2);
});

test('folder editor loads its ABS link, saves a folder-scoped change and keeps existing mappings when untouched', async (t) => {
  const dom = await browser(t), writes = [];
  globalThis.fetch = async (path, options = {}) => {
    if (options.method === 'PATCH') { writes.push([path, JSON.parse(options.body)]); return Response.json({}); }
    if (path === '/api/settings/audiobookshelf') return Response.json({ configurable: true, connected: true, categoryDestinations: { folder: { libraryId: 'lib', folderId: 'one' } } });
    if (path === '/api/audiobookshelf/libraries') return Response.json({ libraries: [{ id: 'lib', name: 'Books', folders: [{ id: 'one', path: '/one' }, { id: 'two', path: '/two' }] }] });
    assert.fail(path);
  };
  const link = folderAudiobookshelf(); await link.load({ id: 'folder' }); assert.equal(document.querySelector('#category-abs-folder').value, 'one'); await link.save('folder'); assert.equal(writes.length, 0);
  const input = document.querySelector('#category-abs-folder'); input.value = 'two'; input.dispatchEvent(new dom.window.Event('change')); await link.save('folder');
  assert.deepEqual(writes[0], ['/api/settings/audiobookshelf/categories/folder', { destination: { libraryId: 'lib', folderId: 'two' } }]);
});

test('Process approval buttons submit an explicit decision and completed work respects the chosen delay', async (t) => {
  let panel; t.after(() => panel?.dispose()); const dom = await browser(t);
  saveSettings({ processDismissMinutes: 2 }); let clock = 1000000, approved, reads = 0, jobs = [{ id: 'audiobookshelf:proposal', bookId: 'book', kind: 'audiobookshelf', state: 'waiting', label: 'Import audio', decision: 'proposal' }, { id: 'work', state: 'running', label: 'Work' }];
  globalThis.fetch = async (path, options = {}) => {
    if (path.endsWith('/decision')) { approved = JSON.parse(options.body); jobs = jobs.filter((job) => !job.decision); return Response.json({}); }
    reads++; return Response.json({ accountId: 'approval-reader', jobs });
  };
  panel = processQueue({ now: () => clock }); panel.setAccount('approval-reader'); document.querySelector('#open-process-queue').click();
  await until(() => Boolean(document.querySelector('[data-process="work"]')));
  const minutes = document.querySelector('#process-dismiss-minutes'); minutes.focus(); minutes.value = '3'; const before = reads;
  window.dispatchEvent(new dom.window.CustomEvent('langy-processes-changed')); await until(() => reads > before); await delay(30);
  assert.equal(minutes.value, '3', 'a status poll must preserve an in-progress edit'); minutes.value = '2'; minutes.blur();
  const replace = [...document.querySelectorAll('#process-list button')].find((button) => button.textContent === 'Import and replace Langy audio'); replace.click(); await until(() => Boolean(approved)); assert.deepEqual(approved, { replace: true });
  jobs = []; window.dispatchEvent(new dom.window.CustomEvent('langy-processes-changed')); await until(() => document.querySelector('[data-process="work"]')?.textContent.includes('Finished'));
  clock += 120001; const input = document.querySelector('#process-dismiss-minutes'); input.dispatchEvent(new dom.window.Event('change')); assert.equal(document.querySelector('[data-process="work"]'), null);
});
