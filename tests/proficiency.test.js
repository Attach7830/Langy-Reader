import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openProficiency } from '../server/proficiency.js';
import { compactHistory, proficiencyEstimate } from '../shared/proficiency.js';

test('reading profiles persist outside input and comprehension, isolate accounts and exclude regional L1 tags from every graph', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-proficiency-')); let native = 'en-US', now = Date.parse('2026-11-26T12:00:00Z'), service;
  const preferences = { nativeLanguage: native, readingLanguages: ['en-GB','es-MX','zh-Hans','pt-BR'] };
  const sources = ['en','es','zh','pt'].map((language) => ({ language, unit: language === 'zh' ? 'characters' : 'lemmas', seen: 25, likelyKnown: 5, exposures: 100, trackedExposures: 75, completionExposures: 25, books: ['book'], history: [{ date: '2026-11-20', seen: 25 }] }));
  const options = { now: () => now, readerSettings: { get: () => ({ preferences: { ...preferences, nativeLanguage: native } }) }, account: (visitor) => ({ id: visitor.id }),
    vocabulary: { insights: (visitor) => ({ threshold: 20, byLanguage: visitor.id === 'owner' ? sources : [] }) },
    readingTime: { summary: (visitor) => ({ byLanguage: visitor.id === 'owner' ? [{ language: 'en-US', milliseconds: 36000000 }, { language: 'es', milliseconds: 3600000 }] : [] }) },
    library: { snapshot: () => ({ books: [{ id: 'book', author: 'A Writer' }] }) } };
  service = openProficiency(dir, options); t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  const owner = { id: 'owner' }; let result = service.summary(owner);
  assert.deepEqual(result.languages.map((row) => row.language), ['es','zh','pt']); assert.equal(result.languages.find((row) => row.language === 'es').trackedHours, 1);
  assert.equal(result.languages.find((row) => row.language === 'zh').unit, 'characters');
  result = service.save({ accountId: 'owner', language: 'es-ES', hours: 1200, reading: 3, listening: 2 }, owner);
  const spanish = result.languages.find((row) => row.language === 'es'); assert.equal(spanish.totalHours, 1201); assert.equal(spanish.readingEstimate.range, 'Intermediate–Advanced'); assert.equal(spanish.listeningEstimate.range, 'Novice–Intermediate');
  service.close(); service = openProficiency(dir, options); assert.equal(service.summary(owner).languages.find((row) => row.language === 'es').outsideHours, 1200);
  assert.equal(service.summary({ id: 'other' }).languages.find((row) => row.language === 'es').outsideHours, 0);
  for (const body of [{ accountId: 'other', language: 'es', hours: 1, reading: 1, listening: 1 }, { accountId: 'owner', language: 'en-GB', hours: 1, reading: 1, listening: 1 }, { accountId: 'owner', language: 'es', hours: -1, reading: 1, listening: 1 }]) assert.throws(() => service.save(body, owner));
  native = 'zh-Hant'; result = service.summary(owner); assert.ok(result.languages.some((row) => row.language === 'en')); assert.ok(!result.languages.some((row) => row.language === 'zh'));
  native = 'es-AR'; result = service.summary(owner); assert.ok(!result.languages.some((row) => row.language === 'es'), 'previously saved outside hours and observations never leak L1 back into the result');
  native = 'en-US'; now += 86400000; result = service.summary(owner); assert.equal(result.languages[0].history.observations.length, 2);
});

test('input hours supply exposure context without awarding proficiency and history reduction retains real observations', () => {
  const evidence = { seen: 500, likelyKnown: 30, trackedHours: 5, outsideHours: 10000 };
  assert.equal(proficiencyEstimate(0, evidence).range, null); assert.equal(proficiencyEstimate(1, evidence).range, 'Novice');
  const points = Array.from({ length: 1000 }, (_, index) => ({ date: String(index), seen: index })), compact = compactHistory(points);
  assert.equal(compact.length, 180); assert.equal(compact[0], points[0]); assert.equal(compact.at(-1), points.at(-1)); assert.ok(compact.every((point) => points.includes(point)));
});
