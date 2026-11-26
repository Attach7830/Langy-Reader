import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, isArray: (name) => ['entry', 'link'].includes(name) });
const basic = 'Basic ' + Buffer.from('opds-test:test-password').toString('base64');

async function fixture(t, { demo = false, authenticated = false } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'langy-opds-'));
  const library = await openLibrary(folder);
  const epub = await sampleBook();
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(folder, { recursive: true, force: true });
  });
  async function add(id, body, format = 'epub') {
    const bytes = format === 'epub' ? epub : Buffer.from('%PDF-1.4\n%%EOF\n');
    const path = join(library.uploads, id);
    await writeFile(path, bytes);
    return library.importBook(id, { originalname: `${id}.${format}`, path, size: bytes.length }, { language: 'es', ...body });
  }
  async function start() {
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    let output = '';
    child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env,
      PORT: String(port), READER_DATA: folder, READER_DEMO: demo ? '1' : '0',
      READER_USER: 'opds-test', READER_PASSWORD: authenticated ? 'test-password' : '',
      READER_LANGUAGE_URL: 'http://127.0.0.1:1', READER_KOKORO_URL: '',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (value) => { output = (output + value).slice(-16000); });
    child.stderr.on('data', (value) => { output = (output + value).slice(-16000); });
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(`Reader exited: ${output}`);
      try { if ((await fetch(base + '/healthz', { signal: AbortSignal.timeout(500) })).ok) return base; } catch { /* Wait for startup. */ }
      await delay(20);
    }
    throw new Error(`Reader startup timed out: ${output}`);
  }
  return { folder, library, epub, add, start };
}

async function readFeed(base, path, headers = {}) {
  const response = await fetch(new URL(path, base), { headers });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(response.headers.get('content-type'), /application\/atom\+xml/u);
  assert.equal(XMLValidator.validate(text), true, text);
  assert.match(response.headers.get('cache-control'), /no-store/u);
  return { text, feed: parser.parse(text).feed };
}
const relation = (entry, rel) => entry.link?.find((link) => link['@_rel'] === rel);

test('OPDS browses EPUBs, categories and search with bounded feeds, and downloads original files with Basic auth', async (t) => {
  const { library, epub, add, start, folder } = await fixture(t, { authenticated: true });
  for (let index = 0; index < 22; index++) {
    const number = String(index).padStart(2, '0');
    library.saveCategory(`cat-${number}`, { name: index ? `Category ${number}` : 'Ficción & <poesía>' }, true);
    await add(`book-${number}`, { title: `Libro ${number}`, author: 'Autora', categoryId: `cat-${number}` });
  }
  const special = await add('special', { title: 'Árbol & <noche> "🙂"\u0001', author: 'Juan Rulfo' });
  await add('pdf', { title: 'A PDF' }, 'pdf');
  const cover = Buffer.from('89504e470d0a1a0a', 'hex');
  await writeFile(library.coverPath(special), cover);
  const db = new DatabaseSync(join(folder, 'library.sqlite'));
  db.prepare('UPDATE books SET thumbnailType = ? WHERE id = ?').run('image/png', 'special');
  db.close();
  const base = await start();
  const headers = { Authorization: basic };
  for (const path of ['/opds', '/opds/search.xml', '/opds/books/special/file.epub', '/opds/books/special/cover', '/api/storage', '/api/settings/opds']) {
    const unauthorized = await fetch(base + path);
    assert.equal(unauthorized.status, 401, path);
    if (path.startsWith('/opds')) assert.match(unauthorized.headers.get('www-authenticate'), /^Basic /u);
    else assert.equal(unauthorized.headers.get('www-authenticate'), null, 'Web sign-in uses the app login form.');
  }
  assert.equal((await fetch(base + '/opds', { headers: { Authorization: 'Basic ' + Buffer.from('opds-test:wrong').toString('base64') } })).status, 401);
  const { feed: rootFeed } = await readFeed(base, '/opds', headers);
  assert.equal(rootFeed.entry.length, 4);
  assert.equal(rootFeed.id, (await readFeed(base, '/opds/', headers)).feed.id);
  const all = relation(rootFeed.entry.find((entry) => entry.title === 'All EPUB books'), 'subsection')['@_href'];
  const first = await readFeed(base, all, headers);
  assert.equal(first.feed.entry.length, 20);
  assert.equal(first.feed['opensearch:totalResults'], '24');
  assert.ok(first.feed.entry.every((entry) => relation(entry, 'http://opds-spec.org/acquisition')['@_type'] === 'application/epub+zip'));
  const second = await readFeed(base, relation(first.feed, 'next')['@_href'], headers);
  assert.equal(second.feed.entry.length, 4);
  assert.equal(new Set([...first.feed.entry, ...second.feed.entry].map((entry) => entry.id)).size, 24);
  assert.equal(relation(second.feed, 'next'), undefined);

  const categories = (await readFeed(base, '/opds/categories', headers)).feed;
  assert.equal(categories.entry.length, 20);
  const moreCategories = (await readFeed(base, relation(categories, 'next')['@_href'], headers)).feed;
  assert.equal(moreCategories.entry.length, 4);
  const category = [...categories.entry, ...moreCategories.entry].find((entry) => entry.title === 'Ficción & <poesía>');
  const categorized = (await readFeed(base, relation(category, 'subsection')['@_href'], headers)).feed;
  assert.equal(categorized.entry.length, 1);
  assert.equal(categorized.entry[0].title, 'Libro 00');
  assert.equal(categorized.entry[0].category['@_label'], 'Ficción & <poesía>');

  const searchDescription = await fetch(base + relation(rootFeed, 'search')['@_href'], { headers });
  assert.match(searchDescription.headers.get('content-type'), /application\/opensearchdescription\+xml/u);
  const template = parser.parse(await searchDescription.text()).OpenSearchDescription.Url['@_template'];
  const search = await readFeed(base, template.replace('{searchTerms}', encodeURIComponent('arbol')), headers);
  assert.equal(search.feed.entry.length, 1);
  assert.equal(search.feed.entry[0].title, 'Árbol & <noche> "🙂"');
  assert.match(search.text, /&amp; &lt;noche&gt;/u);
  const author = (await readFeed(base, '/opds/books?q=RULFO', headers)).feed;
  assert.equal(author.entry[0].id, search.feed.entry[0].id);
  const pagedSearch = (await readFeed(base, '/opds/books?q=Libro&sort=recent', headers)).feed;
  const nextSearch = relation(pagedSearch, 'next')['@_href'];
  assert.match(nextSearch, /q=Libro/u);
  assert.match(nextSearch, /sort=recent/u);
  assert.equal((await readFeed(base, nextSearch, headers)).feed.entry.length, 2);

  const download = await fetch(base + relation(search.feed.entry[0], 'http://opds-spec.org/acquisition')['@_href'], { headers });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /application\/epub\+zip/u);
  assert.match(download.headers.get('content-disposition'), /^attachment;.*\.epub/u);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), epub);
  const image = await fetch(base + relation(search.feed.entry[0], 'http://opds-spec.org/image/thumbnail')['@_href'], { headers });
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), cover);
  const pdf = (await readFeed(base, '/opds/books?format=pdf', headers)).feed;
  assert.equal(pdf.entry.length, 1);
  assert.equal(relation(pdf.entry[0], 'http://opds-spec.org/acquisition')['@_type'], 'application/pdf');
  assert.equal((await fetch(base + relation(pdf.entry[0], 'http://opds-spec.org/acquisition')['@_href'], { headers })).status, 200);
  for (const path of ['/opds/books?format=txt', '/opds/books?q=test&q=other', '/opds/books?page=0']) {
    assert.equal((await fetch(base + path, { headers })).status, 400, path);
  }
  for (const path of ['/opds/books?category=missing', '/opds/books?page=999', '/opds/books/missing/file.epub', '/opds/books/special/file.pdf', '/opds/unknown']) {
    assert.equal((await fetch(base + path, { headers })).status, 404, path);
  }
  const settings = await (await fetch(base + '/api/settings/opds', { headers })).json();
  assert.equal(settings.authenticated, true);
  assert.equal(settings.username, 'opds-test');
  assert.ok(!JSON.stringify(settings).includes('test-password'));
  const storage = await (await fetch(base + '/api/storage', { headers })).json();
  const fs = await statfs(folder, { bigint: true });
  assert.equal(storage.scope, 'account'); assert.equal(storage.unlimited, true);
  assert.ok(storage.usedBytes > 0);
  // Other tests can write between this API response and statfs; capacity is stable.
  assert.ok(storage.availableBytes > 0 && storage.availableBytes <= Number(fs.blocks * fs.bsize));
  assert.equal(storage.totalBytes, storage.usedBytes + storage.availableBytes);
  assert.equal(storage.drive.available, true);
  assert.equal(storage.drive.totalBytes, Number(fs.blocks * fs.bsize));
  assert.equal(storage.drive.availableBytes, storage.availableBytes);
  assert.equal(storage.drive.usedBytes + storage.drive.reservedBytes + storage.drive.availableBytes, storage.drive.totalBytes);
  assert.ok(!JSON.stringify(storage).includes(folder));
});

test('demo OPDS is disabled and storage shows only this visitor’s allowance', async (t) => {
  const { start, epub } = await fixture(t, { demo: true });
  const base = await start();
  for (const path of ['/opds', '/opds/books', '/opds/categories', '/opds/search.xml', '/opds/books/sample/file.epub', '/opds/books/sample/cover']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  const initial = await fetch(base + '/api/storage');
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  const before = await initial.json();
  assert.deepEqual(before, { available: true, scope: 'demo', totalBytes: 80 * 1024 ** 2, usedBytes: 0, availableBytes: 80 * 1024 ** 2 });
  const body = new FormData();
  body.set('file', new Blob([epub], { type: 'application/epub+zip' }), 'personal.epub');
  const imported = await fetch(base + '/api/books', { method: 'POST', headers: { Cookie: cookie }, body });
  assert.equal(imported.status, 201, await imported.text());
  const after = await (await fetch(base + '/api/storage', { headers: { Cookie: cookie } })).json();
  assert.equal(after.usedBytes, epub.length);
  assert.equal(after.availableBytes, before.totalBytes - epub.length);
  const otherVisitor = await (await fetch(base + '/api/storage')).json();
  assert.equal(otherVisitor.usedBytes, 0);
  assert.deepEqual(await (await fetch(base + '/api/settings/opds')).json(), {
    available: false, path: '/opds', username: '', authenticated: false, pageSize: 20,
  });
});

test('existing library migration preserves books and stable catalog identity, and unavailable drives fail gracefully', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-migrate-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const epub = await sampleBook();
  await mkdir(join(folder, 'books'));
  await writeFile(join(folder, 'books', 'old.epub'), epub);
  const db = new DatabaseSync(join(folder, 'library.sqlite'));
  db.exec(`CREATE TABLE categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, expires INTEGER);
    CREATE TABLE books(id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, language TEXT NOT NULL, format TEXT NOT NULL,
      categoryId TEXT, thumbnailType TEXT, addedAt INTEGER NOT NULL, owner TEXT NOT NULL, expires INTEGER, bytes INTEGER NOT NULL);
    INSERT INTO categories VALUES ('old-category', 'Existing', '', NULL); PRAGMA user_version=1;`);
  db.prepare('INSERT INTO books VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('old', 'Existing book', 'Author', 'es', 'epub', 'old-category', null, 1000, '', null, epub.length);
  db.close();
  const library = await openLibrary(folder);
  assert.equal(library.snapshot().books.length, 1);
  assert.equal(library.getBook('old').updatedAt, 1000);
  assert.deepEqual(await readFile(library.filePath(library.getBook('old'))), epub);
  const identity = library.instanceId;
  library.editBook('old', { title: 'Edited', author: 'Author', language: 'es', categoryId: 'old-category' });
  assert.ok(library.getBook('old').updatedAt > 1000);
  const reopened = await openLibrary(folder);
  assert.equal(reopened.instanceId, identity);
  assert.equal(reopened.getBook('old').title, 'Edited');
  await rm(folder, { recursive: true, force: true });
  assert.deepEqual(await reopened.storage(), { available: false, scope: 'drive' });
});
