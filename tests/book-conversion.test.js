import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir, chmod, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { bookConverter } from '../server/book-conversion.js';
import { openBookImports } from '../server/book-imports.js';
import { openLibrary } from '../server/books.js';
import { detectBookMetadata } from '../src/book-metadata.js';
import { conversionLimit } from '../shared/import-formats.js';

const execute = promisify(execFile), binary = process.env.LANGY_PANDOC_BIN || 'pandoc';
async function setup(t) { const dir = await mkdtemp(join(tmpdir(), 'langy-convert-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function contents(path) { const zip = await JSZip.loadAsync(await readFile(path)); return (await Promise.all(Object.values(zip.files).filter((file) => /\.(xhtml|opf)$/u.test(file.name)).map((file) => file.async('string')))).join('\n'); }

test('sandboxed conversion preserves multilingual text and embedded Word images across the supported formats', async (t) => {
  const dir = await setup(t), source = join(dir, 'source.md');
  await writeFile(source, '# A small story\n\nUna historia em português. 这是一个故事。\n\n![A dot](pixel.png)\n');
  await writeFile(join(dir, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const convert = bookConverter({ binary });
  for (const format of ['txt','md','html','docx','odt','rtf','fb2']) {
    const path = join(dir, 'input.' + format);
    if (format === 'txt') await writeFile(path, 'Una historia em português. 这是一个故事。\n\n<This stays literal>');
    else if (format === 'md') await writeFile(path, await readFile(source));
    else await execute(binary, [source, '--resource-path=' + dir, '--metadata=title:Embedded title', '--metadata=author:A Writer', '-o', path]);
    const output = await convert({ path, originalname: 'input.' + format });
    const result = await contents(output.path); assert.match(result, /historia/u, format); assert.match(result, /这是一个故事/u, format);
    if (format === 'txt') assert.match(result, /&lt;This stays literal&gt;/u);
    if (format === 'docx') { const metadata=await detectBookMetadata(new File([await readFile(path)],'import.docx')); assert.equal(metadata.title,'Embedded title'); assert.equal(metadata.author,'A Writer'); const zip = await JSZip.loadAsync(await readFile(output.path)); assert.ok(Object.keys(zip.files).some((name) => /media\/.*\.png$/u.test(name))); }
    await output.cleanup(); assert.ok((await readFile(path)).length);
  }
});

test('conversion never imports private files, remote images, scripts, source options or XML entities', async (t) => {
  const dir = await setup(t), source = join(dir, 'unsafe.html'), secret = join(dir, 'secret.txt');
  await writeFile(secret, 'PRIVATE_FILE_MARKER');
  await writeFile(source, `<html><head><meta name="cover-image" content="${secret}"></head><body><h1>Readable text</h1><script>EVIL_SCRIPT_MARKER</script><iframe src="file://${secret}"></iframe><p onclick="evil()">A story.</p><img src="file://${secret}" alt="local"><img src="http://127.0.0.1:1/should-not-fetch" alt="remote"><a href="javascript:evil()">unsafe</a><a href="file://${secret}">local link</a></body></html>`);
  const output = await bookConverter({ binary })({ path: source, originalname: 'unsafe.html' });
  const value = await contents(output.path); assert.doesNotMatch(value, /PRIVATE_FILE_MARKER|EVIL_SCRIPT_MARKER|onclick|javascript:|file:\/\/|127\.0\.0\.1|<iframe/u); assert.match(value, /Readable text/u); await output.cleanup();
  await writeFile(source, '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><html><body>&secret;</body></html>');
  await assert.rejects(bookConverter({ binary })({ path: source, originalname: 'unsafe.html' }), { status: 422 });
});

test('conversion rejects empty and oversized sources, malformed containers and stalled converters', async (t) => {
  const dir = await setup(t), source = join(dir, 'source.txt'), convert = bookConverter({ binary });
  await writeFile(source, ''); await assert.rejects(convert({ path: source, originalname: 'empty.txt' }), { status: 413 });
  await truncate(source, conversionLimit + 1); await assert.rejects(convert({ path: source, originalname: 'big.txt' }), { status: 413 });
  await writeFile(source, 'not a ZIP'); await assert.rejects(convert({ path: source, originalname: 'broken.docx' }), { status: 422 });
  const stalled = join(dir, 'stalled'); await writeFile(stalled, '#!' + process.execPath + '\nsetTimeout(()=>{},30000);\n'); await chmod(stalled, 0o700);
  await assert.rejects(bookConverter({ binary: stalled, timeout: 50 })({ path: source, originalname: 'source.txt' }), { status: 422 });
  assert.equal((await readdir(dir)).some((name) => name.startsWith('convert-')), false);
});

test('queued document conversion survives restart and preserves private series/folder choices', async (t) => {
  const dir = await setup(t), library = await openLibrary(dir), visitor = { id: 'owner' }; let service;
  const options = { library, autoStart: false, convert: bookConverter({ binary }) };
  t.after(() => service.close()); service = await openBookImports(dir, options);
  library.saveCategory('folder', { name: 'Portuguese', language: 'pt' }, true, visitor);
  const path = join(library.uploads, 'uploaded.txt'); await writeFile(path, 'Uma história muito interessante. Era uma vez um menino que gostava de ler livros.');
  const job = await service.queueFile({ path, originalname: 'Story.txt' }, { title: 'A story', series: 'Stories', seriesIndex: '1.5', categoryId: 'folder' }, visitor);
  assert.equal(job.kind, 'conversion'); assert.deepEqual(service.list({ id: 'other' }), []);
  service.close(); service = await openBookImports(dir, options); await service.pump();
  const done = service.list(visitor)[0]; assert.equal(done.state, 'ready', done.error);
  const book = library.getBook(done.book, visitor); assert.equal(book.format, 'epub'); assert.equal(book.seriesIndex, 1.5); assert.equal(book.categoryId, 'folder'); assert.equal(book.language, 'pt');
  assert.deepEqual(await readdir(library.uploads), []);
});


test('cancelling active EPUB conversion aborts its worker and removes temporary source files',async(t)=>{
  const dir=await setup(t),library=await openLibrary(dir);let started;const entered=new Promise((resolve)=>{started=resolve;});
  const service=await openBookImports(dir,{library,autoStart:false,convert:async(_file,{signal})=>{started();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});t.after(()=>service.close());
  const path=join(library.uploads,'source.txt');await writeFile(path,'A small story.');const visitor={id:'reader'},job=await service.queueFile({path,originalname:'source.txt'},{},visitor),running=service.pump();await entered;
  assert.equal(service.list(visitor)[0].state,'converting');assert.throws(()=>service.cancel(job.id,{id:'other'}),{status:404});service.cancel(job.id,visitor);await running;
  assert.equal(service.list(visitor)[0].state,'cancelled');assert.deepEqual(await readdir(library.uploads),[]);assert.equal(library.snapshot(visitor).books.length,0);
});
