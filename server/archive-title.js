import { basename, extname } from 'node:path';
import { cleanMetadata } from '../shared/book-metadata.js';
import { publicDownload } from './public-download.js';

export function cleanArchiveTitle(value) {
  if (typeof value !== 'string') return '';
  const title = cleanMetadata(value.replace(/<[^>]*>/gu, ' ').replace(/&nbsp;/giu, ' '), 500)
    .replace(/\s*(?:[-–—|:]\s*)?Anna[’']s Archive\s*$/iu, '').trim().slice(0, 250);
  return !title || /^[a-f\d]{32}$/iu.test(title) || /^(?:just a moment|access denied|checking your browser|verify you are human|attention required|security check|download|untitled)(?:[.!… ]|$)/iu.test(title) ? '' : title;
}

export function archivePageTitle(html) {
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

// Public catalogue metadata only: no member key, paid API or signed file URL.
export async function lookupArchiveTitle({ baseUrl, md5, signal, request = publicDownload }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.port && base.port !== '443'
    || !/^(?:www\.)?annas-archive\.[a-z]{2,24}$/iu.test(base.hostname) || !/^[a-f\d]{32}$/iu.test(md5)) return '';
  let response;
  try {
    response = await request(new URL('/md5/' + md5, base), { signal, redirects: 2,
      validate(url) { if (url.origin !== base.origin) throw new Error('Catalogue redirect changed origin.'); } });
    if (response.statusCode !== 200 || response.headers['content-type'] && !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(response.headers['content-type'])) return '';
    const chunks = []; let bytes = 0;
    for await (const chunk of response) {
      const part = Buffer.from(chunk).subarray(0, 512 * 1024 - bytes); chunks.push(part); bytes += part.length;
      if (bytes === 512 * 1024) break;
    }
    return archivePageTitle(Buffer.concat(chunks).toString('utf8'));
  } finally { response?.destroy(); }
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
