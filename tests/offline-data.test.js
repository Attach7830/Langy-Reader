import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedRange, rangeBounds } from '../public/offline-range.js';
import { offlineLookup } from '../src/offline-data.js';
import { offlinePacks } from '../server/offline-pack.js';

test('offline audiobook seeking serves exact byte ranges, suffixes, and rejects invalid ranges', async () => {
  const response = () => new Response('0123456789', { headers: { 'Content-Length': '10', 'Content-Type': 'audio/mpeg' } });
  const partial = await cachedRange(response(), 'bytes=3-6'); assert.equal(partial.status, 206); assert.equal(await partial.text(), '3456');
  assert.equal(partial.headers.get('Content-Range'), 'bytes 3-6/10');
  assert.equal(await (await cachedRange(response(), 'bytes=-2')).text(), '89'); assert.equal(await (await cachedRange(response(), 'bytes=8-')).text(), '89');
  assert.equal((await cachedRange(response(), 'bytes=20-30')).status, 416); assert.equal(rangeBounds('bytes=1-2,4-5', 10), null);
});
test('offline word help uses saved dictionary evidence and offline search/pinyin need no model', () => {
  const pack = { book: { id: 'book' }, sections: [{ key: 'epub:0', title: 'One', text: '读书 es interesante.' }], dictionary: {
    lexical: { '["es","interesante"]': { text: 'atractivo', senses: [{ label: 'interesting', labelLanguage: 'en', terms: ['atractivo'] }] } },
    chinese: { '读书': { word: '读书', pinyin: 'dú shū', senses: [{ meanings: ['to read'] }] } }, } };
  assert.equal(offlineLookup(pack, '/api/ai/word', { word: 'interesante', language: 'es', mode: 'translation' }).text, 'interesting');
  assert.equal(offlineLookup(pack, '/api/ai/word', { word: 'interesante', language: 'es', mode: 'synonyms' }).text, 'atractivo');
  const word = offlineLookup(pack, '/api/mandarin/word', { text: '我喜欢读书。', offset: 4 }); assert.equal(word.word, '读书'); assert.equal(word.from, 3);
  assert.equal(offlineLookup(pack, '/api/mandarin/pinyin', { text: '银行' }).characters[1].pinyin, 'háng');
  assert.equal(offlineLookup(pack, '/api/books/book/search?q=interesante').results.length, 1);
  assert.throws(() => offlineLookup(pack, '/api/ai/summary', {}), /connection/u);
});
test('offline packs include canonical source sections, matched dictionaries and the selected recording without paid API calls', async () => {
  const section = { key: 'epub:0', text: 'libros 中文', title: 'Book', digest: 'd', languages: [], tokens: [{ word: 'libros', lemma: 'libro', language: 'es' }] };
  const packs = offlinePacks({ learning: { textSections: () => [section], info: () => ({ state: 'ready' }), narration: () => ({ audio: { id: 'recording', state: 'ready' } }), unit: (_book, key, recording) => ({ key, recording }) },
    lookupSynonyms: ({ lemma }) => ({ text: lemma }), mandarin: { lookup: ({ text }) => ({ word: text, pinyin: '', senses: [] }) } });
  const pack = await packs({ id: 'book', language: 'es' }, 'recording');
  assert.equal(pack.dictionary.lexical['["es","libros"]'].text, 'libro'); assert.ok(pack.dictionary.chinese['中文']);
  assert.equal(pack.units[0].recording, 'recording'); await assert.rejects(packs({ id: 'book', language: 'es' }, 'wrong'), { status: 409 });
});
