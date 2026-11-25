import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { RequestError } from './books.js';

// Exact surrounding text is part of the key: polyphonic readings depend on it.
export function openBookPinyin(dir, mandarin, { demo = false } = {}) {
  const path = join(dir, 'book-pinyin.sqlite'), db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS passages(book TEXT NOT NULL,revision TEXT NOT NULL,hash TEXT NOT NULL,json TEXT NOT NULL,used INTEGER NOT NULL,expires INTEGER,
      PRIMARY KEY(book,revision,hash)) STRICT;`);
  if (!db.prepare('PRAGMA table_info(passages)').all().some((item) => item.name === 'expires')) db.exec('ALTER TABLE passages ADD COLUMN expires INTEGER');
  const prune = () => db.prepare('DELETE FROM passages WHERE expires IS NOT NULL AND expires<=?').run(Date.now());
  prune(); const timer = setInterval(prune, 15 * 60000); timer.unref();
  db.prepare('DELETE FROM passages WHERE revision<>?').run(mandarin.revision);
  return {
    annotation(book, body, expires = null) {
      if (typeof body?.text !== 'string' || body.text.length > 30000) throw new RequestError(422, 'Pinyin supports passages of up to 30,000 characters.');
      prune(); const hash = createHash('sha256').update(body.text).digest('hex');
      const row = db.prepare('SELECT json FROM passages WHERE book=? AND revision=? AND hash=?').get(book.id, mandarin.revision, hash);
      if (row) return JSON.parse(row.json);
      const result = { ...mandarin.annotation(body), revision: mandarin.revision };
      db.prepare('INSERT OR REPLACE INTO passages VALUES(?,?,?,?,?,?)').run(book.id, mandarin.revision, hash, JSON.stringify(result), Date.now(), expires);
      db.prepare('DELETE FROM passages WHERE book=? AND rowid NOT IN (SELECT rowid FROM passages WHERE book=? ORDER BY used DESC LIMIT ?)').run(book.id, book.id, demo ? 32 : 512);
      return result;
    },
    forget(id) { db.prepare('DELETE FROM passages WHERE book=?').run(id); },
    close() { clearInterval(timer); db.close(); },
  };
}
