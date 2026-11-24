import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { sampleBook } from '../server/sample.js';

const root = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'langy-book-upload-'));
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const { port } = probe.address(); await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env,
    PORT: String(port), READER_DATA: folder, READER_STORAGE_ID: '', READER_DEMO: '0', READER_PASSWORD: '',
    READER_LANGUAGE_URL: 'http://127.0.0.1:1', READER_KOKORO_URL: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (value) => { output = (output + value).slice(-10000); });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(folder, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(base + '/healthz', { signal: AbortSignal.timeout(500) })).ok) return { base, folder }; }
    catch { /* Await startup. */ }
    await delay(20);
  }
  throw new Error('Reader startup timed out: ' + output);
}

test('the actual book form uploads one EPUB/PDF with its language field, while invalid multipart requests get accurate errors', async (t) => {
  const { base, folder } = await fixture(t);
  const dom = new JSDOM(await readFile(join(root, 'index.html'), 'utf8')); t.after(() => dom.window.close());
  const form = dom.window.document.querySelector('#book-form');
  form.elements.title.value = 'Upload regression'; form.elements.author.value = 'Test author'; form.elements.language.value = 'es';
  const epub = await sampleBook();
  function requestData({ languages = [], format = 'epub', field = 'file' } = {}) {
    const browser = new dom.window.FormData(form);
    browser.delete('source'); browser.delete('archiveReference'); browser.delete('archiveDownloadMode'); browser.delete('archiveSlowURL'); browser.delete('file');
    browser.delete('archiveQueueUnavailable');
    browser.set('coverStyle', 'auto');
    browser.set('languages', JSON.stringify(languages));
    const data = new FormData();
    for (const [name, value] of browser) data.append(name, String(value));
    data.set('categoryId', 'spanish');
    const bytes = format === 'epub' ? epub : Buffer.from('%PDF-1.4\n%%EOF\n');
    data.append(field, new Blob([bytes], { type: format === 'epub' ? 'application/epub+zip' : 'application/pdf' }), `book.${format}`);
    return { data, bytes };
  }
  const initial = (await (await fetch(base + '/api/library')).json()).books.length;
  for (const options of [{ format: 'epub', languages: [] }, { format: 'pdf', languages: ['es', 'en'] }]) {
    const { data, bytes } = requestData(options);
    const response = await fetch(base + '/api/books', { method: 'POST', body: data });
    const book = await response.json(); assert.equal(response.status, 201, JSON.stringify(book));
    assert.equal(book.title, 'Upload regression'); assert.equal(book.format, options.format);
    assert.deepEqual(book.languages, options.languages);
    const download = await fetch(base + `/api/books/${book.id}/file`);
    assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  }
  for (const [change, expected] of [
    [(data) => data.append('extra', 'unexpected'), /too many book details/i],
    [(data) => data.set('title', 'x'.repeat(1025)), /book details is too long/i],
    [(data) => data.append('file', new Blob([epub]), 'second.epub'), /one EPUB or PDF at a time/i],
  ]) {
    const { data } = requestData(); change(data);
    const response = await fetch(base + '/api/books', { method: 'POST', body: data });
    assert.equal(response.status, 400); assert.match((await response.json()).error, expected);
  }
  const { data } = requestData({ field: 'unexpected-file' });
  const response = await fetch(base + '/api/books', { method: 'POST', body: data });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /unexpected file field/i);
  assert.equal((await (await fetch(base + '/api/library')).json()).books.length, initial + 2);
  assert.deepEqual(await readdir(join(folder, 'uploads')), []);
});
