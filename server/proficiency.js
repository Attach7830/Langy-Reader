import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { baseLanguage, selectedLanguages } from '../shared/language.js';
import { compactHistory, proficiencyEstimate } from '../shared/proficiency.js';
import { RequestError } from './books.js';

export function openProficiency(dir, { vocabulary, readingTime, library, readerSettings, account, now = Date.now }) {
  const db = new DatabaseSync(join(dir, 'proficiency.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS inputs(owner TEXT NOT NULL,language TEXT NOT NULL,hours REAL NOT NULL,reading INTEGER NOT NULL,listening INTEGER NOT NULL,updated INTEGER NOT NULL,expires INTEGER,PRIMARY KEY(owner,language)) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS observations(owner TEXT NOT NULL,language TEXT NOT NULL,day TEXT NOT NULL,known INTEGER NOT NULL,threshold INTEGER NOT NULL,hours REAL NOT NULL,expires INTEGER,PRIMARY KEY(owner,language,day)) STRICT, WITHOUT ROWID;`);
  function context(visitor) {
    const settings = readerSettings.get(visitor), who = account(visitor);
    return { settings, who, native: baseLanguage(settings.preferences.nativeLanguage, '') };
  }
  function summary(visitor) {
    const { settings, who, native } = context(visitor);
    for (const table of ['inputs', 'observations']) db.prepare(`DELETE FROM ${table} WHERE expires IS NOT NULL AND expires<=?`).run(now());
    const exposure = vocabulary.insights(visitor), active = readingTime.summary(who), today = new Date(now()).toISOString().slice(0, 10);
    const saved = new Map(db.prepare('SELECT * FROM inputs WHERE owner=?').all(who.id).map((row) => [row.language, row]));
    const snapshot = library.snapshot(visitor);
    const all = selectedLanguages([...snapshot.books.flatMap((book) => [book.language, ...(book.languages || [])]),...(settings.preferences.readingLanguages || []), ...exposure.byLanguage.map((row) => row.language), ...active.byLanguage.map((row) => row.language), ...saved.keys()]).filter((code) => code !== native);
    const visible = new Map(snapshot.books.map((book) => [book.id, book]));
    const languages = all.map((language) => {
      const terms = exposure.byLanguage.find((row) => baseLanguage(row.language, '') === language) || { unit: language === 'zh' ? 'characters' : 'lemmas', seen: 0, likelyKnown: 0, exposures: 0, trackedExposures: 0, completionExposures: 0, history: [], books: [] };
      const input = saved.get(language) || { hours: 0, reading: 0, listening: 0, updated: null };
      const trackedHours = active.byLanguage.filter((row) => baseLanguage(row.language, '') === language).reduce((sum, row) => sum + row.milliseconds / 3600000, 0);
      const books = terms.books.map((id) => visible.get(id)).filter(Boolean);
      const evidence = { trackedHours, outsideHours: input.hours, seen: terms.seen, likelyKnown: terms.likelyKnown };
      db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,language,day) DO UPDATE SET known=excluded.known,threshold=excluded.threshold,hours=excluded.hours,expires=excluded.expires')
        .run(who.id, language, today, terms.likelyKnown, exposure.threshold, trackedHours + input.hours, who.expires ?? null);
      const observations = db.prepare('SELECT day AS date,known,threshold,hours FROM observations WHERE owner=? AND language=? ORDER BY day').all(who.id, language);
      const seen = terms.history.slice(); if (!seen.length || seen.at(-1).date !== today) seen.push({ date: today, seen: terms.seen });
      return { language, unit: terms.unit, seen: terms.seen, likelyKnown: terms.likelyKnown, exposures: terms.exposures, familiarEncounterPercent: terms.exposures ? (terms.familiarExposures || 0) / terms.exposures * 100 : null, trackedExposures: terms.trackedExposures, completionExposures: terms.completionExposures,
        books: terms.books.length, authors: new Set(books.map((book) => (book.author || '').trim().toLocaleLowerCase()).filter(Boolean)).size,
        trackedHours, outsideHours: input.hours, totalHours: trackedHours + input.hours, readingCheck: input.reading, listeningCheck: input.listening, updated: input.updated,
        readingEstimate: proficiencyEstimate(input.reading, evidence), listeningEstimate: proficiencyEstimate(input.listening, evidence),
        history: { seen: compactHistory(seen), observations: compactHistory(observations) } };
    });
    return { accountId: who.id, threshold: exposure.threshold, languages, updated: now() };
  }
  function save(body, visitor) {
    const { who, native } = context(visitor), language = typeof body.language === 'string' ? baseLanguage(body.language, '') : '';
    if (body.accountId !== who.id) throw new RequestError(409, 'The active account changed. Reload this page.');
    if (!language || language === native) throw new RequestError(422, 'Choose one of your target languages. L1 is excluded from proficiency estimates.');
    if (typeof body.hours !== 'number' || !Number.isFinite(body.hours) || body.hours < 0 || body.hours > 100000 || ![body.reading, body.listening].every((value) => Number.isInteger(value) && value >= 0 && value <= 4)) throw new RequestError(422, 'Enter 0–100,000 input hours and valid comprehension checks.');
    db.prepare('INSERT INTO inputs VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,language) DO UPDATE SET hours=excluded.hours,reading=excluded.reading,listening=excluded.listening,updated=excluded.updated,expires=excluded.expires')
      .run(who.id, language, body.hours, body.reading, body.listening, now(), who.expires ?? null);
    return summary(visitor);
  }
  return { summary, save, close: () => db.close() };
}
