import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { openAICache } from '../server/ai-cache.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-ai-cache-')); let model = 'local-model', service;
  const disabled = new Set();
  const options = { identity: () => model, policy: (visitor) => visitor ? { owner: visitor.id, expires: visitor.expires, enabled: !disabled.has(visitor.id) } : null };
  const open = () => service = openAICache(dir, options);
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, disabled, open, model(value) { model = value; } };
}

test('AI answers persist across restarts, stay account-private, and vary by model, language, prompt and context', async (t) => {
  const f = await fixture(t); let service = f.open(), calls = 0;
  const raw = { async summary(body) { calls++; return { text: `Answer ${calls}`, suggestions: ['Why?'] }; } };
  let ai = service.wrap(raw); const body = { text: 'A page.', language: 'es', earlier: 'Earlier context.' };
  const run = (id, data = body) => service.run({ id }, () => ai.summary(data));
  const first = await run('one'); first.suggestions.push('Mutation');
  assert.deepEqual(await run('one', { earlier: body.earlier, language: 'es', text: body.text }), { text: 'Answer 1', suggestions: ['Why?'] });
  service.close(); service = f.open(); ai = service.wrap(raw);
  assert.equal((await run('one')).text, 'Answer 1'); assert.equal(calls, 1);
  await run('two'); await run('one', { ...body, language: 'en' }); await run('one', { ...body, earlier: 'Different context.' });
  await run('one', { ...body, question: 'Why?', mode: 'question' }); f.model('different-model'); await run('one');
  assert.equal(calls, 6);
  const stored = await readFile(join(f.dir, 'ai-responses.sqlite-wal'));
  assert.equal(stored.includes(Buffer.from('Earlier context.')), false, 'cache stores hashed request keys, not prompts');
});

test('disabled accounts bypass reuse; clearing or disabling during generation cannot save a late result', async (t) => {
  const f = await fixture(t), service = f.open(); let calls = 0, release;
  const ai = service.wrap({ async word() { calls++; if (release === null) return new Promise((resolve) => { release = resolve; }); return 'Meaning'; } });
  const run = () => service.run({ id: 'one' }, () => ai.word({ word: 'palabra' }));
  await run(); await run(); assert.equal(calls, 1);
  f.disabled.add('one'); service.clear({ id: 'one' }); await run(); await run(); assert.equal(calls, 3);
  f.disabled.delete('one'); release = null; const pending = run(); await delay(0);
  service.clear({ id: 'one' }); release('Old answer'); await pending;
  release = undefined; assert.equal(await run(), 'Meaning'); assert.equal(calls, 5);
  service.clear({ id: 'one' }); release = null; const disabledLate = run(); await delay(0);
  f.disabled.add('one'); release('Disabled late answer'); await disabledLate;
  f.disabled.delete('one'); release = undefined; await run(); assert.equal(calls, 7);
});

test('concurrent identical requests share one generation without one cancelled client cancelling the others', async (t) => {
  const f = await fixture(t), service = f.open(); let calls = 0, release, backendSignal;
  const ai = service.wrap({ async word(body, signal) { calls++; backendSignal = signal; return new Promise((resolve) => { release = resolve; }); } });
  const first = new AbortController(), second = new AbortController();
  const a = service.run({ id: 'one' }, () => ai.word({ word: 'same' }, first.signal));
  const rejected = assert.rejects(a, { name: 'AbortError' });
  const b = service.run({ id: 'one' }, () => ai.word({ word: 'same' }, second.signal));
  await delay(0); first.abort(); await rejected; assert.equal(backendSignal.aborted, false);
  release('Shared answer'); assert.equal(await b, 'Shared answer'); assert.equal(calls, 1);
  assert.equal(await service.run({ id: 'one' }, () => ai.word({ word: 'same' })), 'Shared answer');
});

test('failures, fully cancelled requests, expired demo scopes and missing scopes are never reused', async (t) => {
  const f = await fixture(t), service = f.open(); let calls = 0, fail = true, release, backendSignal;
  const ai = service.wrap({ async word(body, signal) { calls++; backendSignal = signal; if (fail) throw new Error('Unavailable');
    if (body.word === 'cancel') return new Promise((resolve) => { release = resolve; }); return 'Answer'; } });
  const run = (visitor, body = { word: 'word' }, signal) => service.run(visitor, () => ai.word(body, signal));
  await assert.rejects(run({ id: 'one' }), /Unavailable/); fail = false; await run({ id: 'one' }); assert.equal(calls, 2);
  const controller = new AbortController(), cancelled = run({ id: 'one' }, { word: 'cancel' }, controller.signal);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' }); await delay(0); controller.abort(); await rejected;
  assert.equal(backendSignal.aborted, true); release('Do not store'); await delay(0);
  await run({ id: 'expired', expires: Date.now() - 1 }); await run({ id: 'expired', expires: Date.now() - 1 });
  await run(undefined); await run(undefined); assert.equal(calls, 7);
});

test('all text generation entry points, including vocabulary and background jobs, use their explicit account scope', async (t) => {
  const f = await fixture(t), service = f.open(); let calls = 0;
  const names = ['word', 'summary', 'bookQuestion', 'characterGuide', 'readingLevel', 'discoveryPlan', 'discoveryRecommendations', 'vocabularyMeaning'];
  const ai = service.wrap(Object.fromEntries(names.map((name) => [name, async (...args) => { calls++; assert.ok(args.at(-1) instanceof AbortSignal); return { text: name }; }])));
  await Promise.all(['one', 'two'].map((id) => service.run({ id }, async () => {
    for (const name of names) {
      const args = name === 'vocabularyMeaning' ? [{ term: 'leer' }, 'translation'] : [{ text: 'Text' }];
      assert.equal((await ai[name](...args)).text, name); await ai[name](...args);
    }
  })));
  assert.equal(calls, names.length * 2);
});
