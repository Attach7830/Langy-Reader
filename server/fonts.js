import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { RequestError } from './books.js';
export const fontUploadLimit = 32 * 1024 ** 2;
const budget = 128 * 1024 ** 2;

export function fontType(bytes) {
  const tag = bytes.toString('ascii', 0, 4), size = bytes.length;
  if (size < 12) throw new RequestError(422, 'Choose a valid TTF, OTF, WOFF or WOFF2 font.');
  if (bytes.readUInt32BE(0) === 0x10000 || ['OTTO', 'true'].includes(tag)) {
    const tables = bytes.readUInt16BE(4);
    if (!tables || tables > 512 || 12 + tables * 16 > size) throw new RequestError(422, 'The font table directory is invalid.');
    for (let index = 0; index < tables; index++) {
      const offset = 12 + index * 16;
      if (bytes.readUInt32BE(offset + 8) + bytes.readUInt32BE(offset + 12) > size) throw new RequestError(422, 'The font contains incomplete tables.');
    }
    return tag === 'OTTO' ? 'otf' : 'ttf';
  }
  if (['wOFF', 'wOF2'].includes(tag) && size >= (tag === 'wOFF' ? 44 : 48) && bytes.readUInt32BE(8) === size && bytes.readUInt16BE(12) > 0 && bytes.readUInt16BE(12) <= 512 && bytes.readUInt32BE(16) <= 64 * 1024 ** 2) return tag === 'wOFF' ? 'woff' : 'woff2';
  throw new RequestError(422, 'Choose a valid TTF, OTF, WOFF or WOFF2 font. Font collections and SVG fonts are not supported.');
}

export async function openFonts(dir, { reserveStorage = async () => () => {} } = {}) {
  const folder = join(dir, 'fonts'); await mkdir(folder, { recursive: true });
  const db = new DatabaseSync(join(dir, 'fonts.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS fonts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,format TEXT NOT NULL,bytes INTEGER NOT NULL,digest TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER,UNIQUE(owner,digest)) STRICT;');
  if (!db.prepare('PRAGMA table_info(fonts)').all().some((column) => column.name === 'source')) db.exec('ALTER TABLE fonts ADD COLUMN source TEXT');
  const path = (font) => join(folder, font.id + '.' + font.format);
  const publicFont = ({ id, name, format, bytes, source }) => ({ id: 'custom-' + id, name, format, bytes, source, url: '/api/fonts/' + id + '/file' });
  const row = (id, owner) => { const font = db.prepare('SELECT * FROM fonts WHERE id=? AND owner=? AND (expires IS NULL OR expires>?)').get(id, owner, Date.now()); if (!font) throw new RequestError(404, 'Font not found.'); return font; };
  async function prune() {
    const expired = db.prepare('SELECT * FROM fonts WHERE expires<=?').all(Date.now());
    for (const font of expired) { await rm(path(font), { force: true }); db.prepare('DELETE FROM fonts WHERE id=?').run(font.id); }
  }
  await prune();
  function quota(owner, bytes) {
    const total = db.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM fonts WHERE owner=?').get(owner);
    if (total.count >= 10 || total.bytes + bytes > budget) throw new RequestError(422, 'Each account can keep up to 10 fonts and 128 MiB. Remove a font before importing another.');
  }
  return {
    storageFiles: (owner) => db.prepare('SELECT * FROM fonts WHERE owner=?').all(owner).map(path),
    async list(owner) { await prune(); return db.prepare('SELECT * FROM fonts WHERE owner=? ORDER BY created,name').all(owner).map(publicFont); },
    file(id, owner) { const font = row(id, owner); return { path: path(font), type: 'font/' + font.format }; },
    async add(file, account, name, source = null) {
      if (!file?.path) throw new RequestError(422, 'Choose one font file.');
      let target, saved = false, release = () => {};
      try {
        await prune();
        const size = (await stat(file.path)).size; if (!size || size > fontUploadLimit) throw new RequestError(413, 'Font files must be at most 32 MiB.');
        const bytes = await readFile(file.path), format = fontType(bytes), digest = createHash('sha256').update(bytes).digest('hex');
        const old = db.prepare('SELECT * FROM fonts WHERE owner=? AND digest=?').get(account.id, digest); if (old) return publicFont(old);
        quota(account.id, size);
        release = await reserveStorage(account.owner ?? account.id, size);
        if (account.expires && db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM fonts WHERE expires IS NOT NULL').get().bytes + size > 256 * 1024 ** 2) throw new RequestError(507, 'The demo font storage is full. Try later or use your own instance.');
        const font = { id: randomUUID(), format }; target = path(font); await rename(file.path, target);
        const concurrent = db.prepare('SELECT * FROM fonts WHERE owner=? AND digest=?').get(account.id, digest); if (concurrent) return publicFont(concurrent);
        quota(account.id, size); if (account.expires && account.expires <= Date.now()) throw new RequestError(410, 'Your demo session expired. Reload before importing a font.');
        const label = (typeof name === 'string' && name.trim() || basename(file.originalname || 'Imported font', extname(file.originalname || ''))).replace(/[\x00-\x1f]/gu, '').slice(0, 100) || 'Imported font';
        db.prepare('INSERT INTO fonts(id,owner,name,format,bytes,digest,created,expires,source) VALUES(?,?,?,?,?,?,?,?,?)').run(font.id, account.id, label, format, size, digest, Date.now(), account.expires || null, source); saved = true;
        return publicFont({ ...font, name: label, bytes: size, source });
      } finally { await rm(file.path, { force: true }); if (!saved && target) await rm(target, { force: true }); release(); }
    },
    async remove(id, owner) { const font = row(id, owner); await rm(path(font), { force: true }); db.prepare('DELETE FROM fonts WHERE id=? AND owner=?').run(id, owner); },
    close() { db.close(); },
  };
}
