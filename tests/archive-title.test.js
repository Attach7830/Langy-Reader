import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivePageTitle, archiveFilenameTitle, archiveRecordTitle, archiveDownloadTitle, lookupArchiveTitle, ArchiveTitleError } from '../server/archive-title.js';
import { openArchive } from '../server/annas-archive.js';
import { openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const md5 = '0123456789abcdef0123456789abcdef';
test('catalogue titles prefer metadata, decode multilingual names and reject fingerprints or verification screens', () => {
  assert.equal(archivePageTitle('<title>Other - Anna’s Archive</title><meta content="China: O socialismo &amp; o século XXI - Anna’s Archive" property="og:title">'), 'China: O socialismo & o século XXI');
  assert.equal(archivePageTitle('<h1><span>中文书名</span></h1>'), '中文书名');
  assert.equal(archivePageTitle('<title>Pedro Páramo — Anna\'s Archive</title>'), 'Pedro Páramo');
  assert.equal(archivePageTitle('<title>Just a moment...</title>'), '');
  assert.equal(archivePageTitle('<title>DDoS-Guard</title>'), '');
  assert.equal(archivePageTitle('<title>Generic title</title><div class="outer"><div class="font-semibold text-2xl leading-[1.2]">中文 &amp; português<span class="select-none"> <a href="/search">🔍</a></span></div></div>'), '中文 & português');
  assert.equal(archivePageTitle(`<meta property="og:title" content="${md5}">`), '');
  assert.equal(archiveFilenameTitle({ 'content-disposition': "attachment; filename*=UTF-8''Ana%20de%20tejas%20verdes.epub" }), 'Ana de tejas verdes');
  assert.equal(archiveFilenameTitle({ 'content-disposition': `attachment; filename="${md5}.pdf"` }), '');
  assert.equal(archiveDownloadTitle('https://files.example/private-token/Pedro%20P%C3%A1ramo.epub?key=not-a-title'), 'Pedro Páramo');
  assert.equal(archiveDownloadTitle('https://files.example/private-token/'+md5+'.epub'), '');
  assert.equal(archiveDownloadTitle('https://files.example/private-token/download?title=not-trusted'), '');
  assert.equal(archiveDownloadTitle('https://files.example/private-token/'+md5+'.epub', { 'content-disposition': 'attachment; filename="A real title.epub"' }), 'A real title');
});

test('authenticated structured metadata stays on the selected origin and never requests a download allowance', async () => {
  const key = 'private-metadata-key', calls = [];
  const title = await lookupArchiveTitle({ baseUrl: 'https://annas-archive.gl', md5, apiKey: key, request: async (url, options) => {
    calls.push(url.pathname); assert.equal(url.origin, 'https://annas-archive.gl'); assert.equal(url.searchParams.get('key'), key); assert.equal(options.redirects, 0);
    assert.throws(() => options.validate(new URL('https://other.example/metadata')), /origin/iu);
    return Object.assign(Readable.from([JSON.stringify({ aarecord: { id: 'md5:'+md5, file_unified_data: { title_best: 'El árbol de la ciencia' } } })]), { statusCode: 200, headers: { 'content-type': 'text/json; charset=utf-8' } });
  } });
  assert.equal(title, 'El árbol de la ciencia'); assert.deepEqual(calls, ['/dyn/api/aarecord_elasticsearch/md5:'+md5+'.json']);
  assert.equal(archiveRecordTitle({ aarecord: { id:'md5:wrong', file_unified_data: { title_best: 'Wrong edition' } } },md5),'');
});

test('metadata permission failures fall back to the public heading without forwarding the key; blocked pages report a safe reason', async () => {
  const request = async (url) => {
    if (url.pathname.startsWith('/dyn/')) return Object.assign(Readable.from(['{"error":"Account not allowed to use special APIs"}']), { statusCode: 403, headers: {} });
    assert.equal(url.search, '');
    return Object.assign(Readable.from(['<div class="font-semibold text-2xl">Ana de tejas verdes</div>']), { statusCode: 200, headers: { 'content-type':'text/html' } });
  };
  assert.equal(await lookupArchiveTitle({ baseUrl:'https://annas-archive.gl',md5,apiKey:'private',request }), 'Ana de tejas verdes');
  await assert.rejects(lookupArchiveTitle({baseUrl:'https://annas-archive.gl',md5,request:async()=>Object.assign(Readable.from(['<title>DDoS-Guard</title>']),{statusCode:403,headers:{}})}),error=>error instanceof ArchiveTitleError && error.code==='blocked' && !error.message.includes(md5));
});

test('failed queued titles back off, survive restarts and recover without restarting the download', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-title-retry-')); t.after(() => rm(dir,{recursive:true,force:true}));
  let clock=1000,calls=0;
  const options={ library:{uploads:dir},autoStart:false,now:()=>clock,lookupTitle:async()=>{calls++;if(calls===1)throw new ArchiveTitleError('blocked');return 'A recovered title';}};
  let archive=await openArchive(dir,options); t.after(()=>archive.close());
  const job=archive.queue({reference:md5}); await archive.resolveTitles();
  assert.equal(archive.job(job.id).titleError,'blocked'); assert.equal(archive.job(job.id).titlePending,false); assert.equal(archive.job(job.id).attempts,0);
  const due=archive.job(job.id).titleRetryAt; assert.ok(due>clock); await archive.resolveTitles(); assert.equal(calls,1);
  archive.close(); archive=await openArchive(dir,options); await archive.resolveTitles(); assert.equal(calls,1);
  clock=due; await archive.resolveTitles(); assert.equal(archive.job(job.id).title,'A recovered title'); assert.equal(archive.job(job.id).state,'queued'); assert.equal(archive.job(job.id).attempts,0);
});

test('manual titles apply to existing owned jobs and win over late metadata while title retries leave download state alone', async (t) => {
  const dir=await mkdtemp(join(tmpdir(),'langy-title-owned-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let release;const held=new Promise(resolve=>{release=resolve;});let calls=0;
  const archive=await openArchive(dir,{library:{uploads:dir},autoStart:false,lookupTitle:async()=>{calls++;await held;return 'A late catalogue title';}});t.after(()=>archive.close());
  const owner={id:'one'},job=archive.queue({reference:md5},owner),work=archive.resolveTitles();
  assert.throws(()=>archive.setTitle(job.id,{title:'Not yours'},{id:'two'}),/not found/iu);
  archive.setTitle(job.id,{title:'My chosen title'},owner);release();await work;
  assert.equal(archive.job(job.id,owner).title,'My chosen title');assert.equal(archive.job(job.id,owner).state,'queued');assert.equal(archive.job(job.id,owner).attempts,0);assert.equal(calls,1);
  assert.throws(()=>archive.setTitle(job.id,{title:md5},owner),/book title/iu);
  assert.equal(archive.retryTitle(job.id,owner).state,'queued');
});

test('an actual download supplies a readable queue name before bytes arrive without persisting its signed URL', async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'langy-title-file-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const library=await openLibrary(dir),bytes=await sampleBook(),hash=createHash('md5').update(bytes).digest('hex');
  const key='private-existing-key',token='private-signed-token';let release;const held=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const archive=await openArchive(dir,{library,autoStart:false,lookupTitle:async(options)=>{assert.equal(options.apiKey,key);throw new ArchiveTitleError('blocked');},request:async(url)=>{
    if(url.pathname==='/dyn/api/fast_download.json')return Object.assign(Readable.from([Buffer.from(JSON.stringify({download_url:'https://files.example/private/A%20readable%20book.epub?token='+token}))]),{statusCode:200,headers:{}});
    return Object.assign(Readable.from((async function*(){await held;yield bytes;})()),{statusCode:200,headers:{'content-type':'application/epub+zip'}});
  }});t.after(()=>archive.close());await archive.save({apiKey:key});const job=archive.queue({reference:hash});await archive.resolveTitles();
  const work=archive.pump();for(let i=0;i<100&&!archive.job(job.id).title;i++)await delay(5);
  assert.equal(archive.job(job.id).title,'A readable book');assert.equal(archive.job(job.id).state,'downloading');
  release();await work;assert.equal(archive.job(job.id).state,'ready');assert.equal(archive.job(job.id).attempts,1);
  const db=new DatabaseSync(join(dir,'archive-jobs.sqlite'),{readOnly:true});const saved=db.prepare('SELECT json FROM jobs').get().json;db.close();
  assert.equal(saved.includes(token),false);assert.equal(saved.includes(key),false);
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
