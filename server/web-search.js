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

export class WebSearchError extends RequestError {
  constructor(reason, message) {
    super(503, message);
    this.reason = reason;
  }
}

export function openWebSearch({ searchUrl = process.env.READER_SEARCH_URL ?? 'http://search:8080', fetcher = (...args) => fetch(...args) } = {}) {
  return async (query, signal) => {
    let url;
    try { if (searchUrl) url = new URL('search', searchUrl.replace(/\/+$/u, '') + '/'); } catch {}
    if (!url || !['http:', 'https:'].includes(url.protocol)) throw new WebSearchError('configuration', 'Web search is not configured.');
    url.searchParams.set('q', query); url.searchParams.set('format', 'json'); url.searchParams.set('categories', 'general');
    const timeout = AbortSignal.timeout(18000);
    let response;
    try {
      response = await fetcher(url, { headers: { Accept: 'application/json' }, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch {
      signal?.throwIfAborted();
      if (timeout.aborted) throw new WebSearchError('timeout', 'The search service did not respond in time.');
      throw new WebSearchError('connection', 'Could not connect to the search service.');
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      const reason = [401, 403].includes(response.status) ? 'access' : response.status === 429 ? 'busy' : response.status === 404 ? 'configuration' : 'service';
      throw new WebSearchError(reason, `Search returned HTTP ${response.status}.`);
    }
    let data;
    try { data = await searchJson(response); }
    catch (error) {
      signal?.throwIfAborted();
      if (timeout.aborted) throw new WebSearchError('timeout', 'The search service did not respond in time.');
      throw error;
    }
    if (!Array.isArray(data?.results)) throw new WebSearchError('service', 'The search service returned an unexpected response.');
    return data.results.slice(0, 6).flatMap((item) => {
      const url = searchLink(item?.url), title = clean(item?.title, 180), snippet = clean(item?.content, 500);
      return url && title ? [{ url, title, snippet }] : [];
    });
  };
}
