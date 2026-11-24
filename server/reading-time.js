import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { RequestError } from './books.js';
import { baseLanguage, bookLanguages } from '../shared/language.js';

export function openReadingTime(dir, { section, now = Date.now }) {
  const db = new DatabaseSync(join(dir, 'reading-time.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS events(owner TEXT NOT NULL,id TEXT NOT NULL,expires INTEGER,PRIMARY KEY(owner,id)) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS spans(owner TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,expires INTEGER,PRIMARY KEY(owner,start)) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS totals(owner TEXT NOT NULL,language TEXT NOT NULL,milliseconds INTEGER NOT NULL,expires INTEGER,PRIMARY KEY(owner,language)) STRICT, WITHOUT ROWID;`);
  function prune() { for (const table of ['events', 'spans', 'totals']) db.prepare(`DELETE FROM ${table} WHERE expires IS NOT NULL AND expires<=?`).run(now()); }
  function summary(account) {
    prune();
    const byLanguage = db.prepare('SELECT language,milliseconds FROM totals WHERE owner=? ORDER BY milliseconds DESC,language').all(account.id);
    return { accountId: account.id, totalMs: byLanguage.reduce((sum, row) => sum + row.milliseconds, 0), byLanguage, idleSeconds: 120 };
  }
  function weights(book, pages) {
    const allowed = bookLanguages(book), primary = baseLanguage(book.language), result = new Map();
    if (allowed.length < 2 || !pages?.length) return new Map([[primary, 1]]);
    for (const page of pages) {
      const source = section(book, page.key);
      if (source.textHash !== page.digest) throw new RequestError(409, 'The book text changed. Refresh the reading page.');
      const spans = Array.isArray(source.languages) ? source.languages : [];
      const ranges = page.ranges.slice().sort((a, b) => a.from - b.from), merged = [];
      for (const range of ranges) {
        if (range.to > source.text.length) throw new RequestError(422, 'Choose valid visible text ranges.');
        const last = merged.at(-1);
        if (last && range.from <= last.to) last.to = Math.max(last.to, range.to); else merged.push({ ...range });
      }
      for (const range of merged) for (const span of spans.length ? spans : [{ from: 0, to: source.text.length, language: primary }]) {
        const from = Math.max(range.from, span.from), to = Math.min(range.to, span.to), language = baseLanguage(span.language);
        if (to <= from || !allowed.includes(language)) continue;
        const amount = [...source.text.slice(from, to).matchAll(/[\p{L}\p{N}]/gu)].length;
        result.set(language, (result.get(language) || 0) + amount);
      }
    }
    return [...result.values()].some(Boolean) ? result : new Map([[primary, 1]]);
  }
  function validate(events) {
    if (!Array.isArray(events) || !events.length || events.length > 32) throw new RequestError(422, 'Send a bounded reading-time update.');
    for (const event of events) {
      if (!event || typeof event.id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/u.test(event.id)
        || !Number.isSafeInteger(event.start) || !Number.isSafeInteger(event.end) || event.start < now() - 90 * 86400000
        || event.end > now() + 60000 || event.end <= event.start || event.end - event.start > 30000) throw new RequestError(422, 'Choose a valid active reading interval of at most 30 seconds.');
      if (event.pages !== undefined && (!Array.isArray(event.pages) || event.pages.length > 16 || event.pages.some((page) => typeof page?.key !== 'string' || page.key.length > 250
        || typeof page.digest !== 'string' || page.digest.length > 100 || !Array.isArray(page.ranges) || !page.ranges.length || page.ranges.length > 1000
        || page.ranges.some((range) => !Number.isInteger(range?.from) || !Number.isInteger(range?.to) || range.from < 0 || range.to <= range.from))
        || event.pages.reduce((sum, page) => sum + page.ranges.length, 0) > 2000)) throw new RequestError(422, 'Choose valid visible text for reading time.');
    }
  }
  function record(book, body, account) {
    if (body.accountId !== account.id) throw Object.assign(new RequestError(409, 'The reading account changed. Reload your reading time.'), { accountChanged: true });
    validate(body.events); prune(); let recordedMs = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of body.events) {
        if (db.prepare('SELECT 1 FROM events WHERE owner=? AND id=?').get(account.id, event.id)) continue;
        const covered = db.prepare('SELECT start,end FROM spans WHERE owner=? AND start<=? AND end>=? ORDER BY start').all(account.id, event.end, event.start);
        let cursor = event.start, amount = 0;
        for (const span of covered) { amount += Math.max(0, Math.min(span.start, event.end) - cursor); cursor = Math.max(cursor, span.end); }
        amount += Math.max(0, event.end - cursor);
        if (amount) {
          const shares = [...weights(book, event.pages)].filter(([, value]) => value > 0).sort(([a], [b]) => a.localeCompare(b));
          const total = shares.reduce((sum, [, value]) => sum + value, 0); let allocated = 0;
          for (const [index, [language, weight]] of shares.entries()) {
            const milliseconds = index === shares.length - 1 ? amount - allocated : Math.floor(amount * weight / total); allocated += milliseconds;
            db.prepare(`INSERT INTO totals VALUES(?,?,?,?) ON CONFLICT(owner,language) DO UPDATE SET milliseconds=totals.milliseconds+excluded.milliseconds,expires=excluded.expires`)
              .run(account.id, language, milliseconds, account.expires ?? null);
          }
          for (const span of covered) db.prepare('DELETE FROM spans WHERE owner=? AND start=?').run(account.id, span.start);
          db.prepare('INSERT INTO spans VALUES(?,?,?,?)').run(account.id, Math.min(event.start, covered[0]?.start ?? event.start), Math.max(event.end, covered.at(-1)?.end ?? event.end), account.expires ?? null);
          recordedMs += amount;
        }
        db.prepare('INSERT INTO events VALUES(?,?,?)').run(account.id, event.id, account.expires ?? null);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { saved: true, recordedMs, readingTime: summary(account) };
  }
  return { summary, record, close: () => db.close() };
}
