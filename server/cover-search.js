import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RequestError } from './books.js';
import { downloadCover } from './cover-images.js';

export const amazonMarkets = ['www.amazon.com','www.amazon.ca','www.amazon.com.mx','www.amazon.com.br','www.amazon.co.uk','www.amazon.de','www.amazon.fr','www.amazon.it','www.amazon.es','www.amazon.co.jp','www.amazon.com.au'];
export async function openCoverSearch(dir,{demo=false,request=fetch,coverDownload=downloadCover,now=Date.now}={}) {
  const path=join(dir,'cover-search-settings.json');let config={googleKey:'',amazonId:'',amazonSecret:'',amazonVersion:'3.1',amazonTag:'',amazonMarket:'www.amazon.com'},writing=Promise.resolve(),token;
  if(!demo)try{config={...config,...JSON.parse(await readFile(path,'utf8'))};}catch(error){if(error.code!=='ENOENT')throw error;}
  const results=new Map(),limits=new Map();
  const settings=()=>({configurable:!demo,hasGoogleKey:Boolean(config.googleKey),amazonConnected:Boolean(config.amazonId&&config.amazonSecret&&config.amazonTag),hasAmazonSecret:Boolean(config.amazonSecret),amazonId:config.amazonId,amazonTag:config.amazonTag,amazonVersion:config.amazonVersion,amazonMarket:config.amazonMarket,markets:amazonMarkets});
  function save(body){const operation=writing.then(async()=>{
    if(demo)throw new RequestError(403,'Cover-provider connections are available on self-hosted installations.');
    const next={...config};for(const key of Object.keys(config)) if(body[key]!==undefined){if(typeof body[key]!=='string'||body[key].length>4096||/[\x00-\x1f]/u.test(body[key]))throw new RequestError(422,'Enter valid cover-provider settings.'); if(body[key].trim())next[key]=body[key].trim();}
    if(body.clearGoogle===true)next.googleKey='';if(body.clearAmazon===true){next.amazonId='';next.amazonSecret='';}
    if(!['3.1','3.2','3.3'].includes(next.amazonVersion)||!amazonMarkets.includes(next.amazonMarket))throw new RequestError(422,'Choose a supported Amazon marketplace and credential version.');
    const temp=path+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(next),{flag:'wx',mode:0o600});await rename(temp,path);config=next;token=undefined;results.clear();}finally{await rm(temp,{force:true});}return settings();
  });writing=operation.catch(()=>{});return operation;}
  async function json(url,options={}){
    let response;try{response=await request(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new RequestError(502,'The cover provider could not be reached. Try again later.');}
    if(!response.ok)throw new RequestError(response.status===429?429:502,[401,403].includes(response.status)?'The cover provider rejected its credentials. Check Settings → Book sources → Cover search.':response.status===429?'The cover provider’s search allowance has been reached. Try again later.':'The cover provider could not complete this search.');
    let size=0;const chunks=[];for await(const part of response.body){size+=part.length;if(size>2*1024**2)throw new RequestError(502,'The cover provider returned too much data.');chunks.push(part);}
    try{return JSON.parse(Buffer.concat(chunks));}catch{throw new RequestError(502,'The cover provider returned invalid data.');}
  }
  function imageURL(value,provider){
    let url;try{url=new URL(value);}catch{return null;}
    const valid=provider==='google'?['books.google.com','books.googleusercontent.com'].includes(url.hostname):['m.media-amazon.com','images-na.ssl-images-amazon.com','images-eu.ssl-images-amazon.com','images-fe.ssl-images-amazon.com'].includes(url.hostname);
    if(!valid||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)return null;url.protocol='https:';return url.href;
  }
  async function amazonToken(){
    if(token?.until>now())return token.value;
    const host={'3.1':'api.amazon.com','3.2':'api.amazon.co.uk','3.3':'api.amazon.co.jp'}[config.amazonVersion];
    const result=await json('https://'+host+'/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:config.amazonId,client_secret:config.amazonSecret,scope:'creatorsapi::default'})});
    if(typeof result.access_token!=='string'||!result.access_token)throw new RequestError(502,'Amazon did not return an access token.');
    token={value:result.access_token,until:now()+Math.max(0,Math.min(3600,Number(result.expires_in)||3600)-60)*1000};return token.value;
  }
  async function search(body,owner=''){
    if(demo)throw new RequestError(403,'Automatic cover search is available on self-hosted installations.');
    if(!['google','amazon'].includes(body.provider)||typeof body.title!=='string'||!body.title.trim()||body.title.length>300||body.author!=null&&(typeof body.author!=='string'||body.author.length>200))throw new RequestError(422,'Enter the book’s title and optional author before searching covers.');
    const recent=limits.get(owner);if(recent&&recent.until>now()&&recent.count>=10)throw new RequestError(429,'Wait a minute before searching more covers.');
    if(recent&&recent.until>now())recent.count++;else limits.set(owner,{until:now()+60000,count:1});
    if(limits.size>1000)for(const [key,value]of limits)if(value.until<=now())limits.delete(key);
    let entries;
    if(body.provider==='google'){
      if(!config.googleKey)throw new RequestError(422,'Add a Google Books API key in Settings → Book sources → Cover search.');
      const url=new URL('https://www.googleapis.com/books/v1/volumes');url.search=new URLSearchParams({q:'intitle:'+body.title.trim()+(body.author?.trim()?' inauthor:'+body.author.trim():''),printType:'books',maxResults:'12',key:config.googleKey});
      const value=await json(url);entries=(value.items||[]).map((item)=>({title:item.volumeInfo?.title,author:item.volumeInfo?.authors?.join(', '),url:item.volumeInfo?.imageLinks?.thumbnail||item.volumeInfo?.imageLinks?.smallThumbnail,source:'https://books.google.com/books?id='+encodeURIComponent(item.id)}));
    }else{
      if(!settings().amazonConnected)throw new RequestError(422,'Connect approved Amazon Creators API credentials in Settings → Book sources → Cover search.');
      const auth=await amazonToken();const value=await json('https://creatorsapi.amazon/catalog/v1/searchItems',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth,'x-marketplace':config.amazonMarket},body:JSON.stringify({title:body.title.trim(),...(body.author?.trim()?{author:body.author.trim()}:{}),searchIndex:'Books',itemCount:10,marketplace:config.amazonMarket,partnerTag:config.amazonTag,resources:['images.primary.large','itemInfo.title','itemInfo.byLineInfo']})});
      entries=(value.searchResult?.items||[]).map((item)=>({title:item.itemInfo?.title?.displayValue,author:item.itemInfo?.byLineInfo?.contributors?.map((part)=>part.name).join(', '),url:item.images?.primary?.large?.url,source:item.detailPageURL}));
    }
    for(const[id,result]of results)if(result.until<=now())results.delete(id);
    return {covers:entries.slice(0,12).flatMap((entry)=>{
      const url=imageURL(entry.url,body.provider);let source;try{source=new URL(entry.source);if(source.protocol!=='https:'||source.username||source.password||![config.amazonMarket,'books.google.com'].includes(source.hostname))return [];}catch{return [];}
      if(!url)return [];while(results.size>=200)results.delete(results.keys().next().value);
      const id=randomUUID();results.set(id,{owner,url,until:now()+600000});
      return [{id,provider:body.provider,title:String(entry.title||body.title).slice(0,300),author:String(entry.author||'').slice(0,200),source:source.href,preview:'/api/covers/previews/'+id,...(body.provider==='google'?{url}:{})}];
    })};
  }
  async function preview(id,owner=''){
    const result=results.get(id);if(!result||result.owner!==owner||result.until<=now())throw new RequestError(404,'Cover search preview expired. Search again.');
    const value=await coverDownload(result.url);return value;
  }
  return {settings,save,search,preview};
}
