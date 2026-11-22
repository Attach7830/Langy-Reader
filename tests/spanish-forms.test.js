import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readerVocabulary } from '../server/reader-vocabulary.js';
import { migrateSpanishFutureSubjunctive, migrateSpanishVerbForms } from '../server/analysis-migrations.js';
const run = promisify(execFile);

test('Spanish pronoun, tense, gender and participle rules pass dependency-free checks', async () => {
  const { stderr } = await run('python3', ['-m', 'unittest', 'discover', '-s', 'language', '-p', 'test_spanish_forms.py']);
  assert.match(stderr, /Ran 13 tests/); assert.match(stderr, /OK/);
});

test('verb variants share exposures, attached pronouns stay separate, and retries/completion/reindex do not inflate counts', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE analyses(book TEXT PRIMARY KEY,state TEXT,metrics TEXT,lemmas TEXT);
    CREATE TABLE chapters(book TEXT,key TEXT,text TEXT,digest TEXT,tokens TEXT,PRIMARY KEY(book,key));`);
  const text = '📖 mirar miró mirarlo mirándome dámelo aproximársele almizclada adulta';
  const book = { id: 'spanish', language: 'es', readAt: 10 };
  const specs = [['mirar', 'mirar'], ['miró', 'mirar'], ['mirarlo', 'mirar', [['mirar', 'mirar'], ['lo', 'él']]],
    ['mirándome', 'mirar', [['mirándo', 'mirar'], ['me', 'yo']]],
    ['dámelo', 'dar', [['dá', 'dar'], ['me', 'yo'], ['lo', 'él']]],
    ['aproximársele', 'aproximar', [['aproximár', 'aproximar'], ['se', 'él'], ['le', 'él']]],
    ['almizclada', 'almizclar'], ['adulta', 'adulto']];
  let cursor = 0;
  const tokens = specs.map(([word, lemma, parts]) => {
    const from = text.indexOf(word, cursor); cursor = from + word.length;
    let offset = from;
    const components = parts?.map(([surface, term], index) => {
      const part = { lemma: term, pos: index ? 'PRON' : 'VERB', from: offset, to: offset + surface.length };
      offset = part.to; return part;
    });
    return { word, lemma, from, to: cursor, properName: false, language: 'es', ...(components ? { components } : {}) };
  });
  const terms = [...new Set(tokens.flatMap((token) => token.components?.map((part) => part.lemma) || [token.lemma]))];
  const metrics = { characters: { inventory: '' }, byLanguage: [{ language: 'es', unit: 'lemmas', count: terms.length }] };
  db.prepare('INSERT INTO analyses VALUES(?,?,?,?)').run(book.id, 'ready', JSON.stringify(metrics), JSON.stringify(terms.map((term) => 'es:' + term)));
  db.prepare('INSERT INTO chapters VALUES(?,?,?,?,?)').run(book.id, 'epub:0', text, 'unchanged-text', JSON.stringify(tokens));
  let read = false;
  const vocabulary = readerVocabulary(db, { completedBooks: () => read ? [book] : [] });
  const ranges = { key: 'epub:0', digest: 'unchanged-text', session: 'first', ranges: [{ from: 0, to: text.length }] };
  vocabulary.record(book, ranges);
  const counts = () => Object.fromEntries(vocabulary.catalogue().entries.map((entry) => [entry.term, entry.exposures]));
  const expected = { mirar: 4, dar: 1, aproximar: 1, almizclar: 1, adulto: 1, yo: 2, 'él': 4 };
  assert.deepEqual(counts(), expected);
  vocabulary.record(book, ranges); assert.deepEqual(counts(), expected);
  read = true; assert.deepEqual(counts(), expected);
  vocabulary.reindex(book); assert.deepEqual(counts(), expected);
  const below = vocabulary.belowThreshold(book).entries;
  assert.equal(below.find((item) => item.term === 'mirar').occurrences, 4);
  assert.equal(below.find((item) => item.term === 'él').occurrences, 4);
  assert.ok(!below.some((item) => item.term.includes(' ')));
});

test('reanalysis replaces a legacy combined headword in saved reading exposure history', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE analyses(book TEXT PRIMARY KEY,state TEXT,metrics TEXT,lemmas TEXT);
    CREATE TABLE chapters(book TEXT,key TEXT,text TEXT,digest TEXT,tokens TEXT,PRIMARY KEY(book,key));`);
  const book = { id: 'legacy', language: 'es' }, text = 'achicarme';
  const metrics = (count) => JSON.stringify({ characters: { inventory: '' }, byLanguage: [{ language: 'es', unit: 'lemmas', count }] });
  db.prepare('INSERT INTO analyses VALUES(?,?,?,?)').run(book.id, 'ready', metrics(1), '["es:achicar yo"]');
  const token = { word: text, lemma: 'achicar yo', from: 0, to: text.length, language: 'es', properName: false };
  db.prepare('INSERT INTO chapters VALUES(?,?,?,?,?)').run(book.id, 'epub:0', text, 'same-text', JSON.stringify([token]));
  const vocabulary = readerVocabulary(db);
  vocabulary.record(book, { key: 'epub:0', digest: 'same-text', ranges: [{ from: 0, to: text.length }] });
  assert.deepEqual(vocabulary.catalogue().entries.map((entry) => entry.term), ['achicar yo']);
  token.lemma = 'achicar'; token.components = [{ lemma: 'achicar', pos: 'VERB', from: 0, to: 7 }, { lemma: 'yo', pos: 'PRON', from: 7, to: 9 }];
  db.prepare('UPDATE analyses SET metrics=?,lemmas=?').run(metrics(2), '["es:achicar","es:yo"]');
  db.prepare('UPDATE chapters SET tokens=?').run(JSON.stringify([token]));
  vocabulary.reindex(book);
  assert.deepEqual(vocabulary.catalogue().entries.map((entry) => entry.term).sort(), ['achicar', 'yo']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM reading_exposures').get().n, 1);
});

test('the verb-form migration refreshes Spanish books even after the future-subjunctive migration was applied', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE analyses(book TEXT PRIMARY KEY,language TEXT,languageSelection TEXT,metrics TEXT,state TEXT,lemmas TEXT,wordCount INTEGER,method TEXT,error TEXT);
    CREATE TABLE estimates(book TEXT PRIMARY KEY,json TEXT);`);
  for (const language of ['es', 'en']) db.prepare('INSERT INTO analyses VALUES(?,?,?,?,?,?,?,?,?)')
    .run(language, language, '[]', '{}', 'ready', '[]', 1, 'contextual', null);
  migrateSpanishFutureSubjunctive(db);
  db.prepare("UPDATE analyses SET state='ready' WHERE book='es'").run();
  assert.deepEqual(migrateSpanishVerbForms(db), ['es']);
  assert.equal(db.prepare("SELECT state FROM analyses WHERE book='en'").get().state, 'ready');
  assert.deepEqual(migrateSpanishVerbForms(db), []);
});
