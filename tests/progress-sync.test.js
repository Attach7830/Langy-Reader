import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';
import { koReaderDocumentID } from '../server/progress-sync.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const md5 = (value) => createHash('md5').update(value).digest('hex');
const basic = 'Basic ' + Buffer.from('reader:test-reader-password').toString('base64');
const json = { Authorization: basic, 'Content-Type': 'application/json' };
const xpath = '/body/DocFragment[1]/body/p[2]/text()[1].7';
const cfi = 'epubcfi(/6/2!/4/2/1:7)';
const deviceHeaders = (user = 'reader', password = 'test-reader-password') => ({
  'x-auth-user': user, 'x-auth-key': md5(password), Accept: 'application/vnd.koreader.v1+json',
  'Content-Type': 'application/json',
});

async function fixture(t, { demo = false, password = 'test-reader-password', syncUser = '', syncPassword = '', languageURL = 'http://127.0.0.1:1' } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'langy-progress-'));
  const library = await openLibrary(folder);
  const bytes = await sampleBook();
  let child;
  const stop = async () => { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } };
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  const path = join(library.uploads, 'sync-book');
  await writeFile(path, bytes);
  await library.importBook('sync-book', { originalname: 'Novela.epub', path, size: bytes.length }, { language: 'es' });
  async function start() {
    await stop();
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    let output = '';
    child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env,
      PORT: String(port), READER_DATA: folder, READER_DEMO: demo ? '1' : '0',
      READER_USER: 'reader', READER_PASSWORD: password, READER_SYNC_USER: syncUser, READER_SYNC_PASSWORD: syncPassword,
      READER_LANGUAGE_URL: languageURL, READER_KOKORO_URL: '',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (value) => { output = (output + value).slice(-12000); });
    child.stderr.on('data', (value) => { output = (output + value).slice(-12000); });
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + '/healthz', { signal: AbortSignal.timeout(500) })).ok) return base; } catch { /* Await startup. */ }
      await delay(20);
    }
    throw new Error(`Reader startup timed out: ${output}`);
  }
  return { folder, library, bytes, start };
}
async function response(base, path, { status = 200, ...options } = {}) {
  const result = await fetch(base + path, options);
  const text = await result.text();
  assert.equal(result.status, status, `${path}: ${text}`);
  if (status === 204) return;
  assert.match(result.headers.get('cache-control') || '', /no-store/u);
  return JSON.parse(text);
}

test('account reader settings require login, enforce same-origin writes, and persist independently of device progress', async (t) => {
  const f = await fixture(t); let base = await f.start();
  assert.equal((await fetch(base + '/api/settings/reader')).status, 401);
  assert.equal((await fetch(base + '/api/settings/ai-cache', { method: 'DELETE' })).status, 401);
  const initial = await response(base, '/api/settings/reader', { headers: json });
  assert.equal(initial.revision, 0);
  const change = { revision: 0, changes: { showPinyin: true, theme: 'midnight', cacheAI: false, keys: { pinyin: 'j' } } };
  await response(base, '/api/settings/reader', { method: 'PATCH', headers: { ...json, Origin: 'https://unrelated.test' }, body: JSON.stringify(change), status: 403 });
  const saved = await response(base, '/api/settings/reader', { method: 'PATCH', headers: json, body: JSON.stringify(change) });
  assert.equal(saved.revision, 1); assert.equal(saved.preferences.showPinyin, true);
  assert.equal(saved.preferences.cacheAI, false);
  await response(base, '/api/settings/ai-cache', { method: 'DELETE', headers: { ...json, Origin: 'https://unrelated.test' }, status: 403 });
  assert.deepEqual(await response(base, '/api/settings/ai-cache', { method: 'DELETE', headers: json }), { cleared: true });
  const conflict = await response(base, '/api/settings/reader', { method: 'PATCH', headers: json, body: JSON.stringify(change), status: 409 });
  assert.equal(conflict.accountId, saved.accountId); assert.equal(conflict.revision, 1);
  await response(base, '/api/settings/reader', { method: 'PATCH', headers: json, body: '{"revision":1,"changes":{"apiKey":"never-store"}}', status: 422 });
  base = await f.start(); const restored = await response(base, '/api/settings/reader', { headers: json });
  assert.deepEqual(restored, saved); assert.equal(JSON.stringify(restored).includes('test-reader-password'), false);
});

test('demo reader settings are isolated by the signed visitor cookie', async (t) => {
  const f = await fixture(t, { demo: true, password: '' }), base = await f.start();
  const result = await fetch(base + '/api/settings/reader'), first = await result.json();
  const cookie = result.headers.get('set-cookie').split(';')[0];
  await response(base, '/api/settings/reader', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ revision: first.revision, changes: { theme: 'dark' } }) });
  const sameVisitor = await response(base, '/api/settings/reader', { headers: { Cookie: cookie } });
  const other = await response(base, '/api/settings/reader');
  assert.equal(sameVisitor.preferences.theme, 'dark'); assert.deepEqual(other.preferences, {}); assert.notEqual(other.accountId, first.accountId);
});

test('cover selection works through authenticated metadata updates and six-field multipart book uploads', async (t) => {
  const f = await fixture(t), base = await f.start();
  const edited = await response(base, '/api/books/sync-book', { method: 'PATCH', headers: json,
    body: JSON.stringify({ title: 'Saved book', author: '', language: 'es', coverStyle: 'midnight' }) });
  assert.equal(edited.coverStyle, 'midnight');
  const data = new FormData();
  for (const [name, value] of Object.entries({ title: '', author: '', language: '', languages: '[]', categoryId: '', coverStyle: 'forest' })) data.set(name, value);
  data.set('file', new Blob([f.bytes], { type: 'application/epub+zip' }), 'upload.epub');
  const imported = await response(base, '/api/books', { status: 201, method: 'POST', headers: { Authorization: basic }, body: data });
  assert.equal(imported.coverStyle, 'forest');
  for (const path of ['/api/imports/anna/id/continue', '/api/imports/anna/id/file']) assert.equal((await fetch(base + path, { method: 'POST' })).status, 401);
});

test('bookmarks require login and persist EPUB positions and notes through the API', async (t) => {
  const f = await fixture(t), base = await f.start();
  assert.equal((await fetch(base + '/api/books/sync-book/bookmarks')).status, 401);
  const saved = await response(base, '/api/books/sync-book/bookmarks', { method: 'POST', headers: json,
    body: JSON.stringify({ target: cfi, label: 'Useful passage', note: 'My note' }) });
  assert.equal(saved.bookmarks[0].target, cfi);
  const restored = await response(base, '/api/books/sync-book/bookmarks', { headers: json }); assert.equal(restored.bookmarks[0].note, 'My note');
  await response(base, '/api/books/sync-book/bookmarks/' + saved.bookmarks[0].id, { method: 'DELETE', headers: json });
  assert.equal((await response(base, '/api/books/sync-book/bookmarks', { headers: json })).bookmarks.length, 0);
  for (const path of ['/api/imports/anna/batch', '/api/books/sync-book/ocr']) assert.equal((await fetch(base + path, { method: 'POST' })).status, 401);
});

test('star, set-aside and reading-time endpoints require login, protect writes, persist and expose library state', async (t) => {
  const f = await fixture(t); let base = await f.start();
  for (const path of ['/api/reading-time', '/api/books/sync-book/currently-reading', '/api/books/sync-book/set-aside', '/api/books/sync-book/offline', '/api/settings/audiobookshelf']) assert.equal((await fetch(base + path)).status, 401);
  await response(base, '/api/books/sync-book/currently-reading', { method: 'PATCH', headers: { ...json, Origin: 'https://elsewhere.test' }, body: '{"currentlyReading":true}', status: 403 });
  const star = await response(base, '/api/books/sync-book/currently-reading', { method: 'PATCH', headers: json, body: '{"currentlyReading":true}' }); assert.ok(star.starredAt);
  const aside = await response(base, '/api/books/sync-book/set-aside', { method: 'PATCH', headers: json, body: '{"setAside":true}' }); assert.ok(aside.setAsideAt); assert.equal(aside.starredAt, null);
  const initial = await response(base, '/api/reading-time', { headers: json }), end = Date.now();
  const body = { accountId: initial.accountId, events: [{ id: 'reading-time-api', start: end - 5000, end }] };
  await response(base, '/api/books/sync-book/reading-time', { method: 'POST', headers: json, body: JSON.stringify({ ...body, accountId: 'wrong' }), status: 409 });
  const saved = await response(base, '/api/books/sync-book/reading-time', { method: 'POST', headers: json, body: JSON.stringify(body) }); assert.equal(saved.recordedMs, 5000);
  base = await f.start(); const snapshot = await response(base, '/api/library', { headers: json });
  assert.equal(snapshot.readingTime.totalMs, 5000); assert.equal(snapshot.books.find((book) => book.id === 'sync-book').setAsideAt, aside.setAsideAt);
  const link = await fetch(base + '/api/archive/search?title=Libro&author=Autora', { headers: json, redirect: 'manual' });
  assert.equal(link.status, 302); const url = new URL(link.headers.get('location')); assert.equal(url.pathname, '/search'); assert.equal(url.searchParams.get('q'), 'Libro Autora');
});

test('document IDs use KOReader/CrossPoint byte samples, including byte zero and a truncated final chunk', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-checksum-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'book.epub');
  await writeFile(path, '');
  assert.equal(await koReaderDocumentID(path), 'd41d8cd98f00b204e9800998ecf8427e');
  await writeFile(path, 'Hola 🙂');
  assert.equal(await koReaderDocumentID(path), md5('Hola 🙂'));
  const offsets = [0, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];
  const file = await open(path, 'w');
  const expected = [];
  try {
    await file.truncate(67108864 + 333);
    for (const [index, offset] of offsets.entries()) {
      const bytes = Buffer.alloc(index === offsets.length - 1 ? 333 : 1024);
      for (let n = 0; n < bytes.length; n++) bytes[n] = (index * 19 + n * 7) % 256;
      await file.write(bytes, 0, bytes.length, offset);
      expected.push(bytes);
    }
  } finally { await file.close(); }
  assert.equal(await koReaderDocumentID(path), md5(Buffer.concat(expected)));
});

test('native KOSync and browser sync share original-book progress with authentication, CAS conflicts, rereading, and persistence', async (t) => {
  const f = await fixture(t);
  let base = await f.start();
  const native = deviceHeaders();
  assert.equal((await fetch(base + '/kosync/healthcheck')).status, 200);
  assert.deepEqual(await response(base, '/kosync/users/auth', { headers: native }), { authorized: 'OK' });
  for (const path of ['/kosync/users/auth', '/kosync/syncs/progress/' + 'a'.repeat(32)]) {
    assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(base + path, { headers: deviceHeaders('reader', 'wrong') })).status, 401);
  }
  // Native credentials do not bypass the web/OPDS login.
  for (const path of ['/api/library', '/api/settings/ai', '/api/books/sync-book/file', '/opds']) {
    assert.equal((await fetch(base + path, { headers: native })).status, 401);
  }
  assert.equal((await fetch(base + '/kosync/users/create', { method: 'POST', headers: native, body: '{}' })).status, 403);
  const settings = await response(base, '/api/settings/sync', { headers: json });
  assert.deepEqual(settings, { available: true, deviceAvailable: true, path: '/kosync', username: 'reader', protocol: 'KOReader Sync' });
  assert.ok(!JSON.stringify(settings).includes('test-reader-password'));
  assert.ok(!JSON.stringify(settings).includes(md5('test-reader-password')));
  assert.deepEqual(await response(base, '/kosync/syncs/progress/' + 'b'.repeat(32), { headers: native }), {});
  // OPDS download registers the ID without needing a prior web-reader visit.
  const download = await fetch(base + '/opds/books/sync-book/file.epub', { headers: json });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), f.bytes);
  const document = await koReaderDocumentID(f.library.filePath(f.library.getBook('sync-book')));
  const device = { document, progress: xpath, percentage: .4, device: 'Xteink', device_id: 'crosspoint-test' };
  const putNative = (body) => response(base, '/kosync/syncs/progress', { method: 'PUT', headers: native, body: JSON.stringify(body) });
  const accepted = await putNative(device);
  assert.equal(accepted.document, document);
  assert.ok(Number.isSafeInteger(accepted.timestamp));
  const snapshot = await response(base, '/api/library', { headers: json });
  assert.equal(snapshot.progress['sync-book'].percentage, .4);
  let saved = await response(base, '/api/books/sync-book/progress', { headers: json });
  assert.equal(saved.progress.progress, xpath);
  assert.equal(saved.progress.langyTarget, undefined);
  const local = { progress: xpath, percentage: .6, target: cfi, device: 'Laptop', device_id: 'browser-test' };
  const conflict = await response(base, '/api/books/sync-book/progress', { status: 409, method: 'PUT', headers: json,
    body: JSON.stringify({ ...local, baseVersion: 0 }) });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.progress.percentage, .4);
  saved = await response(base, '/api/books/sync-book/progress', { method: 'PUT', headers: json,
    body: JSON.stringify({ ...local, baseVersion: saved.version }) });
  assert.equal(saved.progress.langyTarget, cfi);
  assert.equal((await response(base, '/kosync/syncs/progress/' + document + '?position_kinds=locator,percentage', { headers: native })).percentage, .6);
  await putNative({ ...device, percentage: .1, progress: '/body/DocFragment[1]/body/p[1]/text().0' });
  saved = await response(base, '/api/books/sync-book/progress', { headers: json });
  assert.equal(saved.progress.percentage, .1); // Intentional rereading goes backward.
  assert.equal(saved.progress.langyTarget, undefined); // A device update invalidates the old CFI.
  const beforeRestart = saved;
  base = await f.start();
  saved = await response(base, '/api/books/sync-book/progress', { headers: json });
  assert.deepEqual(saved, beforeRestart);
  // Removing a library entry removes its snapshot alias, not another device's saved record.
  await response(base, '/api/books/sync-book', { status: 204, method: 'DELETE', headers: json });
  assert.equal((await response(base, '/api/library', { headers: json })).progress['sync-book'], undefined);
  assert.equal((await response(base, '/kosync/syncs/progress/' + document, { headers: native })).percentage, .1);
});

test('sync rejects malformed fields and only the configured separate device credentials can authenticate', async (t) => {
  const f = await fixture(t, { syncUser: 'xteink', syncPassword: 'separate-test-password' });
  const base = await f.start();
  const headers = deviceHeaders('xteink', 'separate-test-password');
  assert.equal((await fetch(base + '/kosync/users/auth', { headers: deviceHeaders() })).status, 401);
  await response(base, '/kosync/users/auth', { headers });
  const good = { document: 'a'.repeat(32), progress: xpath, percentage: .4, device: 'Xteink' };
  for (const invalid of [{ ...good, document: '../bad' }, { ...good, percentage: '0.4' }, { ...good, percentage: -1 },
    { ...good, percentage: 1.01 }, { ...good, progress: '' }, { ...good, progress: 'a'.repeat(4097) },
    { ...good, progress: 'a\nsecret' }, { ...good, device: '' }, []]) {
    await response(base, '/kosync/syncs/progress', { status: 400, method: 'PUT', headers, body: JSON.stringify(invalid) });
  }
  await response(base, '/kosync/syncs/progress/invalid', { status: 400, headers });
  await response(base, '/kosync/syncs/progress', { status: 400, method: 'PUT', headers, body: '{invalid' });
  await response(base, '/api/books/sync-book/progress', { status: 400, method: 'PUT', headers: json,
    body: JSON.stringify({ ...good, target: cfi }) });
  await response(base, '/api/books/sync-book/progress', { status: 400, method: 'PUT', headers: json,
    body: JSON.stringify({ ...good, target: '/etc/passwd', baseVersion: 0 }) });
  // A rich CrossPoint position is preserved, while arbitrary metadata is discarded.
  const position = { spine: 2, page: 3, pages: 10, pctQ: 400000, xpath, para: 4, unsafe: 'discard' };
  await response(base, '/kosync/syncs/progress', { method: 'PUT', headers,
    body: JSON.stringify({ ...good, position, metadata: { title: 'Private title' } }) });
  const saved = await response(base, '/kosync/syncs/progress/' + good.document, { headers });
  assert.deepEqual(saved.position, { spine: 2, page: 3, pages: 10, pctQ: 400000, xpath, para: 4 });
  assert.equal(saved.metadata, undefined);
});

test('passwordless installations support browser sync but do not expose a native device account', async (t) => {
  const f = await fixture(t, { password: '' });
  const base = await f.start();
  const settings = await response(base, '/api/settings/sync');
  assert.equal(settings.available, true);
  assert.equal(settings.deviceAvailable, false);
  await response(base, '/kosync/users/auth', { status: 503, headers: deviceHeaders() });
  const local = { progress: xpath, percentage: .2, target: cfi, device: 'Browser', baseVersion: 0 };
  assert.equal((await response(base, '/api/books/sync-book/progress', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(local) })).progress.percentage, .2);
});

test('chapter, rescan and iVoox endpoints require the web login and preserve original chapter downloads', async (t) => {
  const f = await fixture(t), base = await f.start();
  for (const endpoint of ['word', 'readings', 'pinyin']) {
    assert.equal((await fetch(base + '/api/mandarin/' + endpoint, { method: 'POST' })).status, 401);
  }
  await response(base, '/api/mandarin/word', { status: 422, method: 'POST', headers: json, body: JSON.stringify({ text: 'hello', offset: 0 }) });
  const pinyin = await response(base, '/api/mandarin/pinyin', { method: 'POST', headers: json, body: JSON.stringify({ text: '银行中文' }) });
  assert.equal(pinyin.characters.map((item) => item.pinyin).join(' ').toLowerCase(), 'yín háng zhōng wén');
  const root = '/api/books/sync-book';
  for (const [method, path] of [['POST', '/recordings/chapters'], ['POST', '/ivoox'], ['GET', '/ivoox'],
    ['DELETE', '/ivoox'], ['POST', '/audio/fake/rescan'], ['DELETE', '/audio/fake/rescan'], ['GET', '/recordings/fake/chapters/0/file']]) {
    assert.equal((await fetch(base + root + path, { method })).status, 401);
  }
  await response(base, root + '/ivoox', { status: 422, method: 'POST', headers: json, body: JSON.stringify({ links: 'https://127.0.0.1/private' }) });
  assert.equal((await response(base, root + '/ivoox', { headers: json })).job, null);
  await response(base, root + '/audio/fake/rescan', { status: 409, method: 'POST', headers: json, body: '{}' });
  const wav = Buffer.alloc(44 + 4800);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const form = () => {
    const body = new FormData(); body.append('name', 'Two chapters');
    for (const name of ['02-first.wav', '01-second.wav']) body.append('files', new Blob([wav], { type: 'audio/wav' }), name);
    return body;
  };
  assert.equal((await fetch(base + root + '/recordings/chapters', { method: 'POST', headers: { Authorization: basic, Origin: 'https://other.example' }, body: form() })).status, 403);
  const item = await response(base, root + '/recordings/chapters', { status: 202, method: 'POST', headers: { Authorization: basic }, body: form() });
  assert.deepEqual(item.sourceChapters.map((chapter) => chapter.name), ['02-first.wav', '01-second.wav']);
  const download = await fetch(base + item.sourceChapters[0].url, { headers: { Authorization: basic } });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), wav);
  const tooMany = new FormData();
  for (let index = 0; index < 201; index++) tooMany.append('files', new Blob(['small']), `${index}.mp3`);
  await response(base, root + '/recordings/chapters', { status: 400, method: 'POST', headers: { Authorization: basic }, body: tooMany });
  assert.deepEqual(await readdir(f.library.uploads), []);
  assert.equal((await response(base, root + '/recordings', { headers: json })).recordings.length, 1);
});

test('book language choices persist through the authenticated API and vocabulary endpoints require the reader login', async (t) => {
  const f = await fixture(t);
  let base = await f.start();
  for (const path of ['/api/vocabulary', '/api/vocabulary/settings', '/api/books/sync-book/recommendations', '/api/books/sync-book/vocabulary/sections/epub%3A0', '/api/books/sync-book/vocabulary/below-threshold']) assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await fetch(base + '/api/books/sync-book/vocabulary/meaning', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  await response(base, '/api/books/sync-book/vocabulary/below-threshold', { headers: json, status: 409 });
  await response(base, '/api/books/not-visible/vocabulary/below-threshold', { headers: json, status: 404 });
  await response(base, '/api/books/sync-book/vocabulary/meaning', { method: 'POST', headers: json, body: '{"mode":"invalid"}', status: 422 });
  assert.equal((await fetch(base + '/api/vocabulary/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"threshold":3}' })).status, 401);
  assert.equal((await fetch(base + '/api/books/sync-book/reading-estimate', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/api/books/sync-book/vocabulary/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const body = { title: 'Mixed languages', author: '', language: 'zh', languages: ['zh-Hant', 'en'], categoryId: '' };
  const edited = await response(base, '/api/books/sync-book', { method: 'PATCH', headers: json, body: JSON.stringify(body) });
  assert.deepEqual(edited.languages, ['zh-Hant', 'en']);
  assert.equal(edited.owner, undefined);
  await response(base, '/api/books/sync-book', { method: 'PATCH', status: 422, headers: json, body: JSON.stringify({ ...body, languages: ['not a valid code'] }) });
  const catalogue = await response(base, '/api/vocabulary', { headers: json }); assert.deepEqual(catalogue.entries, []);
  assert.equal(catalogue.threshold, 20);
  assert.deepEqual(await response(base, '/api/vocabulary/settings', { method: 'PUT', headers: json, body: '{"threshold":3}' }), { threshold: 3 });
  await response(base, '/api/vocabulary/settings', { method: 'PUT', headers: json, body: '{"threshold":0}', status: 422 });
  await response(base, '/api/books/sync-book/vocabulary/seen', { method: 'POST', status: 422, headers: json, body: '{}' });
  assert.deepEqual((await response(base, '/api/books/sync-book/recommendations', { headers: json })).books, []);
  base = await f.start();
  assert.deepEqual(await response(base, '/api/vocabulary/settings', { headers: json }), { threshold: 3 });
  assert.deepEqual((await response(base, '/api/library', { headers: json })).books.find((book) => book.id === 'sync-book').languages, ['zh-Hant', 'en']);
  assert.equal((await fetch(base + '/api/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Private","language":"pt"}' })).status, 401);
  const folder = await response(base, '/api/categories', { method: 'POST', status: 201, headers: json, body: '{"name":"Bilingual folder","language":"en"}' });
  const moved = await response(base, '/api/books/sync-book', { method: 'PATCH', headers: json, body: JSON.stringify({ ...body, categoryId: folder.id }) });
  assert.equal(moved.language, 'en'); assert.deepEqual(moved.languages, ['en', 'zh-Hant']);
  await response(base, '/api/categories/' + folder.id, { method: 'PATCH', headers: json, body: '{"name":"Portuguese folder","language":"pt"}' });
  const assigned = (await response(base, '/api/library', { headers: json })).books.find((book) => book.id === 'sync-book');
  assert.equal(assigned.language, 'pt'); assert.deepEqual(assigned.languages, ['pt', 'en', 'zh-Hant']);
  assert.notEqual(assigned.learning.state, 'ready', 'changed folder metadata queues language analysis');
});

test('read status requires login, preserves the bookmark and waits for analysis before contributing vocabulary', async (t) => {
  const f = await fixture(t);
  let base = await f.start();
  const path = '/api/books/sync-book/read-status';
  assert.equal((await fetch(base + path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"read":true}' })).status, 401);
  const progress = await response(base, '/api/books/sync-book/progress', { headers: json });
  const vocabulary = await response(base, '/api/vocabulary', { headers: json });
  const marked = await response(base, path, { method: 'PATCH', headers: json, body: '{"read":true}' });
  assert.ok(marked.readAt > 0);
  await response(base, path, { method: 'PATCH', headers: json, body: '{"read":"true"}', status: 422 });
  await response(base, '/api/books/not-visible/read-status', { method: 'PATCH', headers: json, body: '{"read":true}', status: 404 });
  assert.deepEqual(await response(base, '/api/books/sync-book/progress', { headers: json }), progress);
  assert.deepEqual(await response(base, '/api/vocabulary', { headers: json }), { ...vocabulary, reading: { ...vocabulary.reading, pendingBooks: 1 } });
  base = await f.start();
  assert.equal((await response(base, '/api/library', { headers: json })).books.find((book) => book.id === 'sync-book').readAt, marked.readAt);
  assert.equal((await response(base, path, { method: 'PATCH', headers: json, body: '{"read":false}' })).readAt, null);
  assert.equal(f.library.getBook('sync-book').readAt, null);
  assert.equal((await response(base, '/api/vocabulary', { headers: json })).reading.pendingBooks, 0);
});

test('authenticated book word counts and reading totals persist across saved views, completion changes and server restarts', async (t) => {
  const f = await fixture(t); let base = await f.start();
  const db = new DatabaseSync(join(f.folder, 'learning.sqlite')); t.after(() => db.close());
  const text = 'Ana lee libros 2026 中文', digest = createHash('sha256').update(text).digest('hex');
  const words = ['Ana', 'lee', 'libros', '中', '文'];
  const tokens = words.map((word) => ({ word, lemma: word === 'lee' ? 'leer' : word === 'libros' ? 'libro' : word,
    language: ['中', '文'].includes(word) ? 'zh' : 'es', properName: word === 'Ana', from: text.indexOf(word), to: text.indexOf(word) + word.length }));
  const lemmas = JSON.stringify(['es:leer', 'es:libro']);
  const metrics = JSON.stringify({ characters: { inventory: '中文', total: 2, unique: 2 }, byLanguage: [
    { language: 'es', unit: 'lemmas', count: 2, total: 3 }, { language: 'zh', unit: 'characters', count: 2, total: 2 },
  ] });
  db.prepare(`INSERT INTO analyses(book,owner,language,state,lemmas,wordCount,method,metrics,languageSelection)
    VALUES(?,?,?,'ready',?,3,'contextual',?,'["es"]')`).run('sync-book', '', 'es', lemmas, metrics);
  db.prepare('UPDATE analyses SET textVersion=1 WHERE book=?').run('sync-book');
  db.prepare(`INSERT INTO chapters(book,key,ordinal,title,text,digest,tokens,lemmas,markers,languages)
    VALUES(?,?,0,?,?,?,?,?,'[]',?)`).run('sync-book', 'epub:0', 'Test chapter', text, digest, JSON.stringify(tokens), lemmas,
      JSON.stringify([{ from: 0, to: text.indexOf('中'), language: 'es' }, { from: text.indexOf('中'), to: text.length, language: 'zh' }]));
  const snapshot = () => response(base, '/api/library', { headers: json });
  assert.deepEqual((await snapshot()).books.find((book) => book.id === 'sync-book').learning.counts, { words: 4, characters: 2 });
  async function seen(from, to) {
    await response(base, '/api/books/sync-book/vocabulary/seen', { method: 'POST', headers: json,
      body: JSON.stringify({ key: 'epub:0', digest, session: 'one', ranges: [{ from, to }] }) });
  }
  await seen(0, 3); await seen(0, 3);
  assert.equal((await snapshot()).vocabulary.reading.words, 1, 'viewed proper names count once even when omitted from the lemma catalogue');
  await response(base, '/api/books/sync-book/read-status', { method: 'PATCH', headers: json, body: '{"read":true}' });
  let reading = (await snapshot()).vocabulary.reading;
  assert.equal(reading.words, 4); assert.equal(reading.characters, 2); assert.equal(reading.completedWords, 3);
  await seen(text.indexOf('2026'), text.indexOf('2026') + 4);
  reading = (await snapshot()).vocabulary.reading; assert.equal(reading.words, 4); assert.equal(reading.trackedWords, 2);
  await response(base, '/api/books/sync-book/read-status', { method: 'PATCH', headers: json, body: '{"read":false}' });
  assert.equal((await snapshot()).vocabulary.reading.words, 2);
  base = await f.start(); assert.equal((await snapshot()).vocabulary.reading.words, 2);
});

test('book discovery uses the existing login and validates preferences before making AI or search requests', async (t) => {
  const f = await fixture(t), base = await f.start();
  assert.equal((await fetch(base + '/api/discovery')).status, 401);
  const status = await response(base, '/api/discovery', { headers: json });
  assert.equal(status.state, 'idle'); assert.equal(status.result, null); assert.ok(status.libraryCount > 0);
  const invalid = await response(base, '/api/discovery', { method: 'POST', headers: json, body: JSON.stringify({ language: 'not a language' }), status: 422 });
  assert.match(invalid.error, /valid book language/);
  assert.equal((await response(base, '/api/discovery', { headers: json })).state, 'idle');
  assert.equal((await response(base, '/api/discovery', { method: 'DELETE', headers: json })).state, 'idle');
});

test('demo mode never exposes shared progress, external audio imports, chapter uploads or rescans', async (t) => {
  const f = await fixture(t, { demo: true, password: '' });
  const base = await f.start();
  const settings = await response(base, '/api/settings/sync');
  assert.deepEqual(settings, { available: false, deviceAvailable: false });
  for (const path of ['/kosync/healthcheck', '/kosync/users/auth', '/kosync/syncs/progress/' + 'a'.repeat(32), '/api/books/sync-book/progress']) {
    assert.equal((await fetch(base + path, { headers: deviceHeaders() })).status, 404);
  }
  assert.equal((await response(base, '/api/library')).progress, null);
  for (const [method, path] of [['POST', '/recordings/chapters'], ['POST', '/ivoox'], ['GET', '/ivoox'],
    ['DELETE', '/ivoox'], ['POST', '/audio/fake/rescan'], ['DELETE', '/audio/fake/rescan'], ['GET', '/recordings/fake/chapters/0/file']]) {
    assert.equal((await fetch(base + '/api/books/sync-book' + path, { method })).status, 404);
  }
});

test('demo vocabulary thresholds remain private to each signed visitor', async (t) => {
  const f = await fixture(t, { demo: true, password: '' }), base = await f.start();
  const first = await fetch(base + '/api/vocabulary/settings'), second = await fetch(base + '/api/vocabulary/settings');
  const a = first.headers.get('set-cookie').split(';')[0], b = second.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await first.json(), { threshold: 20 }); assert.deepEqual(await second.json(), { threshold: 20 });
  await response(base, '/api/vocabulary/settings', { method: 'PUT', headers: { Cookie: a, 'Content-Type': 'application/json' }, body: '{"threshold":7}' });
  assert.deepEqual(await response(base, '/api/vocabulary/settings', { headers: { Cookie: a } }), { threshold: 7 });
  assert.deepEqual(await response(base, '/api/vocabulary/settings', { headers: { Cookie: b } }), { threshold: 20 });
  assert.equal((await response(base, '/api/vocabulary', { headers: { Cookie: a } })).threshold, 7);
  assert.equal((await response(base, '/api/vocabulary', { headers: { Cookie: b } })).threshold, 20);
  assert.equal((await response(base, '/api/library', { headers: { Cookie: a } })).vocabulary.threshold, 7);
});

test('saved credential removal is authenticated, same-origin and preserves each service configuration', async (t) => {
  const f = await fixture(t); let base = await f.start();
  for (const [service, body, kept] of [
    ['ai', { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', apiKey: 'private-test-value' }, 'model'],
    ['learning', { baseUrl: 'http://127.0.0.1:8880/v1', apiKey: 'private-test-value', voice: 'af_heart', model: 'kokoro', speed: 1 }, 'voice'],
    ['archive', { apiKey: 'private-test-value', baseUrl: 'https://annas-archive.gl' }, 'baseUrl'],
    ['audiobookshelf', { apiKey: 'private-test-value', baseUrl: 'http://127.0.0.1:13378', autoExport: false, libraryId: 'lib', folderId: 'folder', categoryDestinations: { uncategorized: { libraryId: 'lib', folderId: 'folder' } } }, 'categoryDestinations'],
  ]) {
    assert.equal((await fetch(base + `/api/settings/${service}/key`, { method: 'DELETE' })).status, 401);
    if (service === 'audiobookshelf') {
      await writeFile(join(f.folder, 'audiobookshelf-settings.json'), JSON.stringify(body)); base = await f.start();
    }
    const configured = await response(base, `/api/settings/${service}`, service === 'audiobookshelf' ? { headers: json } : { method: 'PUT', headers: json, body: JSON.stringify(body) });
    assert.equal(configured.hasKey, true, service);
    await response(base, `/api/settings/${service}/key`, { method: 'DELETE', headers: { ...json, Origin: 'https://other.test' }, status: 403 });
    const removed = await response(base, `/api/settings/${service}/key`, { method: 'DELETE', headers: json });
    assert.equal(removed.hasKey, false, service); assert.deepEqual(removed[kept], configured[kept], service);
    assert.equal(JSON.stringify(removed).includes('private-test-value'), false);
  }
  base = await f.start();
  for (const service of ['ai', 'learning', 'archive', 'audiobookshelf']) assert.equal((await response(base, `/api/settings/${service}`, { headers: json })).hasKey, false);
});

test('process overview and book pinyin require login and keep book data persistent', async (t) => {
  const f = await fixture(t); let base = await f.start();
  assert.equal((await fetch(base + '/api/processes')).status, 401);
  const processes = await response(base, '/api/processes', { headers: json });
  assert.equal(processes.unavailable, false, 'every projected job schema must exist'); assert.ok(Array.isArray(processes.jobs)); assert.ok(processes.accountId);
  assert.equal((await fetch(base + '/api/books/sync-book/pinyin', { method: 'POST', body: JSON.stringify({ text: '有意思' }), headers: { 'Content-Type': 'application/json' } })).status, 401);
  await response(base, '/api/books/missing/pinyin', { method: 'POST', headers: json, body: JSON.stringify({ text: '有意思' }), status: 404 });
  const data = await response(base, '/api/books/sync-book/pinyin', { method: 'POST', headers: json, body: JSON.stringify({ text: '有意思' }) });
  assert.equal(data.characters.map((item) => item.character).join(''), '有意思');
  const db = new DatabaseSync(join(f.folder, 'book-pinyin.sqlite')); assert.equal(db.prepare('SELECT count(*) AS n FROM passages').get().n, 1); db.close();
  base = await f.start();
  assert.deepEqual(await response(base, '/api/books/sync-book/pinyin', { method: 'POST', headers: json, body: JSON.stringify({ text: '有意思' }) }), data);
});

test('library audio-synced status follows completed alignment, persists on restart and excludes stale book text', async (t) => {
  const f = await fixture(t); let base = await f.start();
  let snapshot;
  for (let attempt = 0; attempt < 100; attempt++) {
    snapshot = await response(base, '/api/library', { headers: json });
    if (snapshot.books.find((book) => book.id === 'sync-book').learning.counts) break;
    await delay(20);
  }
  assert.equal(snapshot.books.find((book) => book.id === 'sync-book').audioSynced, false);
  const db = new DatabaseSync(join(f.folder, 'learning.sqlite')); t.after(() => db.close());
  const chapters = db.prepare('SELECT key,digest,markers FROM chapters WHERE book=? ORDER BY ordinal').all('sync-book');
  assert.ok(chapters.length);
  const digest = createHash('sha256').update(JSON.stringify(chapters.map(({ key, digest, markers }) => [key, digest, markers]))).digest('hex');
  const saved = () => response(base, '/api/library', { headers: json }).then((value) => value.books.find((book) => book.id === 'sync-book').audioSynced);
  db.prepare("INSERT INTO book_audio(id,book,digest,options,state,parts,segments,duration,created,kind) VALUES('synced-fixture','sync-book',?,'{}','queued','[]',?,10,?,'uploaded')")
    .run(digest, JSON.stringify([{ key: chapters[0].key, start: 0, end: 10 }]), Date.now());
  assert.equal(await saved(), false, 'a queued upload is not synced');
  db.prepare("UPDATE book_audio SET state='ready' WHERE id='synced-fixture'").run();
  assert.equal(await saved(), true);
  base = await f.start(); assert.equal(await saved(), true, 'ready alignment survives restarting the server');
  db.prepare("UPDATE book_audio SET digest='outdated' WHERE id='synced-fixture'").run();
  assert.equal(await saved(), false);
  db.prepare("UPDATE book_audio SET digest=? WHERE id='synced-fixture'").run(digest);
  assert.equal(await saved(), true);
  db.prepare("DELETE FROM book_audio WHERE id='synced-fixture'").run(); assert.equal(await saved(), false);
});

test('the priority API keeps one active task and permits only the owner to promote queued work', async (t) => {
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; }), requested = new Promise((resolve) => { entered = resolve; });
  const engine = createHTTPServer(async (request, result) => {
    for await (const chunk of request) void chunk;
    if (request.url === '/analyze') { entered(); await held; }
    result.setHeader('Content-Type', 'application/json'); result.end(JSON.stringify({ tokens: [], lemmas: [], method: 'contextual' }));
  });
  engine.listen(0, '127.0.0.1'); await once(engine, 'listening');
  t.after(async () => { release(); engine.closeAllConnections(); await new Promise((resolve) => engine.close(resolve)); });
  const f = await fixture(t, { languageURL: `http://127.0.0.1:${engine.address().port}` });
  const path = join(f.library.uploads, 'second-book'); await writeFile(path, f.bytes);
  await f.library.importBook('other-book', { originalname: 'Other.epub', path, size: f.bytes.length }, { title: 'Other book', language: 'es' });
  const base = await f.start(); await response(base, '/api/library', { headers: json });
  await Promise.race([requested, delay(10000).then(() => { throw new Error('Vocabulary worker did not start'); })]);
  const before = await response(base, '/api/processes', { headers: json });
  assert.equal(before.sequential, true); assert.equal(before.jobs.filter((job) => job.state === 'running').length, 1);
  const active = before.jobs.find((job) => job.state === 'running');
  const queued = before.jobs.find((job) => job.kind === 'analysis' && job.state === 'queued' && job.canPrioritize);
  assert.ok(queued, JSON.stringify(before.jobs));
  const priority = `/api/processes/${encodeURIComponent(queued.id)}/priority`;
  assert.equal((await fetch(base + priority, { method: 'POST' })).status, 401);
  await response(base, priority, { method: 'POST', headers: { ...json, Origin: 'https://untrusted.invalid' }, status: 403 });
  await response(base, '/api/admin/users', { method: 'POST', headers: json, status: 201,
    body: JSON.stringify({ username: 'queue-member', password: 'queue-member-test-password' }) });
  const member = { Authorization: 'Basic ' + Buffer.from('queue-member:queue-member-test-password').toString('base64'), 'Content-Type': 'application/json' };
  await response(base, priority, { method: 'POST', headers: member, status: 404 });
  const drop = { action: 'move', target: active.id, position: 'before' };
  await response(base, priority, { method: 'POST', headers: json, body: JSON.stringify({ ...drop, position: 'inside' }), status: 422 });
  await response(base, priority, { method: 'POST', headers: json, body: JSON.stringify({ ...drop, target: 'missing' }), status: 409 });
  await response(base, priority, { method: 'POST', headers: json, body: JSON.stringify(drop), status: 202 });
  const reordered = await response(base, '/api/processes', { headers: json });
  assert.ok(reordered.jobs.find((job) => job.id === queued.id).queuePosition < reordered.jobs.find((job) => job.id === active.id).queuePosition);
  assert.equal(reordered.jobs.find((job) => job.id === active.id).pauseRequested, true);
  const raised = await response(base, priority, { method: 'POST', headers: json, status: 202 }); assert.ok(raised.priority > 0);
  const after = await response(base, '/api/processes', { headers: json });
  assert.equal(after.jobs.find((job) => job.state === 'running').id, active.id, 'raising priority must not interrupt the current task');
  assert.ok(after.jobs.find((job) => job.id === queued.id).priority > 0);
  await response(base, `/api/books/${queued.bookId}`, { method: 'PATCH', headers: json, body: JSON.stringify({ shared: true }) });
  const shared = await response(base, '/api/processes', { headers: member });
  assert.equal(shared.jobs.find((job) => job.id === queued.id).canPrioritize, false);
  await response(base, priority, { method: 'POST', headers: member, status: 403 });
  await response(base, priority, { method: 'POST', headers: member, body: JSON.stringify(drop), status: 403 });
  release();
});
