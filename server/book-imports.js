import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { maxUpload, RequestError } from './books.js';
import { importNarrationOptions } from './import-narration.js';
import { publicDownload, downloadURL } from './public-download.js';
import { bookConverter } from './book-conversion.js';
import { conversionLimit, convertsToEPUB } from '../shared/import-formats.js';
import { consumeProcesses, PROCESS_YIELD, watchProcessPriority } from './process-scheduler.js';

const pending = new Set(['queued','downloading','converting','importing']);

export async function openBookImports(dir,{library,demo=false,request=publicDownload,autoStart=true,onImport=()=>{},visitorForOwner=(id)=>({id}),activeOwner=()=>true,convert=bookConverter(),connector=null,reserveStorage=async()=>()=>{},scheduler}) {
  const db=new DatabaseSync(join(dir,'book-imports.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;');
  const jobs=new Map(db.prepare('SELECT * FROM jobs ORDER BY rowid').all().map((row)=>[row.id,JSON.parse(row.json)])), controllers=new Map();
  const persist=(job)=>db.prepare('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id,JSON.stringify(job));
  for(const job of jobs.values()) if(['downloading','converting','importing'].includes(job.state)){job.state='queued';persist(job);}
  for(const job of jobs.values())if(job.state==='queued')await rm(join(library.uploads,'web-'+job.id+'.part'),{force:true});
  let running=false,closed=false;
  const owned=(job,visitor)=>(job.owner||'')===(visitor?.id||'');
  const publicJob=({id,state,created,bytes,total,error,book,details,kind='web',name})=>({id,state,created,bytes,total,error,book,kind,title:details?.title||name||'',retryable:kind!=='conversion'});
  const find=(id,visitor)=>{const job=jobs.get(id);if(!job||!owned(job,visitor))throw new RequestError(404,'Book download not found.');return job;};
  async function pump(){
    if(running||closed||![...jobs.values()].some((job)=>job.state==='queued'))return;running=true;
    try{await consumeProcesses(scheduler,()=>closed?[]:[...jobs.values()].filter((job)=>job.state==='queued').map((job)=>({
      id:`${job.kind==='conversion'?'conversion':job.kind==='kavita'?'kavita-import':'web-import'}:${job.id}`,created:job.created,data:job,
    })),async(job)=>{
      const path=join(library.uploads,'web-'+job.id+'.part'),source=join(library.uploads,'source-'+job.id),controller=new AbortController();controllers.set(job.id,controller);let response,converted,release=()=>{},yielding=false;
      const stopPriority=watchProcessPriority(scheduler,()=>{yielding=true;controller.abort();},()=>['queued','downloading','converting'].includes(job.state));
      try{
        if (demo && (!job.expires || job.expires <= Date.now())) throw new RequestError(410,'Your demo session expired. Upload the document again.');
        if(!activeOwner(job.owner))throw new RequestError(403,'This account is no longer active.');
        const visitor={...visitorForOwner(job.owner),...(job.expires?{expires:job.expires}:{})};
        let previous;try{previous=library.getBook(job.id,visitor);}catch{}
        if(previous){job.book=previous.id;job.state='ready';persist(job);return;}
        let file;
        if(job.kind==='conversion'){
          file={path:source,size:(await stat(source)).size,originalname:job.name};
          release=await reserveStorage(job.owner,file.size);
        }else{
          job.state='downloading';job.bytes=0;job.error=null;persist(job);
          response=job.kind==='kavita' ? await connector.download(job.selection,visitor,controller.signal)
            : await request(job.url,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(1800000)])});
          if(response.statusCode!==200)throw new RequestError(502,'The source did not return a downloadable book. Check the connection or direct file link.');
          job.total=Number(response.headers['content-length'])||null;
          if(job.total>maxUpload)throw new RequestError(413,'Books must be at most 120 MiB.');
          release=await reserveStorage(job.owner,job.total||maxUpload);
          const meter=new Transform({transform(chunk,_encoding,done){job.bytes+=chunk.length;done(job.bytes>maxUpload?new RequestError(413,'Books must be at most 120 MiB.'):null,chunk);}});
          await pipeline(response,meter,createWriteStream(path,{flags:'wx',mode:0o600}),{signal:controller.signal});
          controller.signal.throwIfAborted();
          const handle=await open(path,'r'),signature=Buffer.alloc(8);try{await handle.read(signature,0,8,0);}finally{await handle.close();}
          const format=signature.toString('ascii',0,5)==='%PDF-'?'pdf':signature[0]===0x50&&signature[1]===0x4b?'epub':null;
          if(!format)throw new RequestError(415,'The link returned a web page or unsupported file. Choose an EPUB or PDF download.');
          file={path,size:job.bytes,originalname:'download.'+format};
        }
        if(job.kind==='conversion'){
          job.state='converting';persist(job);
          converted=await convert(file,{signal:controller.signal,details:job.details});file=converted;
        }
        controller.signal.throwIfAborted();
        if(!activeOwner(job.owner))throw new RequestError(403,'This account is no longer active.');
        job.state='importing';persist(job);release();release=()=>{};
        const book=await library.importBook(job.id,file,job.details,visitor);
        job.book=book.id;job.state='ready';persist(job);try{onImport(book,job.details);}catch{}
      }catch(error){
        if(yielding&&job.state!=='cancelled'){job.state='queued';job.error=null;if(job.kind!=='conversion')job.bytes=0;persist(job);return PROCESS_YIELD;}
        if(job.state!=='cancelled'){job.state='error';job.error=error instanceof RequestError?error.message:job.kind==='conversion'?'Document conversion failed. Upload the source again to retry.':'Book download failed. Check the source and retry.';}persist(job);
      }
      finally{stopPriority();response?.destroy();controllers.delete(job.id);release();await converted?.cleanup();await Promise.all([path,...(yielding&&job.state==='queued'?[]:[source])].map((file)=>rm(file,{force:true})));}
    });}finally{running=false;if(autoStart&&!closed&&[...jobs.values()].some((job)=>job.state==='queued'))queueMicrotask(()=>void pump());}
  }
  function validate(visitor){
    if(!activeOwner(visitor?.id||''))throw new RequestError(403,'This account is no longer active.');
    if([...jobs.values()].filter((job)=>owned(job,visitor)&&pending.has(job.state)).length>=10)throw new RequestError(409,'Ten book imports are already queued for this account.');
    if([...jobs.values()].filter((job)=>pending.has(job.state)).length>=40)throw new RequestError(503,'The import queue is full. Try again after a book finishes.');
  }
  function detailsFor(body,visitor){
    const details=Object.fromEntries(['title','author','language','languages','categoryId','coverStyle','coverUrl','shared','shareWith','series','seriesIndex'].filter((key)=>body[key]!==undefined).map((key)=>[key,body[key]]));
    Object.assign(details,importNarrationOptions(body));
    if(details.categoryId&&!library.snapshot(visitor).categories.some((category)=>category.id===details.categoryId))throw new RequestError(422,'Choose one of your Langy folders.');
    return details;
  }
  function add(job){
    jobs.set(job.id,job);persist(job);
    const finished=[...jobs.values()].filter((job)=>!pending.has(job.state));
    for(const old of finished.slice(0,Math.max(0,jobs.size-300))){jobs.delete(old.id);db.prepare('DELETE FROM jobs WHERE id=?').run(old.id);}
    if(autoStart)void pump();return publicJob(job);
  }
  function queue(body,visitor){
    if(demo)throw new RequestError(403,'Web book imports are available on self-hosted installations.');
    validate(visitor);
    if(typeof body.url!=='string'||body.url.length>4096)throw new RequestError(422,'Paste a direct public HTTPS EPUB or PDF URL.');
    const url=downloadURL(body.url.trim()).href;
    if([...jobs.values()].some((job)=>owned(job,visitor)&&job.url===url&&pending.has(job.state)))throw new RequestError(409,'This link is already queued.');
    return add({id:randomUUID(),owner:visitor?.id||'',url,details:detailsFor(body,visitor),state:'queued',created:Date.now(),bytes:0,total:null,error:null});
  }
  async function queueFile(file,body,visitor){
    let source,release=()=>{};
    try{
      validate(visitor);
      if(!file||!convertsToEPUB(file.originalname))throw new RequestError(415,'Choose TXT, Markdown, HTML, DOCX, ODT, RTF or FB2 for EPUB conversion.');
      const size=(await stat(file.path)).size;
      if(!size||size>conversionLimit)throw new RequestError(413,'Documents for conversion must be nonempty and at most 30 MiB.');
      const details=detailsFor(body,visitor),id=randomUUID();
      release=await reserveStorage(visitor?.id||'',size);
      source=join(library.uploads,'source-'+id);await rename(file.path,source);
      validate(visitor);
      return add({id,kind:'conversion',owner:visitor?.id||'',expires:visitor?.expires,details,name:file.originalname.slice(0,250),state:'queued',created:Date.now(),bytes:size,total:size,error:null});
    }catch(error){if(source)await rm(source,{force:true});throw error;}
    finally{release();if(file?.path)await rm(file.path,{force:true});}
  }
  function queueKavita(body,visitor){
    if(demo||!connector)throw new RequestError(403,'Kavita imports are available on self-hosted installations.');
    validate(visitor);const selection=connector.selection(body.item,visitor);
    const details=detailsFor({...selection.details,...body},visitor);
    if([...jobs.values()].some((job)=>owned(job,visitor)&&job.kind==='kavita'&&job.selection.url===selection.url&&pending.has(job.state)))throw new RequestError(409,'This book is already queued.');
    return add({id:randomUUID(),kind:'kavita',owner:visitor?.id||'',selection,details,state:'queued',created:Date.now(),bytes:0,total:null,error:null});
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
  return {queue,queueFile,queueKavita,pump,catalogue,list:(visitor)=>[...jobs.values()].filter((job)=>owned(job,visitor)).map(publicJob),
    cancel(id,visitor){const job=find(id,visitor);if(job.state==='importing')throw new RequestError(409,'The completed book is being saved. Wait for it to finish.');if(['queued','downloading','converting'].includes(job.state)){job.state='cancelled';job.error=null;persist(job);controllers.get(id)?.abort();if(!controllers.has(id))void rm(join(library.uploads,'source-'+id),{force:true});}return publicJob(job);},
    retry(id,visitor){const job=find(id,visitor);if(job.kind==='conversion')throw new RequestError(409,'Upload the source document again to retry conversion.');if(!['error','cancelled'].includes(job.state))throw new RequestError(409,'This download is already in progress or finished.');job.state='queued';job.error=null;persist(job);if(autoStart)void pump();return publicJob(job);},
    close(){closed=true;for(const controller of controllers.values())controller.abort();},
  };
}
