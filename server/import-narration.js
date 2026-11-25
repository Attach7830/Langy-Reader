import { RequestError } from './books.js';

export function importNarrationOptions(body = {}) {
  const enabled = body.autoAudiobook;
  if (enabled == null || enabled === false || enabled === 'false' || enabled === '') return null;
  if (enabled !== true && enabled !== 'true' && enabled !== 'on') throw new RequestError(422, 'Choose whether to generate an audiobook for this import.');
  const delay = body.audiobookDelayMinutes ?? 10, minutes = Number(delay);
  if (!['number', 'string'].includes(typeof delay) || !Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new RequestError(422, 'Choose an audiobook delay between 1 and 10,080 minutes.');
  return { autoAudiobook: true, audiobookDelayMinutes: minutes };
}

export function importNarration({ db, library, configuration, queue, demo = false, now = Date.now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS import_narration (
    book TEXT PRIMARY KEY REFERENCES analyses(book) ON DELETE CASCADE,
    due INTEGER NOT NULL, minutes INTEGER NOT NULL, state TEXT NOT NULL, recording TEXT, error TEXT
  ) STRICT;`);
  function status(book) {
    const row = db.prepare('SELECT due,minutes,state,recording,error FROM import_narration WHERE book=?').get(book.id);
    if (!row) return null;
    return { ...row, notice: row.state === 'waiting' ? !configuration().baseUrl
      ? 'Automatic audiobook scheduled. Connect Kokoro in Settings → Narration to generate it.'
      : now() < row.due ? `Automatic audiobook scheduled ${row.minutes} minutes after import.`
        : 'Automatic audiobook waiting for text analysis and an available generation slot.' : row.error || '' };
  }
  return {
    status,
    schedule(book, body) {
      const options = importNarrationOptions(body);
      if (!options) return null;
      if (demo) throw new RequestError(403, 'Scheduled audiobook generation is available on self-hosted installations.');
      const due = (Number.isFinite(book.addedAt) ? book.addedAt : now()) + options.audiobookDelayMinutes * 60000;
      db.prepare("INSERT INTO import_narration(book,due,minutes,state) VALUES(?,?,?,'waiting') ON CONFLICT(book) DO NOTHING")
        .run(book.id, due, options.audiobookDelayMinutes);
      return status(book);
    },
    cancel(book) { return db.prepare("UPDATE import_narration SET state='cancelled' WHERE book=? AND state='waiting'").run(book.id).changes; },
    pump() {
      if (demo || !configuration().baseUrl) return;
      let slots = Math.max(0, 3 - db.prepare("SELECT count(*) AS count FROM book_audio WHERE state IN ('queued','assembling')").get().count);
      const due = db.prepare("SELECT p.book,a.owner FROM import_narration p JOIN analyses a ON a.book=p.book WHERE p.state='waiting' AND p.due<=? AND a.state='ready' ORDER BY p.due,p.book").all(now());
      for (const row of due) {
        if (db.prepare('SELECT id FROM book_audio WHERE book=? LIMIT 1').get(row.book) || db.prepare('SELECT id FROM recordings WHERE book=? LIMIT 1').get(row.book)) {
          db.prepare("UPDATE import_narration SET state='skipped' WHERE book=?").run(row.book); continue;
        }
        if (!slots) break;
        try {
          const book = library.getBook(row.book, { id: row.owner });
          const recording = queue(book);
          db.prepare("UPDATE import_narration SET state='queued',recording=? WHERE book=?").run(recording.id, row.book); slots--;
        } catch (error) {
          db.prepare("UPDATE import_narration SET state='error',error=? WHERE book=?")
            .run(error instanceof RequestError ? error.message : 'Automatic narration failed. Retry from the book’s audio tools.', row.book);
        }
      }
    },
  };
}
