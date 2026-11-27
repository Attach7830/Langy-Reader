import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { archiveMD5, openArchive } from '../server/annas-archive.js';
import { maxUpload, openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';
import { downloadURL, isPublicAddress, publicDownload, resolveDownloadHost } from '../server/public-download.js';

function response(body, statusCode = 200, headers = {}) {
  const value = typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body;
  const stream = Readable.from([Buffer.isBuffer(value) ? value : Buffer.from(value)]);
  return Object.assign(stream, { statusCode, headers });
}
async function finished(archive, id) {
  for (let count = 0; count < 200; count++) {
    const job = archive.job(id);
    if (['ready', 'error', 'needs_action', 'retry_wait', 'cancelled'].includes(job.state)) return job;
    await delay(10);
  }
  throw new Error('Import did not finish');
}

test('member import keeps the key private, imports a verified EPUB, and reports progress/errors without signed links', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-archive-'));
  try {
    const library = await openLibrary(folder), epub = await sampleBook();
    const md5 = createHash('md5').update(epub).digest('hex'), key = 'test-member-secret';
    let mode = 'ok', calls = 0, analyzed;
    const request = async (value, options) => {
      const url = new URL(value); calls++;
      if (url.pathname === '/dyn/api/fast_download.json') {
        assert.equal(url.searchParams.get('key'), key);
        assert.equal(url.searchParams.get('md5'), md5);
        assert.equal(options.redirects, 0);
        if (mode === 'quota') return response({ error: 'Daily download limit reached ' + key }, 403);
        if (mode === 'bad-key') return response({ error: 'Invalid member key ' + key }, 403);
        return response({ download_url: 'https://files.example.test/book?token=private-download-token' });
      }
      assert.equal(url.searchParams.has('key'), false);
      if (mode === 'oversize') return response(epub, 200, { 'content-length': String(maxUpload + 1) });
      if (mode === 'oversize-stream') return Object.assign(Readable.from((async function* () {
        const block = Buffer.alloc(1024 ** 2);
        for (let index = 0; index < 121; index++) yield block;
      })()), { statusCode: 200, headers: {} });
      if (mode === 'mismatch') return response(Buffer.from('not the requested book'));
      return response(epub, 200, { 'content-length': String(epub.length), 'content-disposition': 'attachment; filename="Sample.epub"' });
    };
    const archive = await openArchive(folder, { library, request, onImport: (book) => { analyzed = book.id; } });
    assert.throws(() => archive.queue({ reference: md5, downloadMode: 'fast' }), /membership key/u);
    const settings = await archive.save({ baseUrl: 'https://annas-archive.gl', apiKey: key });
    assert.equal(settings.hasKey, true);
    assert.ok(!JSON.stringify(settings).includes(key));
    assert.equal((await stat(join(folder, 'archive-settings.json'))).mode & 0o777, 0o600);
    library.saveCategory('reading', { name: 'Reading' }, true);
    const job = archive.queue({ reference: `https://annas-archive.org/md5/${md5}`, categoryId: 'reading' });
    assert.throws(() => archive.queue({ reference: md5 }), /already running/u);
    const complete = await finished(archive, job.id);
    assert.equal(complete.state, 'ready', complete.error);
    assert.ok(Number.isSafeInteger(complete.completedAt));
    assert.equal(complete.book.categoryId, 'reading');
    assert.equal(analyzed, complete.book.id);
    assert.deepEqual(await readFile(library.filePath(complete.book)), epub);
    assert.ok(!JSON.stringify(complete).includes(key));
    assert.ok(!JSON.stringify(complete).includes('private-download-token'));
    for (const [failure, expected] of [['bad-key', /membership/u], ['mismatch', /MD5/u], ['oversize', /120 MiB/u], ['oversize-stream', /120 MiB/u]]) {
      mode = failure;
      const failed = await finished(archive, archive.queue({ reference: md5 }).id);
      assert.equal(failed.state, 'error');
      assert.match(failed.error, expected);
      assert.ok(!JSON.stringify(failed).includes(key));
      assert.ok(!JSON.stringify(failed).includes('private-download-token'));
      assert.deepEqual(await readdir(library.uploads), []);
    }
    assert.equal(library.snapshot().books.length, 2);
    const before = calls;
    assert.throws(() => archive.queue({ reference: md5, categoryId: 'missing' }), /category/u);
    assert.equal(calls, before);
    const reopened = await openArchive(folder, { library, request });
    assert.equal(reopened.settings().hasKey, true);
    await reopened.save({ apiKey: '', clearKey: true });
    assert.equal(reopened.settings().hasKey, false);
    const demo = await openArchive(folder, { library, demo: true, request });
    assert.deepEqual(demo.settings(), { configurable: false, hasKey: false });
    assert.throws(() => demo.queue({ reference: md5 }), /self-hosted/u);
    assert.throws(() => demo.save({ apiKey: key }), /self-hosted/u);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('an exhausted fast quota offers a private slow-download continuation and imports a verified public file link', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-slow-link-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const library = await openLibrary(folder), epub = await sampleBook(), md5 = createHash('md5').update(epub).digest('hex');
  const key = 'private-member-key', calls = [];
  const archive = await openArchive(folder, { library, request: async (value) => {
    const url = new URL(value); calls.push(url);
    if (url.pathname === '/dyn/api/fast_download.json') return response({ error: 'quota_exceeded ' + key }, 429);
    assert.equal(url.searchParams.has('key'), false);
    return response(epub, 200, { 'content-length': String(epub.length) });
  } });
  await archive.save({ apiKey: key });
  library.saveCategory('reading', { name: 'Reading' }, true);
  const waiting = await finished(archive, archive.queue({ reference: md5, categoryId: 'reading', title: 'Chosen title' }).id);
  assert.equal(waiting.state, 'needs_action'); assert.equal(waiting.source, 'slow'); assert.match(waiting.notice, /allowance/u);
  assert.equal(waiting.bookUrl, 'https://annas-archive.gl/md5/' + md5); assert.ok(!JSON.stringify(waiting).includes(key));
  assert.throws(() => archive.continue(waiting.id, { url: 'https://127.0.0.1/private' }), /private/u);
  archive.continue(waiting.id, { url: 'https://files.example.test/book?token=private-file-token', details: { title: 'Updated title', coverStyle: 'forest' } });
  const complete = await finished(archive, waiting.id);
  assert.equal(complete.state, 'ready', complete.error); assert.equal(complete.book.categoryId, 'reading'); assert.equal(complete.book.title, 'Updated title');
  assert.equal(complete.book.coverStyle, 'forest'); assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(complete).includes('private-file-token')); assert.deepEqual(await readFile(library.filePath(complete.book)), epub);
});

test('completed legacy imports receive a saved completion time that stays fixed across restarts', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-import-completed-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const db = new DatabaseSync(join(folder, 'archive-jobs.sqlite'));
  db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT');
  db.prepare('INSERT INTO jobs VALUES(?,?)').run('legacy', JSON.stringify({ id: 'legacy', state: 'ready', book: { id: 'book', title: 'Imported book' } })); db.close();
  let clock = 100000;
  let archive = await openArchive(folder, { library: { uploads: folder }, autoStart: false, now: () => clock });
  assert.equal(archive.list()[0].completedAt, clock); archive.close();
  clock += 6000; archive = await openArchive(folder, { library: { uploads: folder }, autoStart: false, now: () => clock });
  assert.equal(archive.list()[0].completedAt, 100000); assert.equal(archive.list()[0].book.id, 'book'); archive.close();
});

test('free slow downloads need no key, retain the pending edition through browser checks and verify uploaded files', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-slow-upload-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const library = await openLibrary(folder), epub = await sampleBook(), md5 = createHash('md5').update(epub).digest('hex'); let calls = 0;
  const archive = await openArchive(folder, { library, request: async () => { calls++; return response('<html>Complete a browser check</html>', 200, { 'content-type': 'text/html' }); } });
  const job = archive.queue({ reference: `https://annas-archive.gl/slow_download/${md5}/0/2`, downloadMode: 'slow', author: 'Selected author', autoAudiobook: true, audiobookDelayMinutes: 7 });
  assert.equal(job.state, 'needs_action'); assert.equal(calls, 0);
  archive.continue(job.id, { url: 'https://files.example.test/check' }); const challenge = await finished(archive, job.id);
  assert.equal(challenge.state, 'needs_action'); assert.match(challenge.error, /browser check/u);
  const bad = join(library.uploads, 'bad.epub'); await writeFile(bad, 'wrong edition');
  await assert.rejects(archive.accept(job.id, { path: bad, size: 13, originalname: 'bad.epub' }), /MD5/u);
  assert.equal(archive.job(job.id).state, 'needs_action'); assert.deepEqual(await readdir(library.uploads), []);
  const good = join(library.uploads, 'downloaded.epub'); await writeFile(good, epub);
  const complete = await archive.accept(job.id, { path: good, size: epub.length, originalname: 'downloaded.epub' });
  assert.equal(complete.state, 'ready'); assert.equal(complete.book.author, 'Selected author'); assert.equal(calls, 1);
  assert.equal(complete.details.autoAudiobook, true); assert.equal(complete.details.audiobookDelayMinutes, 7);
  await assert.rejects(archive.accept(job.id, null), /finish/u);
});

test('fast-only mode and disabled fallback report quotas without starting slow downloads', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-slow-off-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const library = await openLibrary(folder), archive = await openArchive(folder, { library, request: async () => response({ error: 'quota_exceeded' }, 429) });
  await archive.save({ apiKey: 'key', slowFallback: false, retryUnavailable: false });
  const md5 = '0123456789abcdef0123456789abcdef';
  assert.equal((await finished(archive, archive.queue({ reference: md5 }).id)).state, 'error');
  await archive.save({ slowFallback: true });
  assert.equal((await finished(archive, archive.queue({ reference: md5, downloadMode: 'fast' }).id)).state, 'error');
  assert.equal((await openArchive(folder, { library })).settings().slowFallback, true);
});

test('references cannot become arbitrary fetch URLs, and downloads reject private networks and mixed DNS answers', async () => {
  const md5 = '0123456789abcdef0123456789abcdef';
  assert.equal(archiveMD5(md5.toUpperCase()), md5);
  assert.equal(archiveMD5(`https://annas-archive.gl/fast_download/${md5}/0/0?key=discarded`), md5);
  for (const reference of ['http://localhost/md5/' + md5, 'https://example.com/md5/' + md5, 'not-a-hash']) assert.throws(() => archiveMD5(reference));
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://example.com/file', 'https://user:pass@example.com/file', 'https://127.0.0.1/file', 'https://[::1]/file']) assert.throws(() => downloadURL(url));
  await assert.rejects(publicDownload('https://127.0.0.1/file'), /private/u);
  await assert.rejects(resolveDownloadHost('mixed.example', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), /private/u);
});

test('private membership keys stay per account and queued jobs recheck shared-key permission', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-archive-permissions-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const library = await openLibrary(folder); t.after(() => library.close?.());
  const member = { id: 'member', authenticated: true, role: 'user' }, other = { id: 'other', authenticated: true, role: 'user' };
  let allowed = false, active = true; const seen = [];
  const archive = await openArchive(folder, { library, autoStart: false, activeOwner: () => active,
    canUseShared: (visitor) => !visitor?.id || visitor.id === member.id && allowed,
    visitorForOwner: (id) => id === member.id ? member : id === other.id ? other : undefined,
    request: async (value) => { seen.push(new URL(value).searchParams.get('key')); return response({ error: 'Invalid member key' }, 401); } }); t.after(() => archive.close?.());
  await archive.save({apiKey:'shared-private-key'});
  assert.equal(archive.settings(member).hasKey, false);
  await assert.rejects(archive.save({useShared:true}, member), {status:403});
  await archive.save({apiKey:'member-private-key', useShared:false}, member);
  assert.equal(archive.settings(member).hasKey, true); assert.equal(archive.settings(other).hasKey, false);
  assert.equal(JSON.stringify(archive.settings(member)).includes('member-private-key'), false);
  assert.equal((await stat(join(folder, 'archive-users.json'))).mode & 0o777, 0o600);
  archive.queue({reference:'a'.repeat(32), downloadMode:'fast'},member); await archive.pump(); assert.deepEqual(seen,['member-private-key']);
  allowed = true; await archive.save({useShared:true},member);
  const queued = archive.queue({reference:'b'.repeat(32), downloadMode:'fast'},member); allowed = false;
  await archive.pump(); assert.equal(archive.job(queued.id,member).state,'error'); assert.deepEqual(seen,['member-private-key']);
  assert.equal(archive.settings().hasKey, true); await archive.removeKey(member); assert.equal(archive.settings().hasKey,true);
  active = false; assert.throws(() => archive.settings(member), {status:403});
});
