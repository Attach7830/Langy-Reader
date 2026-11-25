import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openLibrary} from '../server/books.js';
import {openBookImports} from '../server/book-imports.js';
import {sampleBook} from '../server/sample.js';

const response=(value)=>Object.assign(Readable.from([Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value))]),{statusCode:200,headers:{}});
test('queued web imports retain folder/audio options through restart, reject HTML, and expose only their owner’s jobs',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'langy-web-import-')),library=await openLibrary(dir),bytes=await sampleBook();let service;const owner={id:'reader'},other={id:'other'};
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  library.saveCategory('private-folder',{name:'Reading'},true,owner);
  let options;const settings={library,autoStart:false,onImport:(_book,details)=>{options=details;},request:async(url)=>url.includes('html')?response(Buffer.from('<html>Not a book</html>')):response(bytes)};
  service=await openBookImports(dir,settings);
  for(const url of ['http://example.test/book.pdf','https://127.0.0.1/book.epub'])assert.throws(()=>service.queue({url},owner),{status:422});
  const queued=service.queue({url:'https://example.test/book.epub',categoryId:'private-folder',title:'From a public source',autoAudiobook:true,audiobookDelayMinutes:9},owner);
  service.close();service=await openBookImports(dir,settings);await service.pump();
  const done=service.list(owner).find((job)=>job.id===queued.id);assert.equal(done.state,'ready',done.error);assert.deepEqual(service.list(other),[]);
  const book=library.getBook(done.book,owner);assert.equal(book.categoryId,'private-folder');assert.equal(book.title,'From a public source');assert.deepEqual(await readFile(library.filePath(book)),bytes);assert.equal(options.audiobookDelayMinutes,9);
  const bad=service.queue({url:'https://example.test/html'},owner);await service.pump();assert.equal(service.list(owner).find((job)=>job.id===bad.id).state,'error');
  assert.throws(()=>library.getBook(bad.id,owner),{status:404});assert.deepEqual(await readdir(library.uploads),[]);
  const waiting=service.queue({url:'https://example.test/wait.epub'},owner);assert.throws(()=>service.cancel(waiting.id,other),{status:404});service.cancel(waiting.id,owner);await service.pump();assert.equal(service.list(owner).find((job)=>job.id===waiting.id).state,'cancelled');
});

test('Gutenberg catalogue uses the documented search schema and accepts only Gutenberg EPUB acquisitions',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'langy-gutenberg-')),library=await openLibrary(dir);const service=await openBookImports(dir,{library,autoStart:false,request:async(value)=>{
    const url=new URL(value);assert.equal(url.hostname,'gutendex.com');assert.equal(url.searchParams.get('search'),'Dickens');assert.equal(url.searchParams.get('copyright'),'false');
    return response({next:null,results:[{id:1,title:'A classic',authors:[{name:'Writer'}],languages:['en'],copyright:false,formats:{'application/epub+zip':'https://www.gutenberg.org/ebooks/1.epub3.images'}},{id:2,title:'Unsafe',copyright:false,formats:{'application/epub+zip':'https://127.0.0.1/private.epub'}}]});
  }});t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const result=await service.catalogue('Dickens');assert.equal(result.books.length,1);assert.equal(result.books[0].author,'Writer');assert.equal(result.books[0].language,'en');assert.equal(result.more,false);
});
