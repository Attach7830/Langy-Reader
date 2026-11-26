import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCoverSearch } from '../server/cover-search.js';
import { waitForOpenLibrary } from '../server/open-library-rate.js';

const googleBook = { id: 'google-edition', volumeInfo: { title: 'A matching edition', authors: ['A Writer'], imageLinks: { thumbnail: 'http://books.google.com/books/content?id=edition', large: 'https://books.googleusercontent.com/large.jpg' } } };
const publicBook = { key: '/works/OL123W', title: 'A public edition', author_name: ['A Writer'], cover_i: 123, cover_edition_key: 'OL456M' };
async function service(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-keyless-covers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return openCoverSearch(dir, { catalogueDelay: 0, ...options });
}

test('Google cover searches work without a key and use a saved optional key only on server requests', async (t) => {
  const keys = [], covers = await service(t, { request: async (url, options) => {
    assert.equal(url.hostname, 'www.googleapis.com'); assert.equal(options.redirect, 'error');
    keys.push(url.searchParams.get('key')); return Response.json({ items: [googleBook] });
  } });
  const body = { provider: 'google', title: 'A book' };
  const first = await covers.search(body, 'member');
  assert.equal(first.covers[0].url, 'https://books.googleusercontent.com/large.jpg');
  await covers.save({ googleKey: 'synthetic-private-google-key' });
  const second = await covers.search(body, 'member');
  assert.deepEqual(keys, [null, 'synthetic-private-google-key']);
  assert.equal(JSON.stringify(second).includes('synthetic-private-google-key'), false);
  assert.equal(JSON.stringify(covers.settings()).includes('synthetic-private-google-key'), false);
  await covers.save({ clearGoogle: true }); await covers.search(body, 'member');
  assert.deepEqual(keys, [null, 'synthetic-private-google-key', null]);
});

test('automatic search combines key-free public providers and returns source links, large covers and private previews', async (t) => {
  const calls = [], covers = await service(t, { coverDownload: async (url) => ({ thumbnail: Buffer.from(url), thumbnailType: 'image/png' }), request: async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error'); assert.equal(options.headers?.Authorization, undefined);
    if (url.hostname === 'www.googleapis.com') { assert.equal(url.searchParams.has('key'), false); return Response.json({ items: [googleBook] }); }
    assert.equal(url.origin, 'https://openlibrary.org'); assert.equal(url.pathname, '/search.json');
    assert.equal(url.searchParams.get('title'), '中文书'); assert.equal(url.searchParams.get('author'), 'A Writer');
    assert.equal(url.searchParams.get('limit'), '12'); assert.match(options.headers['User-Agent'], /^Langy-Reader\//u);
    return Response.json({ docs: [publicBook, { ...publicBook }, { key: 'OL789W', title: 'Edition cover', cover_edition_key: 'OL999M' }, { title: 'Another edition', cover_edition_key: 'OL888M' }, { key: 'https://evil.test/work', cover_i: 44 }, { key: '/works/OL9W', cover_i: -1 }] });
  } });
  const result = await covers.search({ provider: 'auto', title: ' 中文书 ', author: ' A Writer ' }, 'one');
  assert.equal(calls.length, 2); assert.equal(result.covers.length, 4);
  assert.deepEqual(result.covers.map((cover) => cover.provider), ['openlibrary', 'google', 'openlibrary', 'openlibrary']);
  assert.equal(result.covers[0].url, 'https://covers.openlibrary.org/b/id/123-L.jpg?default=false');
  assert.equal(result.covers[0].source, 'https://openlibrary.org/works/OL123W');
  assert.equal(result.covers[2].url, 'https://covers.openlibrary.org/b/olid/OL999M-L.jpg?default=false');
  assert.equal(result.covers[2].source, 'https://openlibrary.org/works/OL789W');
  assert.equal(result.covers[3].source, 'https://openlibrary.org/books/OL888M');
  await covers.preview(result.covers[0].id, 'one');
  await assert.rejects(covers.preview(result.covers[0].id, 'two'), { status: 404 });
});

test('automatic search retains Open Library results when Google is quota-limited and honors the provider cooldown', async (t) => {
  let clock = 1000, googleCalls = 0;
  const covers = await service(t, { now: () => clock, request: async (url) => {
    if (url.hostname === 'www.googleapis.com') { googleCalls++; return Response.json({ error: { message: 'provider quota' } }, { status: 429, headers: { 'Retry-After': '120' } }); }
    return Response.json({ docs: [publicBook] });
  } });
  for (const title of ['First book', 'Second book']) {
    const result = await covers.search({ provider: 'auto', title }, 'member');
    assert.equal(result.covers[0].provider, 'openlibrary'); assert.match(result.notice, /Google Books.*temporarily unavailable/u);
  }
  assert.equal(googleCalls, 1);
  clock += 60001;
  await assert.rejects(covers.search({ provider: 'google', title: 'Third book' }, 'member'), { status: 429 });
  assert.equal(googleCalls, 1, 'Retry-After remains in effect beyond the default minute');
  clock += 60000;
  await covers.search({ provider: 'auto', title: 'Fourth book' }, 'member'); assert.equal(googleCalls, 2);
});

test('concurrent identical searches reuse provider work while each response gets account-scoped previews', async (t) => {
  let release, calls = 0;
  const ready = new Promise((resolve) => { release = resolve; });
  const covers = await service(t, { request: async () => { calls++; await ready; return Response.json({ items: [googleBook] }); } });
  const body = { provider: 'google', title: 'Repeated book' };
  const a = covers.search(body, 'one'), b = covers.search(body, 'one'); release();
  const [first, second] = await Promise.all([a, b]); assert.equal(calls, 1);
  assert.notEqual(first.covers[0].id, second.covers[0].id);
  for (let i = 0; i < 12; i++) await covers.search(body, 'one'); assert.equal(calls, 1);
  await covers.search(body, 'two'); assert.equal(calls, 2, 'query caches remain separate between accounts');
});

test('new searches retain their per-account limit, cached searches remain available, and expired results refresh', async (t) => {
  let clock = 1000, calls = 0;
  const covers = await service(t, { now: () => clock, request: async () => { calls++; return Response.json({ items: [googleBook] }); } });
  for (let i = 0; i < 10; i++) await covers.search({ provider: 'google', title: 'Book ' + i }, 'one');
  await assert.rejects(covers.search({ provider: 'google', title: 'Another book' }, 'one'), { status: 429 });
  await covers.search({ provider: 'google', title: 'Book 0' }, 'one'); assert.equal(calls, 10);
  await covers.search({ provider: 'google', title: 'Another book' }, 'two'); assert.equal(calls, 11);
  clock += 600001; await covers.search({ provider: 'google', title: 'Book 0' }, 'one'); assert.equal(calls, 12);
});

test('failed searches can be retried and untrusted provider URLs or malformed input never become covers', async (t) => {
  let fail = true, calls = 0;
  const covers = await service(t, { request: async () => {
    calls++; if (fail) throw new Error('private connection details');
    return Response.json({ items: [null, { ...googleBook, volumeInfo: { imageLinks: { thumbnail: 'http://127.0.0.1/private' } } }, { ...googleBook, volumeInfo: { imageLinks: { thumbnail: 'https://books.google.com.evil.test/book.jpg' } } }] });
  } });
  const body = { provider: 'google', title: 'A book' };
  await assert.rejects(covers.search(body, 'one'), (error) => error.status === 502 && !error.message.includes('private connection'));
  fail = false; assert.equal((await covers.search(body, 'one')).covers.length, 0); assert.equal(calls, 2);
  for (const bad of [{ provider: 'unknown', title: 'Book' }, { provider: 'auto', title: '' }, { provider: 'openlibrary', title: 'Book', author: {} }]) await assert.rejects(covers.search(bad), { status: 422 });
  const demo = await service(t, { demo: true }); await assert.rejects(demo.search({ provider: 'auto', title: 'Book' }), { status: 403 });
});

test('Open Library request pacing is shared and a cancelled wait does not block later lookups', async () => {
  const started = [];
  await waitForOpenLibrary(undefined, 30); started.push(Date.now());
  const controller = new AbortController();
  const cancelled = waitForOpenLibrary(controller.signal, 30); controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  await waitForOpenLibrary(undefined, 30); started.push(Date.now());
  assert.ok(started[1] - started[0] >= 25, 'a cancelled request does not erase the existing provider interval');
});
