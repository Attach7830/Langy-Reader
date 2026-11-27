import { basename, extname } from 'node:path';
import { cleanMetadata } from '../shared/book-metadata.js';
import { publicDownload } from './public-download.js';

export function cleanArchiveTitle(value) {
  if (typeof value !== 'string') return '';
  const title = cleanMetadata(value.replace(/<[^>]*>/gu, ' ').replace(/&nbsp;/giu, ' '), 500)
    .replace(/\s*(?:[-–—|:]\s*)?Anna[’']s Archive\s*$/iu, '').trim().slice(0, 250);
  return !title || /^[a-f\d]{32}$/iu.test(title) || /^(?:just a moment|access denied|checking your browser|verify you are human|attention required|security check|ddos.guard|download|untitled)(?:[.!… :]|$)/iu.test(title) ? '' : title;
}

export function archiveRecordTitle(value, md5) {
  const record = value?.aarecord || value;
  if (!record || record.error || record.id && record.id !== 'md5:' + md5) return '';
  return cleanArchiveTitle(record.file_unified_data?.title_best) || cleanArchiveTitle(record.additional?.top_box?.title);
}

export function archivePageTitle(html) {
  // Current AA edition pages put the real book heading in a styled div;
  // the document title can also include format/author information.
  for (const item of String(html).matchAll(/<div\b([^>]*)>/giu)) {
    const classes = /\bclass\s*=\s*["']([^"']*)/iu.exec(item[1])?.[1] || '';
    if (/\bfont-semibold\b/u.test(classes) && /\btext-[23]xl\b/u.test(classes)) {
      const start = item.index + item[0].length, end = html.indexOf('</div>', start);
      const text = html.slice(start, end < 0 ? start + 10000 : Math.min(end, start + 10000));
      const title = cleanArchiveTitle(text.replace(/<span\b[^>]*\bselect-none\b[^>]*>[\s\S]*?<\/span>/giu, '').replace(/\s*🔍\s*$/u, ''));
      if (title) return title;
    }
  }
  const fields = new Map();
  for (const tag of String(html).matchAll(/<meta\b[^>]*>/giu)) {
    const attrs = {};
    for (const item of tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)) attrs[item[1].toLowerCase()] = item[2] ?? item[3] ?? item[4];
    const name = (attrs.property || attrs.name || '').toLowerCase();
    if (attrs.content && !fields.has(name)) fields.set(name, attrs.content);
  }
  for (const name of ['og:title', 'twitter:title', 'citation_title', 'dc.title', 'dcterms.title']) {
    const title = cleanArchiveTitle(fields.get(name)); if (title) return title;
  }
  for (const pattern of [/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu, /<title\b[^>]*>([\s\S]*?)<\/title>/iu]) {
    const title = cleanArchiveTitle(pattern.exec(html)?.[1]); if (title) return title;
  }
  return '';
}

export class ArchiveTitleError extends Error {
  constructor(code) { super('Book metadata could not be retrieved.'); this.code = code; }
}

// The optional existing member key is sent only to the configured AA origin's
// metadata endpoint, with redirects disabled. Never request a fast-download URL
// to discover a title: that would consume download allowance.
export async function lookupArchiveTitle({ baseUrl, md5, apiKey = '', signal, request = publicDownload }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.port && base.port !== '443'
    || !/^(?:www\.)?annas-archive\.[a-z]{2,24}$/iu.test(base.hostname) || !/^[a-f\d]{32}$/iu.test(md5)) return '';
  const paths = [];
  if (apiKey) {
    const endpoint = new URL('/dyn/api/aarecord_elasticsearch/md5:' + md5 + '.json', base);
    endpoint.searchParams.set('key', apiKey); paths.push({ endpoint, json: true });
  }
  paths.push({ endpoint: new URL('/md5/' + md5, base), json: false });
  let failure;
  for (const { endpoint, json } of paths) {
    let response;
    try {
      response = await request(endpoint, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12000)]), redirects: json ? 0 : 2,
        validate(url) { if (url.origin !== base.origin) throw new Error('Catalogue redirect changed origin.'); } });
      if (response.statusCode !== 200) {
        failure = [401, 403, 429].includes(response.statusCode) ? 'blocked' : 'unavailable'; continue;
      }
      const type = response.headers['content-type'] || '';
      if (type && !(json ? /^(?:application|text)\/json(?:;|$)/iu : /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu).test(type)) { failure = 'unavailable'; continue; }
      const chunks = []; let bytes = 0; const limit = json ? 1024 * 1024 : 512 * 1024;
      for await (const chunk of response) {
        const part = Buffer.from(chunk).subarray(0, limit - bytes); chunks.push(part); bytes += part.length;
        if (bytes === limit) break;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let title;
      if (json) { try { title = archiveRecordTitle(JSON.parse(body), md5); } catch { /* Invalid metadata falls back to the edition page. */ } }
      else title = archivePageTitle(body);
      if (title) return title;
      if (/ddos.guard|cf-chl-|verify you are human|checking your browser|just a moment/iu.test(body)) failure = 'blocked';
    } catch (error) {
      signal?.throwIfAborted();
      failure = /timeout|abort/iu.test(error.name || '') ? 'timeout' : 'unavailable';
    } finally { response?.destroy(); }
  }
  if (failure) throw new ArchiveTitleError(failure);
  return '';
}

export function archiveDownloadTitle(value, headers = {}) {
  const header = archiveFilenameTitle(headers); if (header) return header;
  try {
    const path = new URL(value).pathname;
    const name = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
    if (!/\.(?:epub|pdf)$/iu.test(name)) return '';
    const title = cleanArchiveTitle(basename(name, extname(name))).replace(/[_\s-]+[a-f\d]{32}$/iu, '').trim();
    if (!title || /^(?:[a-f\d-]{32,36}|book|download|file)$/iu.test(title)) return '';
    return title;
  } catch { return ''; }
}

export function archiveFilenameTitle(headers) {
  const field = String(headers['content-disposition'] || '');
  let name = /filename\*=UTF-8''([^;]+)/iu.exec(field)?.[1];
  try { name = name && decodeURIComponent(name); } catch { name = ''; }
  name ||= /filename="([^"]+)"/iu.exec(field)?.[1] || /filename=([^;]+)/iu.exec(field)?.[1];
  if (!name) return '';
  const safe = basename(name.replaceAll('\\', '/'));
  return cleanArchiveTitle(basename(safe, extname(safe)));
}
