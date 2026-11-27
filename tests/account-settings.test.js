import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReaderSettings } from '../server/reader-settings.js';
import { accountSettings } from '../src/account-settings.js';
import { defaults, mergePreferences } from '../shared/reader-preferences.js';

async function store(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-preferences-'));
  const dbs = [], open = (options) => { const db = openReaderSettings(dir, options); dbs.push(db); return db; };
  t.after(async () => { for (const db of dbs) { try { db.close(); } catch {} } await rm(dir, { recursive: true, force: true }); });
  return { db: open(options), open };
}
function browser(t, db, { initial = {}, storage = new Map(), ...options } = {}) {
  let settings = mergePreferences(structuredClone(defaults), initial), offline = false;
  const statuses = [];
  const disk = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
  const request = async (_path, data = {}) => {
    if (offline) throw new Error('Offline');
    if (data.method === 'PATCH') {
      const result = db.patch(data.body);
      if (result.conflict) throw Object.assign(new Error('Conflict'), { status: 409, details: result });
      return result;
    }
    return db.get();
  };
  const client = accountSettings({ request, preferences: () => settings, apply: (value) => { settings = value; },
    storage: disk, status: (value) => statuses.push(value), ...options });
  t.after(() => client.close());
  return { client, request, storage, statuses, settings: () => settings, offline: (value) => { offline = value; },
    change(values) { const before = settings; settings = mergePreferences(settings, values); client.changed(settings, before); } };
}

test('reader preferences persist across restarts and browsers, preserving device-specific fields', async (t) => {
  const s = await store(t, { username: 'reader' });
  const a = browser(t, s.db, { initial: { theme: 'midnight', showPinyin: true, readingLanguages: ['pt', 'zh'], keys: { pinyin: 'j' }, tapToTurn: true, swipeToTurn: false, tapCenterFullscreen: false, libraryLayout: '3', libraryFormat: 'pdf', coversOnly: true, processDismissMinutes: 2.5 } });
  await a.client.start(); assert.equal(s.db.get().preferences.theme, 'midnight');
  s.db.close(); const restarted = s.open({ username: 'reader' });
  const b = browser(t, restarted, { initial: { theme: 'paper', syncDeviceName: 'Tablet', progressSyncEnabled: false } });
  await b.client.start();
  assert.equal(b.settings().theme, 'midnight'); assert.equal(b.settings().showPinyin, true); assert.equal(b.settings().keys.pinyin, 'j');
  assert.deepEqual(b.settings().readingLanguages, ['pt', 'zh']);
  assert.equal(b.settings().tapToTurn, true); assert.equal(b.settings().swipeToTurn, false); assert.equal(b.settings().tapCenterFullscreen, false);
  assert.equal(b.settings().syncDeviceName, 'Tablet'); assert.equal(b.settings().progressSyncEnabled, false);
  assert.equal(b.settings().libraryLayout, '3'); assert.equal(b.settings().coversOnly, true); assert.equal(b.settings().processDismissMinutes, 2.5);
  assert.equal(b.settings().libraryFormat, 'pdf');
  assert.equal('syncDeviceName' in restarted.get().preferences, false); assert.equal('progressSyncEnabled' in restarted.get().preferences, false);
});

test('only changed preferences are sent and stale revisions cannot erase another browser change', async (t) => {
  const { db } = await store(t);
  const a = browser(t, db); await a.client.start(); const b = browser(t, db); await b.client.start();
  a.change({ showPinyin: true, keys: { pinyin: 'j' } }); await a.client.flush();
  b.change({ theme: 'dark', keys: { summary: 'q' } }); await b.client.flush();
  assert.equal(db.get().preferences.showPinyin, true); assert.equal(db.get().preferences.theme, 'dark');
  assert.equal(db.get().preferences.keys.pinyin, 'j'); assert.equal(db.get().preferences.keys.summary, 'q');
  await a.client.resume(); assert.equal(a.settings().theme, 'dark');
});

test('per-language defaults sync across browsers and preserve concurrent fields through offline changes', async (t) => {
  const { db } = await store(t), first = browser(t, db); await first.client.start();
  const second = browser(t, db); await second.client.start();
  first.change({ languageDefaultsMode: 'per-language', languageDefaults: { pt: { translationLanguage: 'en', summaryLanguage: 'pt' } } }); await first.client.flush();
  second.offline(true); second.change({ languageDefaults: { es: { summaryLanguage: 'es' }, pt: { translationLanguage: 'es' } } }); await second.client.flush();
  second.offline(false); await second.client.resume(); await first.client.resume();
  assert.deepEqual(first.settings().languageDefaults.pt, { translationLanguage: 'es', summaryLanguage: 'pt' });
  assert.equal(first.settings().languageDefaults.es.summaryLanguage, 'es'); assert.equal(second.settings().languageDefaultsMode, 'per-language');
});

test('a conflict between fetch and save rebases pending fields on the current account snapshot', async (t) => {
  const { db } = await store(t); let conflict = false;
  const b = browser(t, db, { request: async (_path, options = {}) => {
    if (options.method !== 'PATCH') return db.get();
    if (conflict) { conflict = false; db.patch({ revision: db.get().revision, changes: { font: 'chinese' } }); }
    const result = db.patch(options.body);
    if (result.conflict) throw Object.assign(new Error('Conflict'), { status: 409, details: result });
    return result;
  } });
  await b.client.start(); conflict = true; b.change({ theme: 'midnight' }); await b.client.flush();
  assert.equal(b.settings().font, 'chinese'); assert.equal(b.settings().theme, 'midnight');
});

test('offline settings survive a reload and synchronize when the connection returns', async (t) => {
  const { db } = await store(t), a = browser(t, db); await a.client.start(); a.offline(true);
  a.change({ showPinyin: true, audioToolbarHidden: true }); await a.client.flush(); assert.equal(a.statuses.at(-1), 'offline');
  const b = browser(t, db, { initial: a.settings(), storage: a.storage }); a.client.close(); await b.client.start();
  assert.equal(b.settings().showPinyin, true); assert.equal(db.get().preferences.audioToolbarHidden, true);
  assert.deepEqual(JSON.parse(a.storage.get('langy-account-settings-v1')).pending, {});
});

test('new changes made during an in-flight save are retained and sent in the next pass', async (t) => {
  const { db } = await store(t); let gate, waiting, begin;
  const began = () => new Promise((resolve) => { begin = resolve; });
  const b = browser(t, db, { request: async (_path, options = {}) => {
    if (options.method !== 'PATCH') return db.get();
    if (gate) { const hold = gate; gate = null; begin(); await hold; }
    return db.patch(options.body);
  } });
  await b.client.start(); const started = began(); gate = new Promise((resolve) => { waiting = resolve; });
  b.change({ showPinyin: true }); const saving = b.client.flush(); await started;
  b.change({ showPinyin: false, font: 'chinese' }); waiting(); await saving;
  assert.equal(db.get().preferences.showPinyin, false); assert.equal(db.get().preferences.font, 'chinese');
});

test('switching accounts never uploads the previous account cache or pending preferences', async (t) => {
  const s = await store(t, { username: 'one' }), a = browser(t, s.db); await a.client.start();
  a.offline(true); a.change({ theme: 'midnight' }); await a.client.flush(); a.client.close();
  const second = s.open({ username: 'two' }), b = browser(t, second, { initial: a.settings(), storage: a.storage }); await b.client.start();
  assert.equal(b.settings().theme, 'paper'); assert.deepEqual(second.get().preferences, {});
});

test('remote preferences wait until an open settings form closes', async (t) => {
  const { db } = await store(t); db.patch({ revision: 0, changes: { theme: 'dark' } }); let busy = true;
  const a = browser(t, db, { busy: () => busy }); await a.client.start(); assert.equal(a.settings().theme, 'paper');
  a.change({ showPinyin: true }); busy = false; await a.client.resume();
  assert.equal(a.settings().theme, 'dark'); assert.equal(a.settings().showPinyin, true);
});

test('preference storage validates fields, rejects credentials and uses server-selected account identities', async (t) => {
  const { db } = await store(t);
  for (const changes of [{ apiKey: 'secret' }, { accountId: 'forged' }, { syncDeviceName: 'other' }, { size: 1000 }, { showPinyin: 'yes' }, { keys: { fake: 'x' } }, { keys: { next: '<script>' } }, { audioRecordings: { '../file': 'id' } }])
    assert.throws(() => db.patch({ revision: 0, changes }), { status: 422 });
  const saved = db.patch({ revision: 0, changes: { summaryLanguage: 'es', audioRecordings: { book: '' } }, owner: 'other' });
  assert.equal(saved.accountId, db.get().accountId); assert.equal(saved.revision, 1);
  assert.equal(db.patch({ revision: 0, changes: { theme: 'dark' } }).conflict, true);
});

test('demo visitors have separate expiring preferences and cannot choose an identity through request data', async (t) => {
  const { db } = await store(t, { demo: true }), a = { id: 'one', expires: Date.now() + 60000 }, b = { id: 'two', expires: Date.now() + 60000 };
  db.patch({ revision: 0, changes: { theme: 'midnight' }, visitor: b }, a);
  assert.equal(db.get(a).preferences.theme, 'midnight'); assert.deepEqual(db.get(b).preferences, {});
  assert.notEqual(db.get(a).accountId, db.get(b).accountId); assert.throws(() => db.get(), { status: 401 });
  const expired = { id: 'old', expires: Date.now() - 1 }; db.patch({ revision: 0, changes: { theme: 'dark' } }, expired);
  assert.equal(db.get(expired).revision, 0);
});

test('server preferences still load if the browser refuses localStorage access', async (t) => {
  const { db } = await store(t); db.patch({ revision: 0, changes: { showPinyin: true } });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Browser storage disabled'); } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; });
  let settings = structuredClone(defaults);
  const client = accountSettings({ request: async () => db.get(), preferences: () => settings, apply: (value) => { settings = value; } });
  t.after(() => client.close()); await client.start(); assert.equal(settings.showPinyin, true);
});
