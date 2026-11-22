import { createHash } from 'node:crypto';
import { RequestError } from './books.js';
import { baseLanguage, hanPattern } from '../shared/language.js';

const identity = (language, unit, term) => JSON.stringify([language, unit, term]);
const ownerOf = (visitor) => visitor?.id || '';
export const defaultKnownThreshold = 20;

export function readerVocabulary(db, { completedBooks = null } = {}) {
  const backfill = !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vocabulary_occurrences'").get();
  const completionUpgrade = !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vocabulary_completions'").get();
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
  CREATE TABLE IF NOT EXISTS vocabulary_completions (
    owner TEXT NOT NULL, book TEXT NOT NULL, readAt INTEGER NOT NULL, signature TEXT NOT NULL, expires INTEGER,
    PRIMARY KEY(owner,book)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS vocabulary_completed_terms (
    owner TEXT NOT NULL, book TEXT NOT NULL, language TEXT NOT NULL, unit TEXT NOT NULL, term TEXT NOT NULL,
    occurrences INTEGER NOT NULL, readAt INTEGER NOT NULL, expires INTEGER,
    PRIMARY KEY(owner,book,language,unit,term)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS occurrence_owner_term ON vocabulary_occurrences(owner,language,unit,term);
  CREATE INDEX IF NOT EXISTS occurrence_expiry ON vocabulary_occurrences(expires);
  CREATE INDEX IF NOT EXISTS vocabulary_owner ON vocabulary_seen(owner,language,unit,term);
  CREATE INDEX IF NOT EXISTS vocabulary_expiry ON vocabulary_seen(expires);
  CREATE INDEX IF NOT EXISTS exposure_expiry ON reading_exposures(expires);
  CREATE INDEX IF NOT EXISTS completion_expiry ON vocabulary_completions(expires);
  CREATE INDEX IF NOT EXISTS completed_term_expiry ON vocabulary_completed_terms(expires);
  CREATE INDEX IF NOT EXISTS completion_book ON vocabulary_completions(book);`);
  if (!db.prepare('PRAGMA table_info(reading_exposures)').all().some(({ name }) => name === 'session')) {
    db.exec("ALTER TABLE reading_exposures ADD COLUMN session TEXT NOT NULL DEFAULT 'legacy'");
  }
  const inventories = new Map(), completionSources = new Map();
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
    db.prepare('DELETE FROM vocabulary_completions WHERE expires<=?').run(Date.now());
    db.prepare('DELETE FROM vocabulary_completed_terms WHERE expires<=?').run(Date.now());
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
  function exposureRows(visitor) {
    // A completion fills missing source positions; extra tracked rereading sessions still count.
    return db.prepare(`WITH occurrences AS (
      SELECT book,language,unit,term,count(*) AS exposures,
        count(DISTINCT json_array(chapter,digest,fromOffset,toOffset)) AS covered
        FROM vocabulary_occurrences WHERE owner=? GROUP BY book,language,unit,term
    ), tracked AS (
      SELECT v.book,v.language,v.unit,v.term,v.firstSeen,v.lastSeen,
        coalesce(o.exposures,1) AS exposures,coalesce(o.covered,1) AS covered
        FROM vocabulary_seen v LEFT JOIN occurrences o USING(book,language,unit,term) WHERE v.owner=?
    ), completed AS (
      SELECT c.language,c.unit,c.term,c.readAt,
        max(c.occurrences-coalesce(t.covered,0),0) AS exposures
        FROM vocabulary_completed_terms c LEFT JOIN tracked t USING(book,language,unit,term) WHERE c.owner=?
    ), combined AS (
      SELECT language,unit,term,firstSeen,lastSeen,exposures AS trackedExposures,0 AS completionExposures FROM tracked
      UNION ALL
      SELECT language,unit,term,readAt,readAt,0,exposures FROM completed WHERE exposures>0
    ) SELECT language,unit,term,min(firstSeen) AS firstSeen,max(lastSeen) AS lastSeen,
        sum(trackedExposures+completionExposures) AS exposures,
        sum(trackedExposures) AS trackedExposures,sum(completionExposures) AS completionExposures
      FROM combined GROUP BY language,unit,term`)
      .all(ownerOf(visitor), ownerOf(visitor), ownerOf(visitor));
  }
  function summarize(rows, threshold) {
    const seen = new Set(), known = new Set(), byLanguage = new Map(), knownByLanguage = new Map();
    for (const row of rows) {
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
  function profile(visitor) {
    prune(); syncCompletions(visitor);
    return summarize(exposureRows(visitor), preferences(visitor).threshold);
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
    if (language === 'zh') return [...token.word.matchAll(new RegExp(hanPattern, 'gu'))]
      .filter((match) => group.terms.has(match[0]))
      .map((match) => ({ language, unit: group.unit, term: match[0], from: token.from + match.index, to: token.from + match.index + match[0].length }));
    let terms = [token.lemma];
    if (language === 'es' && ['al', 'del'].includes(token.word.toLowerCase())) terms = [token.word.toLowerCase() === 'al' ? 'a' : 'de', 'el'];
    else if (language === 'pt' && token.pos === 'ADP' && token.lemma.includes(' ')) terms = token.lemma.split(' ');
    return [...new Set(terms)].filter((term) => group.terms.has(term)).map((term) => ({ language, unit: group.unit, term, from: token.from, to: token.to }));
  }
  function completionSignature(book) {
    const analysis = db.prepare('SELECT state,metrics,lemmas FROM analyses WHERE book=?').get(book.id);
    if (analysis?.state !== 'ready' || !analysis.metrics) return 'pending';
    const sections = db.prepare('SELECT key,digest FROM chapters WHERE book=? ORDER BY key').all(book.id);
    return createHash('sha256').update(JSON.stringify([book.language, analysis.metrics, analysis.lemmas, sections])).digest('hex');
  }
  function completionSource(book, signature) {
    if (signature === 'pending') return { signature, counts: [] };
    const cached = completionSources.get(book.id);
    if (cached?.signature === signature) return cached;
    const counts = new Map(), groups = inventory(book);
    for (const section of db.prepare('SELECT key,tokens FROM chapters WHERE book=?').all(book.id)) {
      const positions = new Set();
      for (const token of JSON.parse(section.tokens || '[]')) for (const item of termsFor(token, groups)) {
        const key = identity(item.language, item.unit, item.term), position = JSON.stringify([key, item.from, item.to]);
        if (positions.has(position)) continue;
        positions.add(position);
        if (!counts.has(key)) counts.set(key, { ...item, occurrences: 0, sample: { key: section.key, from: item.from, to: item.to, word: token.word, pos: token.pos || '' } });
        counts.get(key).occurrences++;
      }
    }
    const result = { signature, counts: [...counts.values()] };
    completionSources.set(book.id, result);
    if (completionSources.size > 100) completionSources.delete(completionSources.keys().next().value);
    return result;
  }
  function saveCompletion(book, completion, signature = completionSignature(book)) {
    const source = completionSource(book, signature);
    db.prepare('DELETE FROM vocabulary_completed_terms WHERE owner=? AND book=?').run(completion.owner, book.id);
    db.prepare(`INSERT INTO vocabulary_completions VALUES(?,?,?,?,?) ON CONFLICT(owner,book)
      DO UPDATE SET readAt=excluded.readAt,signature=excluded.signature,expires=excluded.expires`)
      .run(completion.owner, book.id, completion.readAt, source.signature, completion.expires);
    const insert = db.prepare('INSERT INTO vocabulary_completed_terms VALUES(?,?,?,?,?,?,?,?)');
    for (const item of source.counts) insert.run(completion.owner, book.id, item.language, item.unit, item.term, item.occurrences, completion.readAt, completion.expires);
  }
  function syncCompletions(visitor) {
    if (!completedBooks) return;
    const owner = ownerOf(visitor), time = Date.now();
    const current = new Map(completedBooks(visitor).filter((book) => book.expires == null || book.expires > time).map((book) => [book.id, book]));
    const saved = new Map(db.prepare('SELECT * FROM vocabulary_completions WHERE owner=?').all(owner).map((row) => [row.book, row]));
    db.exec('BEGIN');
    try {
      for (const book of saved.keys()) if (!current.has(book)) {
        db.prepare('DELETE FROM vocabulary_completed_terms WHERE owner=? AND book=?').run(owner, book);
        db.prepare('DELETE FROM vocabulary_completions WHERE owner=? AND book=?').run(owner, book);
      }
      for (const book of current.values()) {
        const previous = saved.get(book.id), signature = completionSignature(book), expires = book.expires ?? null;
        if (previous?.readAt !== book.readAt || previous?.signature !== signature || previous?.expires !== expires)
          saveCompletion(book, { owner, readAt: book.readAt, expires }, signature);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
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
          item.from, item.to, exposure.firstSeen, exposure.lastSeen, exposure.expires);
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
    completionSources.delete(book.id);
    const groups = inventory(book);
    if (!groups) return;
    const sections = new Map(db.prepare('SELECT key,digest,tokens FROM chapters WHERE book=?').all(book.id).map((section) => [section.key, section]));
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM vocabulary_seen WHERE book=?').run(book.id);
      db.prepare('DELETE FROM vocabulary_occurrences WHERE book=?').run(book.id);
      for (const exposure of db.prepare('SELECT * FROM reading_exposures WHERE book=? AND (expires IS NULL OR expires>?)').all(book.id, Date.now())) apply(exposure, sections.get(exposure.chapter), groups);
      for (const completion of db.prepare('SELECT * FROM vocabulary_completions WHERE book=? AND (expires IS NULL OR expires>?)').all(book.id, Date.now())) saveCompletion(book, completion);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function catalogue(visitor, query = {}) {
    prune(); syncCompletions(visitor);
    const language = typeof query.language === 'string' ? query.language.slice(0, 35) : '';
    const search = typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '';
    const offset = Math.max(0, Math.min(1_000_000, Number.parseInt(query.offset, 10) || 0));
    const rows = exposureRows(visitor), reader = summarize(rows, preferences(visitor).threshold);
    const matches = rows.filter((row) => (!language || row.language === language) && (!search || row.term.toLowerCase().includes(search.toLowerCase())))
      .sort((a, b) => b.lastSeen - a.lastSeen || a.language.localeCompare(b.language) || a.unit.localeCompare(b.unit) || a.term.localeCompare(b.term));
    const total = matches.length;
    const entries = matches.slice(offset, offset + 100).map((item) => ({ ...item, likelyKnown: item.exposures >= reader.threshold }));
    return { byLanguage: reader.byLanguage, likelyKnown: reader.knownByLanguage, threshold: reader.threshold, entries, total, offset, more: offset + entries.length < total };
  }
  function bookTerms(book) {
    const signature = completionSignature(book);
    if (signature === 'pending') throw new RequestError(409, 'Wait for this book to finish analysis.');
    return completionSource(book, signature);
  }
  function example(book, item) {
    const text = db.prepare('SELECT text FROM chapters WHERE book=? AND key=?').get(book.id, item.sample.key)?.text || '';
    let from = Math.max(0, item.sample.from - 180), to = Math.min(text.length, item.sample.to + 180);
    if (/[\uDC00-\uDFFF]/u.test(text[from] || '')) from--;
    if (/[\uD800-\uDBFF]/u.test(text[to - 1] || '')) to--;
    return { text: text.slice(from, to).replace(/\s+/gu, ' ').trim(), word: item.sample.word, pos: item.sample.pos, key: item.sample.key };
  }
  function term(book, body) {
    if (typeof body.term !== 'string' || body.term.length > 500 || typeof body.language !== 'string' || body.language.length > 35 || typeof body.unit !== 'string')
      throw new RequestError(422, 'Choose a word from this book’s vocabulary.');
    const source = bookTerms(book);
    const item = source.counts.find((item) => item.term === body.term && item.language === body.language && item.unit === body.unit);
    if (!item) throw new RequestError(404, 'This word is not in the analyzed book vocabulary.');
    return { term: item.term, language: item.language, unit: item.unit, example: example(book, item), revision: source.signature };
  }
  function belowThreshold(book, visitor, query = {}) {
    prune(); syncCompletions(visitor);
    const source = bookTerms(book), threshold = preferences(visitor).threshold;
    const recorded = new Map(exposureRows(visitor).map((row) => [identity(row.language, row.unit, row.term), row.exposures]));
    const rows = source.counts.map((item) => ({ ...item, exposures: recorded.get(identity(item.language, item.unit, item.term)) || 0 }));
    const byLanguage = [...inventory(book).values()].map(({ language, unit, terms }) => ({ language, unit, total: terms.size,
      count: rows.filter((row) => row.language === language && row.unit === unit && row.exposures < threshold).length }));
    const language = typeof query.language === 'string' ? query.language.slice(0, 35) : '';
    const search = typeof query.search === 'string' ? query.search.trim().toLowerCase().slice(0, 100) : '';
    const requestedOffset = Math.max(0, Math.min(1_000_000, Number.parseInt(query.offset, 10) || 0)), pageSize = 10;
    const matches = rows.filter((row) => row.exposures < threshold && (!language || row.language === language) && (!search || row.term.toLowerCase().includes(search)))
      .sort((a, b) => a.exposures - b.exposures || b.occurrences - a.occurrences || a.language.localeCompare(b.language) || a.term.localeCompare(b.term));
    const offset = Math.min(requestedOffset, Math.max(0, Math.floor((matches.length - 1) / pageSize) * pageSize));
    const entries = matches.slice(offset, offset + pageSize).map((item) => ({ language: item.language, unit: item.unit, term: item.term,
      exposures: item.exposures, remaining: threshold - item.exposures, occurrences: item.occurrences, example: example(book, item) }));
    return { threshold, byLanguage, entries, total: matches.length, offset, pageSize, more: offset + entries.length < matches.length, revision: source.signature };
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
  if (backfill || completionUpgrade) for (const row of db.prepare('SELECT DISTINCT book AS id FROM reading_exposures').all()) reindex(row);
  return { profile, familiarity, section, record, reindex, catalogue, recommendations, preferences, savePreferences, syncCompletions, belowThreshold, term };
}
