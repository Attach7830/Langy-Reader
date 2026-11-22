import { mkdir, open, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, posix, extname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { XMLParser } from 'fast-xml-parser';
import yauzl from 'yauzl';
import { sampleBook } from './sample.js';
import { baseLanguage } from '../shared/language.js';

export const maxUpload = 120 * 1024 * 1024;

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const xml = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  processEntities: false,
});

const covers = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const list = (value) => value == null ? [] : [value].flat();
const xmlText = (value) => typeof value === 'string' ? value : value?.['#text'];
const asText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

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
    const rootfiles = list(xml.parse(container?.toString('utf8') || '').container?.rootfiles?.rootfile);
    const rootfile = rootfiles.find((item) => item['@_media-type'] === 'application/oebps-package+xml') ?? rootfiles[0];
    const opfPath = rootfile?.['@_full-path'];
    const opf = opfPath && await read(opfPath, 2 * 1024 * 1024);
    const book = opf && xml.parse(opf.toString('utf8')).package;
    if (!book?.spine?.itemref || !book.manifest?.item) throw new Error('Missing package or spine');
    const metadata = book.metadata ?? {};
    const manifest = list(book.manifest.item);
    const coverId = list(metadata.meta).find((item) => item?.['@_name'] === 'cover')?.['@_content'];
    const cover = manifest.find((item) => item['@_properties']?.split(/\s+/u).includes('cover-image'))
      ?? manifest.find((item) => coverId && item['@_id'] === coverId);
    const thumbnailType = cover?.['@_media-type'];
    let thumbnail = null;
    if (covers.has(thumbnailType) && cover?.['@_href']) {
      try {
        const coverPath = posix.join(posix.dirname(opfPath), decodeURIComponent(cover['@_href']));
        thumbnail = await read(coverPath, 3 * 1024 * 1024);
      } catch {
        // The reader can still use a generated title cover if this asset is damaged.
      }
    }
    return {
      title: xmlText(list(metadata.title)[0]),
      author: list(metadata.creator).map(xmlText).filter(Boolean).join(', '),
      language: normalizeLanguage(xmlText(list(metadata.language)[0])),
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

export async function openLibrary(dir, limits = null) {
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
  `);
  db.prepare('INSERT OR IGNORE INTO library_meta VALUES (?, ?)').run('instanceId', randomUUID());
  const instanceId = db.prepare('SELECT value FROM library_meta WHERE key = ?').get('instanceId').value;
  if (!db.prepare('PRAGMA table_info(books)').all().some(({ name }) => name === 'updatedAt')) {
    db.exec('ALTER TABLE books ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0; UPDATE books SET updatedAt = addedAt;');
  }

  if (!db.prepare('PRAGMA table_info(books)').all().some(({ name }) => name === 'languages')) {
    db.exec("ALTER TABLE books ADD COLUMN languages TEXT NOT NULL DEFAULT '[]'");
  }
  if (!db.prepare('PRAGMA table_info(categories)').all().some(({ name }) => name === 'language')) {
    db.exec('ALTER TABLE categories ADD COLUMN language TEXT');
  }
  if (db.prepare('PRAGMA user_version').get().user_version === 0) {
    const sample = await sampleBook();
    await writeFile(join(folder, 'sample.epub'), sample);
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO categories(id,name,owner,expires) VALUES (?, ?, ?, ?)').run('spanish', 'Spanish', shared, null);
      db.prepare('INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'sample', 'El café de la esquina', '', 'es', 'epub', 'spanish', null, Date.now(), shared, null, sample.byteLength,
        Date.now(), '[]',
      );
      db.exec('PRAGMA user_version = 1; COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  db.prepare('INSERT OR IGNORE INTO library_meta VALUES (?, ?)').run('updatedAt', String(Date.now()));
  const touch = () => db.prepare("UPDATE library_meta SET value = ? WHERE key = 'updatedAt'").run(String(Date.now()));

  const bookScope = limits ? "(owner = ? OR id = 'sample')" : 'owner = ?';
  const categoryScope = limits ? "(owner = ? OR id = 'spanish')" : 'owner = ?';
  const editable = (visitor) => visitor?.id ?? shared;
  const publicBook = ({ owner, expires, bytes, ...book }) => ({ ...book, languages: typeof book.languages === 'string' ? JSON.parse(book.languages) : book.languages });
  const publicCategory = ({ id, name, language = null }) => ({ id, name, language });
  const readAt = (id, visitor) => db.prepare('SELECT readAt FROM book_read_status WHERE book=? AND owner=? AND (expires IS NULL OR expires>?)')
    .get(id, editable(visitor), Date.now())?.readAt ?? null;

  function getBook(id, visitor) {
    const book = db.prepare(`SELECT * FROM books WHERE id = ? AND ${bookScope}`).get(id, editable(visitor));
    if (!book) throw new RequestError(404, 'Book not found.');
    return { ...book, languages: JSON.parse(book.languages), readAt: readAt(id, visitor) };
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

  function filePath(book) { return join(folder, `${book.id}.${book.format}`); }
  function coverPath(book) { return join(folder, `${book.id}.cover`); }

  return {
    uploads, getBook, filePath, coverPath, instanceId,
    readBooks(visitor) {
      return db.prepare(`SELECT b.id,b.language,r.readAt,r.expires FROM book_read_status r JOIN books b ON b.id=r.book
        WHERE r.owner=? AND (r.expires IS NULL OR r.expires>?) AND (b.expires IS NULL OR b.expires>?)
          AND ${limits ? "(b.owner=? OR b.id='sample')" : 'b.owner=?'}`)
        .all(editable(visitor), Date.now(), Date.now(), editable(visitor));
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
      const owner = editable(visitor);
      const statuses = new Map(db.prepare('SELECT book,readAt FROM book_read_status WHERE owner=? AND (expires IS NULL OR expires>?)')
        .all(owner, Date.now()).map((row) => [row.book, row.readAt]));
      return {
        demo: Boolean(limits), maxUpload: limits?.upload ?? maxUpload,
        updatedAt: Number(db.prepare("SELECT value FROM library_meta WHERE key = 'updatedAt'").get().value),
        categories: db.prepare(`SELECT id, name, language FROM categories WHERE ${categoryScope} ORDER BY name COLLATE NOCASE`).all(owner),
        books: db.prepare(`SELECT * FROM books WHERE ${bookScope} ORDER BY addedAt DESC, id`).all(owner)
          .map((book) => publicBook({ ...book, readAt: statuses.get(book.id) ?? null })),
      };
    },
    saveCategory(id, body, isNew, visitor) {
      const owner = editable(visitor);
      const previous = isNew ? null : db.prepare('SELECT language FROM categories WHERE id=? AND owner=?').get(id, owner);
      if (!isNew && !previous) throw new RequestError(404, 'Category not found.');
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
        if (isNew) db.prepare('INSERT INTO categories(id,name,owner,expires,language) VALUES(?,?,?,?,?)').run(id, name, owner, visitor?.expires ?? null, language);
        else db.prepare('UPDATE categories SET name=?,language=? WHERE id=? AND owner=?').run(name, language, id, owner);
        if (language) for (const book of db.prepare('SELECT id,language,languages FROM books WHERE categoryId=? AND owner=?').all(id, owner)) {
          const assignment = folderAssignment(id, book.language, JSON.parse(book.languages), visitor);
          const contained = JSON.stringify(assignment.languages);
          if (book.language !== assignment.language || book.languages !== contained) db.prepare('UPDATE books SET language=?,languages=?,updatedAt=? WHERE id=?')
            .run(assignment.language, contained, Date.now(), book.id);
        }
        touch(); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return publicCategory({ id, name, language });
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
      let saved = false;
      try {
        const metadata = await readMetadata(file.path, format);
        const providedLanguage = asText(body.language, 35);
        const languages = normalizeBookLanguages(body.languages);
        const language = primaryLanguage(normalizeLanguage(providedLanguage) || metadata.language || 'es', languages);
        if (providedLanguage && !normalizeLanguage(providedLanguage)) {
          throw new RequestError(422, 'Enter a language code such as es, en or fr.');
        }
        const title = asText(body.title, 250) || asText(metadata.title, 250)
          || asText(basename(file.originalname, extname(file.originalname)), 250) || 'Untitled';
        const author = asText(body.author, 200) || asText(metadata.author, 200);
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
        db.prepare('INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          id, title, author, assignment.language, format, assignment.categoryId,
          metadata.thumbnail ? metadata.thumbnailType : null, Date.now(), owner, visitor?.expires ?? null, file.size, Date.now(), JSON.stringify(assignment.languages),
        );
        saved = true;
        touch();
        return publicBook(getBook(id, visitor));
      } finally {
        if (!saved) {
          await Promise.allSettled([file.path, filePath(book), coverPath(book)].map((path) => rm(path, { force: true })));
        }
      }
    },
    editBook(id, body, visitor) {
      const book = getBook(id, visitor);
      if (book.owner !== editable(visitor)) throw new RequestError(403, 'The sample book is read-only.');
      const title = asText(body.title, 250);
      const languages = normalizeBookLanguages(body.languages, book.languages);
      const requestedLanguage = normalizeLanguage(body.language);
      if (!title || !requestedLanguage) throw new RequestError(422, 'Enter a title and a valid language code.');
      const language = primaryLanguage(requestedLanguage, languages);
      const assignment = folderAssignment(body.categoryId, language, languages, visitor);
      db.prepare('UPDATE books SET title = ?, author = ?, language = ?, categoryId = ?, updatedAt = ?, languages = ? WHERE id = ?')
        .run(title, asText(body.author, 200), assignment.language, assignment.categoryId, Date.now(), JSON.stringify(assignment.languages), id);
      touch();
      return publicBook(getBook(id, visitor));
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
    async removeBook(id, visitor) {
      const book = getBook(id, visitor);
      if (book.owner !== editable(visitor)) throw new RequestError(403, 'The sample book is read-only.');
      db.prepare('DELETE FROM books WHERE id = ?').run(id);
      touch();
      const cleanup = await Promise.allSettled([filePath(book), coverPath(book)].map((path) => rm(path, { force: true })));
      if (cleanup.some((result) => result.status === 'rejected')) console.error('Could not remove every file for book', id);
    },
    async pruneDemoBooks() {
      const now = Date.now();
      const expired = db.prepare('SELECT id, format FROM books WHERE expires <= ?').all(now);
      db.prepare('DELETE FROM books WHERE expires <= ?').run(now);
      db.prepare('DELETE FROM categories WHERE expires <= ?').run(now);
      db.prepare('DELETE FROM book_read_status WHERE expires <= ?').run(now);
      if (expired.length) touch();
      const paths = expired.flatMap((book) => [filePath(book), coverPath(book)]);
      const removed = await Promise.allSettled(paths.map((path) => rm(path, { force: true })));
      if (removed.some((item) => item.status === 'rejected')) console.error('Could not remove all expired demo files.');
    },
  };
}
