import { RequestError } from './books.js';

const clean = (value, limit) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit) : '';

export function searchLink(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || /^(?:localhost|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[)/iu.test(url.hostname)
      || !url.hostname.includes('.') || /\.(?:local|internal)$/iu.test(url.hostname)) return null;
    url.hash = ''; return url.href;
  } catch { return null; }
}

export async function searchJson(response) {
  if (!response.ok) throw new RequestError(502, `Search returned HTTP ${response.status}.`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 ** 2) throw new RequestError(502, 'Search returned too much data. Try a narrower request.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(502, 'Search returned an unreadable response.'); }
}

export function openWebSearch({ searchUrl = process.env.READER_SEARCH_URL ?? 'http://search:8080', fetcher = (...args) => fetch(...args) } = {}) {
  return async (query, signal) => {
    if (!searchUrl) throw new RequestError(503, 'Web search is not configured.');
    const url = new URL('search', searchUrl.replace(/\/+$/u, '') + '/');
    url.searchParams.set('q', query); url.searchParams.set('format', 'json'); url.searchParams.set('categories', 'general');
    const data = await searchJson(await fetcher(url, { headers: { Accept: 'application/json' }, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(18000)].filter(Boolean)) }));
    return (Array.isArray(data?.results) ? data.results : []).slice(0, 6).flatMap((item) => {
      const url = searchLink(item?.url), title = clean(item?.title, 180), snippet = clean(item?.content, 500);
      return url && title ? [{ url, title, snippet }] : [];
    });
  };
}
