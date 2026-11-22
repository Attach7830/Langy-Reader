import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyStorage } from '../server/storage-location.js';

test('storage verification permits normal volumes and rejects missing or wrong external storage without creating files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-drive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await verifyStorage(join(dir, 'absent'), '');
  await assert.rejects(verifyStorage(join(dir, 'absent'), 'drive-id'), /storage is unavailable/u);
  assert.deepEqual(await readdir(dir), []);
  await writeFile(join(dir, '.langy-storage-id'), 'wrong-drive\n');
  await writeFile(join(dir, 'library.sqlite'), 'existing database');
  await assert.rejects(verifyStorage(dir, 'drive-id'), /another location/u);
  assert.equal((await readFile(join(dir, 'library.sqlite'))).toString(), 'existing database');
  await writeFile(join(dir, '.langy-storage-id'), 'drive-id\n');
  await verifyStorage(dir, 'drive-id');
});
