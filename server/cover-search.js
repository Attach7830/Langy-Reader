import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RequestError } from './books.js';
import { downloadCover } from './cover-images.js';
import { waitForOpenLibrary } from './open-library-rate.js';

export const amazonMarkets = ['www.amazon.com','www.amazon.ca','www.amazon.com.mx','www.amazon.com.br','www.amazon.co.uk','www.amazon.de','www.amazon.fr','www.amazon.it','www.amazon.es','www.amazon.co.jp','www.amazon.com.au'];
export async function openCoverSearch(dir,{demo=false,request=fetch,coverDownload=downloadCover,now=Date.now,catalogueDelay=1100}={}) {
  const path=join(dir,'cover-search-settings.json');let config={googleKey:'',amazonId:'',amazonSecret:'',amazonVersion:'3.1',amazonTag:'',amazonMarket:'www.amazon.com'},writing=Promise.resolve(),token;
  if(!demo)try{config={...config,...JSON.parse(await readFile(path,'utf8'))};}catch(error){if(error.code!=='ENOENT')throw error;}
  const results=new Map(),limits=new Map(),searches=new Map(),cooldowns=new Map();
  let settingsVersion=0;
  const settings=()=>({configurable:!demo,hasGoogleKey:Boolean(config.googleKey),amazonConnected:Boolean(config.amazonId&&config.amazonSecret&&config.amazonTag),hasAmazonSecret:Boolean(config.amazonSecret),amazonId:config.amazonId,amazonTag:config.amazonTag,amazonVersion:config.amazonVersion,amazonMarket:config.amazonMarket,markets:amazonMarkets});
  function save(body){const operation=writing.then(async()=>{
    if(demo)throw new RequestError(403,'Cover-provider connections are available on self-hosted installations.');
    const next={...config};for(const key of Object.keys(config)) if(body[key]!==undefined){if(typeof body[key]!=='string'||body[key].length>4096||/[\x00-\x1f]/u.test(body[key]))throw new RequestError(422,'Enter valid cover-provider settings.'); if(body[key].trim())next[key]=body[key].trim();}
    if(body.clearGoogle===true)next.googleKey='';if(body.clearAmazon===true){next.amazonId='';next.amazonSecret='';}
    if(!['3.1','3.2','3.3'].includes(next.amazonVersion)||!amazonMarkets.includes(next.amazonMarket))throw new RequestError(422,'Choose a supported Amazon marketplace and credential version.');
    const temp=path+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(next),{flag:'wx',mode:0o600});await rename(temp,path);config=next;token=undefined;results.clear();searches.clear();cooldowns.clear();settingsVersion++;}finally{await rm(temp,{force:true});}return settings();
  });writing=operation.catch(()=>{});return operation;}
  async function json(url,options={}){
    const host=new URL(url).hostname;
    if(cooldowns.get(host)>now())throw new RequestError(429,'This cover provider is cooling down after reaching its search allowance. Try another source or wait before retrying.');
    let response;try{response=await request(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new RequestError(502,'The cover provider could not be reached. Try again later.');}
    if(!response.ok){
      if(response.status===429){const raw=response.headers.get('Retry-After'),seconds=raw&&Number(raw);const until=Number.isFinite(seconds)&&seconds>=0?now()+seconds*1000:Date.parse(raw);cooldowns.set(host,Math.max(now()+60000,Number.isFinite(until)?until:0));}
      await response.body?.cancel().catch(()=>{});
      throw new RequestError(response.status===429?429:502,[401,403].includes(response.status)?host==='www.googleapis.com'&&!config.googleKey?'Google Books rejected anonymous search. Choose Open Library or add an optional Google Books key in Settings → Book sources → Cover search.':'The cover provider rejected its credentials. Check Settings → Book sources → Cover search.':response.status===429?'The cover provider’s search allowance has been reached. Try another source or wait before retrying.':'The cover provider could not complete this search.');
    }
    let size=0;const chunks=[];for await(const part of response.body){size+=part.length;if(size>2*1024**2)throw new RequestError(502,'The cover provider returned too much data.');chunks.push(part);}
    try{return JSON.parse(Buffer.concat(chunks));}catch{throw new RequestError(502,'The cover provider returned invalid data.');}
  }
  function imageURL(value,provider){
    let url;try{url=new URL(value);}catch{return null;}
    const hosts={google:['books.google.com','books.googleusercontent.com'],openlibrary:['covers.openlibrary.org'],amazon:['m.media-amazon.com','images-na.ssl-images-amazon.com','images-eu.ssl-images-amazon.com','images-fe.ssl-images-amazon.com']};
    const valid=hosts[provider]?.includes(url.hostname);
    if(!valid||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)return null;url.protocol='https:';return url.href;
  }
  async function amazonToken(){
    if(token?.until>now())return token.value;
    const host={'3.1':'api.amazon.com','3.2':'api.amazon.co.uk','3.3':'api.amazon.co.jp'}[config.amazonVersion];
    const result=await json('https://'+host+'/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:config.amazonId,client_secret:config.amazonSecret,scope:'creatorsapi::default'})});
    if(typeof result.access_token!=='string'||!result.access_token)throw new RequestError(502,'Amazon did not return an access token.');
    token={value:result.access_token,until:now()+Math.max(0,Math.min(3600,Number(result.expires_in)||3600)-60)*1000};return token.value;
  }
  async function lookup(provider,body){
    if(provider==='google'){
      const url=new URL('https://www.googleapis.com/books/v1/volumes');url.search=new URLSearchParams({q:'intitle:'+body.title+(body.author?' inauthor:'+body.author:''),printType:'books',maxResults:'12'});
      if(config.googleKey)url.searchParams.set('key',config.googleKey);
      const value=await json(url),items=Array.isArray(value?.items)?value.items:[];
      return items.slice(0,12).flatMap((item)=>{
        if(!item?.volumeInfo||typeof item.id!=='string')return [];
        const info=item.volumeInfo,images=info.imageLinks||{};
        const url=['extraLarge','large','medium','small','thumbnail','smallThumbnail'].map((size)=>imageURL(images[size],provider)).find(Boolean);
        return [{provider,title:info.title,author:Array.isArray(info.authors)?info.authors.filter((name)=>typeof name==='string').join(', '):'',url,source:'https://books.google.com/books?id='+encodeURIComponent(item.id)}];
      });
    }
    if(provider==='openlibrary'){
      const signal=AbortSignal.timeout(20000);await waitForOpenLibrary(signal,catalogueDelay);
      const url=new URL('https://openlibrary.org/search.json');url.search=new URLSearchParams({title:body.title,...(body.author?{author:body.author}:{}),limit:'12',fields:'key,title,author_name,cover_i,cover_edition_key'});
      const value=await json(url,{headers:{Accept:'application/json','User-Agent':'Langy-Reader/0.1 (https://github.com/Attach7830/Langy-Reader)'}}),docs=Array.isArray(value?.docs)?value.docs:[];
      return docs.slice(0,12).flatMap((doc)=>{
        const work=typeof doc?.key==='string'&&doc.key.match(/^(?:\/works\/)?(OL\d+W)$/u),edition=typeof doc?.cover_edition_key==='string'&&/^OL\d+M$/u.test(doc.cover_edition_key)?doc.cover_edition_key:null;
        const image=Number.isSafeInteger(doc?.cover_i)&&doc.cover_i>0?'id/'+doc.cover_i:edition?'olid/'+edition:null;
        if(!image||!work&&!edition)return [];
        return [{provider,title:doc.title,author:Array.isArray(doc.author_name)?doc.author_name.filter((name)=>typeof name==='string').join(', '):'',url:'https://covers.openlibrary.org/b/'+image+'-L.jpg?default=false',source:'https://openlibrary.org/'+(work?'works/'+work[1]:'books/'+edition)}];
      });
    }
    if(provider==='amazon'){
      if(!settings().amazonConnected)throw new RequestError(422,'Connect approved Amazon Creators API credentials in Settings → Book sources → Cover search.');
      const auth=await amazonToken();const value=await json('https://creatorsapi.amazon/catalog/v1/searchItems',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth,'x-marketplace':config.amazonMarket},body:JSON.stringify({title:body.title,...(body.author?{author:body.author}:{}),searchIndex:'Books',itemCount:10,marketplace:config.amazonMarket,partnerTag:config.amazonTag,resources:['images.primary.large','itemInfo.title','itemInfo.byLineInfo']})});
      return (value.searchResult?.items||[]).map((item)=>({provider,title:item.itemInfo?.title?.displayValue,author:item.itemInfo?.byLineInfo?.contributors?.map((part)=>part.name).join(', '),url:item.images?.primary?.large?.url,source:item.detailPageURL}));
    }
  }
  async function search(body,owner=''){
    if(demo)throw new RequestError(403,'Automatic cover search is available on self-hosted installations.');
    if(!['auto','openlibrary','google','amazon'].includes(body.provider)||typeof body.title!=='string'||!body.title.trim()||body.title.length>300||body.author!=null&&(typeof body.author!=='string'||body.author.length>200))throw new RequestError(422,'Enter the book’s title and optional author before searching covers.');
    body={provider:body.provider,title:body.title.trim(),author:body.author?.trim()||''};
    const key=JSON.stringify([owner,settingsVersion,body]),cached=searches.get(key);
    let pending=cached?.until>now()?cached.pending:null;
    if(!pending){
      const recent=limits.get(owner);if(recent&&recent.until>now()&&recent.count>=10)throw new RequestError(429,'Wait a minute before searching more covers.');
      if(recent&&recent.until>now())recent.count++;else limits.set(owner,{until:now()+60000,count:1});
      for(const [id,value]of limits)if(value.until<=now())limits.delete(id);
      for(const [id,value]of searches)if(value.until<=now())searches.delete(id);
      while(searches.size>=100)searches.delete(searches.keys().next().value);
      pending=(async()=>{
        if(body.provider!=='auto')return {entries:await lookup(body.provider,body),notice:''};
        const providers=['openlibrary','google'],found=await Promise.allSettled(providers.map((provider)=>lookup(provider,body)));
        if(found.every((result)=>result.status==='rejected'))throw new RequestError(found.every((result)=>result.reason.status===429)?429:502,'Cover sources are temporarily unavailable. Try again later or choose a different source.');
        const lists=found.map((result)=>result.status==='fulfilled'?result.value:[]);
        return {entries:Array.from({length:12},(_,index)=>lists.flatMap((list)=>list[index]?[list[index]]:[])).flat(),notice:found.flatMap((result,index)=>result.status==='rejected'?[`${providers[index]==='google'?'Google Books':'Open Library'} is temporarily unavailable; showing results from the other source.`]:[]).join(' ')};
      })();
      const record={pending,until:now()+600000};searches.set(key,record);
      pending.catch(()=>{if(searches.get(key)===record)searches.delete(key);});
    }
    const {entries,notice}=await pending,seen=new Set();
    for(const[id,result]of results)if(result.until<=now())results.delete(id);
    return {notice,covers:entries.flatMap((entry)=>{
      const url=imageURL(entry.url,entry.provider);let source;try{source=new URL(entry.source);const hosts={openlibrary:['openlibrary.org'],google:['books.google.com'],amazon:[config.amazonMarket]};if(source.protocol!=='https:'||source.username||source.password||source.port||!hosts[entry.provider]?.includes(source.hostname))return [];}catch{return [];}
      if(!url||seen.has(url)||seen.size>=12)return [];seen.add(url);
      while(results.size>=200)results.delete(results.keys().next().value);
      const id=randomUUID();results.set(id,{owner,url,until:now()+600000});
      return [{id,provider:entry.provider,title:String(entry.title||body.title).slice(0,300),author:String(entry.author||'').slice(0,200),source:source.href,preview:'/api/covers/previews/'+id,...(entry.provider!=='amazon'?{url}:{})}];
    })};
  }
  async function preview(id,owner=''){
    const result=results.get(id);if(!result||result.owner!==owner||result.until<=now())throw new RequestError(404,'Cover search preview expired. Search again.');
    const value=await coverDownload(result.url);return value;
  }
  return {settings,save,search,preview};
}
