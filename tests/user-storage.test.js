import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userStorage } from '../server/user-storage.js';

test('account storage counts owned media once and reservations prevent concurrent imports exceeding a quota', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-quota-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = join(dir, 'first'), second = join(dir, 'second'); await mkdir(first); await mkdir(second);
  await writeFile(join(first, 'book.epub'), Buffer.alloc(40)); await writeFile(join(first, 'audio.mp3'), Buffer.alloc(20)); await writeFile(join(second, 'other.epub'), Buffer.alloc(90));
  let limit = 100, active = true;
  const storage = userStorage(dir, { policy: () => ({ active, storageLimit: limit }), paths: (owner) => owner === 'first' ? [first, join(first, 'audio.mp3')] : [second] });
  assert.equal((await storage.summary('first')).usedBytes, 60); assert.equal((await storage.summary('second')).usedBytes, 90);
  const release = await storage.reserve('first', 30); await assert.rejects(storage.reserve('first', 20), { status: 507 });
  release(); release(); const next = await storage.reserve('first', 40); next();
  limit = 50; assert.equal((await storage.summary('first')).overLimit, true); await assert.rejects(storage.reserve('first', 1), { status: 507 });
  limit = null; const unrestricted = await storage.reserve('first', 1000000); unrestricted(); assert.equal((await storage.summary('first')).unlimited, true);
  active = false; await assert.rejects(storage.reserve('first', 0), { status: 403 });
});
