import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivePageTitle, archiveFilenameTitle, lookupArchiveTitle } from '../server/archive-title.js';
import { openArchive } from '../server/annas-archive.js';

const md5 = '0123456789abcdef0123456789abcdef';
test('catalogue titles prefer metadata, decode multilingual names and reject fingerprints or verification screens', () => {
  assert.equal(archivePageTitle('<title>Other - Anna’s Archive</title><meta content="China: O socialismo &amp; o século XXI - Anna’s Archive" property="og:title">'), 'China: O socialismo & o século XXI');
  assert.equal(archivePageTitle('<h1><span>中文书名</span></h1>'), '中文书名');
  assert.equal(archivePageTitle('<title>Pedro Páramo — Anna\'s Archive</title>'), 'Pedro Páramo');
  assert.equal(archivePageTitle('<title>Just a moment...</title>'), '');
  assert.equal(archivePageTitle(`<meta property="og:title" content="${md5}">`), '');
  assert.equal(archiveFilenameTitle({ 'content-disposition': "attachment; filename*=UTF-8''Ana%20de%20tejas%20verdes.epub" }), 'Ana de tejas verdes');
  assert.equal(archiveFilenameTitle({ 'content-disposition': `attachment; filename="${md5}.pdf"` }), '');
});

test('title lookup uses only the public edition page with bounded HTML and rejects redirects to other origins', async () => {
  let calls = 0;
  const request = async (url, options) => {
    calls++; assert.equal(url.href, 'https://annas-archive.gl/md5/' + md5); assert.equal(url.search, '');
    assert.throws(() => options.validate(new URL('https://unrelated.example/book')), /origin/u);
    return Object.assign(Readable.from(['<meta property="og:title" content="Un libro">']), { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  assert.equal(await lookupArchiveTitle({ baseUrl: 'https://annas-archive.gl', md5, request }), 'Un libro');
  assert.equal(await lookupArchiveTitle({ baseUrl: 'https://private.example', md5, request }), ''); assert.equal(calls, 1);
  assert.equal(await lookupArchiveTitle({ baseUrl: 'https://annas-archive.gl', md5, request: async () => Object.assign(Readable.from([Buffer.alloc(513 * 1024)]), { statusCode: 200, headers: {} }) }), '');
  assert.equal(await lookupArchiveTitle({ baseUrl: 'https://annas-archive.gl', md5, request: async () => Object.assign(Readable.from(['<meta property="og:title" content="A large catalogue page">', Buffer.alloc(513 * 1024)]), { statusCode: 200, headers: {} }) }), 'A large catalogue page');
});

test('queued titles resolve before download admission, survive restart and preserve manual overrides', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-queue-title-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = { uploads: dir }, calls = [];
  let archive = await openArchive(dir, { library, autoStart: false, lookupTitle: async (options) => {
    assert.deepEqual(Object.keys(options).sort(), ['baseUrl', 'md5', 'signal']); calls.push(options.md5); return 'China: O socialismo do século XXI';
  } }); t.after(() => archive.close());
  const first = archive.queue({ reference: md5 });
  archive.queue({ reference: '1123456789abcdef0123456789abcdef', title: 'My own title' });
  assert.equal(first.titlePending, true); await archive.resolveTitles();
  assert.equal(archive.job(first.id).title, 'China: O socialismo do século XXI'); assert.equal(archive.job(first.id).state, 'queued');
  assert.equal(archive.list()[1].title, 'My own title'); assert.deepEqual(calls, [md5]); archive.close();
  archive = await openArchive(dir, { library, autoStart: false, lookupTitle: async () => assert.fail('Saved titles must be reused') });
  await archive.resolveTitles(); assert.equal(archive.job(first.id).title, 'China: O socialismo do século XXI');
});

test('blocked metadata leaves downloads actionable and a late title cannot revive a cancelled job', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-title-failure-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let release; const held = new Promise((resolve) => { release = resolve; });
  const archive = await openArchive(dir, { library: { uploads: dir }, autoStart: false, lookupTitle: async ({ md5: id }) => {
    if (id === md5) throw new Error('Catalogue unavailable'); await held; return 'A late title';
  } }); t.after(() => archive.close());
  const first = archive.queue({ reference: md5 }); await archive.resolveTitles();
  assert.equal(archive.job(first.id).titlePending, false); assert.equal(archive.job(first.id).state, 'queued'); assert.equal(archive.job(first.id).error, null);
  const second = archive.queue({ reference: '1123456789abcdef0123456789abcdef' });
  const lookup = archive.resolveTitles(); archive.cancel(second.id); release(); await lookup;
  assert.equal(archive.job(second.id).state, 'cancelled'); assert.equal(archive.job(second.id).title, '');
  assert.equal(archive.job(second.id).titlePending, false);
});
