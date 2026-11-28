import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';
import { authenticationGate, clearAccountData } from '../src/auth.js';
import { accountPanel } from '../src/ui-accounts.js';
async function fixture(t) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test' });
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  const saved = new Map();
  for (const name of ['window','document','localStorage','navigator','location','Event','Option']) { saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name)); Object.defineProperty(globalThis,name,{configurable:true,value:dom.window[name]}); }
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; dom.window.close(); for (const [name, value] of saved) if (value) Object.defineProperty(globalThis,name,value); else delete globalThis[name]; });
  return dom;
}

test('sign-in clears the previous account’s local preferences before the new reader starts', async (t) => {
  const dom = await fixture(t); localStorage.setItem('langy-account-settings-v1', JSON.stringify({ accountId: 'old-reader', pending: { theme: 'midnight' } })); localStorage.setItem('langy-progress-v1', 'private old progress'); localStorage.setItem('langy-offline-owner', 'old-reader');
  const requests = [];
  globalThis.fetch = async (path, options) => { requests.push({ path, options }); return Response.json(path === '/api/account' ? { enabled:true,authenticated:false } : { enabled:true,authenticated:true,user:{id:'new-user',username:'new-reader',role:'user'},readerAccountId:'new-reader-id' }); };
  const signing = authenticationGate(); await delay(0); assert.equal(document.body.dataset.auth, 'signed-out'); assert.equal(document.querySelector('#login-screen').hidden, false);
  const form = document.querySelector('#login-form'); assert.equal(form.elements.rememberMe.checked, false); form.elements.rememberMe.checked = true;
  form.elements.username.value = 'new-reader'; form.elements.password.value = 'long-test-reader-password'; form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  const session = await signing; assert.equal(session.user.id,'new-user'); assert.equal(document.body.dataset.auth,'ready'); assert.equal(form.elements.password.value,'');
  assert.equal(localStorage.getItem('langy-progress-v1'),null); assert.equal(localStorage.getItem('langy-account-settings-v1'),null); assert.equal(localStorage.getItem('langy-auth-account'),'new-user');
  assert.equal(requests[1].path,'/api/account/login'); assert.equal(JSON.parse(requests[1].options.body).username,'new-reader');
  assert.equal(JSON.parse(requests[1].options.body).rememberMe, true);
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

test('switching accounts retains downloads by default and optional removal only deletes the current account packs', async (t) => {
  await fixture(t); const prior = globalThis.caches, removed = [];
  globalThis.caches = { keys: async () => ['langy-covers-reader-one', 'langy-covers-reader-two', 'langy-pack-first-book', 'langy-pack-second-book', 'langy-offline-control', 'langy-shell-v1'], delete: async (name) => { removed.push(name); return true; } };
  t.after(() => { if (prior) globalThis.caches = prior; else delete globalThis.caches; });
  await clearAccountData();
  assert.deepEqual(removed, ['langy-covers-reader-one', 'langy-covers-reader-two', 'langy-offline-control']);
  removed.length = 0; localStorage.setItem('langy-offline-owner', 'first'); await clearAccountData({ removeDownloads: true });
  assert.equal(removed.includes('langy-pack-first-book'), true); assert.equal(removed.includes('langy-pack-second-book'), false);
});

test('Switch user offers download removal as an unchecked choice on every opening', async (t) => {
  await fixture(t); const dialog = document.querySelector('#sign-out-dialog'); dialog.showModal = () => { dialog.open = true; };
  accountPanel({ user: { username: 'member', role: 'user' } });
  document.querySelector('[data-switch-user]').click(); assert.equal(dialog.open, true); assert.equal(document.querySelector('#sign-out-remove-downloads').checked, false);
  document.querySelector('#sign-out-remove-downloads').checked = true; dialog.open = false;
  document.querySelector('[data-switch-user]').click(); assert.equal(document.querySelector('#sign-out-remove-downloads').checked, false);
});

test('Safe mode saves independently of other account limits and reloads from the server', async (t) => {
  await fixture(t);
  const admin = { id: 'admin', username: 'administrator', role: 'admin' };
  const reader = { id: 'reader', username: 'member', role: 'user', safeMode: false, rememberDays: 30 };
  const patches = [];
  let rejectSave = false;
  globalThis.fetch = async (path, options) => {
    if (path === '/api/admin/users') return Response.json({ users: [admin, reader] });
    assert.equal(path, '/api/admin/users/reader');
    assert.equal(options.method, 'PATCH');
    const body = JSON.parse(options.body);
    patches.push(body);
    if (rejectSave) return Response.json({ error: 'Try again.' }, { status: 503 });
    return Response.json(Object.assign(reader, body));
  };

  accountPanel({ user: admin });
  const accountTab = document.querySelector('[data-settings-tab="account"]');
  const row = () => document.querySelector('#account-users').lastElementChild;
  const checkbox = () => row().querySelector('[data-account-policy="safeMode"]');
  accountTab.click();
  await delay(0);
  assert.equal(checkbox().checked, false);
  const rememberDays = row().querySelector('[data-account-policy="rememberDays"]');
  rememberDays.value = '0';
  checkbox().click();
  await delay(0);
  assert.deepEqual(patches, [{ safeMode: true }]);
  assert.equal(rememberDays.value, '0');
  assert.match(row().textContent, /Safe mode enabled\./u);
  document.querySelector('#settings-form').reset();
  assert.equal(checkbox().checked, true);

  accountTab.click();
  await delay(0);
  assert.equal(checkbox().checked, true);
  rejectSave = true;
  checkbox().click();
  await delay(0);
  assert.equal(checkbox().checked, true);
  assert.equal(checkbox().disabled, false);
  assert.match(row().textContent, /Could not save Safe mode\. Try again\./u);

  rejectSave = false;
  checkbox().click();
  await delay(0);
  assert.equal(checkbox().checked, false);
  assert.match(row().textContent, /Safe mode disabled\./u);
  accountTab.click();
  await delay(0);
  assert.equal(checkbox().checked, false);
  assert.deepEqual(patches, [{ safeMode: true }, { safeMode: false }, { safeMode: false }]);
});
