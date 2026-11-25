import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';
import { authenticationGate } from '../src/auth.js';
async function fixture(t) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test' });
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  const saved = new Map();
  for (const name of ['window','document','localStorage','navigator','location','Event']) { saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name)); Object.defineProperty(globalThis,name,{configurable:true,value:dom.window[name]}); }
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; dom.window.close(); for (const [name, value] of saved) if (value) Object.defineProperty(globalThis,name,value); else delete globalThis[name]; });
  return dom;
}

test('sign-in clears the previous account’s local preferences before the new reader starts', async (t) => {
  const dom = await fixture(t); localStorage.setItem('langy-account-settings-v1', JSON.stringify({ accountId: 'old-reader', pending: { theme: 'midnight' } })); localStorage.setItem('langy-progress-v1', 'private old progress'); localStorage.setItem('langy-offline-owner', 'old-reader');
  const requests = [];
  globalThis.fetch = async (path, options) => { requests.push({ path, options }); return Response.json(path === '/api/account' ? { enabled:true,authenticated:false } : { enabled:true,authenticated:true,user:{id:'new-user',username:'new-reader',role:'user'},readerAccountId:'new-reader-id' }); };
  const signing = authenticationGate(); await delay(0); assert.equal(document.body.dataset.auth, 'signed-out'); assert.equal(document.querySelector('#login-screen').hidden, false);
  const form = document.querySelector('#login-form'); form.elements.username.value = 'new-reader'; form.elements.password.value = 'long-test-reader-password'; form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  const session = await signing; assert.equal(session.user.id,'new-user'); assert.equal(document.body.dataset.auth,'ready'); assert.equal(form.elements.password.value,'');
  assert.equal(localStorage.getItem('langy-progress-v1'),null); assert.equal(localStorage.getItem('langy-account-settings-v1'),null); assert.equal(localStorage.getItem('langy-auth-account'),'new-user');
  assert.equal(requests[1].path,'/api/account/login'); assert.equal(JSON.parse(requests[1].options.body).username,'new-reader');
});

test('migration of the configured administrator preserves the existing browser preferences', async (t) => {
  await fixture(t); localStorage.setItem('langy-account-settings-v1',JSON.stringify({accountId:'legacy-reader'})); localStorage.setItem('langy-settings-v1','preserved reader preferences');
  globalThis.fetch = async () => Response.json({enabled:true,authenticated:true,user:{id:'admin-id',username:'reader',role:'admin'},readerAccountId:'legacy-reader'});
  await authenticationGate(); assert.equal(localStorage.getItem('langy-settings-v1'),'preserved reader preferences'); assert.equal(localStorage.getItem('langy-auth-account'),'admin-id');
});

test('a downloaded public-instance pack still starts offline without a user account', async (t) => {
  await fixture(t); localStorage.setItem('langy-offline-owner','public-reader'); localStorage.setItem('langy-auth-mode','public'); globalThis.fetch = async () => { throw new TypeError('offline'); };
  const session = await authenticationGate(); assert.equal(session.offline,true); assert.equal(session.enabled,false); assert.equal(document.body.dataset.auth,'ready');
});

test('a first member sign-in cannot inherit pre-account browser data', async (t) => {
  await fixture(t); localStorage.setItem('langy-settings-v1', 'old private preferences'); localStorage.setItem('langy-progress-v1', 'old private progress');
  globalThis.fetch = async () => Response.json({ enabled: true, authenticated: true, legacyAccount: false, user: { id: 'member-id', username: 'member', role: 'user' }, readerAccountId: 'member-reader-id' });
  await authenticationGate(); assert.equal(localStorage.getItem('langy-settings-v1'), null); assert.equal(localStorage.getItem('langy-progress-v1'), null);
});
