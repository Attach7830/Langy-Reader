import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mergePreferences, validatePreferences } from '../shared/reader-preferences.js';
import { RequestError } from './books.js';

export function openReaderSettings(dir, { demo = false, username = 'reader' } = {}) {
  const db = new DatabaseSync(join(dir, 'reader-settings.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS instance(id INTEGER PRIMARY KEY CHECK(id=1), uuid TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS preferences(owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL, expires INTEGER) STRICT;`);
  db.prepare('INSERT OR IGNORE INTO instance VALUES(1,?)').run(randomUUID());
  const instance = db.prepare('SELECT uuid FROM instance WHERE id=1').get().uuid;
  function owner(visitor) {
    if (demo && !visitor?.id) throw new RequestError(401, 'Open the demo to save reader settings.');
    return demo ? `demo:${visitor.id}` : `user:${username}`;
  }
  function get(visitor) {
    db.prepare('DELETE FROM preferences WHERE expires IS NOT NULL AND expires<?').run(Date.now());
    const key = owner(visitor), row = db.prepare('SELECT * FROM preferences WHERE owner=?').get(key);
    return { accountId: createHash('sha256').update(`${instance}:${key}`).digest('hex'), revision: row?.revision || 0,
      preferences: JSON.parse(row?.json || '{}') };
  }
  function patch(body, visitor) {
    if (!body || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new RequestError(422, 'Refresh reader settings and try again.');
    try { validatePreferences(body.changes); } catch (error) { throw new RequestError(422, error.message); }
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = get(visitor);
      if (body.revision !== current.revision) { db.exec('COMMIT'); return { ...current, conflict: true }; }
      const preferences = mergePreferences(current.preferences, body.changes);
      try { validatePreferences(preferences); } catch (error) { throw new RequestError(422, error.message); }
      const revision = current.revision + 1;
      db.prepare(`INSERT INTO preferences VALUES(?,?,?,?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,json=excluded.json,expires=excluded.expires`)
        .run(owner(visitor), revision, JSON.stringify(preferences), demo ? visitor.expires : null);
      db.exec('COMMIT'); return { accountId: current.accountId, revision, preferences };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { get, patch, close: () => db.close() };
}
