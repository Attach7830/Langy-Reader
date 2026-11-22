import { Router } from 'express';
import { RequestError } from './books.js';

export const opdsPageSize = 20;
const navigationType = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const acquisitionType = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
const acquisitionRel = 'http://opds-spec.org/acquisition';
const mime = { epub: 'application/epub+zip', pdf: 'application/pdf' };
const xml = (value) => String(value ?? '')
  .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const fold = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
const stamp = (value) => new Date(value).toISOString();
const link = (rel, href, type, title = '') => `<link rel="${xml(rel)}" href="${xml(href)}" type="${xml(type)}"${title ? ` title="${xml(title)}"` : ''}/>`;

function query(req, name, fallback = '') {
  const value = req.query[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 1000) throw new RequestError(400, 'Invalid catalog query.');
  return value.trim();
}

function pageNumber(req) {
  const value = query(req, 'page', '1');
  if (!/^[1-9]\d{0,6}$/u.test(value)) throw new RequestError(400, 'Choose a valid catalog page.');
  return Number(value);
}

function pathWith(path, params = {}) {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value != null));
  return path + (search.size ? `?${search}` : '');
}

// Root-relative links keep downloads on the same origin and preserve Basic auth,
// including when HTTPS is terminated by a reverse proxy or Cloudflare Tunnel.
export function opdsRouter({ library, demo = false, onDownload }) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (demo) return next(new RequestError(404, 'OPDS is available on self-hosted installations.'));
    next();
  });
  const id = (key) => `urn:langy:${library.instanceId}:${key}`;

  function feed(res, { path, title, entries, updated, acquisition = false, links = '', total, page = 1 }) {
    const type = acquisition ? acquisitionType : navigationType;
    res.set('Content-Type', `${type};charset=utf-8`).send(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
<id>${xml(id(path))}</id><title>${xml(title)}</title><updated>${stamp(updated)}</updated>
<author><name>Langy Reader</name></author>
${link('self', path, type)}${link('start', '/opds', navigationType)}${link('search', '/opds/search.xml', 'application/opensearchdescription+xml')}${links}
${total == null ? '' : `<opensearch:totalResults>${total}</opensearch:totalResults><opensearch:itemsPerPage>${opdsPageSize}</opensearch:itemsPerPage><opensearch:startIndex>${(page - 1) * opdsPageSize + 1}</opensearch:startIndex>`}
${entries.join('\n')}
</feed>`);
  }

  function navigationEntry(key, title, href, updated, summary, type = acquisitionType) {
    return `<entry><id>${xml(id(key))}</id><title>${xml(title)}</title><updated>${stamp(updated)}</updated><summary type="text">${xml(summary)}</summary>${link('subsection', href, type)}</entry>`;
  }

  function snapshot() {
    const value = library.snapshot();
    return { ...value, updated: value.updatedAt };
  }

  router.get('/', (_req, res) => {
    const { books, updated } = snapshot();
    const epubs = books.filter((book) => book.format === 'epub').length;
    feed(res, { path: '/opds', title: 'Langy Reader', updated, entries: [
      navigationEntry('books', 'All EPUB books', '/opds/books', updated, `${epubs} EPUB books for your reader.`),
      navigationEntry('recent', 'Recently added', '/opds/books?sort=recent', updated, 'EPUB books, newest first.'),
      navigationEntry('categories', 'Categories', '/opds/categories', updated, 'Browse EPUB books by category.', navigationType),
      navigationEntry('pdfs', 'PDF books', '/opds/books?format=pdf', updated, 'Original PDFs for clients that support PDF. Xteink readers may require conversion.'),
    ] });
  });

  router.get('/categories', (req, res) => {
    const { books, categories, updated } = snapshot();
    const page = pageNumber(req);
    const counts = new Map();
    for (const book of books.filter((item) => item.format === 'epub')) {
      const key = book.categoryId || 'uncategorized';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const rows = [...categories, { id: 'uncategorized', name: 'Uncategorized' }].filter((item) => counts.has(item.id));
    const pages = Math.max(1, Math.ceil(rows.length / opdsPageSize));
    if (page > pages) throw new RequestError(404, 'Catalog page not found.');
    let links = link('up', '/opds', navigationType);
    if (page > 1) links += link('previous', pathWith('/opds/categories', { page: page - 1 }), navigationType);
    if (page < pages) links += link('next', pathWith('/opds/categories', { page: page + 1 }), navigationType);
    feed(res, { path: pathWith('/opds/categories', page === 1 ? {} : { page }), title: 'Categories', updated, links,
      entries: rows.slice((page - 1) * opdsPageSize, page * opdsPageSize).map((item) => navigationEntry(
        `category:${item.id}`, item.name, pathWith('/opds/books', { category: item.id }), updated, `${counts.get(item.id)} EPUB books.`,
      )) });
  });

  router.get('/books', (req, res) => {
    const { books, categories, updated } = snapshot();
    const format = query(req, 'format', 'epub');
    const sort = query(req, 'sort', 'title');
    const category = query(req, 'category');
    const search = query(req, 'q');
    const page = pageNumber(req);
    if (!['epub', 'pdf', 'all'].includes(format) || !['title', 'recent'].includes(sort)) throw new RequestError(400, 'Choose a supported catalog format and sort order.');
    const group = categories.find((item) => item.id === category);
    if (category && category !== 'uncategorized' && !group) throw new RequestError(404, 'Category not found.');
    const needle = fold(search);
    const visible = books.filter((book) => (format === 'all' || book.format === format)
      && (!category || (book.categoryId || 'uncategorized') === category)
      && (!needle || fold(`${book.title} ${book.author}`).includes(needle)));
    visible.sort(sort === 'recent' ? (a, b) => b.addedAt - a.addedAt || a.id.localeCompare(b.id)
      : (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    const pages = Math.max(1, Math.ceil(visible.length / opdsPageSize));
    if (page > pages) throw new RequestError(404, 'Catalog page not found.');
    const params = { format: format === 'epub' ? '' : format, sort: sort === 'title' ? '' : sort, category, q: search };
    const pagePath = (value) => pathWith('/opds/books', { ...params, page: value === 1 ? '' : value });
    let links = link('up', category ? '/opds/categories' : '/opds', navigationType);
    if (page > 1) links += link('previous', pagePath(page - 1), acquisitionType);
    if (page < pages) links += link('next', pagePath(page + 1), acquisitionType);
    const entries = visible.slice((page - 1) * opdsPageSize, page * opdsPageSize).map((book) => {
      const base = `/opds/books/${encodeURIComponent(book.id)}`;
      const bookCategory = categories.find((item) => item.id === book.categoryId);
      return `<entry><id>${xml(id(`book:${book.id}`))}</id><title>${xml(book.title)}</title><updated>${stamp(book.updatedAt || book.addedAt)}</updated>
${book.author ? `<author><name>${xml(book.author)}</name></author>` : ''}<dc:language>${xml(book.language)}</dc:language><dc:format>${mime[book.format]}</dc:format>
${bookCategory ? `<category term="${xml(bookCategory.id)}" label="${xml(bookCategory.name)}"/>` : ''}
<summary type="text">${xml([book.author, book.language, bookCategory?.name, book.format.toUpperCase()].filter(Boolean).join(' · '))}</summary>
${link(acquisitionRel, `${base}/file.${book.format}`, mime[book.format])}
${book.thumbnailType ? link('http://opds-spec.org/image/thumbnail', `${base}/cover`, book.thumbnailType) : ''}</entry>`;
    });
    const title = search ? `Search: ${search}` : group?.name || (category === 'uncategorized' ? 'Uncategorized'
      : sort === 'recent' ? 'Recently added' : format === 'pdf' ? 'PDF books' : format === 'all' ? 'All books' : 'All EPUB books');
    feed(res, { path: pagePath(page), title, entries, updated, acquisition: true, links, total: visible.length, page });
  });

  router.get('/search.xml', (_req, res) => res.type('application/opensearchdescription+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>Langy Reader</ShortName><Description>Search EPUB books by title or author.</Description><InputEncoding>UTF-8</InputEncoding><Url type="${xml(acquisitionType)}" template="/opds/books?q={searchTerms}"/></OpenSearchDescription>`));

  router.get('/books/:id/file.:format', async (req, res) => {
    const book = library.getBook(req.params.id);
    if (req.params.format !== book.format) throw new RequestError(404, 'Book format not found.');
    await onDownload?.(book);
    const filename = [...book.title.replace(/[\p{Cc}<>:"/\\|?*]/gu, '_').replace(/^\.+/u, '')].slice(0, 120).join('') || 'Book';
    res.type(mime[book.format]).download(library.filePath(book), `${filename}.${book.format}`, { dotfiles: 'allow' });
  });
  router.get('/books/:id/cover', (req, res) => {
    const book = library.getBook(req.params.id);
    if (!book.thumbnailType) throw new RequestError(404, 'Cover not found.');
    res.type(book.thumbnailType).sendFile(library.coverPath(book), { dotfiles: 'allow' });
  });
  router.use((_req, _res, next) => next(new RequestError(404, 'Catalog endpoint not found.')));
  return router;
}
