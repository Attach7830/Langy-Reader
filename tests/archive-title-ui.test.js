import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { archiveTitleActions } from '../src/archive-title-controls.js';

async function fixture(t) {
  const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'));
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:dom.window.document});
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  t.after(()=>{dom.window.close();if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  return dom;
}
async function until(check){for(let i=0;i<100;i++){if(check())return;await delay(5);}throw new Error('Title controls did not update');}

test('blocked download titles offer an independent lookup retry and save a name without restarting the download',async(t)=>{
  const dom=await fixture(t),calls=[];let refreshed=0;
  const controls=archiveTitleActions({id:'archive:queued',titleError:'blocked',titlePending:false},{refresh:()=>{refreshed++;},request:async(path,options)=>{calls.push({path,...options});}});document.body.append(controls);
  assert.match(controls.textContent,/blocked the title lookup/u);
  controls.querySelectorAll('button')[1].click();await until(()=>refreshed===1);
  assert.equal(calls[0].path,'/api/imports/anna/queued/title/retry');assert.equal(calls[0].method,'POST');
  controls.querySelector('button').click();const dialog=document.querySelector('#archive-title-dialog'),form=document.querySelector('#archive-title-form');
  assert.equal(dialog.open,true);form.elements.title.value='O capital no século XXI';
  controls.replaceChildren(archiveTitleActions({id:'archive:queued',titleError:'blocked'},{refresh(){},request(){}}));
  assert.equal(form.elements.title.value,'O capital no século XXI','polling must not erase the title draft');
  form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await until(()=>refreshed===2);
  assert.equal(calls[1].path,'/api/imports/anna/queued/title');assert.equal(calls[1].method,'PATCH');assert.equal(calls[1].body.title,'O capital no século XXI');assert.equal(dialog.open,false);
  assert.equal(calls.some(call=>/\/retry$/u.test(call.path)&&!call.path.includes('/title/')),false);
});

test('late saves cannot close or overwrite a newer book title dialog',async(t)=>{
  const dom=await fixture(t);let release;const held=new Promise(resolve=>{release=resolve;});
  const first=archiveTitleActions({id:'first'},{refresh(){},request:async()=>await held});document.body.append(first);first.querySelector('button').click();
  const dialog=document.querySelector('#archive-title-dialog'),form=document.querySelector('#archive-title-form');form.elements.title.value='First book';form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  dialog.close();const second=archiveTitleActions({id:'second'},{refresh(){},request:async()=>{}});document.body.append(second);second.querySelector('button').click();form.elements.title.value='Second book';
  release();await delay(10);assert.equal(dialog.open,true);assert.equal(form.elements.title.value,'Second book');
  assert.equal(form.querySelector('[type=submit]').disabled,false);
});
