import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLearning } from '../server/learning.js';

test('demo audio preview never contacts Kokoro and leaves personal connections configurable', async () => {
  const names = ['READER_KOKORO_URL', 'READER_KOKORO_API_KEY', 'READER_DEMO_AUDIO_PREVIEW'];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const fetch = globalThis.fetch;
  const folder = await mkdtemp(join(tmpdir(), 'langy-preview-'));
  let requests = 0;
  try {
    process.env.READER_KOKORO_URL = 'http://kokoro.example.test/v1';
    process.env.READER_KOKORO_API_KEY = 'test-key';
    delete process.env.READER_DEMO_AUDIO_PREVIEW;
    globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ voices: ['ef_dora'] })); };
    const library = { getBook() { return { id: 'book' }; } };
    const preview = await openLearning(join(folder, 'demo'), library, true, {});
    assert.deepEqual(preview.settings(), { connected: false, configurable: false, previewAudio: true });
    assert.equal(preview.narration({ id: 'book' }).connected, false);
    assert.equal(preview.narration({ id: 'book' }).previewAudio, true);
    assert.throws(() => preview.queueBook({ id: 'book' }), /not connected in this demo/u);
    await assert.rejects(preview.voices(), /not connected in this demo/u);
    assert.equal(requests, 0);
    assert.ok(!JSON.stringify(preview.settings()).includes('test-key'));
    const personal = await openLearning(join(folder, 'personal'), library, false, {});
    assert.equal(personal.settings().connected, true);
    assert.equal(personal.settings().configurable, true);
    assert.deepEqual(await personal.voices(), { voices: ['ef_dora'] });
    assert.equal(requests, 1);
    process.env.READER_DEMO_AUDIO_PREVIEW = '0';
    const optedIn = await openLearning(join(folder, 'opted-in'), library, true, {});
    assert.deepEqual(optedIn.settings(), { connected: true, configurable: false, previewAudio: false });
    assert.deepEqual(await optedIn.voices(), { voices: ['ef_dora'] });
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = fetch;
    for (const name of names) { if (original[name] == null) delete process.env[name]; else process.env[name] = original[name]; }
    await rm(folder, { recursive: true, force: true });
  }
});
