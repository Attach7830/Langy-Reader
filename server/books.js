import { mkdir, open, rename, rm, stat, statfs, writeFile, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, extname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import yauzl from 'yauzl';
import { sampleBook } from './sample.js';
import { demoSamples } from './demo-samples.js';
import { downloadCover } from './cover-images.js';
import { baseLanguage } from '../shared/language.js';
import { archivePath, bookText, epubMetadataValues, filenameTitle, inferBookLanguage, parseEpubContainer, parseEpubPackage } from '../shared/book-metadata.js';
import { validCoverStyle } from '../shared/book-covers.js';
import { bookmarkTargetKey, isPdfTextBookmark } from '../shared/bookmark-targets.js';

export const maxUpload = 120 * 1024 * 1024;

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const covers = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const list = (value) => value == null ? [] : [value].flat();
const asText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function seriesDetails(body, previous = {}) {
  const value = body.series === undefined ? previous.series || '' : body.series;
  if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f]/u.test(value)) throw new RequestError(422, 'Enter a series name of up to 200 characters.');
  const series = value.trim().replace(/\s+/gu, ' ');
  if (!series) return { series: '', seriesIndex: null };
  const raw = body.seriesIndex === undefined ? previous.seriesIndex : body.seriesIndex;
  if (raw == null || typeof raw === 'string' && !raw.trim()) return { series, seriesIndex: null };
  const seriesIndex = Number(raw);
  if (!['string', 'number'].includes(typeof raw) || !Number.isFinite(seriesIndex) || seriesIndex < 0 || seriesIndex > 1000000) throw new RequestError(422, 'Enter a series book number from 0 to 1,000,000, or leave it blank.');
  return { series, seriesIndex };
}

export function normalizeLanguage(value) {
  try {
    const locales = Intl.getCanonicalLocales(asText(value, 35).replaceAll('_', '-'));
    return locales[0] || '';
  } catch {
    return '';
  }
}

export function normalizeBookLanguages(value, previous = []) {
  if (value === undefined) return previous;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new RequestError(422, 'Choose the languages contained in this book.'); }
  }
  if (!Array.isArray(value) || value.length > 20 || value.some((code) => typeof code !== 'string' || code.length > 35 || !normalizeLanguage(code))) {
    throw new RequestError(422, 'Choose up to 20 valid book languages.');
  }
  return [...new Map(value.map((code) => [baseLanguage(code), normalizeLanguage(code)])).values()];
}
const primaryLanguage = (language, languages) => languages.length && !languages.some((code) => baseLanguage(code) === baseLanguage(language)) ? languages[0] : language;

async function epubMetadata(path) {
  const zip = await yauzl.openPromise(path, { autoClose: false });
  try {
    const entries = new Map();
    let expanded = 0;
    if (zip.entryCount > 12_000) throw new Error('Too many entries');
    for await (const entry of zip.eachEntry()) {
      expanded += entry.uncompressedSize;
      if (expanded > 384 * 1024 * 1024 || entry.uncompressedSize > 80 * 1024 * 1024) {
        throw new Error('Archive exceeds expansion limit');
      }
      entries.set(entry.fileName, entry);
    }
    async function read(name, limit) {
      const entry = entries.get(name);
      if (!entry || entry.uncompressedSize > limit) return null;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return Buffer.concat(chunks);
    }

    const container = await read('META-INF/container.xml', 128 * 1024);
    const opfPath = archivePath('', parseEpubContainer(container?.toString('utf8') || ''));
    const opf = opfPath && await read(opfPath, 2 * 1024 * 1024);
    const book = opf && parseEpubPackage(opf.toString('utf8'));
    if (!book?.spine?.itemref || !book.manifest?.item) throw new Error('Missing package or spine');
    const metadata = book.metadata ?? {};
    const manifest = list(book.manifest.item);
    const details = epubMetadataValues(metadata);
    if (!details.language) {
      const spine = list(book.spine.itemref).filter((item) => item['@_linear'] !== 'no');
      const indices = [...new Set([0, 1, Math.floor(spine.length / 3), Math.floor(spine.length * 2 / 3), spine.length - 1])].filter((n) => n >= 0 && n < spine.length);
      const passages = [];
      for (const index of indices) {
        const item = manifest.find((entry) => entry['@_id'] === spine[index]['@_idref']);
        if (!item?.['@_href']) continue;
        const source = await read(archivePath(opfPath, item['@_href']), 2 * 1024 * 1024);
        if (source) { try { passages.push(bookText(source.toString('utf8'))); } catch { /* Keep usable metadata when a sampled section is damaged. */ } }
      }
      details.language = inferBookLanguage(passages.join(' ').slice(0, 30000));
    }
    const coverId = list(metadata.meta).find((item) => item?.['@_name'] === 'cover')?.['@_content'];
    const cover = manifest.find((item) => item['@_properties']?.split(/\s+/u).includes('cover-image'))
      ?? manifest.find((item) => coverId && item['@_id'] === coverId);
    const thumbnailType = cover?.['@_media-type'];
    let thumbnail = null;
    if (covers.has(thumbnailType) && cover?.['@_href']) {
      try {
        const coverPath = archivePath(opfPath, cover['@_href']);
        thumbnail = await read(coverPath, 3 * 1024 * 1024);
      } catch {
        // The reader can still use a generated title cover if this asset is damaged.
      }
    }
    return {
      ...details,
      thumbnail,
      thumbnailType,
    };
  } finally {
    zip.close();
  }
}

async function readMetadata(file, format) {
  try {
    if (format === 'epub') return await epubMetadata(file);
    const handle = await open(file, 'r');
    try {
      const prefix = Buffer.alloc(1024);
      const { bytesRead } = await handle.read(prefix);
      if (!/%PDF-\d\.\d/u.test(prefix.toString('latin1', 0, bytesRead))) throw new Error('Missing PDF header');
      return {};
    } finally {
      await handle.close();
    }
  } catch {
    throw new RequestError(422, `This file could not be opened as a supported ${format.toUpperCase()}.`);
  }
}

export async function openLibrary(dir, limits = null, { coverDownload = downloadCover, reserveStorage = async () => () => {} } = {}) {
  const folder = join(dir, 'books');
  const uploads = join(dir, 'uploads');
  await mkdir(folder, { recursive: true });
  await mkdir(uploads, { recursive: true });
  const shared = '';
  const db = new DatabaseSync(join(dir, 'library.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE,
      owner TEXT NOT NULL, expires INTEGER, UNIQUE(owner, name)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL,
      language TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('epub', 'pdf')),
      categoryId TEXT REFERENCES categories(id) ON DELETE SET NULL,
      thumbnailType TEXT, addedAt INTEGER NOT NULL,
      owner TEXT NOT NULL, expires INTEGER, bytes INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS book_read_status (
      book TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      owner TEXT NOT NULL, readAt INTEGER NOT NULL, expires INTEGER,
      PRIMARY KEY(book,owner)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS read_status_owner ON book_read_status(owner);
    CREATE TABLE IF NOT EXISTS currently_reading (
      book TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      owner TEXT NOT NULL, starredAt INTEGER NOT NULL, expires INTEGER,
      PRIMARY KEY(book,owner)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS currently_reading_owner ON currently_reading(owner);
    CREATE TABLE IF NOT EXISTS books_set_aside (
      book TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,owner TEXT NOT NULL,setAsideAt INTEGER NOT NULL,expires INTEGER,
      PRIMARY KEY(book,owner)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bookmarks(
      id TEXT PRIMARY KEY,book TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,owner TEXT NOT NULL,
      target TEXT NOT NULL,label TEXT NOT NULL,note TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER,
      UNIQUE(book,owner,target)
    ) STRICT;
  `);
  db.prepare('INSERT OR IGNORE INTO library_meta VALUES (?, ?)').run('instanceId', randomUUID());
  const instanceId = db.prepare('SELECT value FROM library_meta WHERE key = ?').get('instanceId').value;
  if (!db.prepare('PRAGMA table_info(books)').all().some(({ name }) => name === 'updatedAt')) {
    db.exec('ALTER TABLE books ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0; UPDATE books SET updatedAt = addedAt;');
  }

  if (!db.prepare('PRAGMA table_info(books)').all().some(({ name }) => name === 'languages')) {
    db.exec("ALTER TABLE books ADD COLUMN languages TEXT NOT NULL DEFAULT '[]'");
  }
  if (!db.prepare('PRAGMA table_info(books)').all().some(({ name }) => name === 'coverStyle')) db.exec("ALTER TABLE books ADD COLUMN coverStyle TEXT NOT NULL DEFAULT 'auto'");
  if (!db.prepare('PRAGMA table_info(books)').all().some(({ name }) => name === 'coverRevision')) db.exec("ALTER TABLE books ADD COLUMN coverRevision TEXT NOT NULL DEFAULT ''");
  if (!db.prepare('PRAGMA table_info(books)').all().some(({ name }) => name === 'contentRevision')) db.exec("ALTER TABLE books ADD COLUMN contentRevision TEXT NOT NULL DEFAULT ''");
  if (!db.prepare('PRAGMA table_info(books)').all().some(({ name }) => name === 'ocrComplete')) db.exec('ALTER TABLE books ADD COLUMN ocrComplete INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(books)').all().some(({ name }) => name === 'series')) db.exec("ALTER TABLE books ADD COLUMN series TEXT NOT NULL DEFAULT ''");
  if (!db.prepare('PRAGMA table_info(books)').all().some(({ name }) => name === 'seriesIndex')) db.exec('ALTER TABLE books ADD COLUMN seriesIndex REAL');
  if (!db.prepare('PRAGMA table_info(categories)').all().some(({ name }) => name === 'language')) {
    db.exec('ALTER TABLE categories ADD COLUMN language TEXT');
  }
  if (!db.prepare('PRAGMA table_info(categories)').all().some(({ name }) => name === 'l1Folder')) {
    db.exec('ALTER TABLE categories ADD COLUMN l1Folder INTEGER NOT NULL DEFAULT 0 CHECK(l1Folder IN (0,1))');
  }
  if (db.prepare('PRAGMA user_version').get().user_version === 0) {
    const sample = await sampleBook();
    await writeFile(join(folder, 'sample.epub'), sample);
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO categories(id,name,owner,expires) VALUES (?, ?, ?, ?)').run('spanish', 'Spanish', shared, null);
      db.prepare('INSERT INTO books(id,title,author,language,format,categoryId,thumbnailType,addedAt,owner,expires,bytes,updatedAt,languages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'sample', 'El café de la esquina', '', 'es', 'epub', 'spanish', null, Date.now(), shared, null, sample.byteLength,
        Date.now(), '[]',
      );
      db.exec('PRAGMA user_version = 1; COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  let addedDemoSamples = false;
  if (limits) for (const sample of demoSamples) {
    if (db.prepare('SELECT id FROM books WHERE id=?').get(sample.id)) continue;
    const bytes = await sampleBook(sample); await writeFile(join(folder, sample.id + '.epub'), bytes);
    db.exec('BEGIN');
    try {
      db.prepare('INSERT OR IGNORE INTO categories(id,name,owner,expires,language) VALUES(?,?,?,NULL,?)').run(sample.categoryId, sample.categoryName, shared, sample.language);
      db.prepare('INSERT INTO books(id,title,author,language,format,categoryId,addedAt,owner,expires,bytes,updatedAt,languages,coverStyle) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,?)')
        .run(sample.id, sample.title, '', sample.language, 'epub', sample.categoryId, Date.now(), shared, bytes.byteLength, Date.now(), '[]', sample.coverStyle);
      db.exec('COMMIT'); addedDemoSamples = true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  db.prepare('INSERT OR IGNORE INTO library_meta VALUES (?, ?)').run('updatedAt', String(Date.now()));
  const touch = () => db.prepare("UPDATE library_meta SET value = ? WHERE key = 'updatedAt'").run(String(Date.now()));
  if (addedDemoSamples) touch();

  if (!db.prepare('PRAGMA table_info(books)').all().some(({ name }) => name === 'shared')) db.exec('ALTER TABLE books ADD COLUMN shared INTEGER NOT NULL DEFAULT 0');
  const demoBookIds = ['sample', ...demoSamples.map((sample) => sample.id)].map((id) => `'${id}'`).join(',');
  const demoCategoryIds = ['spanish', ...demoSamples.map((sample) => sample.categoryId)].map((id) => `'${id}'`).join(',');
  const scope = (visitor) => limits ? { sql: `(owner=? OR id IN (${demoBookIds}))`, args: [editable(visitor)] }
    : visitor ? { sql: '(owner=? OR shared=1)', args: [editable(visitor)] } : { sql: '1', args: [] };
  const categoryScope = limits ? `(owner = ? OR id IN (${demoCategoryIds}))` : 'owner = ?';
  const editable = (visitor) => visitor?.id ?? shared;
  const l1Folder = (book, visitor) => (!visitor || book.owner === editable(visitor))
    && Boolean(db.prepare('SELECT l1Folder FROM categories WHERE id=? AND owner=?').get(book.categoryId ?? '', book.owner)?.l1Folder);
  const hasOCR = (book) => book.format === 'pdf' && Boolean(book.ocrComplete || book.contentRevision);
  const publicBook = ({ owner, expires, bytes, ...book }, visitor) => ({ ...book, shared: Boolean(book.shared), ocrComplete: hasOCR(book),
    l1Folder: l1Folder({ ...book, owner }, visitor),
    canEdit: !visitor || owner === editable(visitor), sharedWithMe: Boolean(!limits && book.shared && visitor && owner !== editable(visitor)),
    categoryId: !limits && visitor && owner !== editable(visitor) ? null : book.categoryId,
    languages: typeof book.languages === 'string' ? JSON.parse(book.languages) : book.languages });
  function sharing(value, previous = false) {
    if (value === undefined) return Number(previous);
    if (![true, false, 'true', 'false'].includes(value)) throw new RequestError(422, 'Choose whether to share this book.');
    const share = value === true || value === 'true';
    if (limits && share) throw new RequestError(403, 'Book sharing is available on self-hosted installations.');
    return Number(share);
  }
  const publicCategory = ({ id, name, language = null, l1Folder = false }) => ({ id, name, language, l1Folder: Boolean(l1Folder) });
  const readAt = (id, visitor) => db.prepare('SELECT readAt FROM book_read_status WHERE book=? AND owner=? AND (expires IS NULL OR expires>?)')
    .get(id, editable(visitor), Date.now())?.readAt ?? null;
  const starredAt = (id, visitor) => db.prepare('SELECT starredAt FROM currently_reading WHERE book=? AND owner=? AND (expires IS NULL OR expires>?)')
    .get(id, editable(visitor), Date.now())?.starredAt ?? null;
  const setAsideAt = (id, visitor) => db.prepare('SELECT setAsideAt FROM books_set_aside WHERE book=? AND owner=? AND (expires IS NULL OR expires>?)')
    .get(id, editable(visitor), Date.now())?.setAsideAt ?? null;

  function getBook(id, visitor) {
    const visible = scope(visitor);
    const book = db.prepare(`SELECT * FROM books WHERE id=? AND ${visible.sql}`).get(id, ...visible.args);
    if (!book) throw new RequestError(404, 'Book not found.');
    return { ...book, ocrComplete: hasOCR(book), l1Folder: l1Folder(book, visitor), canEdit: !visitor || book.owner === editable(visitor), sharedWithMe: Boolean(!limits && book.shared && visitor && book.owner !== editable(visitor)), languages: JSON.parse(book.languages), readAt: readAt(id, visitor), starredAt: starredAt(id, visitor), setAsideAt: setAsideAt(id, visitor) };
  }

  function categoryId(value, visitor) {
    if (!value) return null;
    if (!db.prepare(`SELECT id FROM categories WHERE id = ? AND ${categoryScope}`).get(String(value), editable(visitor))) {
      throw new RequestError(422, 'Choose a category that exists.');
    }
    return String(value);
  }

  function categoryName(value, id, visitor) {
    const name = asText(value, 70);
    if (!name) throw new RequestError(422, 'Enter a category name.');
    if (db.prepare(`SELECT id FROM categories WHERE name = ? AND id <> ? AND ${categoryScope}`).get(name, id, editable(visitor))) {
      throw new RequestError(409, 'That category name is already in use.');
    }
    return name;
  }

  function folderAssignment(value, language, languages, visitor) {
    const id = categoryId(value, visitor);
    const folderLanguage = id ? db.prepare('SELECT language FROM categories WHERE id=?').get(id)?.language : null;
    if (!folderLanguage) return { categoryId: id, language, languages };
    const contained = [folderLanguage, ...languages.filter((code) => baseLanguage(code) !== baseLanguage(folderLanguage))];
    if (contained.length > 20) throw new RequestError(422, 'Remove a selected book language before adding this folder’s language.');
    return { categoryId: id, language: folderLanguage, languages: contained };
  }

  function filePath(book) { return join(folder, `${book.id}${book.contentRevision ? '.' + book.contentRevision : ''}.${book.format}`); }
  function coverPath(book) { return join(folder, `${book.id}${book.coverRevision ? '.' + book.coverRevision : ''}.cover`); }

  return {
    uploads, getBook, filePath, coverPath, instanceId,
    markOCRComplete(id) {
      if (db.prepare("UPDATE books SET ocrComplete=1 WHERE id=? AND format='pdf' AND ocrComplete=0").run(id).changes) touch();
    },
    ownedBooks: (owner) => db.prepare('SELECT * FROM books WHERE owner=?').all(owner),
    storageFiles(owner) { return db.prepare('SELECT * FROM books WHERE owner=?').all(owner).flatMap((book) => [filePath(book), filePath({ ...book, contentRevision: '' }), coverPath(book), coverPath({ ...book, coverRevision: '' })]); },
    bookmarks(id, visitor) {
      getBook(id, visitor);
      return db.prepare('SELECT id,target,label,note,created FROM bookmarks WHERE book=? AND owner=? AND (expires IS NULL OR expires>?) ORDER BY created DESC,id')
        .all(id, editable(visitor), Date.now())
        .map((row) => ({ ...row, target: JSON.parse(row.target) }));
    },
    saveBookmark(id, body, visitor) {
      const book = getBook(id, visitor), target = body.target;
      const valid = book.format === 'pdf' ? isPdfTextBookmark(target) || (Number.isSafeInteger(target) && target >= 1 && target <= 1_000_000)
        : typeof target === 'string' && target.length <= 8192 && /^epubcfi\([^<>\x00-\x1f]+\)$/u.test(target);
      if (!valid || typeof body.label !== 'string' || body.label.length > 200 || typeof (body.note ?? '') !== 'string' || (body.note || '').length > 2000) throw new RequestError(422, 'Choose a reading position, a label of up to 200 characters and an optional note of up to 2,000 characters.');
      const owner = editable(visitor), serialized = bookmarkTargetKey(target);
      const existing = db.prepare('SELECT id FROM bookmarks WHERE book=? AND owner=? AND target=?').get(id, owner, serialized);
      if (!existing && db.prepare('SELECT count(*) AS n FROM bookmarks WHERE book=? AND owner=?').get(id, owner).n >= 1000) throw new RequestError(422, 'This book already has 1,000 bookmarks. Remove one to add another.');
      db.prepare(`INSERT INTO bookmarks VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(book,owner,target) DO UPDATE SET
        label=excluded.label,note=CASE WHEN ? THEN bookmarks.note ELSE excluded.note END`)
        .run(randomUUID(), id, owner, serialized, body.label.trim() || 'Bookmark', (body.note || '').trim(), Date.now(), visitor?.expires ?? null, Number(body.note === undefined));
      return { bookmarks: this.bookmarks(id, visitor) };
    },
    removeBookmark(id, bookmark, visitor) {
      getBook(id, visitor);
      if (!db.prepare('DELETE FROM bookmarks WHERE id=? AND book=? AND owner=?').run(bookmark, id, editable(visitor)).changes) throw new RequestError(404, 'Bookmark not found.');
      return { bookmarks: this.bookmarks(id, visitor) };
    },
    removeBookmarkTarget(id, target, visitor) {
      getBook(id, visitor);
      db.prepare('DELETE FROM bookmarks WHERE book=? AND owner=? AND target=?').run(id, editable(visitor), bookmarkTargetKey(target ?? null));
      return { bookmarks: this.bookmarks(id, visitor) };
    },
    readBooks(visitor) {
      const owner = editable(visitor);
      return db.prepare(`SELECT b.id,b.language,r.readAt,r.expires FROM book_read_status r JOIN books b ON b.id=r.book
        WHERE r.owner=? AND (r.expires IS NULL OR r.expires>?) AND (b.expires IS NULL OR b.expires>?)
          AND ${limits ? `(b.owner=? OR b.id IN (${demoBookIds}))` : '(b.owner=? OR b.shared=1)'}`)
        .all(owner, Date.now(), Date.now(), owner);
    },
    async storage(visitor) {
      if (limits) {
        const { usedBytes } = db.prepare('SELECT coalesce(sum(bytes), 0) AS usedBytes FROM books WHERE owner = ? AND expires > ?')
          .get(editable(visitor), Date.now());
        const totalBytes = limits.books * limits.upload;
        return { available: true, scope: 'demo', totalBytes, usedBytes, availableBytes: Math.max(0, totalBytes - usedBytes) };
      }
      try {
        const stats = await statfs(dir, { bigint: true });
        const totalBytes = Number(stats.blocks * stats.bsize);
        if (totalBytes <= 0) return { available: false, scope: 'drive' };
        return {
          available: true, scope: 'drive', totalBytes,
          availableBytes: Number(stats.bavail * stats.bsize),
          usedBytes: Number((stats.blocks - stats.bfree) * stats.bsize),
          reservedBytes: Number((stats.bfree - stats.bavail) * stats.bsize),
        };
      } catch {
        return { available: false, scope: 'drive' };
      }
    },
    snapshot(visitor) {
      const owner = editable(visitor), visible = scope(visitor);
      const statuses = new Map(db.prepare('SELECT book,readAt FROM book_read_status WHERE owner=? AND (expires IS NULL OR expires>?)')
        .all(owner, Date.now()).map((row) => [row.book, row.readAt]));
      const stars = new Map(db.prepare('SELECT book,starredAt FROM currently_reading WHERE owner=? AND (expires IS NULL OR expires>?)')
        .all(owner, Date.now()).map((row) => [row.book, row.starredAt]));
      const aside = new Map(db.prepare('SELECT book,setAsideAt FROM books_set_aside WHERE owner=? AND (expires IS NULL OR expires>?)').all(owner, Date.now()).map((row) => [row.book, row.setAsideAt]));
      return {
        demo: Boolean(limits), sharingAvailable: !limits && Boolean(visitor?.authenticated), maxUpload: limits?.upload ?? maxUpload,
        updatedAt: Number(db.prepare("SELECT value FROM library_meta WHERE key = 'updatedAt'").get().value),
        categories: db.prepare(`SELECT id, name, language,l1Folder FROM categories WHERE ${categoryScope} ORDER BY name COLLATE NOCASE`).all(owner).map(publicCategory),
        books: db.prepare(`SELECT * FROM books WHERE ${visible.sql} ORDER BY addedAt DESC,id`).all(...visible.args)
          .map((book) => publicBook({ ...book, readAt: statuses.get(book.id) ?? null, starredAt: stars.get(book.id) ?? null, setAsideAt: aside.get(book.id) ?? null }, visitor)),
      };
    },
    saveCategory(id, body, isNew, visitor) {
      const owner = editable(visitor);
      const previous = isNew ? null : db.prepare('SELECT language,l1Folder FROM categories WHERE id=? AND owner=?').get(id, owner);
      if (!isNew && !previous) throw new RequestError(404, 'Category not found.');
      if (body.l1Folder !== undefined && typeof body.l1Folder !== 'boolean') throw new RequestError(422, 'Choose whether this is an L1 Folder.');
      const l1 = Number(body.l1Folder ?? Boolean(previous?.l1Folder));
      const name = categoryName(body.name, id, visitor);
      if (body.language != null && typeof body.language !== 'string') throw new RequestError(422, 'Choose a valid folder language.');
      const language = body.language === undefined ? previous?.language ?? null : normalizeLanguage(body.language) || null;
      if (typeof body.language === 'string' && body.language.trim() && !language) throw new RequestError(422, 'Choose a valid folder language.');
      if (isNew) {
        if (limits && db.prepare('SELECT count(*) AS count FROM categories WHERE owner = ?').get(owner).count >= 25) {
          throw new RequestError(422, 'A demo session can have up to 25 categories.');
        }
      }
      db.exec('BEGIN');
      try {
        if (isNew) db.prepare('INSERT INTO categories(id,name,owner,expires,language,l1Folder) VALUES(?,?,?,?,?,?)').run(id, name, owner, visitor?.expires ?? null, language,l1);
        else db.prepare('UPDATE categories SET name=?,language=?,l1Folder=? WHERE id=? AND owner=?').run(name, language,l1, id, owner);
        if (language) for (const book of db.prepare('SELECT id,language,languages FROM books WHERE categoryId=? AND owner=?').all(id, owner)) {
          const assignment = folderAssignment(id, book.language, JSON.parse(book.languages), visitor);
          const contained = JSON.stringify(assignment.languages);
          if (book.language !== assignment.language || book.languages !== contained) db.prepare('UPDATE books SET language=?,languages=?,updatedAt=? WHERE id=?')
            .run(assignment.language, contained, Date.now(), book.id);
        }
        if (previous && Boolean(previous.l1Folder) !== Boolean(l1)) db.prepare('UPDATE books SET updatedAt=? WHERE categoryId=? AND owner=?').run(Date.now(), id, owner);
        touch(); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return publicCategory({ id, name, language, l1Folder: l1 });
    },
    removeCategory(id, visitor) {
      if (!db.prepare('DELETE FROM categories WHERE id = ? AND owner = ?').run(id, editable(visitor)).changes) {
        throw new RequestError(404, 'Category not found.');
      }
      touch();
    },
    async importBook(id, file, body, visitor) {
      if (!file) throw new RequestError(422, 'Choose an EPUB or PDF file.');
      const format = extname(file.originalname).slice(1).toLowerCase();
      if (!['epub', 'pdf'].includes(format)) {
        await rm(file.path, { force: true });
        throw new RequestError(415, 'Choose an EPUB or PDF file.');
      }
      const book = { id, format };
      const owner = editable(visitor);
      let saved = false, release = () => {};
      try {
        const sharedBook = sharing(body.shared);
        const coverStyle = body.coverStyle ?? 'auto';
        if (!validCoverStyle(coverStyle)) throw new RequestError(422, 'Choose one of the available book covers.');
        const series = seriesDetails(body);
        const metadata = await readMetadata(file.path, format);
        if (body.coverUrl !== undefined && typeof body.coverUrl !== 'string') throw new RequestError(422, 'Paste a valid cover image URL.');
        if (body.coverUrl?.trim()) Object.assign(metadata, await coverDownload(body.coverUrl));
        const providedLanguage = asText(body.language, 35);
        const languages = normalizeBookLanguages(body.languages);
        const language = primaryLanguage(normalizeLanguage(providedLanguage) || metadata.language || 'es', languages);
        if (providedLanguage && !normalizeLanguage(providedLanguage)) {
          throw new RequestError(422, 'Enter a language code such as es, en or fr.');
        }
        const title = asText(body.title, 250) || asText(metadata.title, 250)
          || filenameTitle(basename(file.originalname)) || 'Untitled';
        const author = asText(body.author, 200) || asText(metadata.author, 200);
        release = await reserveStorage(owner, (await stat(file.path)).size + (metadata.thumbnail?.length || 0));
        if (metadata.thumbnail) await writeFile(coverPath(book), metadata.thumbnail, { flag: 'wx' });
        await rename(file.path, filePath(book));
        // Validate the category after asynchronous file operations, so a concurrent delete is safe.
        if (limits) {
          if (visitor.expires <= Date.now()) throw new RequestError(410, 'Your demo session expired. Reload and try again.');
          if (db.prepare('SELECT count(*) AS count FROM books WHERE owner = ?').get(owner).count >= limits.books) {
            throw new RequestError(422, `A demo session can store up to ${limits.books} books. Remove a book to import another.`);
          }
          const { used } = db.prepare('SELECT coalesce(sum(bytes), 0) AS used FROM books WHERE expires > ?').get(Date.now());
          if (used + file.size > limits.storage) throw new RequestError(507, 'Demo storage is full. Try later.');
        }
        const assignment = folderAssignment(body.categoryId, language, languages, visitor);
        db.prepare('INSERT INTO books(id,title,author,language,format,categoryId,thumbnailType,addedAt,owner,expires,bytes,updatedAt,languages,coverStyle,series,seriesIndex) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          id, title, author, assignment.language, format, assignment.categoryId,
          metadata.thumbnail ? metadata.thumbnailType : null, Date.now(), owner, visitor?.expires ?? null, file.size, Date.now(), JSON.stringify(assignment.languages), coverStyle, series.series, series.seriesIndex,
        );
        db.prepare('UPDATE books SET shared=? WHERE id=?').run(sharedBook, id);
        saved = true;
        touch();
        return publicBook(getBook(id, visitor), visitor);
      } finally {
        if (!saved) {
          await Promise.allSettled([file.path, filePath(book), coverPath(book)].map((path) => rm(path, { force: true })));
        }
        release();
      }
    },
    async replacePDF(id, file, options, visitor) {
      const original = getBook(id, visitor), revision = options.revision;
      if (limits) throw new RequestError(403, 'PDF OCR is available on self-hosted installations.');
      if (original.owner !== editable(visitor)) throw new RequestError(403, 'Only the book owner can update this PDF.');
      if (original.format !== 'pdf' || !/^[\w-]{1,120}$/u.test(revision || '')) throw new RequestError(422, 'Choose a valid PDF replacement.');
      if (original.contentRevision === revision) return publicBook(original, visitor);
      if (options.expectedRevision !== undefined && original.contentRevision !== options.expectedRevision) throw new RequestError(409, 'This PDF changed during OCR. Scan the current version again.');
      const replacement = { ...original, contentRevision: revision }, destination = filePath(replacement), staging = destination + '.pending';
      if (!file?.path || file.path === filePath(original) || file.path === destination) throw new RequestError(422, 'Choose a separate OCR output file.');
      let published = false, release = () => {};
      try {
        const { size } = await stat(file.path);
        if (!size || size > maxUpload) throw new RequestError(413, 'The searchable PDF must be between 1 byte and 120 MiB.');
        await readMetadata(file.path, 'pdf');
        release = await reserveStorage(original.owner, size);
        await copyFile(file.path, staging); await rename(staging, destination);
        const current = getBook(id, visitor);
        if (current.contentRevision !== original.contentRevision || current.owner !== original.owner) throw new RequestError(409, 'This PDF changed during OCR. Scan the current version again.');
        const languages = normalizeBookLanguages(options.languages, current.languages), language = normalizeLanguage(options.language || current.language);
        if (!language) throw new RequestError(422, 'Choose a valid book language.');
        const assignment = folderAssignment(current.categoryId, primaryLanguage(language, languages), languages, visitor);
        // Publish the completed file with one database transaction. A crash
        // before this point leaves the old PDF selected and readable.
        db.exec('BEGIN');
        try {
          db.prepare('UPDATE books SET contentRevision=?,bytes=?,updatedAt=?,language=?,languages=?,ocrComplete=1 WHERE id=?')
            .run(revision, size, Date.now(), assignment.language, JSON.stringify(assignment.languages), id);
          touch(); db.exec('COMMIT'); published = true;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        // Keep the original upload as a private backup, retaining only the
        // latest OCR version alongside it after subsequent scans.
        if (original.contentRevision) await rm(filePath(original), { force: true }).catch(() => {});
        return publicBook(getBook(id, visitor), visitor);
      } finally {
        await Promise.allSettled([staging, file.path, ...(!published ? [destination] : [])].map((path) => rm(path, { force: true })));
        release();
      }
    },
    async resolveBookDetails(id, body, visitor) {
      const book = getBook(id, visitor);
      if (book.owner !== editable(visitor)) throw new RequestError(403, 'Only the book owner can edit or remove this book.');
      const blank = (name) => !asText(body[name], name === 'title' ? 250 : 200);
      if (!['title', 'author', 'language'].some(blank)) return body;
      let metadata = {};
      try { metadata = await readMetadata(filePath(book), book.format); }
      catch { /* Retain saved details if the file has no readable metadata. */ }
      return { ...body,
        title: blank('title') ? metadata.title || book.title : body.title,
        author: blank('author') ? metadata.author || book.author : body.author,
        language: blank('language') ? metadata.language || book.language || 'es' : body.language,
      };
    },
    async importCover(id, url, visitor) {
      const original = getBook(id, visitor);
      if (original.owner !== editable(visitor)) throw new RequestError(403, 'Only the book owner can replace its cover.');
      const cover = await coverDownload(url), revision = randomUUID(), target = coverPath({ id, coverRevision: revision }); let saved = false, release = () => {};
      try {
        release = await reserveStorage(original.owner, cover.thumbnail.length);
        await writeFile(target, cover.thumbnail, { flag: 'wx', mode: 0o600 });
        const current = getBook(id, visitor);
        if (current.owner !== original.owner || current.coverRevision !== original.coverRevision) throw new RequestError(409, 'This cover changed during the download. Try again.');
        db.prepare('UPDATE books SET thumbnailType=?,coverRevision=?,coverStyle=\'auto\',updatedAt=? WHERE id=?')
          .run(cover.thumbnailType, revision, Math.max(Date.now(), current.updatedAt + 1), id);
        touch(); saved = true;
        if (current.coverRevision) await rm(coverPath(current), { force: true }).catch(() => {});
        return publicBook(getBook(id, visitor), visitor);
      } finally { if (!saved) await rm(target, { force: true }); release(); }
    },
    editBook(id, body, visitor) {
      const book = getBook(id, visitor);
      if (book.owner !== editable(visitor)) throw new RequestError(403, 'Only the book owner can edit or remove this book.');
      const sharedBook = sharing(body.shared, book.shared);
      const title = asText(body.title, 250);
      const coverStyle = body.coverStyle ?? book.coverStyle;
      if (!validCoverStyle(coverStyle)) throw new RequestError(422, 'Choose one of the available book covers.');
      const series = seriesDetails(body, book);
      const languages = normalizeBookLanguages(body.languages, book.languages);
      const requestedLanguage = normalizeLanguage(body.language);
      if (!title || !requestedLanguage) throw new RequestError(422, 'Enter a title and a valid language code.');
      const language = primaryLanguage(requestedLanguage, languages);
      const assignment = folderAssignment(body.categoryId, language, languages, visitor);
      db.prepare('UPDATE books SET title = ?, author = ?, language = ?, categoryId = ?, updatedAt = ?, languages = ?, coverStyle = ?, series = ?, seriesIndex = ? WHERE id = ?')
        .run(title, asText(body.author, 200), assignment.language, assignment.categoryId, Date.now(), JSON.stringify(assignment.languages), coverStyle, series.series, series.seriesIndex, id);
      db.prepare('UPDATE books SET shared=? WHERE id=?').run(sharedBook, id);
      touch();
      return publicBook(getBook(id, visitor), visitor);
    },
    setReadStatus(id, body, visitor) {
      getBook(id, visitor);
      if (typeof body.read !== 'boolean') throw new RequestError(422, 'Choose read or unread.');
      if (limits && (!visitor || visitor.expires <= Date.now())) throw new RequestError(410, 'Your demo session expired. Reload and try again.');
      if (body.read) {
        db.prepare(`INSERT INTO book_read_status VALUES(?,?,?,?) ON CONFLICT(book,owner) DO NOTHING`)
          .run(id, editable(visitor), Date.now(), visitor?.expires ?? null);
      } else db.prepare('DELETE FROM book_read_status WHERE book=? AND owner=?').run(id, editable(visitor));
      touch();
      return { id, readAt: readAt(id, visitor) };
    },
    setCurrentlyReading(id, body, visitor) {
      getBook(id, visitor);
      if (typeof body.currentlyReading !== 'boolean') throw new RequestError(422, 'Choose whether this book is currently being read.');
      if (limits && (!visitor || visitor.expires <= Date.now())) throw new RequestError(410, 'Your demo session expired. Reload and try again.');
      if (body.currentlyReading) {
        db.prepare('INSERT INTO currently_reading VALUES(?,?,?,?) ON CONFLICT(book,owner) DO NOTHING').run(id, editable(visitor), Date.now(), visitor?.expires ?? null);
        db.prepare('DELETE FROM books_set_aside WHERE book=? AND owner=?').run(id, editable(visitor));
      }
      else db.prepare('DELETE FROM currently_reading WHERE book=? AND owner=?').run(id, editable(visitor));
      touch();
      return { id, starredAt: starredAt(id, visitor), setAsideAt: setAsideAt(id, visitor) };
    },
    setAside(id, body, visitor) {
      getBook(id, visitor);
      if (typeof body.setAside !== 'boolean') throw new RequestError(422, 'Choose whether to set this book aside.');
      if (limits && (!visitor || visitor.expires <= Date.now())) throw new RequestError(410, 'Your demo session expired. Reload and try again.');
      if (body.setAside) {
        db.prepare('INSERT INTO books_set_aside VALUES(?,?,?,?) ON CONFLICT(book,owner) DO NOTHING').run(id, editable(visitor), Date.now(), visitor?.expires ?? null);
        db.prepare('DELETE FROM currently_reading WHERE book=? AND owner=?').run(id, editable(visitor));
      } else db.prepare('DELETE FROM books_set_aside WHERE book=? AND owner=?').run(id, editable(visitor));
      touch(); return { id, setAsideAt: setAsideAt(id, visitor), starredAt: starredAt(id, visitor) };
    },
    async removeBook(id, visitor) {
      const book = getBook(id, visitor);
      if (book.owner !== editable(visitor)) throw new RequestError(403, 'Only the book owner can edit or remove this book.');
      db.prepare('DELETE FROM books WHERE id = ?').run(id);
      touch();
      const cleanup = await Promise.allSettled([...new Set([filePath(book), filePath({ ...book, contentRevision: '' }), coverPath(book), coverPath({ ...book, coverRevision: '' })])].map((path) => rm(path, { force: true })));
      if (cleanup.some((result) => result.status === 'rejected')) console.error('Could not remove every file for book', id);
    },
    async pruneDemoBooks() {
      const now = Date.now();
      const expired = db.prepare('SELECT id, format FROM books WHERE expires <= ?').all(now);
      db.prepare('DELETE FROM books WHERE expires <= ?').run(now);
      db.prepare('DELETE FROM categories WHERE expires <= ?').run(now);
      db.prepare('DELETE FROM book_read_status WHERE expires <= ?').run(now);
      db.prepare('DELETE FROM currently_reading WHERE expires <= ?').run(now);
      db.prepare('DELETE FROM books_set_aside WHERE expires <= ?').run(now);
      db.prepare('DELETE FROM bookmarks WHERE expires <= ?').run(now);
      if (expired.length) touch();
      const paths = expired.flatMap((book) => [filePath(book), coverPath(book)]);
      const removed = await Promise.allSettled(paths.map((path) => rm(path, { force: true })));
      if (removed.some((item) => item.status === 'rejected')) console.error('Could not remove all expired demo files.');
    },
  };
}
