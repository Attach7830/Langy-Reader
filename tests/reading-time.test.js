import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { openReadingTime } from '../server/reading-time.js';
import { activeReadingClock, readingTime } from '../src/reading-time.js';
import { readingDuration } from '../src/ui-reading-time.js';

const now = 1800000000000, account = { id: 'account-one' }, book = { id: 'novel', language: 'es', languages: [] };
const event = (id, start = 0, end = 10000, pages) => ({ id, start: now + start, end: now + end, ...(pages ? { pages } : {}) });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-reading-time-'));
  const timer = openReadingTime(dir, { section: () => { throw new Error('Monolingual books do not need NLP'); }, now: () => now + 1000000, ...options });
  t.after(async () => { timer.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, timer, save: (events, target = book, owner = account) => timer.record(target, { accountId: owner.id, events }, owner) };
}

test('reading time persists, separates accounts/languages, and deduplicates retries and overlapping devices', async (t) => {
  const f = await fixture(t);
  assert.equal(f.save([event('first-record')]).recordedMs, 10000);
  assert.equal(f.save([event('first-record')]).recordedMs, 0);
  assert.equal(f.save([event('second-device', 5000, 15000)]).recordedMs, 5000);
  assert.equal(f.save([event('fully-covered', 2000, 6000)]).recordedMs, 0);
  assert.equal(f.save([event('portuguese', 15000, 19000)], { ...book, language: 'pt-BR' }).recordedMs, 4000);
  assert.equal(f.save([event('other-account')], book, { id: 'account-two' }).recordedMs, 10000);
  assert.equal(f.timer.summary(account).totalMs, 19000);
  assert.deepEqual(f.timer.summary(account).byLanguage.map((row) => [row.language, row.milliseconds]), [['es', 15000], ['pt', 4000]]);
  const reopened = openReadingTime(f.dir, { now: () => now + 1000000 });
  try { assert.equal(reopened.summary(account).totalMs, 19000); } finally { reopened.close(); }
  assert.equal(f.timer.summary({ id: 'account-two' }).totalMs, 10000);
});

test('mixed-language reading time uses visible source ranges, merges overlaps, and adds up exactly', async (t) => {
  const text = 'Hola cat 中文', source = { text, textHash: 'digest', languages: [{ from: 0, to: 5, language: 'es' }, { from: 5, to: 9, language: 'en' }, { from: 9, to: 11, language: 'zh' }] };
  const f = await fixture(t, { section: () => source });
  const mixed = { ...book, languages: ['es', 'en', 'zh'] }, pages = [{ key: 'epub:0', digest: 'digest', ranges: [{ from: 0, to: text.length }, { from: 0, to: 4 }] }];
  f.save([event('mixed-record', 0, 10001, pages)], mixed);
  const result = f.timer.summary(account);
  assert.equal(result.totalMs, 10001);
  assert.deepEqual(Object.fromEntries(result.byLanguage.map((row) => [row.language, row.milliseconds])), { es: 4444, en: 3333, zh: 2224 });
  assert.throws(() => f.save([event('bad-digest', 20000, 22000, [{ ...pages[0], digest: 'old' }])], mixed), { status: 409 });
  f.save([event('image-page', 30000, 32000)], mixed);
  assert.equal(f.timer.summary(account).totalMs, 12001, 'an image-only page still counts time in the primary language');
});

test('reading-time updates validate all intervals and roll back atomically on changed text', async (t) => {
  const f = await fixture(t, { section: () => ({ text: 'hola', textHash: 'current' }) });
  const invalid = [event('too-long', 0, 30001), event('backwards', 1, 0), event('x'), event('future-time', 2000000, 2001000), { ...event('bad-range'), pages: [{ key: 'p', digest: 'd', ranges: [{ from: -1, to: 4 }] }] }];
  for (const item of invalid) assert.throws(() => f.save([item]), { status: 422 });
  assert.throws(() => f.timer.record(book, { accountId: 'wrong', events: [event('wrong-owner')] }, account), { status: 409, accountChanged: true });
  assert.throws(() => f.save([event('valid-first'), event('stale-second', 20000, 22000, [{ key: 'p', digest: 'stale', ranges: [{ from: 0, to: 4 }] }])], { ...book, languages: ['es', 'en'] }), { status: 409 });
  assert.equal(f.timer.summary(account).totalMs, 0);
  assert.equal(f.save([event('valid-first')]).recordedMs, 10000);
});

test('demo reading time expires without erasing the permanent account', async (t) => {
  let stamp = now + 1000000;
  const f = await fixture(t, { now: () => stamp });
  f.save([event('permanent')]); f.save([event('visitor-record')], book, { id: 'visitor', expires: stamp + 1000 });
  assert.equal(f.timer.summary({ id: 'visitor' }).totalMs, 10000); stamp += 1001;
  assert.equal(f.timer.summary({ id: 'visitor' }).totalMs, 0); assert.equal(f.timer.summary(account).totalMs, 10000);
});

function fakeClock() {
  let mono = 0, wall = now, eligible = true; const records = [];
  const clock = activeReadingClock({ emit: (record) => records.push(record), eligible: () => eligible, monotonic: () => mono, wall: () => wall });
  return { clock, records, advance(ms, wallMs = ms) { mono += ms; wall += wallMs; }, setEligible(value) { eligible = value; }, total: () => records.reduce((sum, row) => sum + row.end - row.start, 0) };
}
test('unchanged-page reading stops at the idle cutoff and resumes only after meaningful activity', () => {
  const f = fakeClock(); f.clock.context({ book: 'a' }); f.clock.activity();
  for (let i = 0; i < 36; i++) { f.advance(5000); f.clock.tick(); }
  assert.equal(f.total(), 120000);
  f.clock.context({ book: 'a', pages: ['auto-turned-page'] });
  f.advance(5000); f.clock.tick(); assert.equal(f.total(), 120000);
  f.clock.activity(); f.advance(5000); f.clock.tick(); assert.equal(f.total(), 125000);
});
test('clock excludes hidden/unfocused time, suspension and wall-clock jumps', () => {
  const f = fakeClock(); f.clock.context({ book: 'a' }); f.clock.activity();
  f.advance(3000); f.setEligible(false); f.clock.pause(); assert.equal(f.total(), 3000);
  for (let i = 0; i < 5; i++) { f.advance(5000); f.clock.tick(); } assert.equal(f.total(), 3000);
  f.setEligible(true); f.clock.activity(); f.advance(5000); f.clock.tick(); assert.equal(f.total(), 8000);
  f.advance(60000); f.clock.tick(); f.advance(5000); f.clock.tick(); assert.equal(f.total(), 8000);
  f.clock.activity(); f.advance(5000, 3605000); f.clock.tick(); assert.equal(f.total(), 8000);
  f.clock.stop(); f.advance(5000); f.clock.tick(); assert.equal(f.total(), 8000);
});

function browserFixture(t, options = {}) {
  const dom = new JSDOM('<main><iframe></iframe></main>', { url: 'https://langy.test', pretendToBeVisual: true });
  const names = ['document', 'window', 'localStorage'], original = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  let mono = 0; const posts = [];
  const tracker = readingTime({ book: () => book, renderer: () => ({ audioUnit: () => ({ root: dom.window.document.querySelector('iframe').contentDocument.body }) }),
    request: async (path, value) => { posts.push(structuredClone(value.body)); return {}; }, eligible: () => true,
    monotonic: () => mono, wall: () => now + mono, trusted: () => true, automatic: false, ...options });
  t.after(() => { tracker.destroy(); dom.window.close(); for (const [name, desc] of original) if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name]; });
  return { dom, tracker, posts, advance: (ms) => { mono += ms; }, storage: dom.window.localStorage };
}
test('iframe actions renew activity while passive mouse moves and automatic page updates do not', async (t) => {
  const f = browserFixture(t); f.tracker.setAccount(account.id); f.tracker.refresh();
  for (let i = 0; i < 25; i++) {
    f.advance(5000); f.dom.window.document.dispatchEvent(new f.dom.window.MouseEvent('pointermove', { bubbles: true }));
    f.tracker.refresh(); f.tracker.tick();
  }
  await f.tracker.flush(); assert.equal(f.posts.flatMap((row) => row.events).reduce((sum, row) => sum + row.end - row.start, 0), 120000);
  f.dom.window.document.querySelector('iframe').contentDocument.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  f.advance(5000); f.tracker.tick(); await f.tracker.flush();
  assert.equal(f.posts.at(-1).events.at(-1).end - f.posts.at(-1).events.at(-1).start, 5000);
});
test('offline intervals keep their IDs on retry and new time is preserved while a save is in flight', async (t) => {
  let online = false, release; const posts = [];
  const f = browserFixture(t, { request: async (path, value) => { posts.push(structuredClone(value.body)); if (!online) throw new Error('offline'); if (release) { const held = release; release = null; await held.promise; } } });
  f.tracker.setAccount(account.id); f.tracker.refresh(); f.advance(5000); f.tracker.tick(); await f.tracker.flush();
  const first = posts[0].events[0]; assert.ok(JSON.parse(f.storage.getItem('langy-reading-time-v1')).pending.length);
  let done; release = { promise: new Promise((resolve) => { done = resolve; }) }; online = true;
  const saving = f.tracker.flush(); await Promise.resolve();
  f.advance(5000); f.tracker.tick(); done(); await saving;
  assert.deepEqual(posts[1].events[0], first);
  assert.notEqual(posts.at(-1).events.at(-1).id, first.id);
  assert.equal(JSON.parse(f.storage.getItem('langy-reading-time-v1')).pending.length, 0);
});
test('pending time cannot move from one account to another', async (t) => {
  const f = browserFixture(t, { request: async () => { throw new Error('offline'); } });
  f.tracker.setAccount(account.id); f.tracker.refresh(); f.advance(5000); f.tracker.tick(); await f.tracker.flush();
  f.tracker.setAccount('different-account'); await f.tracker.flush();
  const saved = JSON.parse(f.storage.getItem('langy-reading-time-v1')); assert.equal(saved.accountId, 'different-account'); assert.deepEqual(saved.pending, []);
});
test('reading duration is readable for seconds, minutes and hours', () => {
  assert.equal(readingDuration(0), '0s'); assert.equal(readingDuration(65000), '1m 5s'); assert.equal(readingDuration(7500000), '2h 5m');
});
