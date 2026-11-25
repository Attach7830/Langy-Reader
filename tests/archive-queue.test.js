import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { DatabaseSync } from 'node:sqlite';
import { openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';
import { archiveRetryDelay, openArchive } from '../server/annas-archive.js';

const response = (body, statusCode = 200) => Object.assign(Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]), { statusCode, headers: {} });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-archive-queue-')); const library = await openLibrary(dir), files = new Map(), services = [];
  for (let i = 0; i < 3; i++) { const zip = await JSZip.loadAsync(await sampleBook()); zip.file('edition.txt', String(i)); const bytes = await zip.generateAsync({ type: 'nodebuffer' }); files.set(createHash('md5').update(bytes).digest('hex'), bytes); }
  const open = async (options) => { const service = await openArchive(dir, { library, autoStart: false, ...options }); services.push(service); return service; };
  t.after(async () => { services.forEach((service) => service.close()); await rm(dir, { recursive: true, force: true }); });
  return { dir, library, files, open };
}

test('bulk downloads validate atomically, retain shared language settings and optionally use one author, with one file at a time', async (t) => {
  const f = await fixture(t); let active = 0, peak = 0; const planned = [];
  const service = await f.open({ onImport: (book, details) => planned.push({ id: book.id, details }), request: async (value) => {
    const url = new URL(value);
    if (url.pathname === '/dyn/api/fast_download.json') return response({ download_url: 'https://files.example.test/' + url.searchParams.get('md5') });
    const bytes = f.files.get(url.pathname.slice(1));
    return Object.assign(Readable.from((async function* () { active++; peak = Math.max(peak, active); await delay(3); yield bytes; active--; })()), { statusCode: 200, headers: {} });
  } });
  await service.save({ apiKey: 'private-key' });
  const books = [...f.files.keys()].map((reference, index) => ({ reference, title: 'Book ' + index, author: 'Individual ' + index }));
  assert.throws(() => service.queueBatch({ books: [books[0], { reference: 'invalid' }] }), { status: 422 }); assert.equal(service.list().length, 0);
  assert.throws(() => service.queueBatch({ books: Array(51).fill(books[0]) }), { status: 422 });
  const batch = service.queueBatch({ books, sameAuthor: true, author: 'One author', language: 'pt', languages: ['pt', 'zh'], coverStyle: 'forest', autoAudiobook: 'true', audiobookDelayMinutes: '7' });
  assert.equal(batch.jobs.length, 3); assert.ok(batch.jobs.every((job) => job.batchId === batch.batchId));
  await service.pump(); assert.equal(peak, 1);
  assert.equal(planned.length, 3); assert.ok(planned.every(({ details }) => details.autoAudiobook === true && details.audiobookDelayMinutes === 7));
  for (const job of service.list()) { assert.equal(job.state, 'ready', job.error); assert.equal(job.book.author, 'One author'); assert.equal(job.book.language, 'pt'); assert.deepEqual(job.book.languages, ['pt', 'zh']); assert.equal(job.book.coverStyle, 'forest'); }
  const separate = service.queueBatch({ books: [books[0], books[1]], sameAuthor: false, author: 'Ignored common author', language: 'es' });
  await service.pump(); assert.deepEqual(separate.jobs.map((job) => service.job(job.id).book.author), ['Individual 0', 'Individual 1']);
});

test('unavailable imports retry after six hours, survive restart, and never persist keys or signed download links', async (t) => {
  const f = await fixture(t), md5 = [...f.files.keys()][0]; let clock = 1000, available = false, calls = 0;
  const request = async (value) => {
    const url = new URL(value); calls++;
    if (url.pathname === '/dyn/api/fast_download.json') return available ? response({ download_url: 'https://files.example.test/book?token=temporary-token' }) : response({ error: 'service unavailable' }, 503);
    return response(f.files.get(md5));
  };
  let service = await f.open({ now: () => clock, request }); await service.save({ apiKey: 'never-persist-this-key-in-jobs' });
  const job = service.queue({ reference: md5 }); await service.pump();
  assert.equal(service.job(job.id).state, 'retry_wait'); assert.equal(service.job(job.id).nextAttempt, 1000 + archiveRetryDelay); assert.equal(calls, 1);
  clock += archiveRetryDelay - 1; await service.pump(); assert.equal(calls, 1);
  service.close(); available = true; service = await f.open({ now: () => clock, request }); await service.pump(); assert.equal(calls, 1);
  clock++; await service.pump(); const ready = service.job(job.id);
  assert.equal(ready.state, 'ready', ready.error); assert.equal(ready.attempts, 2); assert.equal(calls, 3);
  assert.deepEqual(await readFile(f.library.filePath(ready.book)), f.files.get(md5));
  const db = new DatabaseSync(join(f.dir, 'archive-jobs.sqlite')); t.after(() => db.close());
  const saved = db.prepare('SELECT json FROM jobs').get().json; assert.ok(!saved.includes('temporary-token')); assert.ok(!saved.includes('never-persist-this-key-in-jobs'));
});

test('wrong keys do not retry automatically and waiting imports can be retried or cancelled explicitly', async (t) => {
  const f = await fixture(t); let status = 401, calls = 0, clock = 1000;
  const service = await f.open({ now: () => clock, request: async () => { calls++; return response({ error: status === 401 ? 'invalid_key' : 'service unavailable' }, status); } });
  await service.save({ apiKey: 'key' }); const [one, two] = [...f.files.keys()];
  const bad = service.queue({ reference: one }); await service.pump(); assert.equal(service.job(bad.id).state, 'error');
  clock += archiveRetryDelay * 2; await service.pump(); assert.equal(calls, 1);
  status = 503; service.retry(bad.id); await service.pump(); assert.equal(service.job(bad.id).state, 'retry_wait');
  service.cancel(bad.id); clock += archiveRetryDelay; await service.pump(); assert.equal(calls, 2);
  const waiting = service.queue({ reference: two }); await service.pump(); assert.equal(service.job(waiting.id).state, 'retry_wait');
  await service.save({ retryUnavailable: false }); assert.equal(service.job(waiting.id).state, 'error'); assert.equal(service.job(waiting.id).nextAttempt, null);
});
