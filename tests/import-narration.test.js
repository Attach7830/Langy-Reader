import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { importNarration, importNarrationOptions } from '../server/import-narration.js';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE analyses(book TEXT PRIMARY KEY, owner TEXT, state TEXT);
    CREATE TABLE book_audio(id TEXT PRIMARY KEY, book TEXT, state TEXT);
    CREATE TABLE recordings(id TEXT PRIMARY KEY, book TEXT, state TEXT);`);
  const books = new Map(), queued = []; let clock = 1000000, baseUrl = 'http://kokoro.test/v1', fail = false;
  const dependencies = { db, now: () => clock, configuration: () => ({ baseUrl }),
    library: { getBook(id, visitor) { const book = books.get(id); assert.equal(visitor.id, book.owner); return book; } },
    queue(book) { if (fail) throw new Error('Unavailable'); const id = 'audio-' + book.id; db.prepare('INSERT INTO book_audio VALUES(?,?,?)').run(id, book.id, 'queued'); queued.push(book.id); return { id }; }, ...options };
  let scheduler = importNarration(dependencies);
  return { db, queued, get scheduler() { return scheduler; },
    add(id, state = 'ready') { const book = { id, owner: 'owner-' + id, addedAt: 1000000 }; books.set(id, book); db.prepare('INSERT INTO analyses VALUES(?,?,?)').run(id, book.owner, state); return book; },
    time(value) { clock = value; }, connected(value) { baseUrl = value ? 'http://kokoro.test/v1' : ''; }, fail(value) { fail = value; },
    restart() { scheduler = importNarration(dependencies); } };
}

test('import audio is opt-in and validates a per-book delay', () => {
  assert.equal(importNarrationOptions({}), null); assert.equal(importNarrationOptions({ autoAudiobook: 'false', audiobookDelayMinutes: 'invalid' }), null);
  assert.deepEqual(importNarrationOptions({ autoAudiobook: 'on', audiobookDelayMinutes: '7' }), { autoAudiobook: true, audiobookDelayMinutes: 7 });
  for (const value of [0, -1, 1.5, 10081, '', 'invalid', true, [5]]) assert.throws(() => importNarrationOptions({ autoAudiobook: true, audiobookDelayMinutes: value }), { status: 422 });
  assert.throws(() => importNarrationOptions({ autoAudiobook: 'maybe' }), { status: 422 });
});

test('only selected imports queue after the requested delay, once, across restarts', (t) => {
  const f = fixture(t), selected = f.add('selected'), other = f.add('other');
  f.scheduler.schedule(other, {}); assert.equal(f.scheduler.status(other), null);
  f.scheduler.schedule(selected, { autoAudiobook: true, audiobookDelayMinutes: 2 });
  f.time(1119999); f.scheduler.pump(); assert.deepEqual(f.queued, []);
  f.restart(); f.time(1120000); f.scheduler.pump(); assert.deepEqual(f.queued, ['selected']);
  f.restart(); f.scheduler.schedule(selected, { autoAudiobook: true, audiobookDelayMinutes: 5 }); f.scheduler.pump(); assert.deepEqual(f.queued, ['selected']);
  assert.equal(f.scheduler.status(selected).due, 1120000);
});

test('uploaded, synced, ready, queued and failed recordings prevent duplicate automatic generation', (t) => {
  const f = fixture(t);
  for (const state of ['uploaded', 'syncing', 'ready', 'queued', 'error', 'cancelled']) {
    const book = f.add(state); f.scheduler.schedule(book, { autoAudiobook: true, audiobookDelayMinutes: 1 });
    f.db.prepare(`INSERT INTO ${['uploaded','syncing'].includes(state) ? 'recordings' : 'book_audio'} VALUES(?,?,?)`).run('existing-' + state, book.id, state);
  }
  f.time(1060000); f.scheduler.pump(); assert.deepEqual(f.queued, []);
  assert.equal(f.scheduler.status({ id: 'uploaded' }).state, 'skipped');
});

test('a schedule waits for connection and analysis, can be cancelled, and limits the generation backlog', (t) => {
  const f = fixture(t), waiting = f.add('waiting', 'queued'), cancelled = f.add('cancelled');
  f.scheduler.schedule(waiting, { autoAudiobook: true, audiobookDelayMinutes: 1 });
  f.scheduler.schedule(cancelled, { autoAudiobook: true, audiobookDelayMinutes: 1 }); f.scheduler.cancel(cancelled);
  for (const id of ['one', 'two', 'three', 'four']) f.scheduler.schedule(f.add(id), { autoAudiobook: true, audiobookDelayMinutes: 1 });
  f.time(1060000); f.connected(false); f.scheduler.pump(); assert.deepEqual(f.queued, []);
  f.connected(true); f.scheduler.pump(); assert.equal(f.queued.length, 3); assert.equal(f.queued.includes('waiting'), false); assert.equal(f.queued.includes('cancelled'), false);
  f.db.exec("UPDATE analyses SET state='ready' WHERE book='waiting'; UPDATE book_audio SET state='ready'");
  f.scheduler.pump(); assert.equal(f.queued.includes('waiting'), true); assert.equal(f.queued.length, 5);
});

test('failed scheduling needs a manual retry and demos cannot schedule jobs', (t) => {
  const f = fixture(t), book = f.add('failed'); f.scheduler.schedule(book, { autoAudiobook: true, audiobookDelayMinutes: 1 });
  f.time(1060000); f.fail(true); f.scheduler.pump(); assert.equal(f.scheduler.status(book).state, 'error');
  f.fail(false); f.restart(); f.scheduler.pump(); assert.deepEqual(f.queued, []);
  const demo = fixture(t, { demo: true }), demoBook = demo.add('demo');
  assert.throws(() => demo.scheduler.schedule(demoBook, { autoAudiobook: true }), { status: 403 });
});
