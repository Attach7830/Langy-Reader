import { proficiencyPage } from '../src/proficiency.js';
import { kavitaConnection } from '../src/kavita.js';
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
import { pdfOCR } from '../src/pdf-ocr.js';

async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); } throw new Error('Reader tool did not update'); }
async function browser(t) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test', pretendToBeVisual: true });
  const names = ['window', 'document', 'localStorage', 'navigator', 'Option', 'Node', 'location', 'CustomEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'FormData'];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])), originalFetch = globalThis.fetch;
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  t.after(() => { globalThis.fetch = originalFetch; dom.window.close(); for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  return dom;
}

test('rapid successive edits open the requested book and an older refresh cannot reset the newer save', async (t) => {
  const dom = await browser(t); let releaseRefresh, releaseSecond, holdRefresh = false, refreshing = false, savingSecond = false;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; }), secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const books = ['First book', 'Second book'].map((title, index) => ({ id: String(index + 1), title, author: '', language: 'es', format: 'epub', addedAt: index + 1 }));
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/library') {
      if (holdRefresh) { refreshing = true; await refreshGate; }
      return Response.json({ books, categories: [], maxUpload: 1000000, demo: false, storage: { available: false } });
    }
    const id = path.split('/').at(-1), book = books.find((item) => item.id === id);
    assert.equal(options.method, 'PATCH'); assert.ok(book);
    if (id === '2') { savingSecond = true; await secondGate; }
    Object.assign(book, JSON.parse(options.body)); return Response.json(book);
  };
  const ui = libraryScreen({ progress: {}, onRemove() {} });
  t.after(() => { releaseRefresh(); releaseSecond(); ui.dispose(); }); await ui.refresh();
  document.querySelector('[aria-label="Edit First book"]').click();
  const form = document.querySelector('#book-form'); form.elements.series.value = 'First series';
  holdRefresh = true; form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => refreshing && !document.querySelector('#book-dialog').open);
  document.querySelector('[aria-label="Edit Second book"]').click();
  assert.equal(form.elements.title.value, 'Second book'); assert.equal(document.querySelector('#book-submit').disabled, false);
  form.elements.series.value = 'Second series'; form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => savingSecond); releaseRefresh(); await delay(25);
  assert.equal(document.querySelector('#book-dialog').open, true); assert.equal(form.elements.title.value, 'Second book');
  assert.equal(document.querySelector('#book-submit').disabled, true, 'the older save must not unlock the newer submit');
  releaseSecond(); await until(() => !document.querySelector('#book-dialog').open);
  assert.equal(books[0].series, 'First series'); assert.equal(books[1].series, 'Second series');
});

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

test('submitting OCR closes its dialog only after queue acceptance, while Details and rejected submissions remain open', async (t) => {
  const dom = await browser(t); let job = null, reject = false, posts = 0;
  globalThis.fetch = async (_path, options = {}) => {
    if (options.method === 'POST') { posts++; if (reject) return Response.json({ error: 'Choose an installed OCR language.' }, { status: 422 }); job = { id: 'scan', state: 'queued' }; return Response.json(job); }
    return Response.json({ available: true, languages: ['spa'], job });
  };
  const ui = pdfOCR({ changed() {} }); t.after(() => ui.dispose());
  const book = { id: 'one', title: 'A PDF', format: 'pdf', language: 'es' };
  ui.show(book); await until(() => !document.querySelector('#ocr-submit').disabled);
  document.querySelector('#ocr-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !document.querySelector('#ocr-dialog').open); assert.equal(posts, 1);
  ui.show(book); await until(() => document.querySelector('#ocr-progress').textContent.includes('queued'));
  assert.equal(document.querySelector('#ocr-dialog').open, true, 'opening Details for active work must remain useful');
  document.querySelector('#ocr-dialog').close(); job = null; reject = true;
  ui.show(book); await until(() => !document.querySelector('#ocr-submit').disabled);
  document.querySelector('#ocr-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.querySelector('#ocr-error').textContent.includes('installed OCR language'));
  assert.equal(document.querySelector('#ocr-dialog').open, true); document.querySelector('#ocr-dialog').close();
});

test('cover imports close immediately, allow another book to be edited, and preserve quick failures in Process queue', async (t) => {
  const dom = await browser(t); processTasks.setAccount('cover-dialog-reader'); processTasks.clearFinished();
  let release, fail = false, imports = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const books = ['one', 'two'].map((id) => ({ id, title: id === 'one' ? 'First book' : 'Second book', author: '', language: 'es', format: 'epub', addedAt: 1 }));
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/library') return Response.json({ books, categories: [], maxUpload: 1000000, demo: false, storage: { available: false } });
    assert.equal(path, '/api/books/one/cover'); imports++;
    assert.equal(JSON.parse(options.body).url, 'https://images.example.org/cover.png');
    if (fail) return Response.json({ error: 'Image could not be decoded.' }, { status: 422 });
    await held; return Response.json({ ...books[0], thumbnailType: 'image/png', coverRevision: 'updated' });
  };
  const ui = libraryScreen({ progress: {}, onRemove() {} }); t.after(() => { release(); ui.dispose(); processTasks.clearFinished(); }); await ui.refresh();
  document.querySelector('[aria-label="Edit First book"]').click();
  document.querySelector('[name=coverUrl]').value = 'https://images.example.org/cover.png';
  document.querySelector('#book-import-cover').click();
  assert.equal(document.querySelector('#book-dialog').open, false); assert.equal(imports, 1);
  assert.equal(processTasks.snapshot().tasks.find((job) => job.kind === 'cover')?.title, 'First book');
  document.querySelector('[aria-label="Edit Second book"]').click();
  document.querySelector('#book-form [name=author]').value = 'An unsaved author'; release();
  await until(() => !processTasks.snapshot().tasks.some((job) => job.kind === 'cover' && job.state === 'running'));
  assert.equal(document.querySelector('#book-dialog').open, true);
  assert.equal(document.querySelector('#book-form [name=title]').value, 'Second book');
  assert.equal(document.querySelector('#book-form [name=author]').value, 'An unsaved author');
  document.querySelector('#book-dialog').close(); fail = true;
  document.querySelector('[aria-label="Edit First book"]').click();
  document.querySelector('[name=coverUrl]').value = 'https://images.example.org/cover.png'; document.querySelector('#book-import-cover').click();
  await until(() => processTasks.snapshot().tasks.some((job) => job.kind === 'cover' && job.state === 'failed'));
  assert.equal(document.querySelector('#book-dialog').open, false);
  assert.match(processTasks.snapshot().tasks.find((job) => job.state === 'failed').detail, /could not be decoded/u);
});

test('saving a selected cover saves edited series metadata first and closes while its image is importing', async (t) => {
  const dom = await browser(t); processTasks.setAccount('save-cover-reader'); processTasks.clearFinished();
  let release, saved, calls = [];
  const held = new Promise((resolve) => { release = resolve; });
  let book = { id: 'one', title: 'Original title', author: '', language: 'es', languages: [], format: 'epub', addedAt: 1 };
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/library') return Response.json({ books: [book], categories: [], maxUpload: 1000000, demo: false, storage: { available: false } });
    calls.push(path);
    if (path === '/api/books/one') { saved = JSON.parse(options.body); book = { ...book, ...saved }; return Response.json(book); }
    assert.equal(path, '/api/books/one/cover'); await held; return Response.json(book);
  };
  const ui = libraryScreen({ progress: {}, onRemove() {} }); t.after(() => { release(); ui.dispose(); processTasks.clearFinished(); }); await ui.refresh();
  document.querySelector('[aria-label="Edit Original title"]').click(); const fields = document.querySelector('#book-form').elements;
  fields.title.value = 'Saved title'; fields.series.value = 'My series'; fields.series.dispatchEvent(new dom.window.Event('input')); fields.seriesIndex.value = '2.5'; fields.coverUrl.value = 'https://images.example.org/cover.png';
  document.querySelector('#book-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !document.querySelector('#book-dialog').open);
  assert.deepEqual(calls, ['/api/books/one', '/api/books/one/cover']); assert.equal(saved.title, 'Saved title'); assert.equal(saved.series, 'My series'); assert.equal(saved.seriesIndex, '2.5');
  assert.equal(processTasks.snapshot().tasks.find((job) => job.kind === 'cover')?.title, 'Saved title');
  release(); await until(() => !processTasks.snapshot().tasks.some((job) => job.kind === 'cover' && job.state === 'running'));
});

test('series controls filter the visible library and show numeric sequence order across folders', async (t) => {
  const dom = await browser(t);
  const books = [
    { id: 'ten', title: 'Tenth', series: 'Stories', seriesIndex: 10, starredAt: 1 },
    { id: 'two', title: 'Second', series: 'Stories', seriesIndex: 2, categoryId: 'folder' },
    { id: 'half', title: 'Prequel', series: 'Stories', seriesIndex: 0.5 },
    { id: 'alone', title: 'Standalone' },
    { id: 'hidden', title: 'Hidden shared book', series: 'Hidden series', sharedWithMe: true, canEdit: false },
  ].map((book) => ({ ...book, author: '', language: 'es', format: 'epub', addedAt: 1 }));
  globalThis.fetch = async () => Response.json({ books, categories: [{ id: 'folder', name: 'A folder' }], maxUpload: 1000000, demo: false, storage: { available: false } });
  const ui = libraryScreen({ progress: {}, onRemove() {}, preferences: () => ({ showSharedBooks: false }) }); t.after(() => ui.dispose()); await ui.refresh();
  const filter = document.querySelector('#book-series-filter');
  assert.equal([...filter.options].some((option) => option.text === 'Hidden series'), false);
  filter.value = 'series:stories'; filter.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.querySelector('#book-sort').value, 'series');
  assert.deepEqual([...document.querySelectorAll('#books .book-card')].map((node) => node.dataset.book), ['half', 'two', 'ten']);
  assert.match(document.querySelector('[data-book=half] .book-series').textContent, /Book 0\.5/u);
  filter.value = 'none'; filter.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual([...document.querySelectorAll('#books .book-card')].map((node) => node.dataset.book), ['alone']);
  filter.value = ''; filter.dispatchEvent(new dom.window.Event('change'));
  document.querySelector('#search').value = 'Stories'; document.querySelector('#search').dispatchEvent(new dom.window.Event('input'));
  assert.equal(document.querySelectorAll('#books .book-card').length, 3);
});

test('completed OCR refreshes library metadata once even when its status dialog has closed', async (t) => {
  let queue; t.after(() => queue?.dispose());
  const dom = await browser(t); let notifications = 0, reads = 0;
  let jobs = [{ id: 'ocr:one', kind: 'ocr', label: 'Scan PDF with OCR', state: 'running', bookId: 'one' }];
  const changed = () => { notifications++; }; window.addEventListener('langy-library-changed', changed);
  globalThis.fetch = async () => { reads++; return Response.json({ accountId: 'ocr-completion-reader', jobs }); };
  queue = processQueue(); queue.setAccount('ocr-completion-reader'); await until(() => reads > 0);
  await delay(20); jobs = [{ ...jobs[0], state: 'completed' }]; window.dispatchEvent(new dom.window.CustomEvent('langy-processes-changed'));
  await until(() => notifications === 1); const before = reads;
  window.dispatchEvent(new dom.window.CustomEvent('langy-processes-changed')); await until(() => reads > before); assert.equal(notifications, 1);
  window.removeEventListener('langy-library-changed', changed);
});

test('text selection offers icon-only bookmark and explain actions and aborts stale explanations', async (t) => {
  const dom = await browser(t), root = document.createElement('article'); root.innerHTML = '<p>La viajera tenía muchas ganas de leer esta historia.</p>'; document.body.append(root);
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 30, top: 100, bottom: 125 });
  const calls = []; let selected = 0, pending;
  const ui = phraseHelp({ book: () => ({ id: 'book', language: 'es', languages: ['es', 'pt'] }), preferences: () => ({ translationLanguage: 'en', languageDefaultsMode: 'per-language', languageDefaults: { es: { translationLanguage: 'pt' }, pt: { translationLanguage: 'es' } } }), onSelection() { selected++; },
    async request(path, options) { calls.push({ path, ...options }); return pending ? await pending : { text: 'Significa estar com muita vontade de ler.' }; } });
  const unbind = ui.bind(root); t.after(unbind);
  const range = document.createRange(); range.setStart(root.firstChild.firstChild, 17); range.setEnd(root.firstChild.firstChild, 28); const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new dom.window.Event('selectionchange'));
  await until(() => !document.querySelector('#phrase-help').hidden);
  assert.equal(calls.length, 0, 'selection itself must not spend tokens'); assert.equal(selected, 1);
  const actions = [...document.querySelectorAll('#phrase-help button:not([hidden])')];
  assert.deepEqual(actions.map((button) => button.getAttribute('aria-label')), ['Bookmark selection', 'Explain phrase']);
  assert.ok(actions.every((button) => button.querySelector('[data-lucide]') && button.textContent.trim() === ''));
  assert.equal(document.querySelector('.phrase-response').hidden, true);
  document.querySelector('[data-explain-phrase]').click(); await until(() => document.querySelector('[data-phrase-answer]').textContent.includes('Significa'));
  assert.equal(calls[0].path, '/api/ai/phrase'); assert.equal(calls[0].body.translationLanguage, 'pt'); assert.ok(calls[0].body.context.includes(calls[0].body.phrase));
  root.setAttribute('lang', 'pt'); ui.clear(); document.dispatchEvent(new dom.window.Event('selectionchange')); await until(() => !document.querySelector('#phrase-help').hidden);
  document.querySelector('[data-explain-phrase]').click(); await until(() => calls.length === 2);
  assert.equal(calls[1].body.language, 'pt'); assert.equal(calls[1].body.translationLanguage, 'es', 'the phrase language chooses its override even when the primary book language differs');
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
  document.querySelector('[aria-label="Edit Own shared book"]').click();
  assert.equal(document.querySelector('#book-sharing-controls').hidden, false);
  assert.equal(document.querySelector('#book-sharing-mode').value, 'everyone');
  document.querySelector('#book-dialog').close(); document.querySelector('#import-book').click();
  assert.equal(document.querySelector('#book-sharing-mode').value, 'private', 'new books are private by default');
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

test('Imported download entries expire after five seconds without removing books or resetting on refresh', async (t) => {
  await browser(t); t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const books = [{ id: 'imported-book', title: 'Imported book', format: 'epub', language: 'es', addedAt: 1 }];
  let jobs = [{ id: 'done', state: 'ready', completedAt: 100000, details: { title: 'Finished download' } },
    { id: 'old', state: 'ready', completedAt: 90000, details: { title: 'Previous download' } },
    { id: 'queued', state: 'queued', details: { title: 'Pending download' } },
    { id: 'error', state: 'error', error: 'Retry needed', details: { title: 'Failed download' } }];
  globalThis.fetch = async (path) => {
    assert.equal(path, '/api/library', 'expiry must not issue a delete or download request');
    return Response.json({ books, categories: [], storage: { available: false }, archive: { jobs } });
  };
  const ui = libraryScreen({ progress: {}, onRemove() {} }); t.after(() => ui.dispose()); await ui.refresh();
  const list = document.querySelector('#archive-download-list'), panel = document.querySelector('#archive-downloads');
  assert.match(list.textContent, /Finished downloadImported/u); assert.doesNotMatch(list.textContent, /Previous download/u);
  t.mock.timers.tick(4999); await ui.refresh(); assert.match(list.textContent, /Finished downloadImported/u);
  t.mock.timers.tick(1); assert.doesNotMatch(list.textContent, /Finished download/u);
  assert.match(list.textContent, /Pending download/u); assert.match(list.textContent, /Failed download/u);
  assert.equal(document.querySelectorAll('#books .book-card').length, 1);
  await ui.refresh(); assert.doesNotMatch(list.textContent, /Finished download/u);
  jobs = jobs.filter((job) => job.state === 'ready'); await ui.refresh(); assert.equal(panel.hidden, true);
  ui.dispose();
  const reopened = libraryScreen({ progress: {}, onRemove() {} }); t.after(() => reopened.dispose()); await reopened.refresh();
  assert.equal(panel.hidden, true, 'saved completion times keep imported entries dismissed when the view reopens');
});

test('synced audio is visible in quiet and covers-only libraries and refreshes after recording changes', async (t) => {
  const dom = await browser(t);
  const books = ['synced', 'unsynced'].map((id) => ({ id, title: id, format: 'epub', language: 'es', addedAt: 1, audioSynced: id === 'synced' }));
  globalThis.fetch = async (path) => {
    assert.equal(path, '/api/library'); return Response.json({ books, categories: [], storage: { available: false } });
  };
  const ui = libraryScreen({ progress: {}, onRemove() {}, preferences: () => ({ quietLibrary: true, coversOnly: true }) });
  t.after(() => ui.dispose()); await ui.refresh();
  assert.equal(document.querySelector('[data-book="synced"] .book-audio-badge').textContent, 'Audio synced');
  assert.equal(document.querySelector('[data-book="unsynced"] .book-audio-badge'), null);
  assert.equal(document.querySelector('#books').dataset.coversOnly, 'true');
  assert.equal(document.querySelector('[data-book="synced"] .book-reading-details').hidden, true);
  assert.equal(document.querySelector('[data-book="synced"] .book-audio-badge').closest('.book-info'), null, 'the badge remains outside hidden cover metadata');
  books[0].audioSynced = false; books[1].audioSynced = true;
  window.dispatchEvent(new dom.window.CustomEvent('langy-audio-updated', { detail: { book: 'synced' } }));
  await until(() => !document.querySelector('[data-book="synced"] .book-audio-badge'));
  assert.equal(document.querySelector('[data-book="unsynced"] .book-audio-badge').textContent, 'Audio synced');
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


test('reading profile renders one language at a time, removes L1 even from stale results and saves account-scoped hours', async (t) => {
  let ui; t.after(()=>ui?.leave()); const dom = await browser(t); let l1 = 'en-US', saved;
  const language = (code) => ({ language:code, unit:code==='zh'?'characters':'lemmas', seen:30, likelyKnown:5, exposures:120, trackedExposures:100, completionExposures:20, books:2, authors:1, trackedHours:1, outsideHours:2, totalHours:3, readingCheck:2, listeningCheck:1, readingEstimate:{range:'Novice–Intermediate',evidence:'Partial exposure record'}, listeningEstimate:{range:'Novice',evidence:'Partial exposure record'}, history:{seen:[{date:'2026-11-20',seen:20},{date:'2026-11-26',seen:30}],observations:[{date:'2026-11-26',known:5,threshold:20,hours:3}]} });
  const data={accountId:'reader-account',threshold:20,languages:['en','es','zh'].map(language)};
  globalThis.fetch=async(_path,options={})=>{if(options.method==='PUT')saved=JSON.parse(options.body);return Response.json(data);};
  document.querySelector('#proficiency-chart').getBoundingClientRect=()=>({width:340});
  ui=proficiencyPage({preferences:()=>({nativeLanguage:l1})});await ui.open();
  assert.deepEqual([...document.querySelector('#proficiency-language').options].map((item)=>item.value),['es','zh']);
  assert.equal(document.querySelector('#proficiency-chart svg').getAttribute('viewBox'),'0 0 340 260');
  assert.equal(document.querySelectorAll('#proficiency-chart svg').length,1);assert.match(document.querySelector('#proficiency-reading-range').textContent,/Novice/u);
  document.querySelector('#proficiency-input-hours').value='150';document.querySelector('#proficiency-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await until(()=>Boolean(saved));assert.equal(saved.accountId,'reader-account');assert.equal(saved.hours,150);assert.equal(saved.language,'es');
  l1='zh-Hant';await ui.open();assert.ok(![...document.querySelector('#proficiency-language').options].some((item)=>item.value==='zh'));
  ui.leave();assert.equal(document.querySelectorAll('#proficiency-chart svg').length,0);
});

test('Kavita settings clear secrets after testing and catalogue imports queue without locking the library',async(t)=>{
  let ui;t.after(()=>ui?.reset());const dom=await browser(t);let connected=false,connection,queued;
  globalThis.fetch=async(path,options={})=>{
    if(path==='/api/settings/kavita'){if(options.method==='PUT'){connection=JSON.parse(options.body);connected=true;}return Response.json({available:true,connected,origin:connected?'http://kavita.test:5000':''});}
    if(path==='/api/library')return Response.json({categories:[{id:'folder',name:'Stories'}]});
    if(path.startsWith('/api/kavita/catalogue'))return Response.json({title:'Kavita books',node:'feed-token',searchable:false,navigation:[],entries:[{title:'A story',author:'A Writer',summary:'A useful story',acquisitions:[{id:'book-token',format:'epub'}]}]});
    if(path==='/api/imports/kavita'){queued=JSON.parse(options.body);return Response.json({state:'queued'});}assert.fail(path);
  };
  ui=kavitaConnection();await ui.load();document.querySelector('#kavita-url').value='http://kavita.test:5000/api/Opds/secret-key';document.querySelector('#kavita-username').value='reader';document.querySelector('#kavita-password').value='secret-password';document.querySelector('#kavita-save').click();await until(()=>connected&&document.querySelector('#kavita-url').value==='');assert.ok(connection.url.endsWith('secret-key'));assert.equal(document.querySelector('#kavita-password').value,'');
  document.querySelector('#kavita-browse').click();await until(()=>document.querySelector('#kavita-entries button'));document.querySelector('#kavita-folder').value='folder';document.querySelector('#kavita-entries button').click();await until(()=>Boolean(queued));assert.deepEqual(queued,{item:'book-token',categoryId:'folder',language:''});assert.equal(document.querySelector('#kavita-dialog').open,true);assert.doesNotMatch(document.querySelector('#kavita-entries').textContent,/secret-key|secret-password/u);
});
