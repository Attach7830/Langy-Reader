import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openFonts} from '../server/fonts.js';
import {fontDownloads,trustedFontURL} from '../server/font-downloads.js';

test('free-font downloads use trusted direct files and catalogue variants, validate fonts, and stay private',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'langy-free-fonts-')),fonts=await openFonts(dir);t.after(async()=>{fonts.close();await rm(dir,{recursive:true,force:true});});
  const bytes=await readFile(new URL('../node_modules/@fontsource/spectral/files/spectral-latin-400-normal.woff2',import.meta.url));
  let invalid=false;const response=(data)=>Object.assign(Readable.from([Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data))]),{statusCode:200,headers:{}});
  const service=fontDownloads({fonts,uploads:dir,request:async(value,options)=>{
    const url=new URL(value);if(url.hostname==='api.fontsource.org')return response(url.pathname.endsWith('/spectral')?{family:'Spectral',variants:{400:{normal:{latin:{url:{woff2:'https://cdn.jsdelivr.net/fontsource/fonts/spectral@latest/latin-400-normal.woff2'}}}}}}:[{id:'spectral',family:'Spectral',type:'google',subsets:['latin']}]);
    options.validate(url);assert.throws(()=>options.validate(new URL('https://evil.test/font.woff2')),{status:422});return response(invalid?Buffer.from('<html>Not a font</html>'):bytes);
  }});
  for(const url of ['https://evil.test/a.woff2','http://fonts.gstatic.com/s/a.woff2','https://cdn.jsdelivr.net/npm/some-script/a.woff2','https://raw.githubusercontent.com/other/fonts/main/a.ttf'])assert.throws(()=>trustedFontURL(url),{status:422});
  assert.equal((await service.search('Spectral')).fonts[0].id,'spectral');
  const font=await service.download({id:'spectral',weight:'400',style:'normal',subset:'latin'},{id:'one'});assert.match(font.source,/fontsource.org/u);
  assert.deepEqual(await readFile(fonts.file(font.id.slice(7),'one').path),bytes);assert.throws(()=>fonts.file(font.id.slice(7),'two'),{status:404});
  invalid=true;await assert.rejects(service.download({url:'https://fonts.gstatic.com/s/font.woff2'},{id:'two'}),{status:422});assert.deepEqual(await fonts.list('two'),[]);
});
