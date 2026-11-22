import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { migrateSpanishFutureSubjunctive } from '../server/analysis-migrations.js';
const run = promisify(execFile);

test('Spanish future conjugation rules pass dependency-free morphology checks', async () => {
  const { stderr } = await run('python3', ['-m', 'unittest', 'discover', '-s', 'language', '-p', 'test_spanish_morphology.py']);
  assert.match(stderr, /Ran 14 tests/); assert.match(stderr, /OK/);
});

test('existing Spanish and mixed-book analyses are refreshed once without discarding chapters, audio or other languages', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE analyses(book TEXT PRIMARY KEY, language TEXT, languageSelection TEXT, metrics TEXT,state TEXT,lemmas TEXT,wordCount INTEGER,method TEXT,error TEXT);
    CREATE TABLE estimates(book TEXT PRIMARY KEY,json TEXT);
    CREATE TABLE chapters(book TEXT,text TEXT,tokens TEXT);
    CREATE TABLE audio(book TEXT,path TEXT);`);
  const insert = db.prepare('INSERT INTO analyses VALUES(?,?,?,?,?,?,?,?,?)');
  for (const [id, language, selection, metrics] of [['spanish', 'es-MX', [], {}], ['mixed', 'zh', ['zh', 'es'], {}], ['detected', 'en', [], { languages: ['en', 'es'] }], ['english', 'en', ['en'], { languages: ['en'] }], ['chinese', 'zh', ['zh'], { languages: ['zh'] }]]) {
    insert.run(id, language, JSON.stringify(selection), JSON.stringify(metrics), 'ready', '["hubierir"]', 1, 'contextual', null);
    db.prepare('INSERT INTO estimates VALUES(?,?)').run(id, '{"state":"ready"}');
    db.prepare('INSERT INTO chapters VALUES(?,?,?)').run(id, 'Si hubiere tiempo.', 'original tokens');
    db.prepare('INSERT INTO audio VALUES(?,?)').run(id, 'original.mp3');
  }
  const chapters = db.prepare('SELECT * FROM chapters').all(), audio = db.prepare('SELECT * FROM audio').all();
  assert.deepEqual(migrateSpanishFutureSubjunctive(db), ['spanish', 'mixed', 'detected']);
  assert.deepEqual(db.prepare("SELECT book FROM analyses WHERE state='queued'").all().map((row) => row.book), ['spanish', 'mixed', 'detected']);
  assert.equal(db.prepare('SELECT metrics FROM analyses WHERE book=?').get('spanish').metrics, null);
  assert.equal(db.prepare('SELECT json FROM estimates WHERE book=?').get('spanish'), undefined);
  assert.ok(db.prepare('SELECT json FROM estimates WHERE book=?').get('english'));
  assert.deepEqual(db.prepare('SELECT * FROM chapters').all(), chapters); assert.deepEqual(db.prepare('SELECT * FROM audio').all(), audio);
  db.prepare("UPDATE analyses SET state='ready',metrics='{}' WHERE book='spanish'").run();
  assert.deepEqual(migrateSpanishFutureSubjunctive(db), []);
  assert.equal(db.prepare('SELECT state FROM analyses WHERE book=?').get('spanish').state, 'ready');
});
