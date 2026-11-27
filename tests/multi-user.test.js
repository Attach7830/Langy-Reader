import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openLibrary } from '../server/books.js';
import { openReaderSettings } from '../server/reader-settings.js';
import { sampleBook } from '../server/sample.js';
const pass = 'administrator-test-password', memberPass = 'member-test-password-42';
const basic = (name, password) => ({ Authorization: 'Basic ' + Buffer.from(`${name}:${password}`).toString('base64') });
const sync = (name, password) => ({ 'x-auth-user': name, 'x-auth-key': createHash('md5').update(password).digest('hex'), 'Content-Type': 'application/json' });
const cfi = 'epubcfi(/6/2!/4/2/1:7)';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-users-http-')), library = await openLibrary(dir), bytes = await sampleBook();
  const path = join(library.uploads, 'legacy'); await writeFile(path, bytes);
  await library.importBook('legacy', { path, size: bytes.length, originalname: 'Legacy.epub' }, { title: 'Legacy private book', language: 'es' });
  const settings = openReaderSettings(dir, { username: 'reader' }), before = settings.get(); settings.patch({ revision: 0, changes: { theme: 'midnight', nativeLanguage: 'en' } }); settings.close();
  let child, base, output = '';
  async function start() {
    if (child?.exitCode === null) { child.kill(); await once(child, 'exit'); }
    const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening'); const { port } = listener.address(); await new Promise((done) => listener.close(done));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), READER_DATA: dir, READER_USER: 'reader', READER_PASSWORD: pass, READER_DEMO: '0', READER_SYNC_USER: '', READER_SYNC_PASSWORD: '', READER_LANGUAGE_URL: 'http://127.0.0.1:1', READER_KOKORO_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', (value) => { output = (output + value).slice(-10000); });
    for (let i = 0; i < 200; i++) { if (child.exitCode !== null) throw new Error(output); if (await fetch(base + '/healthz').then((r) => r.ok).catch(() => false)) return; await delay(25); }
    throw new Error('Reader startup timed out: ' + output);
  }
  t.after(async () => { if (child?.exitCode === null) { child.kill(); await once(child, 'exit'); } await rm(dir, { recursive: true, force: true }); });
  async function api(path, headers = {}, { status = 200, body, method = body ? 'POST' : 'GET' } = {}) {
    const form = body instanceof FormData;
    const result = await fetch(base + path, { method, headers: { ...headers, ...(!form && body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined });
    const text = await result.text(); assert.equal(result.status, status, `${method} ${path}: ${text}`); return result.status === 204 ? null : JSON.parse(text);
  }
  async function login(name, password) {
    const result = await fetch(base + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password }) });
    assert.equal(result.status, 200, await result.clone().text()); const cookie = result.headers.getSetCookie().find((value) => value.startsWith('langy_session='))?.split(';')[0]; assert.ok(cookie); return { Cookie: cookie };
  }
  async function upload(headers, title, shared = false, shareWith) {
    const data = new FormData();
    data.set('title', title); data.set('language', 'es'); data.set('shared', String(shared));
    if (shareWith) data.set('shareWith', JSON.stringify(shareWith));
    data.set('file', new Blob([bytes]), 'book.epub');
    return api('/api/books', headers, { body: data, status: 201 });
  }
  await start(); return { dir, api, login, upload, start, before, base: () => base };
}

test('self-hosted users have private libraries, owner-controlled sharing and isolated reader data', async (t) => {
  const f = await fixture(t), admin = basic('reader', pass); let member, third, privateBook, sharedBook;
  await t.test('the existing account becomes administrator without losing its library or account identity', async () => {
    const info = await f.api('/api/account', admin); assert.equal(info.user.role, 'admin'); assert.equal(info.user.username, 'reader'); assert.equal(info.readerAccountId, f.before.accountId);
    assert.ok((await f.api('/api/library', admin)).books.some((book) => book.id === 'legacy'));
    assert.equal((await f.api('/api/settings/reader', admin)).preferences.theme, 'midnight');
    const body = await f.api('/api/account'); assert.equal(body.authenticated, false); assert.equal(body.readerAccountId, null);
    await f.api('/api/library', {}, { status: 401 });
    for (const path of ['/API/library', '/Api/books/legacy/file', '/OPDS/books']) assert.equal((await fetch(f.base() + path)).status, 401);
    await f.api('/api/account/login', { Origin: 'https://another-site.test' }, { body: { username: 'reader', password: pass }, status: 403 });
  });
  await t.test('Remember me controls persistent cookies, survives a server restart and remains revocable', async () => {
    for (const rememberMe of ['false', 1, null]) await f.api('/api/account/login', {}, { body: { username: 'reader', password: pass, rememberMe }, status: 422 });
    async function signIn(rememberMe) {
      const response = await fetch(f.base() + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reader', password: pass, ...(rememberMe === undefined ? {} : { rememberMe }) }) });
      assert.equal(response.status, 200); return response.headers.getSetCookie().find((value) => value.startsWith('langy_session='));
    }
    const short = await signIn(); assert.doesNotMatch(short, /Max-Age|Expires=/iu); assert.match(short, /HttpOnly/iu);
    const remembered = await signIn(true); assert.match(remembered, /Max-Age=2592000/u); assert.match(remembered, /SameSite=Lax/iu);
    const headers = { Cookie: remembered.split(';')[0] }; await f.start();
    assert.equal((await f.api('/api/account', headers)).authenticated, true);
    const passwordResponse = await fetch(f.base() + '/api/account/password', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: pass, newPassword: pass }) });
    assert.equal(passwordResponse.status, 200); const renewed = passwordResponse.headers.getSetCookie().find((value) => value.startsWith('langy_session=')); assert.match(renewed, /Max-Age=2592000/u);
    const current = { Cookie: renewed.split(';')[0] }; await f.api('/api/account/logout', current, { body: {} });
    assert.equal((await f.api('/api/account', current)).authenticated, false);
  });
  await t.test('only administrators create users and credentials never appear in responses', async () => {
    const one = await f.api('/api/admin/users', admin, { body: { username: 'member', password: memberPass }, status: 201 });
    await f.api('/api/admin/users', admin, { body: { username: 'third', password: memberPass }, status: 201 });
    member = await f.login('MEMBER', memberPass); third = await f.login('third', memberPass);
    assert.equal((await f.api('/api/account', { ...member, ...admin })).user.username, 'member', 'session cookies take precedence over legacy cached Basic credentials');
    assert.equal((await f.api('/api/library', member)).books.length, 0); assert.equal((await f.api('/api/library', third)).books.length, 0);
    const listed = await f.api('/api/admin/users', admin); assert.equal(listed.users.length, 3); assert.equal(/password|scrypt|sync|settingsKey/u.test(JSON.stringify(listed)), false);
    await f.api('/api/admin/users', member, { status: 403 }); await f.api('/api/admin/users', member, { body: { username: 'forbidden', password: memberPass }, status: 403 });
    await f.api('/api/admin/users/' + one.id, member, { method: 'PATCH', body: { role: 'admin' }, status: 403 });
    await f.api('/api/admin/users', admin, { body: { username: 'MEMBER', password: memberPass }, status: 409 });
  });
  await t.test('font imports and downloads are private to their account and remain removable', async () => {
    const bytes = await readFile(new URL('../node_modules/@fontsource/spectral/files/spectral-latin-400-normal.woff2', import.meta.url));
    const form = new FormData(); form.set('file', new Blob([bytes]), 'reading.woff2'); form.set('name', 'Private reading font');
    const font = await f.api('/api/fonts', member, { body: form, status: 201 }); assert.match(font.id, /^custom-/u);
    assert.equal((await f.api('/api/fonts', member)).fonts.length, 1); assert.equal((await f.api('/api/fonts', third)).fonts.length, 0);
    assert.equal((await fetch(f.base() + font.url, { headers: member })).status, 200);
    await f.api(font.url, third, { status: 404 }); await f.api('/api/fonts', {}, { status: 401 });
    await f.api('/api/fonts/' + font.id.slice(7), third, { method: 'DELETE', status: 404 });
    await f.api('/api/fonts/' + font.id.slice(7), member, { method: 'DELETE' }); await f.api(font.url, member, { status: 404 });
  });
  await t.test('private uploads and categories cannot be accessed by another account, including direct URLs', async () => {
    privateBook = await f.upload(member, 'Private member title');
    for (const suffix of ['/file', '/cover', '/learning', '/narration', '/recordings', '/bookmarks', '/offline', '/progress']) await f.api(`/api/books/${privateBook.id}${suffix}`, admin, { status: 404 });
    await f.api(`/api/books/${privateBook.id}/pinyin`, third, { body: { text: '有意思' }, status: 404 });
    assert.equal((await f.api('/api/library', admin)).books.some((book) => book.id === privateBook.id), false);
    const feed = await fetch(f.base() + '/opds/books', { headers: admin }); assert.equal((await feed.text()).includes('Private member title'), false);
    assert.equal((await fetch(f.base() + `/opds/books/${privateBook.id}/file.epub`, { headers: third })).status, 404);
  });
  await t.test('sharing works on upload and edit, and recipients cannot change the owner’s copy', async () => {
    sharedBook = await f.upload(member, 'Shared member title', true);
    const fromAdmin = (await f.api('/api/library', admin)).books.find((book) => book.id === sharedBook.id); assert.equal(fromAdmin.sharedWithMe, true); assert.equal(fromAdmin.canEdit, false);
    await f.api(`/api/books/${privateBook.id}`, member, { method: 'PATCH', body: { title: privateBook.title, language: 'es', shared: true } });
    assert.ok((await f.api('/api/library', third)).books.some((book) => book.id === privateBook.id));
    for (const [method, suffix] of [['PATCH',''], ['DELETE',''], ['POST','/cover'], ['POST','/narration'], ['POST','/learning'], ['POST','/ocr'], ['POST','/recordings']]) await f.api(`/api/books/${sharedBook.id}${suffix}`, third, { method, body: {}, status: 403 });
    for (const suffix of ['/NARRATION', '/RECORDINGS', '/OCR']) await f.api(`/api/books/${sharedBook.id}${suffix}`, third, { method: 'POST', body: {}, status: 404 });
    assert.equal((await fetch(f.base() + `/api/books/${sharedBook.id}/file`, { headers: third })).status, 200);
    await f.api(`/api/books/${privateBook.id}`, member, { method: 'PATCH', body: { title: privateBook.title, language: 'es', shared: false } });
    await f.api(`/api/books/${privateBook.id}/file`, third, { status: 404 });
  });
  await t.test('selected-user grants control the library, direct downloads and OPDS and can be revoked', async () => {
    await f.api('/api/sharing/recipients', {}, { status: 401 });
    const { users } = await f.api('/api/sharing/recipients', member);
    assert.deepEqual(users.map(({ username }) => username), ['reader', 'third']);
    assert.ok(users.every((user) => Object.keys(user).sort().join(',') === 'id,username'));
    const [reader, readerThree] = users;
    const book = await f.upload(member, 'A selectively shared book', false, [readerThree.id, readerThree.id]);
    assert.deepEqual(book.shareWith, [readerThree.id]);
    const path = '/api/books/' + book.id, file = path + '/file', opds = `/opds/books/${book.id}/file.epub`;
    const byId = async (headers) => (await f.api('/api/library', headers)).books.find(({ id }) => id === book.id);
    const download = (path, headers) => fetch(f.base() + path, { headers });
    const edit = (body, status = 200) => f.api(path, member, { method: 'PATCH', body, status });
    const recipient = await byId(third);
    assert.equal(recipient.sharedWithMe, true);
    assert.equal(recipient.canEdit, false);
    assert.equal(Object.hasOwn(recipient, 'shareWith'), false);
    assert.equal(await byId(admin), undefined);
    for (const suffix of ['/file', '/cover', '/learning', '/narration', '/recordings', '/offline', '/progress']) {
      await f.api(path + suffix, admin, { status: 404 });
    }
    await f.api(path, third, { method: 'PATCH', body: { shared: true }, status: 403 });
    assert.equal((await download(file, third)).status, 200);
    assert.equal((await download(opds, third)).status, 200);
    assert.equal((await download(opds, admin)).status, 404);
    assert.match(await (await download('/opds/books', third)).text(), new RegExp(book.title, 'u'));
    assert.doesNotMatch(await (await download('/opds/books', admin)).text(), new RegExp(book.title, 'u'));
    await f.api(path + '/read-status', third, { method: 'PATCH', body: { read: true } });
    assert.ok((await byId(third)).readAt);
    assert.equal((await byId(member)).readAt, null);

    const other = (await f.api('/api/account', member)).user.id;
    for (const body of [{ shareWith: [other] }, { shareWith: ['unknown'] }, { shareWith: '[broken' },
      { shared: true, shareWith: [reader.id] }]) await edit(body, 422);
    assert.deepEqual((await edit({ title: book.title, shared: false })).shareWith, [readerThree.id], 'legacy metadata saves retain selected users');
    assert.equal((await download(file, third)).status, 200);
    assert.equal((await download(file, admin)).status, 404);
    assert.deepEqual((await edit({ shareWith: [reader.id] })).shareWith, [reader.id]);
    await f.start();
    assert.equal((await byId(admin)).sharedWithMe, true);
    assert.equal((await download(file, admin)).status, 200);
    assert.equal(await byId(third), undefined);
    await f.api(path + '/progress', third, { status: 404 });
    assert.equal((await download(opds, third)).status, 404);
    assert.equal((await edit({ shared: true })).shared, true);
    assert.equal((await download(file, third)).status, 200);
    assert.deepEqual((await edit({ shareWith: [] })).shareWith, []);
    assert.equal((await download(file, third)).status, 404);
    assert.equal((await download(file, admin)).status, 404);
    assert.equal((await download(file, member)).status, 200);
  });
  await t.test('read status, bookmarks, preferences and hiding shared books are account-private', async () => {
    await f.api(`/api/books/${sharedBook.id}/read-status`, third, { method: 'PATCH', body: { read: true } });
    assert.ok((await f.api('/api/library', third)).books.find((book) => book.id === sharedBook.id).readAt);
    assert.equal((await f.api('/api/library', member)).books.find((book) => book.id === sharedBook.id).readAt, null);
    await f.api(`/api/books/${sharedBook.id}/bookmarks`, third, { body: { target: cfi, label: 'Private bookmark', note: 'Private note' } });
    assert.equal((await f.api(`/api/books/${sharedBook.id}/bookmarks`, member)).bookmarks.length, 0);
    const settings = await f.api('/api/settings/reader', third);
    await f.api('/api/settings/reader', third, { method: 'PATCH', body: { revision: settings.revision, changes: { showSharedBooks: false, theme: 'dusk', cacheCovers: false } } });
    assert.equal((await f.api('/api/settings/reader', third)).preferences.showSharedBooks, false);
    assert.equal((await f.api('/api/settings/reader', member)).preferences.showSharedBooks, undefined);
    assert.equal((await f.api('/api/settings/reader', third)).preferences.cacheCovers, false);
    assert.equal((await f.api('/api/settings/reader', member)).preferences.cacheCovers, undefined);
  });
  await t.test('reading time and vocabulary thresholds stay account-private', async () => {
    const first = await f.api('/api/reading-time', third), end = Date.now();
    await f.api(`/api/books/${sharedBook.id}/reading-time`, third, { body: { accountId: first.accountId, events: [{ id: 'member-private-reading', start: end - 5000, end }] } });
    assert.equal((await f.api('/api/reading-time', third)).totalMs, 5000); assert.equal((await f.api('/api/reading-time', member)).totalMs, 0);
    await f.api('/api/vocabulary/settings', third, { method: 'PUT', body: { threshold: 12 } });
    assert.equal((await f.api('/api/vocabulary/settings', third)).threshold, 12); assert.notEqual((await f.api('/api/vocabulary/settings', member)).threshold, 12);
  });
  await t.test('browser and KOReader progress remain separate for identical shared files', async () => {
    const own = await f.api(`/api/books/${sharedBook.id}/progress`, member), other = await f.api(`/api/books/${sharedBook.id}/progress`, third);
    assert.equal(own.progress, null); assert.equal(other.progress, null); assert.equal(own.document, other.document);
    await f.api(`/api/books/${sharedBook.id}/progress`, member, { method: 'PUT', body: { baseVersion: 0, target: cfi, progress: '/body/DocFragment[1]/body/p[2]/text()[1].7', percentage: .2, device: 'Member browser' } });
    assert.equal((await f.api(`/api/books/${sharedBook.id}/progress`, third)).progress, null);
    await f.api('/kosync/users/auth', sync('third', memberPass));
    await f.api('/kosync/syncs/progress', sync('third', memberPass), { method: 'PUT', body: { document: own.document, progress: '/body/DocFragment[1]/body/p[2]/text()[1].20', percentage: .8, device: 'Third e-reader' } });
    assert.equal((await f.api(`/api/books/${sharedBook.id}/progress`, third)).progress.percentage, .8);
    assert.equal((await f.api(`/api/books/${sharedBook.id}/progress`, member)).progress.percentage, .2);
    const rootNative = await f.api('/kosync/syncs/progress/' + own.document, sync('reader', pass)); assert.deepEqual(rootNative, {});
    assert.equal(Object.hasOwn((await f.api('/api/library', admin)).progress, sharedBook.id), false);
  });
  await t.test('AI connection overrides and private keys cannot change the administrator’s connection', async () => {
    await f.api('/api/settings/ai', admin, { method: 'PUT', body: { provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'administrator-model', apiKey: 'ADMIN_FAKE_KEY' } });
    const initial = await f.api('/api/settings/ai', member); assert.equal(initial.inherited, true); assert.equal(initial.hasKey, false); assert.equal(initial.model, 'administrator-model');
    await f.api('/api/settings/ai', member, { method: 'PUT', body: { provider: 'ollama', baseUrl: 'http://127.0.0.1:2', model: 'forbidden-model' }, status: 403 });
    await f.api('/api/settings/ai', member, { method: 'PUT', body: { provider: 'ollama', baseUrl: initial.baseUrl, model: 'member-model', apiKey: 'MEMBER_FAKE_KEY' } });
    assert.equal((await f.api('/api/settings/ai', admin)).model, 'administrator-model'); assert.equal((await f.api('/api/settings/ai', third)).model, 'administrator-model');
    await f.api('/api/settings/ai/key', member, { method: 'DELETE' }); assert.equal((await f.api('/api/settings/ai', admin)).hasKey, true);
    await f.api('/api/settings/ai/override', member, { method: 'DELETE' }); assert.equal((await f.api('/api/settings/ai', member)).inherited, true);
    await f.api('/api/settings/learning', member, { method: 'PUT', body: {}, status: 403 });
    assert.equal((await f.api('/api/settings/learning', member)).configurable, false);
    await f.api('/api/settings/ocr', admin, { method: 'PUT', body: { provider: 'builtin', baseUrl: 'http://private-ocr.test:8000', apiKey: 'ADMIN_OCR_FAKE_KEY' } });
    const managedOCR = await f.api('/api/settings/ocr', member); assert.equal(managedOCR.configurable, false); assert.equal(managedOCR.provider, 'builtin');
    assert.equal(Object.hasOwn(managedOCR, 'baseUrl'), false); assert.equal(Object.hasOwn(managedOCR, 'hasKey'), false); assert.equal(JSON.stringify(managedOCR).includes('ADMIN_OCR_FAKE_KEY'), false);
    await f.api('/api/settings/ocr', member, { method: 'PUT', body: { provider: 'builtin' }, status: 403 });
    await f.api('/api/settings/ocr/key', member, { method: 'DELETE', status: 403 });
    assert.equal((await f.api('/api/settings/ocr', admin)).hasKey, true);
    await f.api('/api/audiobookshelf/libraries', member, { status: 403 }); assert.equal((await f.api('/api/settings/audiobookshelf', member)).connected, false);
  });
  await t.test('download jobs and their continuation controls belong to the requesting user', async () => {
    const body = { reference: 'a'.repeat(32), downloadMode: 'slow', title: 'Private queued title' };
    const { users } = await f.api('/api/sharing/recipients', member);
    const shareWith = [users.find(({ username }) => username === 'third').id];
    const one = await f.api('/api/imports/anna', member, { body: { ...body, shareWith }, status: 202 });
    const two = await f.api('/api/imports/anna', admin, { body: { ...body, title: 'Admin queued title' }, status: 202 });
    assert.deepEqual(one.details.shareWith, shareWith);
    assert.ok((await f.api('/api/imports/anna', member)).jobs.every((job) => job.id === one.id));
    await f.api('/api/imports/anna/' + one.id, admin, { status: 404 });
    await f.api('/api/imports/anna/' + one.id, third, { method: 'DELETE', status: 404 });
    const queue = await f.api('/api/processes', admin); assert.equal(JSON.stringify(queue).includes('Private queued title'), false); assert.equal((await f.api('/api/imports/anna', admin)).jobs[0].id, two.id);
  });
  await t.test('per-user quotas and source-key permissions are private and enforced on existing libraries', async () => {
    const users = (await f.api('/api/admin/users', admin)).users, user = users.find((item) => item.username === 'member');
    assert.ok(user.storage.usedBytes > 0);
    await f.api('/api/admin/users/' + user.id, admin, {method:'PATCH', body:{storageLimit:0, sharedArchive:false, maxSessions:2, rememberDays:7}});
    const usage = await f.api('/api/storage', member); assert.equal(usage.scope,'account'); assert.equal(usage.totalBytes,0); assert.equal(usage.overLimit,true);
    assert.ok((await f.api('/api/library', member)).books.some((book) => book.id === privateBook.id));
    const data = new FormData(); data.set('file',new Blob([await sampleBook()]),'limited.epub');
    await f.api('/api/books',member,{body:data,status:507});
    const settings = await f.api('/api/settings/archive',member); assert.equal(settings.configurable,true); assert.equal(settings.sharedAllowed,false);
    await f.api('/api/settings/archive',member,{method:'PUT',body:{useShared:true},status:403});
    await f.api('/api/settings/archive',member,{method:'PUT',body:{apiKey:'member-private-example-key',useShared:false}});
    assert.equal((await f.api('/api/settings/archive',member)).hasPersonalKey,true);
    assert.equal((await f.api('/api/settings/archive',third)).hasPersonalKey,false);
    assert.equal(JSON.stringify(await f.api('/api/settings/archive',member)).includes('member-private-example-key'),false);
    await f.api('/api/admin/users/' + user.id,admin,{method:'PATCH',body:{storageLimit:null}});
    assert.equal((await f.api('/api/storage',member)).unlimited,true);
  });
  await t.test('Safe mode restricts an existing session to its library and personal reading data', async () => {
    const { users } = await f.api('/api/admin/users', admin);
    const user = users.find((item) => item.username === 'member');
    const operator = users.find((item) => item.role === 'admin');
    const policy = '/api/admin/users/' + user.id;
    const book = '/api/books/' + privateBook.id;
    await f.api(policy, member, { method: 'PATCH', body: { safeMode: true }, status: 403 });
    await f.api('/api/admin/users/' + operator.id, admin, { method: 'PATCH', body: { safeMode: true }, status: 422 });
    await f.api(policy, admin, { method: 'PATCH', body: { safeMode: 'true' }, status: 422 });
    await f.api(policy, admin, { method: 'PATCH', body: { safeMode: true } });
    assert.equal((await f.api('/api/account', member)).user.safeMode, true);
    const library = await openLibrary(f.dir), bytes = await sampleBook(), file = join(library.uploads, 'unindexed.epub');
    await writeFile(file, bytes);
    await library.importBook('unindexed', { path: file, size: bytes.length, originalname: 'unindexed.epub' },
      { title: 'Unindexed book', language: 'es' }, { id: user.id, userId: user.id });
    const snapshot = await f.api('/api/library', member);
    assert.ok(snapshot.books.some((item) => item.id === privateBook.id && !item.canEdit));
    assert.equal(snapshot.books.find((item) => item.id === 'unindexed').learning.state, 'missing');
    assert.equal((await f.api('/api/books/unindexed/learning', member)).analysis.state, 'missing', 'opening an unindexed book must not start work');
    assert.equal((await fetch(f.base() + book + '/file', { headers: member, method: 'HEAD' })).status, 200);
    await f.api(book + '/learning', member);
    await f.api(book + '/narration', member);
    const mark = await f.api(book + '/bookmarks', member, { body: { target: cfi, label: 'Continue here' } });
    assert.ok(mark);
    await f.api(book + '/read-status', member, { method: 'PATCH', body: { read: true } });
    for (const [method, path] of [
      ['GET', '/api/processes'], ['GET', '/api/storage'], ['GET', '/api/kavita/catalogue'],
      ['GET', '/api/settings/ai'], ['GET', '/api/fonts/catalogue'], ['GET', '/api/book-catalogue/gutenberg'],
      ['GET', '/api/sharing/recipients'], ['GET', '/opds/books'], ['GET', book + '/ocr'],
      ['GET', book + '/offline'], ['POST', '/api/ai/phrase'], ['POST', '/api/imports/web'],
      ['POST', '/api/books'], ['POST', book + '/narration'], ['POST', book + '/pdf-review/ocr'],
      ['PATCH', book], ['PUT', '/api/settings/kavita'], ['DELETE', book],
    ]) {
      const result = await f.api(path, member, { method, status: 403 });
      assert.match(result.error, /Safe mode/u);
    }
    await f.api('/api/library', basic('member', memberPass), { status: 401 });
    await f.api('/kosync/users/auth', sync('member', memberPass), { status: 401 });
    await f.api('/api/processes', third);
    await f.api(policy, admin, { method: 'PATCH', body: { role: 'admin' }, status: 422 });
    await f.start();
    assert.equal((await f.api('/api/account', member)).user.safeMode, true);
    await f.api(policy, admin, { method: 'PATCH', body: { safeMode: false } });
    assert.equal((await f.api('/api/account', member)).user.safeMode, false);
    await f.api('/api/processes', member);
  });
  await t.test('disabling or resetting an account revokes sessions and device credentials without losing its books', async () => {
    const users = (await f.api('/api/admin/users', admin)).users, user = users.find((item) => item.username === 'member');
    await f.api('/api/admin/users/' + user.id, admin, { method: 'PATCH', body: { disabled: true } });
    await f.api('/api/library', member, { status: 401 }); await f.api('/api/library', basic('member', memberPass), { status: 401 }); await f.api('/kosync/users/auth', sync('member', memberPass), { status: 401 });
    await f.api('/api/admin/users/' + user.id, admin, { method: 'PATCH', body: { disabled: false } }); await f.api('/api/library', member, { status: 401 });
    member = await f.login('member', memberPass); assert.ok((await f.api('/api/library', member)).books.some((book) => book.id === privateBook.id));
    await f.api('/api/admin/users/' + user.id + '/password', admin, { body: { password: 'a-new-member-test-password' } });
    await f.api('/api/library', member, { status: 401 }); member = await f.login('member', 'a-new-member-test-password');
    await f.start(); assert.ok((await f.api('/api/library', member)).books.some((book) => book.id === privateBook.id));
    assert.equal((await f.api('/api/settings/reader', third)).preferences.showSharedBooks, false);
  });
});
