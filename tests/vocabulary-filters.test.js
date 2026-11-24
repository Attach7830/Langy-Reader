import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { migrateLexicalFilters } from '../server/analysis-migrations.js';
import { countReadingUnits, readingUnits } from '../server/reading-counts.js';
const run = promisify(execFile);

test('bound anti-prefix and numeral exclusions pass source-offset regression checks', async () => {
  const { stderr } = await run('python3', ['-m', 'unittest', 'discover', '-s', 'language', '-p', 'test_vocabulary_filters.py']);
  assert.match(stderr, /Ran 6 tests/); assert.match(stderr, /OK/);
});

test('the lexical filter upgrade refreshes existing analyses once without changing text, progress or surface reading totals', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE analyses(book TEXT PRIMARY KEY,state TEXT,lemmas TEXT,wordCount INTEGER,method TEXT,metrics TEXT,error TEXT);
    CREATE TABLE estimates(book TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE chapters(book TEXT,text TEXT,digest TEXT);
    CREATE TABLE reading_exposures(book TEXT,ranges TEXT);
    INSERT INTO analyses VALUES('es','ready','["es:anti","es:U2"]',2,'contextual','{}',NULL);
    INSERT INTO analyses VALUES('en','error',NULL,NULL,NULL,NULL,'temporarily offline');
    INSERT INTO chapters VALUES('es','antihéroe U2 libro 2','same-digest');
    INSERT INTO reading_exposures VALUES('es','[{"from":0,"to":18}]');`);
  const chapter = db.prepare('SELECT * FROM chapters').get(), exposure = db.prepare('SELECT * FROM reading_exposures').get();
  const words = countReadingUnits(readingUnits(chapter, 'es'));
  assert.equal(words.words, 4);
  assert.deepEqual(migrateLexicalFilters(db), ['es', 'en']); assert.deepEqual(migrateLexicalFilters(db), []);
  assert.deepEqual(db.prepare('SELECT * FROM chapters').get(), chapter); assert.deepEqual(db.prepare('SELECT * FROM reading_exposures').get(), exposure);
  assert.deepEqual(countReadingUnits(readingUnits(chapter, 'es')), words);
  assert.equal(db.prepare('SELECT state FROM analyses WHERE book=?').get('es').state, 'queued');
});
