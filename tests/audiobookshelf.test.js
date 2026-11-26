import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestError } from '../server/books.js';
import { openAudiobookshelf } from '../server/audiobookshelf.js';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-abs-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'book.epub'), 'EPUB'); await writeFile(join(dir, 'audio.mp3'), 'AUDIO');
  const book = { id: 'book', title: 'A Book', author: 'An Author', language: 'es', format: 'epub', categoryId: 'spanish' }, calls = [], imported = [];
  const remoteLibraries = [{ id: 'lib', mediaType: 'book', folders: [{ id: 'folder', path: '/books' }, { id: 'spanish-folder', path: '/books/es' }] },
    { id: 'other-lib', mediaType: 'book', folders: [{ id: 'other-folder', path: '/books/zh' }] }];
  let progress = null, state = 'uploaded', clock = 1000000, catalogFails = false, uploadFails = false, catalogLag = false, catalogHook;
  const ready = [], localBooks = new Map([[book.id, book]]), remoteBooks = new Map(), removed = [], uploads = [];
  const recordings = new Map([['recording', { id: 'recording', state: 'ready', duration: 100, markers: [{ time: 0, title: 'One' }] }]]);
  const item = { id: 'remote-item', libraryId: 'lib', folderId: 'spanish-folder', mediaType: 'book', media: { duration: 100, metadata: { title: 'A Book' }, tracks: [{ index: 1, title: 'part.mp3', contentUrl: '/abs/s/item/remote-item/part.mp3', duration: 100 }] } };
  const library = { uploads: dir, getBook: (id) => { if (!localBooks.has(id)) throw new RequestError(404, 'Book not found'); return localBooks.get(id); }, filePath: () => join(dir, 'book.epub') };
  const learning = { ensure() {}, info: () => ({ state: 'ready' }), narration: (_book, selected = 'recording') => ({ audio: recordings.get(selected) || { state: 'missing' } }),
    readyAudiobooks: () => ready.filter((candidate) => recordings.get(candidate.recording)?.state === 'ready'),
    audioFile: () => join(dir, 'audio.mp3'), async removeRecording(_book, id) { removed.push(id); recordings.delete(id); }, recordings: {
      async accept(_book, file) { imported.push(await readFile(file.path, 'utf8')); recordings.set('imported', { id: 'imported', duration: 100, state: 'ready' }); return { id: 'imported' }; },
      list: () => imported.length ? [{ id: 'imported', state }] : [], queue() { state = 'ready'; },
    } };
  const request = async (value, opts) => {
    const url = new URL(value); calls.push({ path: url.pathname, search: url.searchParams, options: opts });
    assert.equal(url.origin, 'http://192.168.1.20:13378'); assert.equal(opts.headers.Authorization, 'Bearer synthetic-test-token'); assert.equal(opts.redirect, 'error');
    if (catalogFails && opts.method !== 'POST') throw new Error('Offline');
    if (url.pathname === '/abs/api/libraries') return Response.json({ libraries: remoteLibraries });
    const catalog = /^\/abs\/api\/libraries\/([^/]+)\/items$/u.exec(url.pathname);
    if (catalog) { const hook = catalogHook; catalogHook = null; hook?.(); const all = remoteBooks.get(catalog[1]) || [], page = Number(url.searchParams.get('page')), limit = Number(url.searchParams.get('limit')); return Response.json({ total: all.length, results: all.slice(page * limit, (page + 1) * limit) }); }
    if (url.pathname === '/abs/api/items/remote-item') return Response.json(item);
    const expanded = /^\/abs\/api\/items\/([^/]+)$/u.exec(url.pathname);
    if (expanded) return Response.json([...remoteBooks.values()].flat().find((entry) => entry.id === expanded[1]) || {});
    if (url.pathname.startsWith('/abs/api/me/progress/')) {
      if (opts.method === 'PATCH') { progress = { ...JSON.parse(opts.body), lastUpdate: (progress?.lastUpdate || 1000) + 1 }; return new Response('OK'); }
      return progress ? Response.json(progress) : new Response('Not found', { status: 404 });
    }
    if (url.pathname === '/abs/api/upload') {
      const data = opts.body, metadata = JSON.parse(await data.get('metadata').text());
      assert.ok([...localBooks.values()].some((entry) => entry.title === metadata.title));
      assert.match(data.get('title'), /^Langy-[\w-]+ - /u);
      assert.equal(await data.get('audio').text(), 'AUDIO'); assert.equal(await data.get('ebook').text(), 'EPUB'); assert.equal(metadata.chapters[0].title, 'One');
      if (uploadFails) throw new Error('Upload connection lost');
      const entry = { id: `uploaded-${uploads.length}`, libraryId: data.get('library'), folderId: data.get('folder'), mediaType: 'book',
        libraryFiles: [{ metadata: { filename: data.get('audio').name } }], media: { metadata, duration: 100 } };
      uploads.push(entry);
      if (!catalogLag) remoteBooks.set(entry.libraryId, [...remoteBooks.get(entry.libraryId) || [], entry]);
      return new Response('OK');
    }
    if (url.pathname === '/abs/s/item/remote-item/part.mp3') return new Response('DOWNLOADED AUDIO');
    assert.fail('Unexpected ABS path: ' + url.pathname);
  };
  let service = await openAudiobookshelf(dir, { library, learning, autoStart: false, request, now: () => clock, ...options }); t.after(() => service.close());
  return { dir, get service() { return service; }, book, calls, imported, removed, uploads, item, remoteLibraries, remoteBooks, ready, recordings,
    clock(value) { clock = value; }, alignment(value) { state = value; }, duringCatalog(callback) { catalogHook = callback; }, failCatalog(value) { catalogFails = value; }, failUpload(value) { uploadFails = value; }, lagCatalog(value) { catalogLag = value; },
    addReady(id = 'recording', target = book) { localBooks.set(target.id, target); if (!recordings.has(id)) recordings.set(id, { ...recordings.get('recording'), id }); ready.push({ book: target.id, recording: id }); },
    setProgress(value) { progress = value; },
    async restart() { service.close(); service = await openAudiobookshelf(dir, { library, learning, autoStart: false, request, now: () => clock, ...options }); },
    connectMapped: (updates = {}) => service.save({ baseUrl: 'http://192.168.1.20:13378/abs', apiKey: 'synthetic-test-token', libraryId: 'lib', folderId: 'folder', categoryDestinations: { spanish: { libraryId: 'lib', folderId: 'spanish-folder' } }, ...updates }),
    connect: (updates = {}) => service.save({ baseUrl: 'http://192.168.1.20:13378/abs', apiKey: 'synthetic-test-token', libraryId: 'lib', folderId: 'folder', ...updates }) };
}
test('Audiobookshelf uses the configured remote host/subpath, stores credentials privately and exports book/audio metadata', async (t) => {
  const f = await fixture(t); await f.connectMapped();
  assert.equal(f.service.settings().hasKey, true); assert.equal(JSON.stringify(f.service.settings()).includes('synthetic-test-token'), false);
  assert.equal((await stat(join(f.dir, 'audiobookshelf-settings.json'))).mode & 0o777, 0o600);
  const job = f.service.queue(f.book, 'export', { recording: 'recording' }); assert.equal(job.state, 'queued'); await f.service.pump();
  assert.equal(f.service.status(f.book).jobs[0].state, 'exported');
  assert.ok(f.calls.some((call) => call.path === '/abs/api/upload'));
  assert.equal(JSON.stringify(f.service.status(f.book)).includes('synthetic-test-token'), false);
});
test('ABS imports audio in track order, automatically aligns it and links only the exact recording for progress', async (t) => {
  const f = await fixture(t); await f.connect();
  const queued = f.service.queue(f.book, 'import', { item: 'remote-item' }); await f.service.decide(f.book, queued.id, true); await f.service.pump(); assert.deepEqual(f.imported, ['DOWNLOADED AUDIO']);
  assert.equal(f.service.status(f.book).jobs[0].state, 'syncing'); await f.service.pump(); await f.service.pump(); assert.equal(f.service.status(f.book).jobs[0].state, 'ready');
  assert.deepEqual(f.removed, ['recording']); f.recordings.set('recording', { id: 'recording', state: 'ready', duration: 100 });
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
  const queued = f.service.queue(f.book, 'import', { item: 'remote-item' }); await f.service.decide(f.book, queued.id, true); await f.service.pump();
  assert.equal(f.service.status(f.book).jobs[0].state, 'error'); assert.match(f.service.status(f.book).jobs[0].error, /outside the configured server/u);
  const demo = await openAudiobookshelf(f.dir, { library: {}, learning: {}, demo: true, autoStart: false }); t.after(() => demo.close());
  await assert.rejects(demo.libraries(), { status: 403 });
});

test('mapped exports use the book folder and unmapped manual exports cannot use the global default', async (t) => {
  const f = await fixture(t);
  await f.connect({ categoryDestinations: { spanish: { libraryId: 'lib', folderId: 'spanish-folder' }, chinese: { libraryId: 'other-lib', folderId: 'other-folder' } } });
  for (const categoryId of ['spanish', 'chinese']) {
    f.book.categoryId = categoryId; f.book.title = categoryId;
    f.service.queue(f.book, 'export', { recording: 'recording' }); await f.service.pump();
  }
  assert.deepEqual(f.uploads.map((item) => [item.libraryId, item.folderId]), [['lib', 'spanish-folder'], ['other-lib', 'other-folder']]);
  for (const categoryId of ['portuguese', null]) {
    f.book.categoryId = categoryId;
    assert.throws(() => f.service.queue(f.book, 'export', { recording: 'recording' }), { status: 422 });
  }
  assert.equal(f.uploads.length, 2);
});

test('queued manual exports recheck the current book folder and mapping after restart', async (t) => {
  const f = await fixture(t); await f.connectMapped();
  const queued = f.service.queue(f.book, 'export', { recording: 'recording' });
  assert.equal(queued.destination.folderId, 'spanish-folder');
  f.book.categoryId = 'chinese';
  await f.connect({ categoryDestinations: { chinese: { libraryId: 'other-lib', folderId: 'other-folder' } } });
  await f.restart(); await f.service.pump();
  assert.equal(f.uploads[0].folderId, 'other-folder');
  f.book.categoryId = 'unmapped'; f.book.title = 'An unmapped book';
  f.service.queue(f.book, 'export', { recording: 'recording', destination: { libraryId: 'lib', folderId: 'folder' } });
  f.book.categoryId = 'another-unmapped'; await f.restart(); await f.service.pump();
  assert.equal(f.uploads.length, 1, 'a queued choice cannot follow a book into a different unmapped folder');
});

test('category mappings validate folder membership, support uncategorized books, and survive legacy saves', async (t) => {
  const f = await fixture(t), categoryDestinations = { uncategorized: { libraryId: 'other-lib', folderId: 'other-folder' } };
  await f.connect({ categoryDestinations });
  await f.connect(); assert.deepEqual(f.service.settings().categoryDestinations, categoryDestinations);
  for (const invalid of [[], { spanish: null }, { spanish: { libraryId: 'lib', folderId: 'other-folder' } }, { spanish: { libraryId: '../bad', folderId: 'folder' } }]) {
    await assert.rejects(f.connect({ categoryDestinations: invalid }), { status: 422 });
    assert.deepEqual(f.service.settings().categoryDestinations, categoryDestinations);
  }
  f.book.categoryId = null; f.service.queue(f.book, 'export', { recording: 'recording' }); await f.service.pump();
  assert.equal(f.calls.filter((call) => call.path === '/abs/api/upload').at(-1).options.body.get('folder'), 'other-folder');
  await f.connect({ libraryId: '', folderId: '', categoryDestinations: { spanish: { libraryId: 'lib', folderId: 'spanish-folder' } } });
  assert.throws(() => f.service.queue(f.book, 'export', { recording: 'recording' }), { status: 422 });
  f.book.categoryId = 'spanish'; assert.equal(f.service.queue(f.book, 'export', { recording: 'recording' }).destination.folderId, 'spanish-folder');
});

test('ready generated and uploaded audiobooks export automatically to category folders once and survive restart', async (t) => {
  const f = await fixture(t);
  f.addReady(); f.addReady('uploaded', { ...f.book, id: 'second', title: '第二本书', categoryId: 'chinese' });
  await f.connect({ categoryDestinations: { spanish: { libraryId: 'lib', folderId: 'spanish-folder' }, chinese: { libraryId: 'other-lib', folderId: 'other-folder' } } });
  assert.equal(f.service.settings().autoExport, true);
  await f.service.pump();
  const uploads = () => f.calls.filter((call) => call.path === '/abs/api/upload');
  assert.deepEqual(await Promise.all(uploads().map(async (call) => [JSON.parse(await call.options.body.get('metadata').text()).title, call.options.body.get('folder')])) , [['A Book', 'spanish-folder'], ['第二本书', 'other-folder']]);
  await f.service.pump(); await f.restart(); await f.service.pump(); assert.equal(uploads().length, 2);
  assert.equal(f.service.status(f.book).jobs[0].automatic, true);
});

test('matching titles on later pages propose import without linking or deleting a different recording', async (t) => {
  const f = await fixture(t); f.book.title = 'A Book: A Story'; f.addReady(); await f.connectMapped();
  const entries = Array.from({ length: 500 }, (_, index) => ({ id: `other-${index}`, media: { metadata: { title: `Another title ${index}` } } }));
  entries.push({ id: 'different-edition', media: { metadata: { title: '  A BOOK — A STORY  ', authorName: 'A different author' } } });
  entries.at(-1).folderId = 'spanish-folder'; f.remoteBooks.set('lib', entries);
  await f.service.pump();
  const job = f.service.status(f.book).jobs[0]; assert.equal(job.state, 'skipped'); assert.equal(job.item, 'different-edition');
  assert.equal(f.calls.some((call) => call.path === '/abs/api/upload'), false);
  assert.ok(f.calls.some((call) => call.path === '/abs/api/libraries/lib/items' && call.search.get('page') === '1'));
  assert.equal((await f.service.remote(f.book, 'recording')).linked, false);
  await f.restart(); await f.service.pump(); assert.equal(f.service.status(f.book).jobs.length, 1);
});

test('successful upload receipts prevent duplicates from another book or regenerated recording while ABS is still indexing', async (t) => {
  const f = await fixture(t); f.lagCatalog(true); f.addReady(); f.addReady('replacement', { ...f.book, id: 'duplicate' });
  await f.connectMapped(); await Promise.all([f.service.pump(), f.service.pump()]);
  assert.equal(f.calls.filter((call) => call.path === '/abs/api/upload').length, 1);
  await f.restart(); f.addReady('regenerated'); await f.service.pump();
  assert.equal(f.calls.filter((call) => call.path === '/abs/api/upload').length, 1);
  assert.equal(f.service.status(f.book).jobs[0].state, 'linking');
});

test('offline duplicate checks retry after a persisted delay without uploading or losing the selected category folder', async (t) => {
  const f = await fixture(t); f.addReady(); await f.connect({ categoryDestinations: { spanish: { libraryId: 'lib', folderId: 'spanish-folder' } } });
  f.failCatalog(true); await f.service.pump();
  const waiting = f.service.status(f.book).jobs[0]; assert.equal(waiting.state, 'queued'); assert.equal(waiting.retryAt, 1015000);
  assert.equal(f.calls.some((call) => call.path === '/abs/api/upload'), false);
  await f.restart(); f.failCatalog(false);
  await f.service.pump(); assert.equal(f.service.status(f.book).jobs[0].state, 'queued');
  f.clock(1015000); await f.service.pump();
  assert.equal(f.service.status(f.book).jobs[0].state, 'exported');
  assert.equal(f.calls.find((call) => call.path === '/abs/api/upload').options.body.get('folder'), 'spanish-folder');
});

test('automatic export can be disabled, preserves legacy saves, and waits for valid folders and ready audio', async (t) => {
  const f = await fixture(t); f.addReady();
  await f.connect({ autoExport: false }); await f.connect(); assert.equal(f.service.settings().autoExport, false);
  await f.service.pump(); assert.equal(f.service.status(f.book).jobs.length, 0);
  await f.connect({ autoExport: true, libraryId: '', folderId: '' }); await f.service.pump(); assert.equal(f.service.status(f.book).jobs.length, 0);
  f.recordings.get('recording').state = 'syncing'; await f.connectMapped(); await f.service.pump(); assert.equal(f.service.status(f.book).jobs.length, 0);
  f.recordings.get('recording').state = 'ready'; await f.service.pump(); assert.equal(f.service.status(f.book).jobs[0].state, 'exported');
  await assert.rejects(f.connect({ autoExport: 'true' }), { status: 422 });
});

test('linked Audiobookshelf imports never loop back into exports and a manual export also checks matching titles', async (t) => {
  const f = await fixture(t); await f.connectMapped();
  await f.service.attach(f.book, { recording: 'recording', item: 'remote-item', sameRecording: true }); f.addReady();
  await f.service.pump(); assert.equal(f.service.status(f.book).jobs.length, 0);
  f.remoteBooks.set('lib', [f.item]); f.service.queue(f.book, 'export', { recording: 'recording' }); await f.service.pump();
  assert.equal(f.service.status(f.book).jobs[0].state, 'exported'); assert.equal(f.calls.some((call) => call.path === '/abs/api/upload'), false);
});

test('ambiguous upload failures are held for review across restart and cannot cause automatic duplicate uploads', async (t) => {
  const f = await fixture(t); f.addReady(); await f.connectMapped(); f.failUpload(true);
  await f.service.pump(); assert.equal(f.service.status(f.book).jobs[0].state, 'needs_review');
  f.failUpload(false); await f.restart(); await f.service.pump();
  assert.equal(f.calls.filter((call) => call.path === '/abs/api/upload').length, 1);
  f.addReady('replacement', { ...f.book, id: 'same-title' }); await f.service.pump();
  assert.equal(f.calls.filter((call) => call.path === '/abs/api/upload').length, 1);
});

test('a manual export honors a different library/folder and invalid destinations never fall back to the default', async (t) => {
  const f = await fixture(t); await f.connect();
  f.service.queue(f.book, 'export', { recording: 'recording', destination: { libraryId: 'other-lib', folderId: 'other-folder' } }); await f.service.pump();
  const sent = f.calls.find((call) => call.path === '/abs/api/upload').options.body;
  assert.equal(sent.get('library'), 'other-lib'); assert.equal(sent.get('folder'), 'other-folder');
  f.book.title = 'Invalid destination';
  f.service.queue(f.book, 'export', { recording: 'recording', destination: { libraryId: 'other-lib', folderId: 'folder' } }); await f.service.pump();
  assert.equal(f.service.status(f.book).jobs.at(-1).state, 'error');
  assert.equal(f.calls.filter((call) => call.path === '/abs/api/upload').length, 1);
  assert.throws(() => f.service.queue(f.book, 'export', { recording: 'recording', destination: {} }), { status: 422 });
});

test('manual exports cannot override a mapped book folder with a stale default destination', async (t) => {
  const f = await fixture(t); f.addReady(); await f.connectMapped(); f.failCatalog(true); await f.service.pump();
  assert.throws(() => f.service.queue(f.book, 'export', { recording: 'recording', destination: { libraryId: 'lib', folderId: 'folder' } }), { status: 422 });
  f.failCatalog(false); f.clock(1015000); await f.service.pump();
  assert.equal(f.uploads[0].folderId, 'spanish-folder');
});

test('disabling automatic export cancels pending work and re-enabling discovers it again', async (t) => {
  const f = await fixture(t); f.addReady(); await f.connectMapped(); f.failCatalog(true); await f.service.pump(); f.failCatalog(false);
  await f.connect({ autoExport: false }); assert.equal(f.service.status(f.book).jobs[0].state, 'cancelled');
  await f.service.pump(); assert.equal(f.calls.some((call) => call.path === '/abs/api/upload'), false);
  await f.connect({ autoExport: true }); await f.service.pump();
  assert.equal(f.calls.filter((call) => call.path === '/abs/api/upload').length, 1);
});

test('the background worker exports ready audio after connecting without an open book or manual pump', async (t) => {
  const f = await fixture(t, { autoStart: true }); f.addReady(); await f.connectMapped();
  for (let n = 0; n < 100 && f.service.status(f.book).jobs.at(-1)?.state !== 'exported'; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.calls.filter((call) => call.path === '/abs/api/upload').length, 1);
});

test('saving a new category destination replaces waiting automatic exports that used the old category folder', async (t) => {
  const f = await fixture(t); f.addReady(); await f.connectMapped(); f.failCatalog(true); await f.service.pump(); f.failCatalog(false);
  await f.connect({ categoryDestinations: { spanish: { libraryId: 'other-lib', folderId: 'other-folder' } } });
  assert.equal(f.service.status(f.book).jobs[0].state, 'cancelled'); await f.service.pump();
  const sent = f.calls.find((call) => call.path === '/abs/api/upload').options.body;
  assert.equal(sent.get('library'), 'other-lib'); assert.equal(sent.get('folder'), 'other-folder');
});

test('an unavailable mapped folder blocks export and correcting its mapping retries in the intended library', async (t) => {
  const f = await fixture(t); f.addReady(); await f.connect({ categoryDestinations: { spanish: { libraryId: 'lib', folderId: 'spanish-folder' } } });
  f.remoteLibraries[0].folders = f.remoteLibraries[0].folders.filter((folder) => folder.id !== 'spanish-folder');
  await f.service.pump(); assert.equal(f.service.status(f.book).jobs[0].state, 'error');
  assert.equal(f.calls.some((call) => call.path === '/abs/api/upload'), false);
  await f.connect({ categoryDestinations: { spanish: { libraryId: 'other-lib', folderId: 'other-folder' } } }); await f.service.pump();
  const body = f.calls.find((call) => call.path === '/abs/api/upload').options.body;
  assert.equal(body.get('library'), 'other-lib'); assert.equal(body.get('folder'), 'other-folder');
});

test('unmapped automatic exports wait instead of using an unrelated default folder', async (t) => {
  const f = await fixture(t); f.addReady(); await f.connect(); await f.service.pump();
  assert.equal(f.calls.some((call) => call.path === '/abs/api/upload'), false);
  assert.match(f.service.status(f.book).automaticExportNotice, /map this book’s category/);
  f.book.categoryId = null; await f.service.pump(); assert.equal(f.service.status(f.book).jobs.length, 0);
  await f.connect({ categoryDestinations: { uncategorized: { libraryId: 'other-lib', folderId: 'other-folder' } } });
  await f.service.pump(); assert.equal(f.calls.find((call) => call.path === '/abs/api/upload').options.body.get('library'), 'other-lib');
});

test('a queued automatic export rechecks the current category after editing and restarting', async (t) => {
  const f = await fixture(t); f.addReady(); await f.connectMapped({ categoryDestinations: { spanish: { libraryId: 'lib', folderId: 'spanish-folder' }, chinese: { libraryId: 'other-lib', folderId: 'other-folder' } } });
  f.failCatalog(true); await f.service.pump();
  f.book.categoryId = 'chinese'; f.book.language = 'zh'; await f.restart(); f.failCatalog(false);
  await f.service.pump();
  const body = f.calls.find((call) => call.path === '/abs/api/upload').options.body;
  assert.equal(body.get('library'), 'other-lib'); assert.equal(body.get('folder'), 'other-folder');
});

test('category changes during duplicate checking cancel the old upload and never fall back when unmapped', async (t) => {
  const f = await fixture(t); f.addReady(); await f.connectMapped();
  f.duringCatalog(() => { f.book.categoryId = 'unmapped'; }); await f.service.pump();
  assert.equal(f.calls.some((call) => call.path === '/abs/api/upload'), false);
  assert.equal(f.service.status(f.book).jobs[0].state, 'cancelled');
  await f.restart(); await f.service.pump(); assert.equal(f.calls.some((call) => call.path === '/abs/api/upload'), false);
  await f.connect({ categoryDestinations: { unmapped: { libraryId: 'other-lib', folderId: 'other-folder' } } });
  await f.service.pump(); assert.equal(f.calls.find((call) => call.path === '/abs/api/upload').options.body.get('folder'), 'other-folder');
});

test('automatic exports never send another user’s private book to the owner’s Audiobookshelf account', async (t) => {
  const f = await fixture(t); f.book.owner = 'another-reader'; await f.connect(); f.ready.push({ book: f.book.id, recording: 'recording' });
  await f.service.pump(); assert.equal(f.service.status(f.book).jobs.length, 0); assert.equal(f.calls.some((call) => call.url?.includes('/upload')), false);
});

test('matching ABS audio requires a persistent Process decision and deletes only the approved local recording after successful sync', async (t) => {
  const f = await fixture(t); f.remoteBooks.set('lib', [f.item]); f.addReady(); f.recordings.set('another', { id: 'another', state: 'ready', duration: 100 }); await f.connectMapped();
  await f.service.pump(); const proposal = f.service.status(f.book).jobs[0];
  assert.equal(proposal.state, 'awaiting_confirmation'); assert.deepEqual(proposal.replaces, ['recording']);
  assert.equal(f.imported.length, 0); assert.equal(f.removed.length, 0);
  await f.restart(); await f.service.pump(); assert.equal(f.service.status(f.book).jobs[0].state, 'awaiting_confirmation');
  await f.service.decide(f.book, proposal.id, true); await f.service.pump(); assert.equal(f.imported.length, 1); assert.equal(f.removed.length, 0);
  await f.service.pump(); assert.equal(f.removed.length, 0, 'alignment must finish before deletion');
  await f.service.pump(); assert.deepEqual(f.removed, ['recording']); assert.ok(f.recordings.has('another'));
  assert.equal((await f.service.remote(f.book, 'imported')).item, 'remote-item');
  assert.equal(f.calls.some((call) => call.options.method === 'DELETE' || call.path === '/abs/api/upload'), false, 'replacement never mutates ABS files');
  await f.restart(); await f.service.pump(); assert.deepEqual(f.removed, ['recording']);
});

test('declining a replacement or failing alignment retains local audio without exporting over ABS', async (t) => {
  const f = await fixture(t); await f.connectMapped(); f.remoteBooks.set('lib', [f.item]); f.addReady(); await f.service.pump();
  const first = f.service.status(f.book).jobs[0]; await f.service.decide(f.book, first.id, false); await f.service.pump(); await f.restart(); await f.service.pump();
  assert.equal(f.service.status(f.book).jobs.length, 1); assert.equal(f.imported.length, 0); assert.ok(f.recordings.has('recording'));
  const retry = f.service.queue(f.book, 'import', { item: 'remote-item', recording: 'recording' }); await f.service.decide(f.book, retry.id, true); await f.service.pump();
  f.alignment('error'); await f.service.pump(); assert.equal(f.service.status(f.book).jobs.at(-1).state, 'error'); assert.deepEqual(f.removed, []);
  assert.equal(f.calls.some((call) => call.options.method === 'DELETE' || call.path === '/abs/api/upload'), false);
});

test('delayed indexing links only the exact uploaded file, survives restart and never reuploads or overwrites an existing directory', async (t) => {
  const f = await fixture(t); await f.connectMapped(); f.lagCatalog(true);
  const job = f.service.queue(f.book, 'export', { recording: 'recording' }); await f.service.pump();
  assert.equal(f.service.status(f.book).jobs[0].state, 'linking');
  const sameTitle = { id: 'different-audio', libraryId: 'lib', folderId: 'spanish-folder', mediaType: 'book', media: { duration: 100, metadata: { title: f.book.title } }, libraryFiles: [{ filename: 'other.mp3' }] };
  f.remoteBooks.set('lib', [sameTitle]); await f.restart(); f.clock(1010000); await f.service.pump(); assert.equal((await f.service.remote(f.book, 'recording')).linked, false);
  f.remoteBooks.set('lib', [sameTitle, f.uploads[0]]); f.clock(1020000); await f.service.pump();
  assert.equal((await f.service.remote(f.book, 'recording')).item, f.uploads[0].id);
  const sends = f.calls.filter((call) => call.path === '/abs/api/upload'); assert.equal(sends.length, 1);
  assert.ok(sends[0].options.body.get('title').startsWith(`Langy-${job.id} - `));
  assert.equal(sends[0].options.body.get('audio').name, `langy-${job.id}.mp3`);
});

test('folder editor changes one ABS mapping atomically, preserving the token, defaults and other folders', async (t) => {
  const f = await fixture(t); await f.connectMapped();
  await f.service.linkCategory('chinese', { libraryId: 'other-lib', folderId: 'other-folder' });
  assert.equal(f.service.settings().categoryDestinations.spanish.folderId, 'spanish-folder');
  await assert.rejects(f.service.linkCategory('chinese', { libraryId: 'other-lib', folderId: 'folder' }), { status: 422 });
  assert.equal(f.service.settings().categoryDestinations.chinese.folderId, 'other-folder');
  await f.service.linkCategory('spanish', null); assert.equal(f.service.settings().categoryDestinations.spanish, undefined);
  assert.equal(f.service.settings().libraryId, 'lib'); assert.equal(f.service.settings().hasKey, true); await f.restart();
  assert.equal(f.service.settings().categoryDestinations.chinese.folderId, 'other-folder');
});


test('linking an existing folder copies previously exported audio into its new destination once without changing ABS files', async (t) => {
  const f = await fixture(t); f.addReady(); await f.connectMapped(); await f.service.pump();
  assert.equal(f.uploads.length, 1); const first = structuredClone(f.uploads[0]);
  await f.service.linkCategory('spanish', { libraryId: 'other-lib', folderId: 'other-folder' });
  await f.service.pump();
  assert.equal(f.uploads.length, 2); assert.equal(f.uploads[1].folderId, 'other-folder');
  assert.deepEqual(f.uploads[0], first);
  assert.equal((await f.service.remote(f.book, 'recording')).item, f.uploads[1].id);
  await f.restart(); await f.service.pump(); assert.equal(f.uploads.length, 2);
  assert.equal(f.calls.some((call) => ['DELETE', 'PATCH', 'PUT'].includes(call.options.method)), false);
});

test('a matching title in an unrelated English folder does not redirect the export or trigger an import', async (t) => {
  const f = await fixture(t); f.addReady(); await f.connectMapped();
  f.item.folderId = 'folder'; f.remoteBooks.set('lib', [f.item]); await f.service.pump();
  assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].folderId, 'spanish-folder');
  assert.equal(f.imported.length, 0); assert.equal(f.removed.length, 0);
});

test('the process X cancels queued and active duplicate checks without deleting audio or requeuing automatically',async(t)=>{
  const f=await fixture(t);f.addReady();await f.connectMapped();
  const first=f.service.queue(f.book,'export',{recording:'recording'},true);f.service.cancel(f.book,first.id);await f.service.pump();
  assert.equal(f.uploads.length,0);assert.equal(f.service.status(f.book).jobs.length,1);
  const second=f.service.queue(f.book,'export',{recording:'recording'});f.duringCatalog(()=>f.service.cancel(f.book,second.id));await f.service.pump();
  assert.equal(f.uploads.length,0);assert.equal(f.service.status(f.book).jobs.at(-1).state,'cancelled');assert.deepEqual(f.removed,[]);
  await f.restart();await f.service.pump();assert.equal(f.uploads.length,0);
});

test('moving a book cancels an old folder’s replacement proposal before it can redirect the next export',async(t)=>{
  const f=await fixture(t);f.addReady();await f.connectMapped({categoryDestinations:{spanish:{libraryId:'lib',folderId:'spanish-folder'},chinese:{libraryId:'other-lib',folderId:'other-folder'}}});
  f.remoteBooks.set('lib',[f.item]);await f.service.pump();assert.equal(f.service.status(f.book).jobs.at(-1).state,'awaiting_confirmation');
  f.book.categoryId='chinese';await f.service.pump();assert.equal(f.service.status(f.book).jobs[0].state,'cancelled');assert.equal(f.uploads[0].folderId,'other-folder');assert.deepEqual(f.removed,[]);assert.equal(f.imported.length,0);
});

test('matching title and author automatically link reading and different-duration audio without file transfers', async (t) => {
  const f = await fixture(t); await f.connect({ autoExport: false });
  f.item.media.metadata = { title: '  A BOOK! ', authors: [{ id: 'author', name: 'AN AUTHOR' }] }; f.item.media.duration = 200;
  f.remoteBooks.set('lib', [f.item]); f.setProgress({ currentTime: 80, duration: 200, lastUpdate: 1000 });
  const initial = await f.service.remote(f.book, 'reading');
  assert.equal(initial.linked, true); assert.equal(initial.automatic, true); assert.equal(initial.mode, 'reading');
  assert.equal(initial.currentTime, .4); assert.equal(initial.duration, 1); assert.equal(initial.remoteDuration, 200);
  const saved = await f.service.push(f.book, { recording: 'reading', currentTime: .5, baseVersion: initial.version });
  assert.equal(saved.currentTime, .5);
  const patch = f.calls.find((call) => call.options.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.options.body), { currentTime: 100, duration: 200, progress: .5, isFinished: false });
  const recording = await f.service.remote(f.book, 'recording');
  assert.equal(recording.currentTime, 50); assert.equal(recording.mode, 'percentage'); assert.equal(recording.approximate, true);
  assert.equal(f.uploads.length, 0); assert.equal(f.imported.length, 0); assert.equal(f.removed.length, 0);
  await f.restart(); assert.equal((await f.service.remote(f.book, 'reading')).item, initial.item);
  assert.equal(f.calls.some((call) => call.options.method === 'DELETE'), false);
});

test('automatic progress links require an author and leave duplicate matches unlinked until folder mapping resolves them', async (t) => {
  const f = await fixture(t); await f.connect({ autoExport: false });
  f.item.media.metadata.authorName = f.book.author;
  const copy = { ...structuredClone(f.item), id: 'other-copy', libraryId: 'other-lib', folderId: 'other-folder' };
  f.remoteBooks.set('lib', [f.item]); f.remoteBooks.set('other-lib', [copy]);
  const ambiguous = await f.service.remote(f.book, 'reading'); assert.equal(ambiguous.linked, false); assert.match(ambiguous.notice, /Multiple/u);
  await f.service.linkCategory('spanish', { libraryId: 'other-lib', folderId: 'other-folder' });
  assert.equal((await f.service.remote(f.book, 'reading')).item, 'other-copy');
  f.book.author = 'Another author'; assert.equal((await f.service.remote(f.book, 'reading')).linked, false, 'metadata edits cannot reuse an old link');
  f.book.author = ''; const missing = await f.service.remote(f.book, 'reading'); assert.equal(missing.linked, false); assert.match(missing.notice, /title and author/u);
  f.book.author = 'An Author'; f.book.title = 'A Book abridged'; assert.equal((await f.service.remote(f.book, 'reading')).linked, false);
});

test('automatic matching checks all catalog pages, shares catalog reads and rejects incomplete results', async (t) => {
  const f = await fixture(t); await f.connect({ autoExport: false }); f.item.media.metadata.authorName = f.book.author;
  f.remoteBooks.set('lib', [...Array.from({ length: 500 }, (_, i) => ({ id: `unrelated-${i}`, media: { metadata: { title: `Other ${i}` } } })), f.item]);
  f.calls.length = 0;
  const [first, second] = await Promise.all([f.service.remote(f.book, 'reading'), f.service.remote(f.book, 'recording')]);
  assert.equal(first.item, f.item.id); assert.equal(second.item, f.item.id);
  assert.equal(f.calls.filter((call) => call.path === '/abs/api/libraries').length, 1);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/items') && call.search.get('page') === '1').length, 1);
  f.book.title = 'Different book'; f.failCatalog(true); f.clock(1100000);
  await assert.rejects(f.service.remote(f.book, 'reading'), { status: 502 });
  assert.equal(f.calls.some((call) => call.options.method === 'PATCH' || call.path === '/abs/api/upload'), false);
});

test('automatic linking can be disabled independently of exports and never links a member’s private books', async (t) => {
  const f = await fixture(t); await f.connect({ autoExport: false, autoLink: false }); f.item.media.metadata.authorName = f.book.author; f.remoteBooks.set('lib', [f.item]);
  assert.equal((await f.service.remote(f.book, 'reading')).linked, false);
  await f.connect(); assert.equal(f.service.settings().autoLink, false);
  await f.connect({ autoLink: true }); assert.equal((await f.service.remote(f.book, 'reading')).linked, true);
  await f.connect({ autoLink: false }); assert.equal((await f.service.remote(f.book, 'reading')).linked, false);
  await f.service.attach(f.book, { item: f.item.id, recording: 'recording', sameRecording: true });
  assert.equal((await f.service.remote(f.book, 'recording')).mode, 'recording', 'explicit recording links remain precise when auto matching is off');
  f.book.owner = 'private-member'; f.calls.length = 0; assert.equal((await f.service.remote(f.book, 'reading')).linked, false); assert.equal(f.calls.length, 0);
  await assert.rejects(f.connect({ autoLink: 'true' }), { status: 422 });
});

test('ebook-only metadata matches sync fractional progress and retain remote conflicts', async (t) => {
  const f = await fixture(t); await f.connect({ autoExport: false }); f.recordings.clear();
  f.item.media.metadata.authorName = f.book.author; f.item.media.duration = 0; f.item.media.tracks = []; f.item.media.ebookFile = { ebookFormat: 'epub' };
  f.remoteBooks.set('lib', [f.item]); f.setProgress({ ebookProgress: .25, ebookLocation: 'epubcfi(old-location)', lastUpdate: 10 });
  const initial = await f.service.remote(f.book, 'reading'); assert.equal(initial.currentTime, .25);
  f.setProgress({ ebookProgress: .75, ebookLocation: 'epubcfi(new-location)', lastUpdate: 20 });
  const conflict = await f.service.push(f.book, { recording: 'reading', currentTime: .3, baseVersion: initial.version });
  assert.equal(conflict.conflict, true); assert.equal(conflict.currentTime, .75); assert.equal(f.calls.some((call) => call.options.method === 'PATCH'), false);
  const saved = await f.service.push(f.book, { recording: 'reading', currentTime: .3, baseVersion: conflict.version });
  assert.equal(saved.currentTime, .3);
  assert.deepEqual(JSON.parse(f.calls.find((call) => call.options.method === 'PATCH').options.body), { ebookProgress: .3, isFinished: false });
  await assert.rejects(f.service.push(f.book, { recording: 'reading', currentTime: 1.1, baseVersion: saved.version }), { status: 422 });
});

test('checking an interrupted upload links the exact existing file without uploading again', async (t) => {
  const f = await fixture(t); await f.connectMapped(); f.failUpload(true);
  const job = f.service.queue(f.book, 'export', { recording: 'recording' }); await f.service.pump();
  assert.equal(f.service.status(f.book).jobs[0].state, 'needs_review');
  const sent = f.calls.find((call) => call.path === '/abs/api/upload').options.body;
  f.remoteBooks.set('lib', [{ id: 'interrupted-item', libraryId: 'lib', folderId: 'spanish-folder', mediaType: 'book',
    media: { duration: 100, metadata: { title: f.book.title }, audioFiles: [{ metadata: { filename: sent.get('audio').name } }] } }]);
  f.failUpload(false); f.service.checkUpload(f.book, job.id); await f.service.pump();
  assert.equal(f.service.status(f.book).jobs[0].state, 'exported');
  assert.equal((await f.service.remote(f.book, 'recording')).item, 'interrupted-item');
  assert.equal(f.calls.filter((call) => call.path === '/abs/api/upload').length, 1);
  assert.equal(f.calls.some((call) => ['DELETE', 'PATCH', 'PUT'].includes(call.options.method)), false);
});
