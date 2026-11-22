import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { chapterStorage } from '../server/audio-upload.js';
import { chapterByteLimit } from '../server/chapter-audio.js';

test('chapter uploads enforce a streamed aggregate limit without Content-Length and clean rejected files', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-upload-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const storage = chapterStorage(folder), request = {};
  const handle = (body) => new Promise((resolve, reject) => storage._handleFile(request,
    { stream: Readable.from(body) }, (error, file) => error ? reject(error) : resolve(file)));
  const first = await handle([Buffer.from('first')]);
  assert.equal(request.chapterBytes, 5);
  assert.equal(first.size, 5);
  assert.equal((await readFile(first.path)).toString(), 'first');
  // Simulate already-streamed chapter bytes without allocating a 1 GiB fixture.
  request.chapterBytes = chapterByteLimit - 1;
  await assert.rejects(handle([Buffer.from('a'), Buffer.from('b')]), (error) => error.status === 413);
  assert.equal((await readdir(folder)).length, 1);
  await new Promise((resolve, reject) => storage._removeFile(request, first, (error) => error ? reject(error) : resolve()));
  assert.deepEqual(await readdir(folder), []);
});
