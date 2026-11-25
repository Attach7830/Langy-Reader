import { createHash, timingSafeEqual } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { RequestError } from './books.js';

const digest = (value) => createHash('sha256').update(value).digest();
const documentID = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/iu.test(value) ? value.toLowerCase() : null;
const shortText = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\p{Cc}]/u.test(value);

// Same sample offsets as KOReader and CrossPoint, including the first sample at
// byte zero (not 256). Renaming an unchanged EPUB does not change this ID.
export async function koReaderDocumentID(path) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const md5 = createHash('md5');
    for (const offset of [0, ...Array.from({ length: 11 }, (_, i) => 1024 * 4 ** i)]) {
      if (offset >= size) continue;
      const buffer = Buffer.alloc(Math.min(1024, size - offset));
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await file.read(buffer, read, buffer.length - read, offset + read);
        if (!bytesRead) throw new Error('The book changed while its sync ID was being read.');
        read += bytesRead;
      }
      md5.update(buffer);
    }
    return md5.digest('hex');
  } finally { await file.close(); }
}

function cleanProgress(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'Invalid progress.');
  const document = documentID(body.document);
  const percentage = body.percentage;
  if (!document || typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0 || percentage > 1
    || !shortText(body.progress, 4096) || !shortText(body.device, 120)
    || (body.device_id != null && !shortText(body.device_id, 160))) throw new RequestError(400, 'Invalid progress fields.');
  let position = null;
  if (body.position && typeof body.position === 'object' && !Array.isArray(body.position)) {
    const { spine, page, pages, pctQ, xpath, para } = body.position;
    if ([spine, page, pages, pctQ].every(Number.isSafeInteger) && spine >= 0 && spine < 65536 && page >= 0
      && pages > 0 && pages <= 1000000 && page < pages && pctQ >= 0 && pctQ <= 1000000) {
      position = { spine, page, pages, pctQ };
      if (shortText(xpath, 4096)) position.xpath = xpath;
      if (Number.isSafeInteger(para) && para > 0 && para < 65536) position.para = para;
    }
  }
  return { document, progress: body.progress, percentage, device: body.device, device_id: body.device_id || '', position };
}

export function openProgressSync(dir, { library, demo = false, username = 'reader', password = '', authenticate }) {
  // Demo visitors never share progress or create sync accounts.
  if (demo) return { settings: () => ({ available: false, deviceAvailable: false }), router: unavailableRouter() };
  const db = new DatabaseSync(join(dir, 'progress.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS progress_meta(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO progress_meta VALUES(1,0);
    CREATE TABLE IF NOT EXISTS progress (
      document TEXT PRIMARY KEY, progress TEXT NOT NULL, percentage REAL NOT NULL,
      device TEXT NOT NULL, device_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
      revision INTEGER NOT NULL, langyTarget TEXT, position TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS book_documents(book TEXT PRIMARY KEY, document TEXT NOT NULL, signature TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS document_books ON book_documents(document);
    CREATE TABLE IF NOT EXISTS member_progress(owner TEXT NOT NULL,document TEXT NOT NULL,progress TEXT NOT NULL,percentage REAL NOT NULL,
      device TEXT NOT NULL,device_id TEXT NOT NULL,timestamp INTEGER NOT NULL,revision INTEGER NOT NULL,langyTarget TEXT,position TEXT,
      PRIMARY KEY(owner,document)) STRICT;
    CREATE TABLE IF NOT EXISTS member_progress_meta(owner TEXT PRIMARY KEY,revision INTEGER NOT NULL) STRICT;`);
  const expected = password ? digest(`${username}:${createHash('md5').update(password).digest('hex')}`) : null;
  const ownerOf = (visitor) => visitor?.id || '';
  const row = (document, visitor) => ownerOf(visitor) ? db.prepare('SELECT * FROM member_progress WHERE owner=? AND document=?').get(ownerOf(visitor), document)
    : db.prepare('SELECT * FROM progress WHERE document=?').get(document);
  const publicRow = (value) => value ? {
    document: value.document, progress: value.progress, percentage: value.percentage, device: value.device,
    device_id: value.device_id, timestamp: value.timestamp, version: value.revision,
    ...(value.langyTarget ? { langyTarget: JSON.parse(value.langyTarget) } : {}),
    ...(value.position ? { position: JSON.parse(value.position) } : {}),
  } : null;

  async function bookDocument(book) {
    const path = library.filePath(book);
    const info = await stat(path, { bigint: true });
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    const previous = db.prepare('SELECT * FROM book_documents WHERE book=?').get(book.id);
    if (previous?.signature === signature) return previous.document;
    const document = await koReaderDocumentID(path);
    // Deletion during hashing must not create a dangling book alias.
    library.getBook(book.id);
    db.prepare('INSERT INTO book_documents VALUES(?,?,?) ON CONFLICT(book) DO UPDATE SET document=excluded.document,signature=excluded.signature')
      .run(book.id, document, signature);
    return document;
  }

  function save(value, { baseVersion, target = null, visitor } = {}) {
    const input = cleanProgress(value);
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = row(input.document, visitor);
      if (baseVersion != null && baseVersion !== (current?.revision || 0)) {
        db.exec('ROLLBACK');
        return { conflict: true, document: input.document, version: current?.revision || 0, progress: publicRow(current) };
      }
      const owner = ownerOf(visitor);
      const { revision } = owner ? db.prepare('INSERT INTO member_progress_meta VALUES(?,1) ON CONFLICT(owner) DO UPDATE SET revision=revision+1 RETURNING revision').get(owner)
        : db.prepare('UPDATE progress_meta SET revision=revision+1 WHERE id=1 RETURNING revision').get();
      const timestamp = Math.floor(Date.now() / 1000);
      db.prepare(`INSERT INTO ${owner ? 'member_progress' : 'progress'} VALUES(${owner ? '?,' : ''}?,?,?,?,?,?,?,?,?) ON CONFLICT(${owner ? 'owner,' : ''}document) DO UPDATE SET
        progress=excluded.progress,percentage=excluded.percentage,device=excluded.device,device_id=excluded.device_id,
        timestamp=excluded.timestamp,revision=excluded.revision,langyTarget=excluded.langyTarget,position=excluded.position`)
        .run(...(owner ? [owner] : []), input.document, input.progress, input.percentage, input.device, input.device_id, timestamp, revision,
          target == null ? null : JSON.stringify(target), input.position ? JSON.stringify(input.position) : null);
      db.exec('COMMIT');
      return { document: input.document, version: revision, progress: publicRow(row(input.document, visitor)) };
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }

  async function get(book, visitor) {
    const document = await bookDocument(book);
    const progress = publicRow(row(document, visitor));
    return { available: true, document, version: progress?.version || 0, progress };
  }

  async function put(book, body, visitor) {
    if (!Number.isSafeInteger(body?.baseVersion) || body.baseVersion < 0) throw new RequestError(400, 'A progress version is required.');
    if ((book.format === 'epub' && !(typeof body.target === 'string' && body.target.startsWith('epubcfi(') && body.target.length <= 8192))
      || (book.format === 'pdf' && !(Number.isSafeInteger(body.target) && body.target > 0))) throw new RequestError(400, 'Invalid reading location.');
    const document = await bookDocument(book);
    return save({ ...body, document }, { baseVersion: body.baseVersion, target: body.target, visitor });
  }

  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/healthcheck', (_req, res) => res.json({ state: 'OK' }));
  router.post('/users/create', (_req, res) => res.status(403).json({ code: 2005, message: 'Registration is disabled. Authenticate with the configured Langy sync account.' }));
  router.use(async (req, res, next) => {
    if (!expected && !authenticate) return res.status(503).json({ code: 2005, message: 'Enable a Langy or sync password before connecting a device.' });
    const user = req.get('x-auth-user') || '', key = req.get('x-auth-key') || '';
    if (!/^[a-f0-9]{32}$/iu.test(key)) return res.status(401).json({ code: 2001, message: 'Unauthorized' });
    if (authenticate) {
      req.visitor = await authenticate(user, key.toLowerCase(), req);
      if (!req.visitor) return res.status(401).json({ code: 2001, message: 'Unauthorized' });
    } else if (!timingSafeEqual(expected, digest(`${user}:${key.toLowerCase()}`))) return res.status(401).json({ code: 2001, message: 'Unauthorized' });
    next();
  });
  router.use(express.json({ limit: '16kb', strict: true, type: ['application/json', 'application/*+json'] }));
  router.get('/users/auth', (_req, res) => res.json({ authorized: 'OK' }));
  router.get('/syncs/progress/:document', (req, res) => {
    const document = documentID(req.params.document);
    if (!document) throw new RequestError(400, 'Invalid document ID.');
    res.json(publicRow(row(document, req.visitor)) || {});
  });
  router.put('/syncs/progress', (req, res) => {
    const result = save(req.body, { visitor: req.visitor });
    res.json({ document: result.document, timestamp: result.progress.timestamp });
  });
  router.use((_req, res) => res.status(404).json({ code: 2003, message: 'Sync endpoint not found.' }));
  router.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: 2003,
    message: error instanceof RequestError ? error.message : 'The sync request could not be processed.' }));

  return {
    router, get, put, bookDocument,
    settings: (visitor) => ({ available: true, deviceAvailable: Boolean(expected || authenticate), path: '/kosync', username: visitor?.id ? visitor.username : username, protocol: 'KOReader Sync' }),
    forgetBook: (id) => db.prepare('DELETE FROM book_documents WHERE book=?').run(id),
    snapshot(visitor) {
      const result = {}, owner = ownerOf(visitor);
      const rows = owner ? db.prepare('SELECT book,p.* FROM book_documents JOIN member_progress p USING(document) WHERE p.owner=?').all(owner)
        : db.prepare('SELECT book,progress.* FROM book_documents JOIN progress USING(document)').all();
      for (const value of rows) {
        try { library.getBook(value.book, visitor); result[value.book] = publicRow(value); } catch { /* Deleted books are not listed. */ }
      }
      return result;
    },
  };
}

function unavailableRouter() {
  const router = express.Router();
  router.use((_req, res) => res.status(404).json({ error: 'Progress sync is available on self-hosted installations.' }));
  return router;
}
