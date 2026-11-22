import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { migrateSpanishVerbForms, migrateSpanishTaggedMorphology } from '../server/analysis-migrations.js';
const run = promisify(execFile);

test('tagged Spanish morphology handles new paradigms, POS ambiguity, source verification and offline inference', async () => {
  const { stderr } = await run('python3', ['-m', 'unittest', 'discover', '-s', 'language', '-p', 'test_spanish_dictionary.py']);
  assert.match(stderr, /Ran 8 tests/); assert.match(stderr, /OK/);
});

test('the tagged-dictionary upgrade reanalyzes Spanish once after the previous normalization upgrade', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE analyses(book TEXT PRIMARY KEY,language TEXT,languageSelection TEXT,metrics TEXT,state TEXT,lemmas TEXT,wordCount INTEGER,method TEXT,error TEXT);
    CREATE TABLE estimates(book TEXT PRIMARY KEY,json TEXT);`);
  for (const language of ['es', 'en']) db.prepare('INSERT INTO analyses VALUES(?,?,?,?,?,?,?,?,?)').run(language, language, '[]', '{}', 'ready', '[]', 1, 'contextual', null);
  migrateSpanishVerbForms(db);
  db.prepare("UPDATE analyses SET state='ready' WHERE book='es'").run();
  assert.deepEqual(migrateSpanishTaggedMorphology(db), ['es']);
  assert.equal(db.prepare("SELECT state FROM analyses WHERE book='en'").get().state, 'ready');
  assert.deepEqual(migrateSpanishTaggedMorphology(db), []);
});
