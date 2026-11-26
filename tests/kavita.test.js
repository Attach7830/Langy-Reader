import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { openKavita } from '../server/kavita.js';
import { openBookImports } from '../server/book-imports.js';
import { openLibrary } from '../server/books.js';
import { sampleBook } from '../server/sample.js';

test('personal Kavita OPDS browsing, search and queued acquisitions use private account-scoped tokens', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-kavita-')), bytes = await sampleBook(), seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === '/book/secret-key.epub') return res.setHeader('Content-Type', 'application/epub+zip').end(bytes);
    if (req.url.startsWith('/search-description')) return res.end(`<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><Url type="application/atom+xml" template="${base}/search?key=secret-key&amp;q={searchTerms}"/></OpenSearchDescription>`);
    res.end(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Kavita stories</title><link rel="search" type="application/opensearchdescription+xml" href="/search-description"/><link rel="next" type="application/atom+xml" href="/next?key=secret-key"/><entry><title>A story</title><author><name>A Writer</name></author><link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="/book/secret-key.epub"/><link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="https://foreign.invalid/leak?key=secret-key"/></entry><entry><title>A collection</title><link type="application/atom+xml;profile=opds-catalog" href="/collection?key=secret-key"/></entry></feed>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const base = 'http://127.0.0.1:' + server.address().port;
  const owner = { id: 'owner' }, other = { id: 'other' }, service = await openKavita(dir); let imports;
  t.after(async () => { imports?.close(); service.close(); await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const saved = await service.save({ url: base + '/feed/secret-key', username: 'reader', password: 'private-password' }, owner);
  assert.equal(saved.connected, true); assert.equal((await stat(join(dir, 'kavita.sqlite'))).mode & 0o777, 0o600);
  assert.equal(service.settings(other).connected, false);
  const catalogue = await service.catalogue(owner); assert.equal(catalogue.entries[0].acquisitions.length, 1); assert.equal(catalogue.searchable, true); assert.ok(catalogue.entries[1].node);
  assert.doesNotMatch(JSON.stringify([saved, catalogue]), /secret-key|private-password|Authorization/u);
  await assert.rejects(service.catalogue(other, { node: catalogue.node }), { status: 409 });
  await service.save({ url: base + '/feed/other-key', username: '', password: '' }, other);
  await assert.rejects(service.catalogue(other, { node: catalogue.node }), { status: 410 });
  await service.catalogue(owner, { node: catalogue.node, q: 'La casa de azúcar' }); assert.ok(seen.some((item) => item.url.includes('q=La%20casa%20de%20az%C3%BAcar')));
  const library = await openLibrary(dir); imports = await openBookImports(dir, { library, connector: service, autoStart: false });
  const job = imports.queueKavita({ item: catalogue.entries[0].acquisitions[0].id, series: 'Kavita imports', seriesIndex: 2 }, owner);
  assert.doesNotMatch(JSON.stringify(job), /secret-key|http:|private-password/u); assert.deepEqual(imports.list(other), []);
  await imports.pump(); const done = imports.list(owner)[0]; assert.equal(done.state, 'ready', done.error); assert.equal(library.getBook(done.book, owner).seriesIndex, 2); assert.equal(library.snapshot(other).books.length, 0); assert.deepEqual(await readdir(library.uploads), []);
  assert.ok(seen.filter((item) => item.url.includes('secret-key')).every((item) => item.authorization === 'Basic ' + Buffer.from('reader:private-password').toString('base64')));
  service.remove(owner); await assert.rejects(service.download(service.selection?.unreachable || { connection: 'old' }, owner, new AbortController().signal), { status: 409 });
});

test('Kavita refuses foreign redirects, XML entities, website pages and stale selections after changing connection', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-kavita-boundaries-')); let mode = 'feed', foreignHits = 0;
  const foreign = createServer((_req, res) => { foreignHits++; res.end('should not be reached'); }); await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  const server = createServer((_req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:' + foreign.address().port }); return res.end(); }
    if (mode === 'entities') return res.end('<!DOCTYPE feed [<!ENTITY test "bad">]><feed/>');
    if (mode === 'html') return res.end('<html><body>Login</body></html>');
    res.end('<feed xmlns="http://www.w3.org/2005/Atom"><title>Books</title><entry><title>Book</title><link rel="http://opds-spec.org/acquisition" type="application/pdf" href="/book.pdf"/></entry></feed>');
  }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const service = await openKavita(dir), visitor = { id: 'reader' }, config = { url: 'http://127.0.0.1:' + server.address().port + '/feed', username: '', password: '' };
  t.after(async () => { service.close(); await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => foreign.close(resolve))]); await rm(dir, { recursive: true, force: true }); });
  await service.save(config, visitor); const found = await service.catalogue(visitor), selection = service.selection(found.entries[0].acquisitions[0].id, visitor);
  await service.save(config, visitor); await assert.rejects(service.download(selection, visitor, new AbortController().signal), { status: 409 });
  for (const value of ['redirect','entities','html']) { mode = value; await assert.rejects(service.save(config, visitor)); }
  assert.equal(foreignHits, 0); assert.equal(service.settings(visitor).connected, true);
});
