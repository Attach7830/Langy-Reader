import { baseLanguage, selectedLanguages } from '../shared/language.js';

export function migrateSpanishFutureSubjunctive(db) {
  return refreshSpanishAnalyses(db, 'spanish-future-subjunctive-v1');
}

export function migrateSpanishVerbForms(db) {
  return refreshSpanishAnalyses(db, 'spanish-verb-components-and-inflections-v1');
}

export function migrateSpanishTaggedMorphology(db) {
  return refreshSpanishAnalyses(db, 'spanish-tagged-morphology-v1');
}

function refreshSpanishAnalyses(db, name) {
  db.exec('CREATE TABLE IF NOT EXISTS analysis_migrations (name TEXT PRIMARY KEY, appliedAt INTEGER NOT NULL) STRICT');
  if (db.prepare('SELECT 1 FROM analysis_migrations WHERE name=?').get(name)) return [];
  const affected = db.prepare("SELECT book,language,languageSelection,metrics FROM analyses WHERE state IN ('ready','error')").all().filter((row) => {
    const metrics = JSON.parse(row.metrics || '{}');
    const languages = [row.language, ...selectedLanguages(JSON.parse(row.languageSelection || '[]')), ...(metrics.languages || []),
      ...(metrics.byLanguage || []).map((item) => item.language)];
    return languages.some((language) => baseLanguage(language, '') === 'es');
  }).map((row) => row.book);
  db.exec('BEGIN');
  try {
    for (const id of affected) {
      db.prepare("UPDATE analyses SET state='queued',lemmas=NULL,wordCount=NULL,method=NULL,metrics=NULL,error=NULL WHERE book=?").run(id);
      db.prepare('DELETE FROM estimates WHERE book=?').run(id);
    }
    db.prepare('INSERT INTO analysis_migrations VALUES(?,?)').run(name, Date.now());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return affected;
}
