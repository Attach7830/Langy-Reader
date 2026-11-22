import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readerVocabulary } from '../server/reader-vocabulary.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE analyses(book TEXT PRIMARY KEY,state TEXT,metrics TEXT,lemmas TEXT);
    CREATE TABLE chapters(book TEXT,key TEXT,text TEXT,digest TEXT,tokens TEXT,PRIMARY KEY(book,key));`);
  const vocabulary = readerVocabulary(db);
  function book(id, title, text, words) {
    const tokens = words.map(([word, lemma, language, properName = false]) => ({ word, lemma, language, properName, from: text.indexOf(word), to: text.indexOf(word) + word.length }));
    const chinese = [...new Set(tokens.filter((token) => token.language === 'zh').map((token) => token.word))].join('');
    const groups = new Map();
    for (const token of tokens) {
      if (token.properName) continue;
      if (!groups.has(token.language)) groups.set(token.language, new Set());
      groups.get(token.language).add(token.lemma);
    }
    const metrics = { characters: { inventory: chinese }, byLanguage: [...groups].map(([language, terms]) => ({ language, unit: language === 'zh' ? 'characters' : 'lemmas', count: terms.size, total: terms.size })) };
    const lemmas = tokens.filter((token) => token.language !== 'zh' && !token.properName).map((token) => `${token.language}:${token.lemma}`);
    const digest = createHash('sha256').update(text).digest('hex');
    db.prepare('INSERT OR REPLACE INTO analyses VALUES(?,?,?,?)').run(id, 'ready', JSON.stringify(metrics), JSON.stringify([...new Set(lemmas)]));
    db.prepare('INSERT OR REPLACE INTO chapters VALUES(?,?,?,?,?)').run(id, 'epub:0', text, digest, JSON.stringify(tokens));
    return { id, title, language: words[0][2], text, digest, tokens };
  }
  function record(item, terms, visitor, session) {
    return vocabulary.record(item, { key: 'epub:0', digest: item.digest, ranges: item.tokens.filter((token) => terms.includes(token.word)).map(({ from, to }) => ({ from, to })), ...(session ? { session } : {}) }, visitor);
  }
  return { db, vocabulary, book, record };
}

test('only displayed words enter the catalogue; inflections merge and language/character inventories remain separate', (t) => {
  const f = fixture(t);
  const spanish = f.book('mixed', 'Mixed', 'Hablo hablaron libros pie 中文书 Teresa', [
    ['Hablo', 'hablar', 'es'], ['hablaron', 'hablar', 'es'], ['libros', 'libro', 'es'], ['pie', 'pie', 'es'],
    ['中', '中', 'zh'], ['文', '文', 'zh'], ['书', '书', 'zh'], ['Teresa', 'teresa', 'es', true],
  ]);
  const english = f.book('english', 'English', 'pie books', [['pie', 'pie', 'en'], ['books', 'book', 'en']]);
  f.record(spanish, ['Hablo', 'hablaron', 'pie', '中', '文', 'Teresa']);
  assert.deepEqual(f.vocabulary.section(spanish, 'epub:0'), { key: 'epub:0', text: spanish.text, textHash: spanish.digest, analysisState: 'ready' });
  let catalogue = f.vocabulary.catalogue();
  assert.deepEqual(catalogue.byLanguage, [{ language: 'es', unit: 'lemmas', count: 2 }, { language: 'zh', unit: 'characters', count: 2 }]);
  assert.ok(!catalogue.entries.some((item) => ['libro', '书', 'teresa'].includes(item.term)));
  const mixed = f.vocabulary.familiarity(spanish, f.vocabulary.profile());
  assert.deepEqual(mixed.byLanguage.map(({ language, seen, unfamiliar }) => ({ language, seen, unfamiliar })), [{ language: 'es', seen: 2, unfamiliar: 1 }, { language: 'zh', seen: 2, unfamiliar: 1 }]);
  assert.equal(f.vocabulary.familiarity(english, f.vocabulary.profile()).byLanguage[0].seen, 0, 'Spanish pie is not English pie');
  f.record(spanish, ['Hablo']); f.record(english, ['pie']);
  catalogue = f.vocabulary.catalogue();
  assert.equal(catalogue.entries.filter((item) => item.term === 'hablar').length, 1);
  assert.equal(catalogue.entries.filter((item) => item.term === 'pie').length, 2);
  assert.equal(readerVocabulary(f.db).catalogue().entries.length, catalogue.entries.length, 'catalogue survives opening the service again');
  assert.throws(() => f.vocabulary.record(spanish, { key: 'epub:0', digest: spanish.digest, ranges: [{ from: -1, to: 99 }] }), { status: 422 });
  assert.throws(() => f.vocabulary.record(spanish, { key: 'epub:0', digest: 'stale', ranges: [{ from: 0, to: 5 }] }), { status: 409 });
});

test('reader catalogues are private, bounded and searchable, and expired demo exposure is removed', (t) => {
  const f = fixture(t), first = { id: 'visitor-a', expires: Date.now() + 60000 }, second = { id: 'visitor-b', expires: Date.now() + 60000 };
  const item = f.book('sample', 'Shared sample', 'books reading', [['books', 'book', 'en'], ['reading', 'read', 'en']]);
  f.record(item, ['books'], first);
  assert.equal(f.vocabulary.catalogue(second).total, 0);
  assert.equal(f.vocabulary.catalogue().total, 0);
  assert.equal(f.vocabulary.catalogue(first, { language: 'es' }).total, 0);
  assert.equal(f.vocabulary.catalogue(first, { search: 'BOOK' }).entries[0].term, 'book');
  f.record(item, ['reading'], second);
  assert.deepEqual(f.vocabulary.catalogue(first).entries.map((row) => row.term), ['book']);
  const save = f.db.prepare('INSERT INTO vocabulary_seen VALUES(?,?,?,?,?,?,?,?)');
  for (let n = 0; n < 105; n++) save.run(first.id, 'another', 'en', 'lemmas', 'word' + n, 1, n, first.expires);
  const page = f.vocabulary.catalogue(first);
  assert.equal(page.entries.length, 100); assert.equal(page.more, true);
  assert.equal(f.vocabulary.catalogue(first, { offset: 100 }).entries.length, 6);
  f.db.prepare('UPDATE vocabulary_seen SET expires=1 WHERE owner=?').run(first.id);
  assert.equal(f.vocabulary.catalogue(first).total, 0);
  assert.equal(f.vocabulary.catalogue(second).entries[0].term, 'read');
});

test('language corrections reclassify previously seen passages without erasing other books, and recommendations rank shared vocabulary', (t) => {
  const f = fixture(t);
  let source = f.book('reference', 'Reference', 'read books', [['read', 'read', 'de'], ['books', 'book', 'de']]);
  f.record(source, ['read']);
  const keeper = f.book('keeper', 'Keeper', 'Haus', [['Haus', 'haus', 'de']]); f.record(keeper, ['Haus']);
  source = f.book('reference', 'Reference', 'read books', [['read', 'read', 'en'], ['books', 'book', 'en']]);
  f.vocabulary.reindex(source);
  assert.deepEqual(f.vocabulary.catalogue().entries.map(({ language, term }) => [language, term]).sort(), [['de', 'haus'], ['en', 'read']]);
  const close = f.book('close', 'Close', 'read books learn', [['read', 'read', 'en'], ['books', 'book', 'en'], ['learn', 'learn', 'en']]);
  const distant = f.book('distant', 'Distant', 'read tree sky', [['read', 'read', 'en'], ['tree', 'tree', 'en'], ['sky', 'sky', 'en']]);
  const unrelated = f.book('other-language', 'Other language', 'read', [['read', 'read', 'es']]);
  const recommendations = f.vocabulary.recommendations(source, [source, close, distant, unrelated], f.vocabulary.profile());
  assert.deepEqual(recommendations.map((book) => book.id), ['close', 'distant']);
  assert.equal(recommendations[0].byLanguage[0].shared, 2);
  assert.equal(recommendations[0].familiarity.byLanguage[0].unfamiliar, 2);
  const hybrid = f.book('hybrid', 'Hybrid', 'read books 中', [['read', 'read', 'en'], ['books', 'book', 'en'], ['中', '中', 'zh']]);
  const mixed = f.vocabulary.recommendations(source, [close, hybrid], f.vocabulary.profile());
  assert.deepEqual(mixed.map((book) => book.id), ['close', 'hybrid'], 'an additional unseen language is included in the similarity comparison');
  assert.deepEqual(mixed[1].familiarity.byLanguage.map(({ language, unfamiliar }) => ({ language, unfamiliar })), [{ language: 'en', unfamiliar: 1 }, { language: 'zh', unfamiliar: 1 }]);
});

test('likely known vocabulary uses reading exposures alone, deduplicates overlapping pages, and changes immediately with the saved threshold', (t) => {
  const f = fixture(t);
  const source = f.book('exposure-book', 'Exposure book', 'Hablo hablaron libros 中文', [
    ['Hablo', 'hablar', 'es'], ['hablaron', 'hablar', 'es'], ['libros', 'libro', 'es'], ['中', '中', 'zh'], ['文', '文', 'zh'],
  ]);
  assert.deepEqual(f.vocabulary.preferences(), { threshold: 20 });
  f.vocabulary.savePreferences({ threshold: 3 });
  f.record(source, ['Hablo', 'hablaron', '中'], undefined, 'first-reading');
  let catalogue = f.vocabulary.catalogue();
  assert.equal(catalogue.entries.find((row) => row.term === 'hablar').exposures, 2);
  assert.equal(catalogue.entries.find((row) => row.term === 'hablar').likelyKnown, false);
  f.record(source, ['Hablo'], undefined, 'first-reading');
  f.record(source, ['Hablo', 'hablaron', '中'], undefined, 'first-reading');
  assert.equal(f.vocabulary.catalogue().entries.find((row) => row.term === 'hablar').exposures, 2, 'redraws and overlapping ranges are not new encounters');
  f.record(source, ['Hablo', '中'], undefined, 'second-reading');
  catalogue = f.vocabulary.catalogue();
  assert.equal(catalogue.entries.find((row) => row.term === 'hablar').exposures, 3);
  assert.equal(catalogue.entries.find((row) => row.term === 'hablar').likelyKnown, true);
  assert.deepEqual(catalogue.likelyKnown, [{ language: 'es', unit: 'lemmas', count: 1 }, { language: 'zh', unit: 'characters', count: 0 }]);
  f.vocabulary.savePreferences({ threshold: 2 });
  assert.deepEqual(f.vocabulary.catalogue().likelyKnown, [{ language: 'es', unit: 'lemmas', count: 1 }, { language: 'zh', unit: 'characters', count: 1 }]);
  assert.equal(f.vocabulary.familiarity(source, f.vocabulary.profile()).byLanguage[0].likelyKnown, 1);
  f.vocabulary.reindex(source);
  assert.equal(f.vocabulary.catalogue().entries.find((row) => row.term === 'hablar').exposures, 3, 'reanalyzing does not inflate the history');
  assert.deepEqual(readerVocabulary(f.db).preferences(), { threshold: 2 });
  assert.deepEqual(f.vocabulary.preferences({ id: 'another-reader' }), { threshold: 20 });
  for (const value of [0, -1, 1.5, 10001, '3', null]) assert.throws(() => f.vocabulary.savePreferences({ threshold: value }), { status: 422 });
});

test('existing saved ranges backfill occurrence counts without inflating overlaps or losing language identities', (t) => {
  const f = fixture(t);
  const source = f.book('legacy', 'Legacy book', 'Hablo hablaron 中文', [['Hablo', 'hablar', 'es'], ['hablaron', 'hablar', 'es'], ['中', '中', 'zh'], ['文', '文', 'zh']]);
  f.record(source, ['Hablo']); f.record(source, ['Hablo', 'hablaron', '中']);
  f.db.exec('DROP TABLE vocabulary_occurrences; ALTER TABLE reading_exposures DROP COLUMN session;');
  const migrated = readerVocabulary(f.db), catalogue = migrated.catalogue();
  assert.equal(catalogue.entries.find((row) => row.term === 'hablar').exposures, 2);
  assert.equal(catalogue.entries.find((row) => row.term === '中').exposures, 1);
  assert.equal(catalogue.threshold, 20);
});
