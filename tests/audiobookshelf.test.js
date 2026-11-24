import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAudiobookshelf } from '../server/audiobookshelf.js';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-abs-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'book.epub'), 'EPUB'); await writeFile(join(dir, 'audio.mp3'), 'AUDIO');
  const book = { id: 'book', title: 'A Book', author: 'An Author', language: 'es', format: 'epub' }, calls = [], imported = [];
  let progress = null, state = 'uploaded';
  const item = { id: 'remote-item', mediaType: 'book', media: { duration: 100, metadata: { title: 'A Book' }, tracks: [{ index: 1, title: 'part.mp3', contentUrl: '/abs/s/item/remote-item/part.mp3', duration: 100 }] } };
  const library = { uploads: dir, getBook: () => book, filePath: () => join(dir, 'book.epub') };
  const learning = { ensure() {}, info: () => ({ state: 'ready' }), narration: () => ({ audio: { id: 'recording', state: 'ready', duration: 100, markers: [{ time: 0, title: 'One' }] } }),
    audioFile: () => join(dir, 'audio.mp3'), recordings: {
      async accept(_book, file) { imported.push(await readFile(file.path, 'utf8')); return { id: 'imported' }; },
      list: () => [{ id: 'imported', state }], queue() { state = 'ready'; },
    } };
  const request = async (value, opts) => {
    const url = new URL(value); calls.push({ path: url.pathname, options: opts });
    assert.equal(url.origin, 'http://192.168.1.20:13378'); assert.equal(opts.headers.Authorization, 'Bearer synthetic-test-token'); assert.equal(opts.redirect, 'error');
    if (url.pathname === '/abs/api/libraries') return Response.json({ libraries: [{ id: 'lib', mediaType: 'book', folders: [{ id: 'folder', path: '/books' }] }] });
    if (url.pathname === '/abs/api/items/remote-item') return Response.json(item);
    if (url.pathname === '/abs/api/me/progress/remote-item') {
      if (opts.method === 'PATCH') { progress = { ...JSON.parse(opts.body), lastUpdate: (progress?.lastUpdate || 1000) + 1 }; return new Response('OK'); }
      return progress ? Response.json(progress) : new Response('Not found', { status: 404 });
    }
    if (url.pathname === '/abs/api/upload') { assert.equal(opts.body.get('title'), book.title); assert.equal(await opts.body.get('audio').text(), 'AUDIO'); assert.equal(await opts.body.get('ebook').text(), 'EPUB'); assert.equal(JSON.parse(await opts.body.get('metadata').text()).chapters[0].title, 'One'); return new Response('OK'); }
    if (url.pathname === '/abs/s/item/remote-item/part.mp3') return new Response('DOWNLOADED AUDIO');
    assert.fail('Unexpected ABS path: ' + url.pathname);
  };
  const service = await openAudiobookshelf(dir, { library, learning, autoStart: false, request, ...options }); t.after(() => service.close());
  return { dir, service, book, calls, imported, item, setProgress(value) { progress = value; },
    connect: () => service.save({ baseUrl: 'http://192.168.1.20:13378/abs', apiKey: 'synthetic-test-token', libraryId: 'lib', folderId: 'folder' }) };
}
test('Audiobookshelf uses the configured remote host/subpath, stores credentials privately and exports book/audio metadata', async (t) => {
  const f = await fixture(t); await f.connect();
  assert.equal(f.service.settings().hasKey, true); assert.equal(JSON.stringify(f.service.settings()).includes('synthetic-test-token'), false);
  assert.equal((await stat(join(f.dir, 'audiobookshelf-settings.json'))).mode & 0o777, 0o600);
  const job = f.service.queue(f.book, 'export', { recording: 'recording' }); assert.equal(job.state, 'queued'); await f.service.pump();
  assert.equal(f.service.status(f.book).jobs[0].state, 'exported');
  assert.ok(f.calls.some((call) => call.path === '/abs/api/upload'));
  assert.equal(JSON.stringify(f.service.status(f.book)).includes('synthetic-test-token'), false);
});
test('ABS imports audio in track order, automatically aligns it and links only the exact recording for progress', async (t) => {
  const f = await fixture(t); await f.connect();
  f.service.queue(f.book, 'import', { item: 'remote-item' }); await f.service.pump(); assert.deepEqual(f.imported, ['DOWNLOADED AUDIO']);
  assert.equal(f.service.status(f.book).jobs[0].state, 'syncing'); await f.service.pump(); await f.service.pump(); assert.equal(f.service.status(f.book).jobs[0].state, 'ready');
  await assert.rejects(f.service.attach(f.book, { recording: 'recording', item: 'remote-item' }), { status: 422 });
  f.item.media.duration = 200; await assert.rejects(f.service.attach(f.book, { recording: 'recording', item: 'remote-item', sameRecording: true }), { status: 422 });
  f.item.media.duration = 100; await f.service.attach(f.book, { recording: 'recording', item: 'remote-item', sameRecording: true });
  const initial = await f.service.remote(f.book, 'recording'); assert.equal(initial.version, 'none');
  const saved = await f.service.push(f.book, { recording: 'recording', currentTime: 20, baseVersion: initial.version }); assert.equal(saved.currentTime, 20);
  f.setProgress({ currentTime: 60, duration: 100, lastUpdate: 2000 });
  const conflict = await f.service.push(f.book, { recording: 'recording', currentTime: 25, baseVersion: saved.version }); assert.equal(conflict.conflict, true); assert.equal(conflict.currentTime, 60);
  const confirmed = await f.service.push(f.book, { recording: 'recording', currentTime: 25, baseVersion: conflict.version }); assert.equal(confirmed.currentTime, 25);
});
test('ABS downloads never forward credentials to a different origin and demo connections are unavailable', async (t) => {
  const f = await fixture(t); await f.connect(); f.item.media.tracks[0].contentUrl = 'https://different.example/audio.mp3';
  f.service.queue(f.book, 'import', { item: 'remote-item' }); await f.service.pump();
  assert.equal(f.service.status(f.book).jobs[0].state, 'error'); assert.match(f.service.status(f.book).jobs[0].error, /outside the configured server/u);
  const demo = await openAudiobookshelf(f.dir, { library: {}, learning: {}, demo: true, autoStart: false }); t.after(() => demo.close());
  await assert.rejects(demo.libraries(), { status: 403 });
});
