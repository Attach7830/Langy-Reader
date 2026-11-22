import { createHash } from 'node:crypto';
import { RequestError } from './books.js';
import { baseLanguage, hanPattern } from '../shared/language.js';

const identity = (language, unit, term) => JSON.stringify([language, unit, term]);
const ownerOf = (visitor) => visitor?.id || '';
export const defaultKnownThreshold = 20;

export function readerVocabulary(db) {
  const backfill = !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vocabulary_occurrences'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS reading_exposures (
    owner TEXT NOT NULL, book TEXT NOT NULL, chapter TEXT NOT NULL, page TEXT NOT NULL,
    digest TEXT NOT NULL, ranges TEXT NOT NULL, firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, expires INTEGER,
    PRIMARY KEY(owner,book,chapter,page)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS vocabulary_seen (
    owner TEXT NOT NULL, book TEXT NOT NULL, language TEXT NOT NULL, unit TEXT NOT NULL, term TEXT NOT NULL,
    firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, expires INTEGER,
    PRIMARY KEY(owner,book,language,unit,term)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS vocabulary_occurrences (
    owner TEXT NOT NULL, book TEXT NOT NULL, chapter TEXT NOT NULL, digest TEXT NOT NULL, session TEXT NOT NULL,
    language TEXT NOT NULL, unit TEXT NOT NULL, term TEXT NOT NULL, fromOffset INTEGER NOT NULL, toOffset INTEGER NOT NULL,
    firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, expires INTEGER,
    PRIMARY KEY(owner,book,chapter,digest,session,language,unit,term,fromOffset,toOffset)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS vocabulary_preferences (
    owner TEXT PRIMARY KEY, threshold INTEGER NOT NULL CHECK(threshold BETWEEN 1 AND 10000), expires INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS occurrence_owner_term ON vocabulary_occurrences(owner,language,unit,term);
  CREATE INDEX IF NOT EXISTS occurrence_expiry ON vocabulary_occurrences(expires);
  CREATE INDEX IF NOT EXISTS vocabulary_owner ON vocabulary_seen(owner,language,unit,term);
  CREATE INDEX IF NOT EXISTS vocabulary_expiry ON vocabulary_seen(expires);
  CREATE INDEX IF NOT EXISTS exposure_expiry ON reading_exposures(expires);`);
  if (!db.prepare('PRAGMA table_info(reading_exposures)').all().some(({ name }) => name === 'session')) {
    db.exec("ALTER TABLE reading_exposures ADD COLUMN session TEXT NOT NULL DEFAULT 'legacy'");
  }
  const inventories = new Map();
  function inventory(book) {
    const row = db.prepare('SELECT state,metrics,lemmas FROM analyses WHERE book=?').get(book.id);
    if (row?.state !== 'ready' || !row.metrics) return null;
    const cached = inventories.get(book.id);
    if (cached?.metrics === row.metrics && cached?.lemmas === row.lemmas) return cached.groups;
    const metrics = JSON.parse(row.metrics), groups = new Map();
    for (const item of metrics.byLanguage) groups.set(item.language, { language: item.language, unit: item.unit, terms: new Set() });
    for (const term of metrics.characters?.inventory || '') groups.get('zh')?.terms.add(term);
    for (const item of JSON.parse(row.lemmas || '[]')) {
      const separator = item.indexOf(':');
      const language = separator < 0 ? baseLanguage(book.language) : item.slice(0, separator);
      groups.get(language)?.terms.add(separator < 0 ? item : item.slice(separator + 1));
    }
    inventories.set(book.id, { metrics: row.metrics, lemmas: row.lemmas, groups });
    if (inventories.size > 100) inventories.delete(inventories.keys().next().value);
    return groups;
  }
  function prune() {
    db.prepare('DELETE FROM vocabulary_seen WHERE expires<=?').run(Date.now());
    db.prepare('DELETE FROM reading_exposures WHERE expires<=?').run(Date.now());
    db.prepare('DELETE FROM vocabulary_occurrences WHERE expires<=?').run(Date.now());
    db.prepare('DELETE FROM vocabulary_preferences WHERE expires<=?').run(Date.now());
  }
  function preferences(visitor) {
    return { threshold: db.prepare('SELECT threshold FROM vocabulary_preferences WHERE owner=? AND (expires IS NULL OR expires>?)')
      .get(ownerOf(visitor), Date.now())?.threshold ?? defaultKnownThreshold };
  }
  function savePreferences(body, visitor) {
    if (!Number.isInteger(body.threshold) || body.threshold < 1 || body.threshold > 10000) throw new RequestError(422, 'Choose an exposure threshold from 1 to 10,000.');
    db.prepare('INSERT INTO vocabulary_preferences VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET threshold=excluded.threshold,expires=excluded.expires')
      .run(ownerOf(visitor), body.threshold, visitor?.expires ?? null);
    return preferences(visitor);
  }
  function exposureRows(visitor, filter = '1', values = [], tail = '') {
    return db.prepare(`WITH occurrences AS (
      SELECT book,language,unit,term,count(*) AS exposures FROM vocabulary_occurrences WHERE owner=? GROUP BY book,language,unit,term
    ) SELECT v.language,v.unit,v.term,min(v.firstSeen) AS firstSeen,max(v.lastSeen) AS lastSeen,sum(coalesce(o.exposures,1)) AS exposures
      FROM vocabulary_seen v LEFT JOIN occurrences o USING(book,language,unit,term)
      WHERE v.owner=? AND ${filter} GROUP BY v.language,v.unit,v.term ${tail}`)
      .all(ownerOf(visitor), ownerOf(visitor), ...values);
  }
  function profile(visitor) {
    prune();
    const threshold = preferences(visitor).threshold;
    const seen = new Set(), known = new Set(), byLanguage = new Map(), knownByLanguage = new Map();
    for (const row of exposureRows(visitor)) {
      seen.add(identity(row.language, row.unit, row.term));
      const key = identity(row.language, row.unit, '');
      if (!byLanguage.has(key)) byLanguage.set(key, { language: row.language, unit: row.unit, count: 0 });
      if (!knownByLanguage.has(key)) knownByLanguage.set(key, { language: row.language, unit: row.unit, count: 0 });
      byLanguage.get(key).count++;
      if (row.exposures >= threshold) { known.add(identity(row.language, row.unit, row.term)); knownByLanguage.get(key).count++; }
    }
    return { seen, known, threshold, byLanguage: [...byLanguage.values()].sort((a, b) => a.language.localeCompare(b.language)),
      knownByLanguage: [...knownByLanguage.values()].sort((a, b) => a.language.localeCompare(b.language)) };
  }
  function familiarity(book, reader) {
    const groups = inventory(book);
    if (!groups) return null;
    const byLanguage = [...groups.values()].map(({ language, unit, terms }) => {
      const seen = [...terms].filter((term) => reader.seen.has(identity(language, unit, term))).length;
      const likelyKnown = [...terms].filter((term) => reader.known?.has(identity(language, unit, term))).length;
      return { language, unit, total: terms.size, seen, likelyKnown, unfamiliar: terms.size - seen,
        knownCoverage: terms.size ? Math.round(likelyKnown / terms.size * 1000) / 10 : null,
        coverage: terms.size ? Math.round(seen / terms.size * 1000) / 10 : null };
    });
    const available = byLanguage.filter((item) => item.coverage != null);
    return { byLanguage, score: available.length ? available.reduce((sum, item) => sum + item.coverage, 0) / available.length : 0,
      knownScore: available.length ? available.reduce((sum, item) => sum + item.knownCoverage, 0) / available.length : 0 };
  }
  function termsFor(token, groups) {
    const language = baseLanguage(token.language), group = groups.get(language);
    if (!group || token.properName) return [];
    let terms = [token.lemma];
    if (language === 'zh') terms = [...token.word.matchAll(new RegExp(hanPattern, 'gu'))].map((match) => match[0]);
    else if (language === 'es' && ['al', 'del'].includes(token.word.toLowerCase())) terms = [token.word.toLowerCase() === 'al' ? 'a' : 'de', 'el'];
    else if (language === 'pt' && token.pos === 'ADP' && token.lemma.includes(' ')) terms = token.lemma.split(' ');
    return terms.filter((term) => group.terms.has(term)).map((term) => ({ language, unit: group.unit, term }));
  }
  function apply(exposure, section, groups) {
    if (!section || section.digest !== exposure.digest) return;
    const ranges = JSON.parse(exposure.ranges), terms = new Map();
    const occurrence = db.prepare(`INSERT INTO vocabulary_occurrences VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner,book,chapter,digest,session,language,unit,term,fromOffset,toOffset)
      DO UPDATE SET firstSeen=min(firstSeen,excluded.firstSeen),lastSeen=max(lastSeen,excluded.lastSeen),expires=excluded.expires`);
    for (const token of JSON.parse(section.tokens || '[]')) {
      if (!ranges.some((range) => token.from >= range.from && token.to <= range.to)) continue;
      for (const item of termsFor(token, groups)) {
        terms.set(identity(item.language, item.unit, item.term), item);
        occurrence.run(exposure.owner, exposure.book, exposure.chapter, exposure.digest, exposure.session || 'legacy', item.language, item.unit, item.term,
          token.from, token.to, exposure.firstSeen, exposure.lastSeen, exposure.expires);
      }
    }
    const save = db.prepare(`INSERT INTO vocabulary_seen VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner,book,language,unit,term)
      DO UPDATE SET firstSeen=min(firstSeen,excluded.firstSeen),lastSeen=max(lastSeen,excluded.lastSeen),expires=excluded.expires`);
    for (const item of terms.values()) save.run(exposure.owner, exposure.book, item.language, item.unit, item.term, exposure.firstSeen, exposure.lastSeen, exposure.expires);
  }
  function record(book, body, visitor) {
    if (typeof body.key !== 'string' || body.key.length > 250 || typeof body.digest !== 'string' || body.digest.length > 100) throw new RequestError(422, 'Choose a valid book section and text digest.');
    const session = body.session === undefined ? 'legacy' : body.session;
    if (typeof session !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(session)) throw new RequestError(422, 'Choose a valid reading session.');
    const groups = inventory(book);
    if (!groups) throw new RequestError(409, 'Wait for this book to finish analysis.');
    const section = db.prepare('SELECT text,digest,tokens FROM chapters WHERE book=? AND key=?').get(book.id, body.key);
    if (!section || section.digest !== body.digest) throw new RequestError(409, 'The book text changed. Reload this page.');
    if (!Array.isArray(body.ranges) || !body.ranges.length || body.ranges.length > 1000 || body.ranges.some((range) =>
      !Number.isInteger(range?.from) || !Number.isInteger(range?.to) || range.from < 0 || range.to <= range.from || range.to > section.text.length)
      || body.ranges.reduce((sum, range) => sum + range.to - range.from, 0) > 50000) throw new RequestError(422, 'Choose valid displayed text ranges.');
    const ranges = JSON.stringify(body.ranges), time = Date.now();
    const page = createHash('sha256').update(body.digest + ranges + (session === 'legacy' ? '' : '\n' + session)).digest('hex');
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO reading_exposures(owner,book,chapter,page,digest,ranges,firstSeen,lastSeen,expires,session) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner,book,chapter,page) DO UPDATE SET lastSeen=excluded.lastSeen`)
        .run(ownerOf(visitor), book.id, body.key, page, body.digest, ranges, time, time, visitor?.expires ?? null, session);
      apply(db.prepare('SELECT * FROM reading_exposures WHERE owner=? AND book=? AND chapter=? AND page=?').get(ownerOf(visitor), book.id, body.key, page), section, groups);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { saved: true };
  }
  function section(book, key) {
    const row = db.prepare('SELECT text,digest FROM chapters WHERE book=? AND key=?').get(book.id, key);
    if (!row) throw new RequestError(409, 'Wait for this book to finish analysis.');
    return { key, text: row.text, textHash: row.digest, analysisState: db.prepare('SELECT state FROM analyses WHERE book=?').get(book.id)?.state };
  }
  function reindex(book) {
    inventories.delete(book.id);
    const groups = inventory(book);
    if (!groups) return;
    const sections = new Map(db.prepare('SELECT key,digest,tokens FROM chapters WHERE book=?').all(book.id).map((section) => [section.key, section]));
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM vocabulary_seen WHERE book=?').run(book.id);
      db.prepare('DELETE FROM vocabulary_occurrences WHERE book=?').run(book.id);
      for (const exposure of db.prepare('SELECT * FROM reading_exposures WHERE book=? AND (expires IS NULL OR expires>?)').all(book.id, Date.now())) apply(exposure, sections.get(exposure.chapter), groups);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function catalogue(visitor, query = {}) {
    prune();
    const language = typeof query.language === 'string' ? query.language.slice(0, 35) : '';
    const search = typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '';
    const offset = Math.max(0, Math.min(1_000_000, Number.parseInt(query.offset, 10) || 0));
    const filter = "owner=? AND (?='' OR language=?) AND (?='' OR instr(lower(term),lower(?))>0)";
    const values = [ownerOf(visitor), language, language, search, search];
    const total = db.prepare(`SELECT count(*) AS count FROM (SELECT 1 FROM vocabulary_seen WHERE ${filter} GROUP BY language,unit,term)`).get(...values).count;
    const reader = profile(visitor);
    const entries = exposureRows(visitor, "(?='' OR v.language=?) AND (?='' OR instr(lower(v.term),lower(?))>0)",
      [language, language, search, search, offset], 'ORDER BY lastSeen DESC,v.language,v.unit,v.term LIMIT 100 OFFSET ?')
      .map((item) => ({ ...item, likelyKnown: item.exposures >= reader.threshold }));
    return { byLanguage: reader.byLanguage, likelyKnown: reader.knownByLanguage, threshold: reader.threshold, entries, total, offset, more: offset + entries.length < total };
  }
  function recommendations(book, books, reader) {
    const reference = inventory(book);
    if (!reference) return [];
    return books.filter((other) => other.id !== book.id).map((other) => {
      const candidate = inventory(other);
      if (!candidate) return null;
      const byLanguage = [...new Set([...reference.keys(), ...candidate.keys()])].map((language) => {
        const left = reference.get(language), right = candidate.get(language);
        const shared = left && right && left.unit === right.unit ? [...left.terms].filter((term) => right.terms.has(term)).length : 0;
        const union = (left?.terms.size || 0) + (right?.terms.size || 0) - shared;
        return { language, unit: left?.unit || right.unit, shared, similarity: union ? shared / union : 0 };
      });
      const shared = byLanguage.filter((item) => item.shared);
      if (!shared.length) return null;
      return { id: other.id, title: other.title, byLanguage: shared, familiarity: familiarity(other, reader),
        score: byLanguage.reduce((sum, item) => sum + item.similarity, 0) / byLanguage.length };
    }).filter(Boolean).sort((a, b) => b.score - a.score || b.familiarity.score - a.familiarity.score || a.title.localeCompare(b.title)).slice(0, 8);
  }
  if (backfill) for (const row of db.prepare('SELECT DISTINCT book AS id FROM reading_exposures').all()) reindex(row);
  return { profile, familiarity, section, record, reindex, catalogue, recommendations, preferences, savePreferences };
}
