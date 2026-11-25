import { randomUUID } from 'node:crypto';
import { RequestError } from './books.js';
import { readingSamples } from './book-text.js';

// This lane runs independently of narration/alignment, with one LLM request at a time.
export function readingEstimates({ db, ai, timeoutMs = 100000, withAI = (_visitor, task) => task(), visitorForBook = () => undefined }) {
  for (const [name, type] of [['jobId', 'TEXT'], ['queuedAt', 'INTEGER NOT NULL DEFAULT 0'], ['startedAt', 'INTEGER']]) {
    if (!db.prepare('PRAGMA table_info(estimates)').all().some((column) => column.name === name)) db.exec(`ALTER TABLE estimates ADD COLUMN ${name} ${type}`);
  }
  db.prepare("UPDATE estimates SET state='queued',startedAt=NULL,jobId=NULL,json=NULL,error=NULL WHERE state='running'").run();
  for (const row of db.prepare("SELECT book FROM estimates WHERE state='queued' AND jobId IS NULL").all()) {
    db.prepare('UPDATE estimates SET jobId=?,queuedAt=?,json=NULL,error=NULL WHERE book=?').run(randomUUID(), Date.now(), row.book);
  }
  let active;
  function invalidate(book) {
    if (active?.book === book) active.controller.abort(new Error('Reading estimate replaced.'));
    db.prepare('DELETE FROM estimates WHERE book=?').run(book);
  }
  function queue(book) {
    const id = typeof book === 'string' ? book : book.id;
    if (db.prepare('SELECT state FROM analyses WHERE book=?').get(id)?.state !== 'ready') throw new RequestError(409, 'Wait for vocabulary analysis to finish before estimating reading demand.');
    invalidate(id);
    db.prepare("INSERT INTO estimates(book,state,jobId,queuedAt) VALUES(?,'queued',?,?)").run(id, randomUUID(), Date.now());
  }
  function status(book) {
    const row = db.prepare('SELECT * FROM estimates WHERE book=?').get(typeof book === 'string' ? book : book.id);
    return row ? { ...JSON.parse(row.json || '{}'), state: row.state, error: row.error, queuedAt: row.queuedAt, startedAt: row.startedAt,
      timeoutMs, ...(row.startedAt ? { deadline: row.startedAt + timeoutMs } : {}) } : null;
  }
  async function pump() {
    if (active) return;
    const row = db.prepare(`SELECT e.*,a.metrics FROM estimates e JOIN analyses a ON a.book=e.book
      WHERE e.state='queued' AND a.state='ready' ORDER BY e.queuedAt,e.rowid LIMIT 1`).get();
    if (!row) return;
    const controller = new AbortController();
    const job = { book: row.book, controller }; active = job;
    db.prepare("UPDATE estimates SET state='running',startedAt=?,error=NULL WHERE book=? AND jobId=?").run(Date.now(), row.book, row.jobId);
    const valid = () => db.prepare(`SELECT 1 FROM estimates e JOIN analyses a ON a.book=e.book
      WHERE e.book=? AND e.jobId=? AND e.state='running' AND a.state='ready' AND a.metrics IS ?`).get(row.book, row.jobId, row.metrics);
    let timer, onAbort;
    try {
      const sample = readingSamples(db.prepare('SELECT text FROM chapters WHERE book=? ORDER BY ordinal').all(row.book));
      const metrics = JSON.parse(row.metrics || 'null');
      if (metrics) sample.vocabulary = { unit: metrics.unit, count: metrics.count, languages: metrics.languages, byLanguage: metrics.byLanguage,
        ...(metrics.unit === 'characters' ? { characterProfile: { ...metrics.characters, inventory: [...metrics.characters.inventory].slice(0, 3000).join('') } } : {}) };
      let result;
      if (sample.passages.join('').length < 80) result = { band: null, text: 'More text is needed to estimate reading demand.' };
      else {
        const cancelled = new Promise((_, reject) => {
          onAbort = () => reject(controller.signal.reason || new Error('Reading estimate cancelled.'));
          controller.signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => controller.abort(new RequestError(504, 'Reading estimate timed out. Retry the estimate or check the model’s inference queue.')), timeoutMs);
        });
        result = await Promise.race([Promise.resolve().then(() => withAI(visitorForBook(row.book), () => ai.readingLevel(sample, controller.signal))), cancelled]);
      }
      if (valid()) db.prepare("UPDATE estimates SET state='ready',json=?,error=NULL WHERE book=? AND jobId=?").run(JSON.stringify(result), row.book, row.jobId);
    } catch (error) {
      if (valid()) db.prepare("UPDATE estimates SET state='error',error=? WHERE book=? AND jobId=?")
        .run(error instanceof RequestError ? error.message : 'Reading estimate unavailable. Check the AI connection and retry the estimate.', row.book, row.jobId);
    } finally {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (active === job) active = null;
    }
  }
  return { queue, status, invalidate, pump, cancel(book) {
    db.prepare("UPDATE estimates SET state='cancelled',error=NULL WHERE book=? AND state IN ('queued','running')").run(book);
    if (active?.book === book) active.controller.abort(new DOMException('Cancelled', 'AbortError'));
  } };
}
