import test from 'node:test';
import assert from 'node:assert/strict';
import { vocabularyMeanings } from '../server/vocabulary-meanings.js';
import { openAISettings } from '../server/ai.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('vocabulary meanings use book context, dictionary synonyms and a labelled Spanish definition when synonyms are missing', async () => {
  const calls = [], dictionaryCalls = [];
  let hasSynonyms = true, revision = 'one', model = 'local-model';
  const entry = { term: 'libro', language: 'es', unit: 'lemmas', example: { word: 'libros', text: 'Leí varios libros.', pos: 'NOUN' } };
  const generate = vocabularyMeanings({
    vocabulary: { term(book, body) { assert.equal(body.term, 'libro'); return { ...entry, revision }; } },
    ai: { settings: () => ({ model }), async vocabularyMeaning(source, mode, signal) { calls.push({ source, mode, signal }); return mode === 'translation' ? 'book' : 'Una obra escrita para leer.'; } },
    lookupSynonyms(body) { dictionaryCalls.push(body); return hasSynonyms ? { senses: [{ labelLanguage: 'es', label: 'Obra escrita', terms: ['obra', 'volumen'] }] } : { status: 'missing', senses: [] }; },
  });
  const book = { id: 'one' }, body = { term: 'libro', language: 'es', unit: 'lemmas', mode: 'synonyms' };
  const dictionary = await generate(book, body);
  assert.equal(dictionary.text, 'Obra escrita: obra, volumen'); assert.match(dictionary.source, /Dictionary/);
  assert.equal(calls.length, 0); assert.equal(dictionaryCalls[0].lemma, 'libro');
  hasSynonyms = false; revision = 'two';
  const fallback = await generate(book, body);
  assert.match(fallback.source, /no dictionary synonyms/); assert.equal(fallback.language, 'es'); assert.equal(calls[0].mode, 'definition');
  const translated = await generate(book, { ...body, mode: 'translation' });
  assert.equal(translated.text, 'book'); assert.equal(translated.language, 'en');
  assert.equal(calls[1].source.example.text, 'Leí varios libros.');
  await generate(book, { ...body, mode: 'translation' }); assert.equal(calls.length, 2, 'successful meanings are cached');
  entry.example.text = 'El libro era antiguo.';
  await generate(book, { ...body, mode: 'translation' }); assert.equal(calls.length, 3, 'a changed book example invalidates the meaning');
  model = 'different-local-model'; await generate(book, { ...body, mode: 'translation' }); assert.equal(calls.length, 4);
  await assert.rejects(generate(book, { ...body, mode: '__proto__' }), { status: 422 });
});

test('AI vocabulary prompts preserve the source language and explicitly request English translations or Spanish explanations', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-word-meanings-')), previous = globalThis.fetch, requests = [];
  t.after(async () => { globalThis.fetch = previous; await rm(folder, { recursive: true, force: true }); });
  globalThis.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ message: { content: JSON.stringify({ text: 'Meaning.' }) } });
  };
  const ai = await openAISettings(folder, true), entry = { term: 'ler', language: 'pt', example: { word: 'leio', pos: 'VERB', text: 'Leio um livro.' } };
  const controller = new AbortController();
  await ai.vocabularyMeaning(entry, 'translation', controller.signal);
  await ai.vocabularyMeaning(entry, 'definition', controller.signal);
  await ai.vocabularyMeaning(entry, 'synonyms', controller.signal);
  assert.match(requests[0].messages[0].content, /entirely in English/);
  assert.match(requests[1].messages[0].content, /únicamente en español/);
  assert.match(requests[2].messages[1].content, /Spanish equivalents/);
  assert.match(requests[0].messages[1].content, /Portuguese \(pt\)/);
  assert.match(requests[0].messages[1].content, /Leio um livro/);
  assert.match(requests[0].messages[1].content, /queryLemma/);
  await assert.rejects(ai.vocabularyMeaning(entry, 'constructor', controller.signal), { status: 422 });
  assert.equal(requests.length, 3, 'invalid modes make no inference request');
});

test('other book languages receive Spanish equivalents, failures remain retryable and cancelled results are not cached', async () => {
  let fail = true, calls = 0;
  const controller = new AbortController(); controller.abort();
  const generate = vocabularyMeanings({
    vocabulary: { term: () => ({ term: 'ler', language: 'pt', unit: 'lemmas', revision: 'one', example: { word: 'leio', text: 'Leio um livro.' } }) },
    ai: { settings: () => ({}), async vocabularyMeaning(entry, mode) { calls++; assert.equal(mode, 'synonyms'); if (fail) throw new Error('Offline'); return 'leer'; } },
    lookupSynonyms() { assert.fail('Spanish dictionary must not be applied to Portuguese'); },
  });
  const body = { mode: 'synonyms' }, book = { id: 'portuguese' };
  await assert.rejects(generate(book, body), /Offline/);
  fail = false;
  assert.equal((await generate(book, body, controller.signal)).source, 'AI Spanish equivalents');
  await generate(book, body); assert.equal(calls, 3, 'an aborted lookup must not be cached');
});
