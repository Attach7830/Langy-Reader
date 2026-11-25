import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {JSDOM} from 'jsdom';
import {processQueue} from '../src/process-queue.js';

test('the small process X calls server cancellation and a shared recipient cannot get a cancel control',async(t)=>{
  const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'),{url:'https://langy.test',pretendToBeVisual:true}),before=new Map();
  for(const key of ['window','document','location','localStorage','requestAnimationFrame','cancelAnimationFrame','CustomEvent']){before.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value:typeof dom.window[key]==='function'&&key.includes('AnimationFrame')?dom.window[key].bind(dom.window):dom.window[key]});}
  const oldFetch=globalThis.fetch;let jobs=[{id:'analysis:one',kind:'analysis',label:'Vocabulary analysis',state:'running',created:1,bookId:'one',cancellable:true},{id:'analysis:shared',kind:'analysis',label:'Shared analysis',state:'running',bookId:'shared',cancellable:false}],cancelled=[];
  globalThis.fetch=async(path,options={})=>{if(options.method==='DELETE'){cancelled.push(path);jobs=jobs.filter(job=>job.id!=='analysis:one');return Response.json({cancelled:true});}return Response.json({accountId:'account',jobs,unavailable:false});};
  const queue=processQueue();queue.setAccount('account');
  t.after(()=>{queue.dispose();globalThis.fetch=oldFetch;dom.window.close();for(const[key,value]of before)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];});
  for(let n=0;n<100&&!document.querySelector('.process-cancel');n++)await delay(10);
  const cancel=document.querySelector('[aria-label="Cancel Vocabulary analysis"]');assert.ok(cancel);assert.equal(cancel.textContent,'×');assert.equal(document.querySelectorAll('.process-cancel').length,1);
  cancel.click();for(let n=0;n<100&&!cancelled.length;n++)await delay(10);assert.deepEqual(cancelled,['/api/processes/analysis%3Aone']);
});
