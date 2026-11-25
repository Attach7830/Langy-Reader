import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ocrSettings } from '../server/ocr-settings.js';

test('OCR connector validates the PDF service, keeps its key private and never redirects credentials', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-ocr-settings-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = []; let compatible = true;
  const options = { workerURL: 'http://language:8000', request: async (url, args) => { calls.push([url, args]); return Response.json({ languages: ['chi_sim', 'chi_tra'], ...(compatible ? { engine: 'paddleocr', protocol: 1 } : {}) }); } };
  const service = await ocrSettings(dir, options); assert.equal(service.settings().provider, 'builtin');
  await service.save({ provider: 'paddle', baseUrl: 'http://ocr.test:8000/subpath/', apiKey: 'synthetic-ocr-key' });
  assert.equal(calls[0][0].pathname, '/subpath/ocr/languages'); assert.equal(calls[0][1].redirect, 'error'); assert.equal(calls[0][1].headers.Authorization, 'Bearer synthetic-ocr-key');
  assert.equal(JSON.stringify(service.settings()).includes('synthetic-ocr-key'), false); assert.equal((await stat(join(dir, 'ocr-settings.json'))).mode & 0o777, 0o600);
  assert.equal((await ocrSettings(dir, options)).settings().hasKey, true);
  compatible = false; await assert.rejects(service.save({ provider: 'paddle', baseUrl: 'http://generic.test' }), /generic PaddleOCR/u);
  assert.deepEqual(calls.at(-1)[1].headers, {}, 'a different server never receives the saved key');
  assert.equal(service.settings().baseUrl, 'http://ocr.test:8000/subpath'); await service.removeKey(); assert.equal(service.settings().hasKey, false);
  assert.equal(JSON.parse(await readFile(join(dir, 'ocr-settings.json'), 'utf8')).apiKey, '');
  for (const baseUrl of ['file:///tmp/file', 'http://user:password@ocr.test', 'http://ocr.test?api_key=secret']) await assert.rejects(service.save({ provider: 'paddle', baseUrl }), { status: 422 });
});

test('OCR connection changes respect active scans, demo restrictions and invalid input', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-ocr-restrictions-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let running = true; const service = await ocrSettings(dir, { workerURL: 'http://language:8000', busy: () => running });
  await assert.rejects(service.save({ provider: 'builtin' }), { status: 409 }); running = false;
  for (const body of [{ provider: 'unknown' }, { provider: 'paddle', baseUrl: '' }, { provider: 'builtin', baseUrl: 42 }, { provider: 'builtin', apiKey: 42 }, { provider: 'builtin', apiKey: 'two words' }]) await assert.rejects(service.save(body), { status: 422 });
  await service.save({ provider: 'builtin' }); assert.equal(service.connection().baseUrl, 'http://language:8000'); assert.equal(service.connection().apiKey, '');
  const demo = await ocrSettings(dir, { demo: true, workerURL: 'http://language:8000' });
  assert.equal(demo.settings().configurable, false); await assert.rejects(demo.save({ provider: 'builtin' }), { status: 403 });
});
