import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { bookMetadataFields } from '../src/book-metadata-fields.js';
import { libraryScreen } from '../src/ui-library.js';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function until(check) { for (let n = 0; n < 150; n++) { if (check()) return; await delay(10); } throw new Error('Metadata UI timed out'); }

test('preview protects manual edits, rejects stale file results, preserves folder language and permits retry after timeout', async (t) => {
  const dom = new JSDOM('<form><input name="title"><input name="author"><input name="language"></form><p id="status"></p>');
  t.after(() => dom.window.close());
  const form = dom.window.document.querySelector('form'), status = dom.window.document.querySelector('#status'), jobs = [];
  const fields = bookMetadataFields({ form, status, detect(file, options) { const job = deferred(); jobs.push({ ...job, file, ...options }); return job.promise; }, timeoutMs: 50 });
  const edit = (name, value) => { form.elements[name].value = value; form.elements[name].dispatchEvent(new dom.window.Event('input')); };
  fields.start({ name: 'First_file.epub' });
  assert.equal(form.elements.title.value, 'First file'); await Promise.resolve();
  edit('title', 'Manual title'); edit('language', 'Portuguese');
  jobs[0].resolve({ title: 'Embedded title', author: 'Writer', language: 'es' }); await fields.ready();
  assert.equal(form.elements.title.value, 'Manual title'); assert.equal(form.elements.language.value, 'Portuguese'); assert.equal(form.elements.author.value, 'Writer');
  fields.start({ name: 'Second.epub' }); await Promise.resolve();
  assert.equal(form.elements.author.value, '', 'previous automatic author is cleared when changing files');
  fields.start({ name: 'Third.epub' }); await Promise.resolve();
  assert.equal(jobs[1].signal.aborted, true); jobs[1].resolve({ author: 'Stale author', language: 'de' });
  jobs[2].resolve({ author: 'Current author', language: 'fr' }); await fields.ready();
  assert.equal(form.elements.author.value, 'Current author'); assert.equal(form.elements.language.value, 'Portuguese');
  fields.reset(); form.reset(); form.elements.language.value = 'zh'; form.elements.language.readOnly = true;
  fields.start({ name: 'Folder.epub' }); await Promise.resolve(); jobs[3].resolve({ author: 'Folder writer', language: 'en' }); await fields.ready();
  assert.equal(form.elements.language.value, 'zh');
  fields.start({ name: 'Timeout.epub' }); await fields.ready();
  assert.match(status.textContent, /could not be detected/); assert.equal(jobs[4].signal.aborted, true);
  fields.start({ name: 'Retry.epub' }); await Promise.resolve(); jobs[5].resolve({ title: 'Retry title', author: 'Retry author' }); await fields.ready();
  assert.equal(form.elements.title.value, 'Retry title'); assert.match(status.textContent, /language not detected/);
  fields.reset(); assert.equal(status.hidden, true);
  fields.start({ name: 'Closed.epub' }); await Promise.resolve(); fields.reset(); form.reset(); form.elements.title.value = 'Saved book details';
  jobs[6].resolve({ title: 'Obsolete preview', author: 'Obsolete author' }); await fields.ready(); await Promise.resolve();
  assert.equal(form.elements.title.value, 'Saved book details', 'closing or switching to saved details discards pending detection');
});

test('real library import waits for metadata, submits manual overrides once, and exposes saved details for editing', async (t) => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test', pretendToBeVisual: true });
  const names = ['window', 'document', 'Option', 'Node', 'Element', 'HTMLElement', 'CustomEvent', 'FormData'];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  const originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval, intervals = [];
  globalThis.setInterval = (...args) => { const handle = originalInterval(...args); intervals.push(handle); return handle; };
  t.after(() => {
    intervals.forEach(clearInterval); globalThis.setInterval = originalInterval; globalThis.fetch = originalFetch;
    dom.window.close(); for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  let books = [], imports = [], edits = [];
  globalThis.fetch = async (path, options) => {
    if (path === '/api/library') return Response.json({ books, categories: [], maxUpload: 120 * 1024 ** 2, demo: false, storage: { available: false }, vocabulary: { byLanguage: [] } });
    if (path === '/api/books') {
      imports.push(options.body); const data = Object.fromEntries(options.body);
      books = [{ id: 'book', ...data, languages: JSON.parse(data.languages), format: 'epub' }]; return Response.json(books[0]);
    }
    if (path === '/api/books/book') { edits.push(JSON.parse(options.body)); books = [{ ...books[0], ...edits.at(-1) }]; return Response.json(books[0]); }
    assert.fail(`Unexpected request: ${path}`);
  };
  const abandoned = deferred(), detection = deferred(), jobs = [abandoned, detection]; let detections = 0;
  const library = libraryScreen({ progress: {}, onRemove() {}, detectMetadata() { return jobs[detections++].promise; } }); await library.refresh();
  document.querySelector('#import-book').click();
  const form = document.querySelector('#book-form'), input = document.querySelector('#book-file');
  form.elements.autoAudiobook.checked = true; form.elements.autoAudiobook.dispatchEvent(new dom.window.Event('change'));
  form.elements.audiobookDelayMinutes.value = '7';
  let file = new dom.window.File(['EPUB'], 'Book_file.epub');
  const choose = () => { Object.defineProperty(input, 'files', { value: [file], configurable: true }); input.dispatchEvent(new dom.window.Event('change')); };
  const submit = () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  choose();
  assert.equal(form.elements.title.value, 'Book file'); assert.match(document.querySelector('#book-metadata-status').textContent, /Detecting/);
  submit(); await Promise.resolve();
  file = new dom.window.File(['EPUB'], 'Final_book.epub'); choose(); await Promise.resolve();
  abandoned.resolve({ title: 'Abandoned title', author: 'Obsolete author', language: 'de' });
  form.elements.author.value = 'My author'; form.elements.author.dispatchEvent(new dom.window.Event('input'));
  submit(); submit(); await Promise.resolve(); assert.equal(imports.length, 0);
  detection.resolve({ title: 'Detected book', author: 'Detected author', language: 'pt' });
  await until(() => !document.querySelector('#book-dialog').open);
  assert.equal(imports.length, 1); assert.equal(imports[0].get('title'), 'Detected book'); assert.equal(imports[0].get('author'), 'My author');
  assert.equal(imports[0].get('language'), 'pt'); assert.equal(imports[0].get('languages'), '[]'); assert.equal(imports[0].get('file').name, file.name);
  assert.equal(imports[0].get('coverStyle'), 'auto');
  assert.equal(imports[0].get('autoAudiobook'), 'true'); assert.equal(imports[0].get('audiobookDelayMinutes'), '7');
  assert.equal([...imports[0].keys()].filter((name) => name !== 'file').length, 9, 'metadata, series, cover and narration options stay within the multipart field limit');
  document.querySelector('[aria-label="Edit Detected book"]').click();
  assert.equal(form.elements.title.required, false); assert.equal(form.elements.language.required, false);
  assert.equal(document.querySelector('#book-language-note').hidden, false);
  form.elements.title.value = 'Corrected title'; form.elements.author.value = 'Corrected author'; form.elements.language.value = 'Spanish';
  submit(); await until(() => edits.length === 1);
  assert.equal(edits[0].title, 'Corrected title'); assert.equal(edits[0].author, 'Corrected author'); assert.equal(edits[0].language, 'es');
  await until(() => !document.querySelector('#book-dialog').open);
  document.querySelector('[aria-label="Edit Corrected title"]').click();
  for (const name of ['title', 'author', 'language']) form.elements[name].value = '';
  assert.equal(form.checkValidity(), true, 'blank details can reach automatic detection on the server');
  submit(); await until(() => edits.length === 2);
  assert.equal(edits[1].title, ''); assert.equal(edits[1].author, ''); assert.equal(edits[1].language, '');
  assert.equal(detections, 2, 'opening saved details never reruns file detection');
});
