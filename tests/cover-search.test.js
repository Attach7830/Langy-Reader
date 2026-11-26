import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openCoverSearch} from '../server/cover-search.js';

test('cover search uses server-side credentials, private expiring previews and the actual Google/Amazon API schemas',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'langy-cover-search-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls=[];let time=1000,unsafe=false;
  const service=await openCoverSearch(dir,{now:()=>time,coverDownload:async(url)=>({thumbnail:Buffer.from(url),thumbnailType:'image/png'}),request:async(value,options)=>{
    const url=new URL(value);calls.push({url,options});assert.equal(options.redirect,'error');
    if(url.hostname==='www.googleapis.com'){assert.equal(url.searchParams.get('key'),'synthetic-google-key');return Response.json({items:[{id:'edition',volumeInfo:{title:'Test edition',authors:['A Writer'],imageLinks:{thumbnail:unsafe?'http://127.0.0.1/private':'http://books.google.com/books/content?id=edition'}}}]});}
    if(url.hostname==='api.amazon.com'){assert.equal(JSON.parse(options.body).client_secret,'synthetic-amazon-secret');return Response.json({access_token:'synthetic-access-token',expires_in:3600});}
    assert.equal(url.href,'https://creatorsapi.amazon/catalog/v1/searchItems');assert.equal(options.headers.Authorization,'Bearer synthetic-access-token');
    assert.equal(JSON.parse(options.body).searchIndex,'Books');assert.equal(JSON.parse(options.body).partnerTag,'reader-20');
    return Response.json({searchResult:{items:[{asin:'B012345678',detailPageURL:'https://www.amazon.com/dp/B012345678?tag=reader-20',images:{primary:{large:{url:'https://m.media-amazon.com/images/I/book.jpg'}}},itemInfo:{title:{displayValue:'Amazon edition'}}}]}});
  }});
  await assert.rejects(service.search({provider:'amazon',title:'Test'},'one'),{status:422});
  await service.save({googleKey:'synthetic-google-key',amazonId:'test-client',amazonSecret:'synthetic-amazon-secret',amazonTag:'reader-20'});
  assert.equal((await stat(join(dir,'cover-search-settings.json'))).mode&0o777,0o600);
  assert.equal(/synthetic-/u.test(JSON.stringify(service.settings())),false);
  const google=(await service.search({provider:'google',title:'Test',author:'A Writer'},'one')).covers[0];assert.equal(new URL(google.url).protocol,'https:');
  await service.preview(google.id,'one');await assert.rejects(service.preview(google.id,'two'),{status:404});
  const amazon=(await service.search({provider:'amazon',title:'Test'},'one')).covers[0];assert.equal(Object.hasOwn(amazon,'url'),false,'Amazon API images must not become permanent offline covers');
  await service.search({provider:'amazon',title:'Another'},'one');assert.equal(calls.filter((call)=>call.url.hostname==='api.amazon.com').length,1,'OAuth tokens are reused until expiry');
  unsafe=true;assert.equal((await service.search({provider:'google',title:'Test'},'one')).covers.length,0);
  time+=600001;await assert.rejects(service.preview(google.id,'one'),{status:404});
  await service.save({clearGoogle:true,clearAmazon:true});assert.equal(service.settings().hasGoogleKey,false);assert.equal(service.settings().amazonConnected,false);
});
