import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { maxUpload, RequestError } from './books.js';
import { importNarrationOptions } from './import-narration.js';
import { publicDownload, downloadURL } from './public-download.js';

export async function openBookImports(dir,{library,demo=false,request=publicDownload,autoStart=true,onImport=()=>{},visitorForOwner=(id)=>({id}),activeOwner=()=>true}) {
  const db=new DatabaseSync(join(dir,'book-imports.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;');
  const jobs=new Map(db.prepare('SELECT * FROM jobs ORDER BY rowid').all().map((row)=>[row.id,JSON.parse(row.json)])), controllers=new Map();
  const persist=(job)=>db.prepare('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id,JSON.stringify(job));
  for(const job of jobs.values()) if(['downloading','importing'].includes(job.state)){job.state='queued';persist(job);}
  for(const job of jobs.values())if(job.state==='queued')await rm(join(library.uploads,'web-'+job.id+'.part'),{force:true});
  let running=false,closed=false;
  const owned=(job,visitor)=>(job.owner||'')===(visitor?.id||'');
  const publicJob=({id,state,created,bytes,total,error,book,details})=>({id,state,created,bytes,total,error,book,title:details?.title||''});
  const find=(id,visitor)=>{const job=jobs.get(id);if(!job||!owned(job,visitor))throw new RequestError(404,'Book download not found.');return job;};
  async function pump(){
    if(running||closed||demo)return;running=true;
    try{for(const job of jobs.values()){
      if(closed||job.state!=='queued')continue;
      const path=join(library.uploads,'web-'+job.id+'.part'),controller=new AbortController();controllers.set(job.id,controller);let response;
      try{
        if(!activeOwner(job.owner))throw new RequestError(403,'This account is no longer active.');
        const visitor=visitorForOwner(job.owner);
        let previous;try{previous=library.getBook(job.id,visitor);}catch{}
        if(previous){job.book=previous.id;job.state='ready';persist(job);continue;}
        job.state='downloading';job.bytes=0;job.error=null;persist(job);
        response=await request(job.url,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(1800000)])});
        if(response.statusCode!==200)throw new RequestError(502,'The source did not return a downloadable book. Use its direct EPUB/PDF link or upload a file.');
        job.total=Number(response.headers['content-length'])||null;
        if(job.total>maxUpload)throw new RequestError(413,'Books must be at most 120 MiB.');
        const meter=new Transform({transform(chunk,_encoding,done){job.bytes+=chunk.length;done(job.bytes>maxUpload?new RequestError(413,'Books must be at most 120 MiB.'):null,chunk);}});
        await pipeline(response,meter,createWriteStream(path,{flags:'wx',mode:0o600}),{signal:controller.signal});
        controller.signal.throwIfAborted();
        const file=await open(path,'r'),signature=Buffer.alloc(8);try{await file.read(signature,0,8,0);}finally{await file.close();}
        const format=signature.toString('ascii',0,5)==='%PDF-'?'pdf':signature[0]===0x50&&signature[1]===0x4b?'epub':null;
        if(!format)throw new RequestError(415,'The link returned a web page or unsupported file. Choose a direct EPUB or PDF download.');
        if(!activeOwner(job.owner))throw new RequestError(403,'This account is no longer active.');
        job.state='importing';persist(job);
        const book=await library.importBook(job.id,{path,size:job.bytes,originalname:'download.'+format},job.details,visitor);
        job.book=book.id;job.state='ready';persist(job);try{onImport(book,job.details);}catch{}
      }catch(error){if(job.state!=='cancelled'){job.state='error';job.error=error instanceof RequestError?error.message:'Book download failed. Check the public file link and retry.';}persist(job);}
      finally{response?.destroy();controllers.delete(job.id);await rm(path,{force:true});}
    }}finally{running=false;}
  }
  function queue(body,visitor){
    if(demo)throw new RequestError(403,'Web book imports are available on self-hosted installations.');
    if(!activeOwner(visitor?.id||''))throw new RequestError(403,'This account is no longer active.');
    if(typeof body.url!=='string'||body.url.length>4096)throw new RequestError(422,'Paste a direct public HTTPS EPUB or PDF URL.');
    const url=downloadURL(body.url.trim()).href;
    if([...jobs.values()].filter((job)=>owned(job,visitor)&&['queued','downloading','importing'].includes(job.state)).length>=10)throw new RequestError(409,'Ten book downloads are already queued for this account.');
    if([...jobs.values()].some((job)=>owned(job,visitor)&&job.url===url&&['queued','downloading','importing'].includes(job.state)))throw new RequestError(409,'This link is already queued.');
    const details=Object.fromEntries(['title','author','language','languages','categoryId','coverStyle','coverUrl','shared'].filter((key)=>body[key]!==undefined).map((key)=>[key,body[key]]));
    Object.assign(details,importNarrationOptions(body));
    if(details.categoryId&&!library.snapshot(visitor).categories.some((category)=>category.id===details.categoryId))throw new RequestError(422,'Choose one of your Langy folders.');
    const job={id:randomUUID(),owner:visitor?.id||'',url,details,state:'queued',created:Date.now(),bytes:0,total:null,error:null};jobs.set(job.id,job);persist(job);
    const finished=[...jobs.values()].filter((job)=>!['queued','downloading','importing'].includes(job.state));
    for(const old of finished.slice(0,Math.max(0,jobs.size-300))){jobs.delete(old.id);db.prepare('DELETE FROM jobs WHERE id=?').run(old.id);}
    if(autoStart)void pump();return publicJob(job);
  }
  async function catalogue(query,page=1){
    if(demo)throw new RequestError(403,'Book catalogue imports are available on self-hosted installations.');
    if(typeof query!=='string'||!query.trim()||query.length>160||!Number.isInteger(page)||page<1||page>1000)throw new RequestError(422,'Enter a title or author.');
    const url=new URL('https://gutendex.com/books/');url.search=new URLSearchParams({search:query.trim(),copyright:'false',mime_type:'application/epub+zip',page:String(page)});
    let response;try{
      response=await request(url.href,{signal:AbortSignal.timeout(20000),redirects:0});if(response.statusCode!==200)throw new Error();
      let size=0;const chunks=[];for await(const chunk of response){size+=chunk.length;if(size>2*1024**2)throw new Error();chunks.push(chunk);}
      const result=JSON.parse(Buffer.concat(chunks));if(!Array.isArray(result.results))throw new Error();
      return {more:Boolean(result.next),books:result.results.flatMap((book)=>{
        let file;try{file=downloadURL(book.formats?.['application/epub+zip']);}catch{return [];}
        if(!/(^|\.)gutenberg\.org$/u.test(file.hostname)||book.copyright!==false||!Number.isSafeInteger(book.id))return [];
        return [{id:book.id,title:String(book.title||'Untitled').slice(0,250),author:(book.authors||[]).map((author)=>author.name).join(', ').slice(0,200),language:book.languages?.[0]||'',url:file.href,source:'https://www.gutenberg.org/ebooks/'+book.id}];
      })};
    }catch(error){if(error instanceof RequestError)throw error;throw new RequestError(502,'The Gutenberg catalogue is unavailable. Browse its website and paste a direct EPUB link instead.');}finally{response?.destroy();}
  }
  if(autoStart)void pump();
  return {queue,pump,catalogue,list:(visitor)=>demo?[]:[...jobs.values()].filter((job)=>owned(job,visitor)).map(publicJob),
    cancel(id,visitor){const job=find(id,visitor);if(job.state==='importing')throw new RequestError(409,'The completed book is being saved. Wait for it to finish.');if(['queued','downloading'].includes(job.state)){job.state='cancelled';job.error=null;persist(job);controllers.get(id)?.abort();}return publicJob(job);},
    retry(id,visitor){const job=find(id,visitor);if(!['error','cancelled'].includes(job.state))throw new RequestError(409,'This download is already in progress or finished.');job.state='queued';job.error=null;persist(job);if(autoStart)void pump();return publicJob(job);},
    close(){closed=true;for(const controller of controllers.values())controller.abort();},
  };
}
