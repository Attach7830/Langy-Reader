import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readerVocabulary } from '../server/reader-vocabulary.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE analyses(book TEXT PRIMARY KEY,state TEXT,metrics TEXT,lemmas TEXT);
    CREATE TABLE chapters(book TEXT,key TEXT,text TEXT,digest TEXT,tokens TEXT,PRIMARY KEY(book,key));`);
  const completed = new Map();
  const completedBooks = (visitor) => [...(completed.get(visitor?.id || '')?.values() || [])];
  const vocabulary = readerVocabulary(db, { completedBooks });
  function book(id, title, text, words) {
    let cursor = 0;
    const tokens = words.map(([word, lemma, language, properName = false]) => {
      const from = text.indexOf(word, cursor); assert.ok(from >= 0); cursor = from + word.length;
      return { word, lemma, language, properName, from, to: cursor };
    });
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
  function mark(item, read = true, visitor) {
    const owner = visitor?.id || '';
    if (!completed.has(owner)) completed.set(owner, new Map());
    if (read) completed.get(owner).set(item.id, { ...item, readAt: 1000, expires: visitor?.expires ?? null });
    else completed.get(owner).delete(item.id);
  }
  return { db, vocabulary, book, record, mark, completedBooks };
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

test('books marked read contribute all occurrences, preserve language units and use the saved likely-known threshold', (t) => {
  const f = fixture(t);
  const source = f.book('completed', 'Completed', 'Hablo hablaron hablaré libros 看看看 read Teresa', [
    ['Hablo', 'hablar', 'es'], ['hablaron', 'hablar', 'es'], ['hablaré', 'hablar', 'es'], ['libros', 'libro', 'es'],
    ['看看看', '看看看', 'zh'], ['read', 'read', 'en'], ['Teresa', 'teresa', 'es', true],
  ]);
  f.vocabulary.savePreferences({ threshold: 3 }); f.mark(source);
  let result = f.vocabulary.catalogue();
  assert.deepEqual(result.byLanguage, [{ language: 'en', unit: 'lemmas', count: 1 }, { language: 'es', unit: 'lemmas', count: 2 }, { language: 'zh', unit: 'characters', count: 1 }]);
  assert.deepEqual(result.entries.map(({ term, exposures, trackedExposures, completionExposures, likelyKnown }) =>
    ({ term, exposures, trackedExposures, completionExposures, likelyKnown })).sort((a, b) => a.term.localeCompare(b.term)), [
    { term: 'hablar', exposures: 3, trackedExposures: 0, completionExposures: 3, likelyKnown: true },
    { term: 'libro', exposures: 1, trackedExposures: 0, completionExposures: 1, likelyKnown: false },
    { term: 'read', exposures: 1, trackedExposures: 0, completionExposures: 1, likelyKnown: false },
    { term: '看', exposures: 3, trackedExposures: 0, completionExposures: 3, likelyKnown: true },
  ]);
  f.mark(source); assert.deepEqual(f.vocabulary.catalogue(), result, 'repeated marking and requests are idempotent');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM reading_exposures').get().n, 0, 'completion does not fabricate tracked pages');
  assert.equal(f.vocabulary.catalogue(undefined, { language: 'zh', search: '看' }).total, 1);
  assert.equal(f.vocabulary.familiarity(source, f.vocabulary.profile()).byLanguage.find((item) => item.language === 'es').unfamiliar, 0);
  f.mark(source, false);
  assert.equal(f.vocabulary.catalogue().total, 0);
});

test('completion fills only untracked positions, retains rereading and reverses without erasing monitored reading', (t) => {
  const f = fixture(t), source = f.book('overlap', 'Overlap', 'Hablo hablaron hablaré libros 看看看', [
    ['Hablo', 'hablar', 'es'], ['hablaron', 'hablar', 'es'], ['hablaré', 'hablar', 'es'], ['libros', 'libro', 'es'], ['看看看', '看看看', 'zh'],
  ]);
  f.record(source, ['Hablo', '看看看'], undefined, 'pass-one');
  f.record(source, ['Hablo'], undefined, 'pass-two');
  f.mark(source);
  const row = () => f.vocabulary.catalogue().entries.find((entry) => entry.term === 'hablar');
  assert.equal(row().exposures, 4); assert.equal(row().trackedExposures, 2); assert.equal(row().completionExposures, 2);
  assert.equal(f.vocabulary.catalogue().entries.find((entry) => entry.term === '看').exposures, 3, 'individual repeated Han characters are distinct source positions');
  f.record(source, ['hablaron', 'hablaré'], undefined, 'pass-one');
  assert.equal(row().exposures, 4, 'tracking a previously inferred position replaces its inferred contribution');
  assert.equal(row().completionExposures, 0);
  f.vocabulary.reindex(source); assert.equal(row().exposures, 4);
  f.mark(source, false);
  assert.equal(row().exposures, 4);
  assert.equal(f.vocabulary.catalogue().entries.some((entry) => entry.term === 'libro'), false);
  f.mark(source); f.mark(source, false);
  assert.equal(row().exposures, 4);
});

test('pending completed books count after analysis, and reanalysis corrects their language and term frequencies', (t) => {
  const f = fixture(t);
  let source = f.book('pending', 'Pending', 'read read books', [['read', 'read', 'de'], ['read', 'read', 'de'], ['books', 'book', 'de']]);
  f.db.prepare("UPDATE analyses SET state='queued' WHERE book=?").run(source.id);
  f.mark(source);
  assert.equal(f.vocabulary.catalogue().total, 0);
  f.db.prepare("UPDATE analyses SET state='ready' WHERE book=?").run(source.id);
  f.vocabulary.reindex(source);
  assert.equal(f.vocabulary.catalogue().entries.find((entry) => entry.term === 'read').exposures, 2);
  source = f.book('pending', 'Pending', 'read read books', [['read', 'read', 'en'], ['read', 'read', 'en'], ['books', 'book', 'en']]);
  f.mark(source); f.vocabulary.reindex(source);
  assert.deepEqual(f.vocabulary.catalogue().byLanguage, [{ language: 'en', unit: 'lemmas', count: 2 }]);
  const tokens = JSON.parse(f.db.prepare('SELECT tokens FROM chapters WHERE book=?').get(source.id).tokens);
  f.db.prepare('UPDATE chapters SET tokens=? WHERE book=?').run(JSON.stringify(tokens.slice(1)), source.id);
  f.vocabulary.reindex(source);
  assert.equal(f.vocabulary.catalogue().entries.find((entry) => entry.term === 'read').exposures, 1, 'reanalyzing token positions refreshes frequencies even when inventory and source text match');
});

test('completed books backfill after upgrade, remain private and expire with their demo owner', (t) => {
  const f = fixture(t), a = { id: 'a', expires: Date.now() + 60000 }, b = { id: 'b', expires: Date.now() + 60000 };
  const source = f.book('sample', 'Sample', 'pie books', [['pie', 'pie', 'en'], ['books', 'book', 'en']]);
  f.mark(source, true, a);
  const reopened = readerVocabulary(f.db, { completedBooks: f.completedBooks });
  assert.equal(reopened.catalogue(a).total, 2);
  assert.equal(reopened.catalogue(b).total, 0); assert.equal(reopened.catalogue().total, 0);
  f.record(source, ['books'], b, 'one');
  f.mark(source, false, a);
  assert.equal(reopened.catalogue(a).total, 0); assert.equal(reopened.catalogue(b).total, 1);
  f.mark(source, true, { ...a, expires: 1 });
  assert.equal(reopened.catalogue(a).total, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM vocabulary_completed_terms WHERE owner=?').get(a.id).n, 0);
});

test('one full reading includes repeated source positions in different chapters', (t) => {
  const f = fixture(t), source = f.book('chapters', 'Chapters', 'books', [['books', 'book', 'en']]);
  f.db.prepare('INSERT INTO chapters SELECT book,?,text,digest,tokens FROM chapters WHERE book=? AND key=?').run('epub:1', source.id, 'epub:0');
  f.record(source, ['books'], undefined, 'one'); f.mark(source);
  const entry = f.vocabulary.catalogue().entries[0];
  assert.equal(entry.exposures, 2); assert.equal(entry.completionExposures, 1);
  const other = f.book('another', 'Another', 'books', [['books', 'book', 'en']]);
  f.mark(other);
  assert.equal(f.vocabulary.catalogue().entries[0].exposures, 3, 'another completed book adds its own occurrences');
});

test('the completion upgrade rebuilds legacy Han token positions so further reading cannot inflate them', (t) => {
  const f = fixture(t), source = f.book('han', 'Han', '看看', [['看看', '看看', 'zh']]);
  f.record(source, ['看看'], undefined, 'same-pass');
  f.db.exec('DELETE FROM vocabulary_occurrences; DROP TABLE vocabulary_completed_terms; DROP TABLE vocabulary_completions;');
  f.db.prepare('INSERT INTO vocabulary_occurrences VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('', source.id, 'epub:0', source.digest, 'same-pass', 'zh', 'characters', '看', 0, 2, 1000, 1000, null);
  const migrated = readerVocabulary(f.db, { completedBooks: f.completedBooks });
  assert.equal(migrated.catalogue().entries[0].exposures, 2);
  migrated.record(source, { key: 'epub:0', digest: source.digest, session: 'same-pass', ranges: [{ from: 0, to: 2 }] });
  assert.equal(migrated.catalogue().entries[0].exposures, 2);
});

test('book vocabulary lists only below-threshold items, sorts least exposed first and breaks ties by frequency in the book', (t) => {
  const f = fixture(t), source = f.book('target', 'Target', 'apples apples apples bananas bananas read 中文 Teresa', [
    ['apples', 'apple', 'en'], ['apples', 'apple', 'en'], ['apples', 'apple', 'en'], ['bananas', 'banana', 'en'], ['bananas', 'banana', 'en'],
    ['read', 'read', 'en'], ['中', '中', 'zh'], ['文', '文', 'zh'], ['Teresa', 'teresa', 'en', true],
  ]);
  const history = f.book('history', 'History', 'apples read 中', [['apples', 'apple', 'en'], ['read', 'read', 'en'], ['中', '中', 'zh']]);
  f.vocabulary.savePreferences({ threshold: 3 });
  f.record(history, ['apples', 'read', '中'], undefined, 'one');
  f.record(history, ['read'], undefined, 'two'); f.record(history, ['read'], undefined, 'three');
  const before = f.vocabulary.catalogue(), result = f.vocabulary.belowThreshold(source);
  assert.deepEqual(result.entries.map(({ term, exposures, occurrences }) => [term, exposures, occurrences]), [
    ['banana', 0, 2], ['文', 0, 1], ['apple', 1, 3], ['中', 1, 1],
  ]);
  assert.equal(result.threshold, 3); assert.equal(result.entries[0].remaining, 3);
  assert.deepEqual(result.byLanguage, [{ language: 'en', unit: 'lemmas', total: 3, count: 2 }, { language: 'zh', unit: 'characters', total: 2, count: 2 }]);
  assert.equal(f.vocabulary.belowThreshold(source, undefined, { language: 'zh' }).entries.length, 2);
  assert.equal(f.vocabulary.belowThreshold(source, undefined, { search: 'APPLE' }).entries[0].term, 'apple');
  assert.deepEqual(f.vocabulary.catalogue(), before, 'viewing the list never records new reading exposure');
  const word = f.vocabulary.term(source, { term: 'apple', language: 'en', unit: 'lemmas' });
  assert.equal(word.example.word, 'apples'); assert.match(word.example.text, /apples apples/);
  assert.throws(() => f.vocabulary.term(source, { term: 'apple', language: 'es', unit: 'lemmas' }), { status: 404 });
  assert.throws(() => f.vocabulary.term(source, { term: '<script>', language: 'en', unit: 'lemmas' }), { status: 404 });
  f.vocabulary.savePreferences({ threshold: 1 });
  assert.deepEqual(f.vocabulary.belowThreshold(source).entries.map((row) => row.term), ['banana', '文']);
  f.mark(source);
  assert.equal(f.vocabulary.belowThreshold(source).total, 0, 'completed-book contributions use the same threshold');
  assert.ok(f.vocabulary.belowThreshold(source, { id: 'another-reader' }).total > 0, 'a different visitor has an independent tally');
});

test('book vocabulary pagination stays bounded and pending or corrected analysis cannot publish stale vocabulary', (t) => {
  const f = fixture(t), words = Array.from({ length: 26 }, (_, n) => `word${n}`);
  let source = f.book('pages', 'Pages', words.join(' '), words.map((word) => [word, word, 'en']));
  const first = f.vocabulary.belowThreshold(source);
  assert.equal(first.entries.length, 10); assert.equal(first.more, true); assert.equal(first.total, 26);
  const second = f.vocabulary.belowThreshold(source, undefined, { offset: 10 });
  assert.equal(second.entries.length, 10); assert.ok(second.entries.every((row) => !first.entries.some((previous) => previous.term === row.term)));
  const end = f.vocabulary.belowThreshold(source, undefined, { offset: 10000000 });
  assert.equal(end.offset, 20); assert.equal(end.entries.length, 6); assert.equal(end.more, false);
  f.db.prepare("UPDATE analyses SET state='queued' WHERE book=?").run(source.id);
  assert.throws(() => f.vocabulary.belowThreshold(source), { status: 409 });
  source = f.book('pages', 'Pages', 'livros', [['livros', 'livro', 'pt']]); f.vocabulary.reindex(source);
  assert.equal(f.vocabulary.belowThreshold(source).entries[0].term, 'livro');
  assert.throws(() => f.vocabulary.term(source, { term: 'word0', language: 'en', unit: 'lemmas' }), { status: 404 });
});
