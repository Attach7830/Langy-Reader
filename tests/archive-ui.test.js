import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { libraryScreen } from '../src/ui-library.js';

async function until(check) { for (let n = 0; n < 150; n++) { if (check()) return; await delay(10); } throw new Error('Slow-import UI timed out'); }
async function fixture(t, { queued = false } = {}) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test', pretendToBeVisual: true });
  const names = ['window', 'document', 'Option', 'Node', 'Element', 'HTMLElement', 'CustomEvent', 'FormData'];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  const oldFetch = globalThis.fetch, oldInterval = globalThis.setInterval, intervals = [];
  globalThis.setInterval = (...args) => { const id = oldInterval(...args); intervals.push(id); return id; };
  t.after(() => { intervals.forEach(clearInterval); globalThis.setInterval = oldInterval; globalThis.fetch = oldFetch; dom.window.close();
    for (const [name, value] of previous) { if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; } });
  const md5 = '0123456789abcdef0123456789abcdef', calls = []; let job, books = [];
  globalThis.fetch = async (path, options) => {
    if (path === '/api/library') return Response.json({ books, categories: [], maxUpload: 120 * 1024 ** 2, storage: { available: false }, vocabulary: { byLanguage: [] }, archive: { available: true, hasKey: true, job, jobs: job ? [job] : [] } });
    calls.push({ path, ...options });
    if (path === '/api/imports/anna/batch') return Response.json({ batchId: 'batch', jobs: JSON.parse(options.body).books.map((_, index) => ({ id: 'bulk-' + index, state: 'queued' })) });
    if (path === '/api/imports/anna') {
      const body = JSON.parse(options.body);
      job = { id: 'job', state: 'needs_action', source: 'slow', reference: md5, bookUrl: 'https://annas-archive.gl/md5/' + md5,
        notice: 'Fast-download allowance reached.', details: body };
      if (queued) job = { ...job, state: 'downloading', source: 'fast', bytes: 3700000, total: 15200000 };
      return Response.json(job);
    }
    if (['/api/imports/anna/job/file', '/api/imports/anna/job/continue'].includes(path)) {
      const details = options.body instanceof dom.window.FormData ? JSON.parse(options.body.get('details')) : JSON.parse(options.body).details;
      books = [{ ...details, id: 'book', format: 'epub', languages: [] }]; job = { ...job, state: 'ready', book: books[0] }; return Response.json(job);
    }
    assert.fail('Unexpected request: ' + path);
  };
  const ui = libraryScreen({ progress: {}, onRemove() {}, detectMetadata() { throw new Error('Slow imports do not use local-file preview'); } }); await ui.refresh();
  t.after(() => ui.dispose());
  document.querySelector('#import-book').click(); const form = document.querySelector('#book-form');
  document.querySelector('#book-source').value = 'anna'; document.querySelector('#book-source').dispatchEvent(new dom.window.Event('change'));
  form.elements.archiveReference.value = md5; form.elements.title.value = 'Chosen title'; form.elements.coverStyle.value = 'forest';
  const submit = () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  submit(); await until(() => (queued ? !document.querySelector('#book-dialog').open : !document.querySelector('#archive-slow-download').hidden) && !document.querySelector('#book-submit').disabled);
  return { dom, form, calls, submit };
}

test('quota fallback keeps the dialog and metadata, can be reopened, and uploads the downloaded edition', async (t) => {
  const f = await fixture(t);
  assert.equal(document.querySelector('#book-dialog').open, true); assert.equal(f.form.elements.archiveReference.readOnly, true);
  assert.match(document.querySelector('#archive-slow-page').href, /\/md5\/012345/u);
  assert.equal(document.querySelector('#resume-slow-import'), null);
  document.querySelector('#book-dialog').close(); document.querySelector('#archive-download-list button').click();
  assert.equal(f.form.elements.title.value, 'Chosen title'); assert.equal(f.form.elements.coverStyle.value, 'forest');
  const input = document.querySelector('#book-file'), file = new f.dom.window.File(['EPUB'], 'downloaded.epub');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new f.dom.window.Event('change'));
  f.submit(); await until(() => !document.querySelector('#book-dialog').open);
  const upload = f.calls.find((call) => call.path.endsWith('/file'));
  assert.equal(upload.body.get('file').name, 'downloaded.epub'); assert.equal(JSON.parse(upload.body.get('details')).coverStyle, 'forest');
  assert.ok(document.querySelector('.book-cover[data-cover="forest"]'));
});

test('a single live download closes the import dialog immediately and allows another import with retry queuing on by default', async (t) => {
  const f = await fixture(t, { queued: true });
  assert.equal(document.querySelector('#book-dialog').open, false);
  const request = f.calls.find((call) => call.path === '/api/imports/anna'); assert.equal(JSON.parse(request.body).queueUnavailable, true);
  assert.equal(document.querySelector('#archive-import-status'), null);
  assert.match(document.querySelector('#archive-download-list').textContent, /Downloading book/u);
  document.querySelector('#import-book').click(); assert.equal(document.querySelector('#book-dialog').open, true);
  assert.equal(document.querySelector('#book-submit').disabled, false); assert.equal(f.form.elements.archiveQueueUnavailable.checked, true);
});

test('a final slow file link continues the existing job instead of consuming another fast download', async (t) => {
  const f = await fixture(t); f.form.elements.archiveSlowURL.value = 'https://files.example.test/book?token=temporary';
  f.submit(); await until(() => !document.querySelector('#book-dialog').open);
  assert.equal(f.calls.filter((call) => call.path === '/api/imports/anna').length, 1);
  const continuation = f.calls.find((call) => call.path.endsWith('/continue'));
  assert.equal(JSON.parse(continuation.body).url, 'https://files.example.test/book?token=temporary');
  assert.equal(JSON.parse(continuation.body).details.title, 'Chosen title');
});

test('bulk import submits one title/link per row with common language settings and the optional common author', async (t) => {
  const f = await fixture(t), toggle = document.querySelector('#archive-bulk-mode');
  toggle.checked = true; toggle.dispatchEvent(new f.dom.window.Event('change'));
  const rows = document.querySelectorAll('.archive-bulk-row'); assert.equal(rows.length, 2);
  for (const [index, row] of [...rows].entries()) { const inputs = row.querySelectorAll('input'); inputs[0].value = String(index).repeat(32); inputs[1].value = 'Title ' + index; inputs[2].value = 'Different author'; }
  f.form.elements.language.value = 'Portuguese'; f.form.elements.author.value = 'One author';
  const shared = document.querySelector('#archive-shared-author'); shared.checked = true; shared.dispatchEvent(new f.dom.window.Event('change'));
  f.submit(); await until(() => !document.querySelector('#book-dialog').open);
  const body = JSON.parse(f.calls.find((call) => call.path === '/api/imports/anna/batch').body);
  assert.equal(body.language, 'pt'); assert.equal(body.sameAuthor, true); assert.equal(body.author, 'One author');
  assert.equal(body.books.length, 2); assert.equal(body.books[1].title, 'Title 1'); assert.equal(body.coverStyle, 'forest');
});
