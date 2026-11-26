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

test('Raise priority posts the selected queued task and refreshes its queue position', async (t) => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test', pretendToBeVisual: true });
  const originals = new Map(), oldFetch = globalThis.fetch;
  for (const key of ['window','document','location','localStorage','requestAnimationFrame','cancelAnimationFrame','CustomEvent']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{configurable:true,value:key.includes('AnimationFrame')?dom.window[key].bind(dom.window):dom.window[key]});
  }
  let raised;
  let jobs = [{ id: 'ocr:first', label: 'First task', state: 'queued', queuePosition: 1, canPrioritize: true },
    { id: 'narration:second', label: 'Second task', state: 'queued', queuePosition: 2, canPrioritize: true },
    { id: 'analysis:shared', label: 'Shared task', state: 'queued', queuePosition: 3, canPrioritize: false }];
  globalThis.fetch = async (path, options = {}) => {
    if (options.method === 'POST') { raised = path; jobs = jobs.map((job) => ({ ...job, queuePosition: job.id === 'narration:second' ? 1 : job.queuePosition + 1, priority: job.id === 'narration:second' ? 1 : 0 })); return Response.json({ priority: 1 }); }
    return Response.json({ accountId: 'priority-reader', jobs });
  };
  const queue = processQueue(); queue.setAccount('priority-reader');
  t.after(() => { queue.dispose(); globalThis.fetch = oldFetch; dom.window.close(); for (const [key,value] of originals) if (value) Object.defineProperty(globalThis,key,value); else delete globalThis[key]; });
  for (let i=0;i<100&&!document.querySelector('[data-process="narration:second"]');i++) await delay(10);
  assert.equal(document.querySelector('[data-process="analysis:shared"]').textContent.includes('Raise priority'), false);
  const button = [...document.querySelectorAll('[data-process="narration:second"] button')].find((node) => node.textContent === 'Raise priority');
  button.click(); for (let i=0;i<100&&!document.querySelector('[data-process="narration:second"]').textContent.includes('Priority raised');i++) await delay(10);
  assert.equal(raised, '/api/processes/narration%3Asecond/priority');
  assert.equal(document.querySelector('#process-list').firstElementChild.dataset.process, 'narration:second');
});

test('finished narration and uploaded-audio sync notify the library to refresh its saved audio badge', async (t) => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test', pretendToBeVisual: true });
  const originals = new Map(), oldFetch = globalThis.fetch;
  for (const key of ['window','document','location','localStorage','requestAnimationFrame','cancelAnimationFrame','CustomEvent']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{configurable:true,value:key.includes('AnimationFrame')?dom.window[key].bind(dom.window):dom.window[key]});
  }
  let jobs = [{ id: 'narration:generated', bookId: 'one', kind: 'narration', label: 'Generate audiobook', state: 'running' },
    { id: 'recording:uploaded', bookId: 'two', kind: 'recording', label: 'Sync audiobook with text', state: 'queued' }];
  const updated = []; window.addEventListener('langy-audio-updated', (event) => updated.push(event.detail.book));
  globalThis.fetch = async () => Response.json({ accountId: 'audio-reader', jobs });
  const queue = processQueue(); queue.setAccount('audio-reader');
  t.after(() => { queue.dispose(); globalThis.fetch = oldFetch; dom.window.close(); for (const [key,value] of originals) if (value) Object.defineProperty(globalThis,key,value); else delete globalThis[key]; });
  for (let i = 0; i < 100 && !document.querySelector('[data-process="recording:uploaded"]'); i++) await delay(10);
  jobs = []; window.dispatchEvent(new dom.window.CustomEvent('langy-processes-changed'));
  for (let i = 0; i < 100 && updated.length < 2; i++) await delay(10);
  assert.deepEqual(updated.sort(), ['one', 'two']);
});
