import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';
import { koReaderDocumentID } from '../server/progress-sync.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const md5 = (value) => createHash('md5').update(value).digest('hex');
const basic = 'Basic ' + Buffer.from('ian:test-reader-password').toString('base64');
const json = { Authorization: basic, 'Content-Type': 'application/json' };
const xpath = '/body/DocFragment[1]/body/p[2]/text()[1].7';
const cfi = 'epubcfi(/6/2!/4/2/1:7)';
const deviceHeaders = (user = 'ian', password = 'test-reader-password') => ({
  'x-auth-user': user, 'x-auth-key': md5(password), Accept: 'application/vnd.koreader.v1+json',
  'Content-Type': 'application/json',
});

async function fixture(t, { demo = false, password = 'test-reader-password', syncUser = '', syncPassword = '' } = {}) {
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
      READER_USER: 'ian', READER_PASSWORD: password, READER_SYNC_USER: syncUser, READER_SYNC_PASSWORD: syncPassword,
      READER_LANGUAGE_URL: 'http://127.0.0.1:1', READER_KOKORO_URL: '',
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
    assert.equal((await fetch(base + path, { headers: deviceHeaders('ian', 'wrong') })).status, 401);
  }
  // Native credentials do not bypass the web/OPDS login.
  for (const path of ['/api/library', '/api/settings/ai', '/api/books/sync-book/file', '/opds']) {
    assert.equal((await fetch(base + path, { headers: native })).status, 401);
  }
  assert.equal((await fetch(base + '/kosync/users/create', { method: 'POST', headers: native, body: '{}' })).status, 403);
  const settings = await response(base, '/api/settings/sync', { headers: json });
  assert.deepEqual(settings, { available: true, deviceAvailable: true, path: '/kosync', username: 'ian', protocol: 'KOReader Sync' });
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
