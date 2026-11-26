import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { RequestError } from './books.js';
import { downloadCover } from './cover-images.js';
import { cleanMetadata } from '../shared/book-metadata.js';

const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, processEntities: false });
const list = (value) => value == null ? [] : [value].flat();
const text = (value, max = 250) => cleanMetadata(value, max);
const formats = new Map([['application/epub+zip', 'epub'], ['application/pdf', 'pdf']]);
const owner = (visitor) => visitor?.id || '';
function connectionURL(value) {
  let url; try { url = new URL(value); } catch { throw new RequestError(422, 'Paste the complete Kavita OPDS URL from User settings → 3rd Party Clients.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || value.length > 4096) throw new RequestError(422, 'Use an HTTP or HTTPS OPDS URL without embedded login credentials.');
  return url;
}
// LAN endpoints are intentional here. All links and redirect hops remain pinned
// to the origin explicitly configured by this account; credentials never cross it.
async function fetchKavita(config, value, { signal } = {}) {
  let url = new URL(value);
  for (let hop = 0; hop < 4; hop++) {
    if (url.origin !== new URL(config.url).origin || url.username || url.password) throw new RequestError(422, 'Kavita links must stay on the configured server.');
    const response = await new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http)(url, { signal, headers: { 'User-Agent': 'Langy-Reader/0.1', 'Accept-Encoding': 'identity', ...(config.username ? { Authorization: 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64') } : {}) } }, resolve);
      req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('Kavita timed out'))); req.end();
    });
    if (![301,302,303,307,308].includes(response.statusCode)) return response;
    response.destroy(); if (!response.headers.location) break;
    url = new URL(response.headers.location, url);
  }
  throw new RequestError(502, 'Kavita redirected too many times. Use its final OPDS URL.');
}

export async function openKavita(dir, { demo = false, request = fetchKavita, now = Date.now } = {}) {
  const file = join(dir, 'kavita.sqlite'), db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS connections(owner TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;');
  await chmod(file, 0o600);
  for (const suffix of ['-wal','-shm']) await chmod(file + suffix, 0o600).catch((error) => { if(error.code !== 'ENOENT')throw error; });
  const tokens = new Map(), browsing = new Map();
  const configFor = (visitor) => { const row = db.prepare('SELECT json FROM connections WHERE owner=?').get(owner(visitor)); return row ? JSON.parse(row.json) : null; };
  function settings(visitor) { const config = configFor(visitor); return { available: !demo, connected: Boolean(config), origin: config ? new URL(config.url).origin : '', hasCredentials: Boolean(config?.username) }; }
  function requireConfig(visitor) { if (demo) throw new RequestError(403, 'Kavita connections are available on self-hosted installations.'); const config = configFor(visitor); if (!config) throw new RequestError(409, 'Connect your Kavita OPDS feed in Book sources first.'); return config; }
  function remember(value, visitor, config) {
    for (const [key, item] of tokens) if (item.until <= now()) tokens.delete(key);
    while (tokens.size >= 3000) tokens.delete(tokens.keys().next().value);
    const key = randomUUID(); tokens.set(key, { ...value, owner: owner(visitor), connection: config.id, until: now() + 1800000 }); return key;
  }
  function resolveToken(key, visitor, config, kind) { const item = tokens.get(key); if (!item || item.owner !== owner(visitor) || item.connection !== config.id || item.until <= now() || kind && item.kind !== kind) throw new RequestError(410, 'This Kavita selection expired. Browse the catalogue again.'); return item; }
  function sameOrigin(value, base, config) { try { const url = new URL(value, base); return ['http:', 'https:'].includes(url.protocol) && url.origin === new URL(config.url).origin && !url.username && !url.password ? url.href : null; } catch { return null; } }
  async function document(config, url, signal) {
    let response;
    try {
      response = await request(config, url, { signal: signal || AbortSignal.timeout(25000) });
      if ([401,403].includes(response.statusCode)) throw new RequestError(401, 'Kavita rejected this connection. Copy a fresh OPDS URL or check the optional login.');
      if (response.statusCode !== 200) throw new RequestError(502, 'Kavita did not return its OPDS catalogue. Check the feed URL.');
      const chunks = []; let size = 0;
      for await (const chunk of response) { size += chunk.length; if (size > 2 * 1024 ** 2) throw new RequestError(413, 'This catalogue page is too large. Enable pagination in Kavita.'); chunks.push(chunk); }
      const source = Buffer.concat(chunks).toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/iu.test(source) || XMLValidator.validate(source) !== true) throw new RequestError(422, 'Kavita returned invalid OPDS XML.');
      return xml.parse(source);
    } catch (error) { if (error instanceof RequestError) throw error; throw new RequestError(502, 'Could not reach Kavita from the Langy server. Check its address and network connection.'); }
    finally { response?.destroy(); }
  }
  async function catalogue(visitor, { node, q = '' } = {}) {
    const config = requireConfig(visitor);
    if (typeof q !== 'string' || q.length > 200) throw new RequestError(422, 'Search for a title or author of up to 200 characters.');
    const selected = node ? resolveToken(node, visitor, config, 'feed') : { url: config.url };
    if (browsing.has(owner(visitor))) throw new RequestError(409, 'A Kavita catalogue request is already running.');
    browsing.set(owner(visitor), true);
    try {
      let url = selected.url;
      if (q.trim()) {
        const search = selected.search; if (!search) throw new RequestError(422, 'Search is not available on this catalogue page. Open a Kavita collection first.');
        url = sameOrigin(search.replace(/\{searchTerms\??\}|%7BsearchTerms(?:%3F)?%7D/giu, encodeURIComponent(q.trim())).replace(/\{(?:startPage|startIndex)\??\}/gu, '1').replace(/\{count\??\}/gu, '50'), config.url, config);
        if (!url) throw new RequestError(422, 'The search link points outside this Kavita server.');
      }
      const parsed = await document(config, url), feed = parsed.feed;
      if (!feed) throw new RequestError(422, 'Use a Kavita OPDS catalogue URL, rather than its website login page.');
      const links = list(feed.link);
      let search;
      const searchLink = links.find((link) => link['@_rel'] === 'search');
      if (searchLink) {
        const target = sameOrigin(searchLink['@_href'], url, config);
        if (target && String(searchLink['@_type']).includes('opensearchdescription')) {
          const description = await document(config, target);
          const template = list(description.OpenSearchDescription?.Url).find((item) => String(item['@_type']).includes('atom+xml'))?.['@_template'];
          if (template) search = sameOrigin(template, url, config);
        } else if (target && /searchTerms/iu.test(target)) search = target;
      }
      const current = remember({ kind: 'feed', url, search }, visitor, config);
      const entries = list(feed.entry).slice(0, 500).map((entry) => {
        const title = text(entry.title) || 'Untitled', author = list(entry.author).map((item) => text(item.name, 200)).filter(Boolean).join(', ').slice(0, 200);
        const item = { title, author, summary: text(entry.summary || entry.content, 500), acquisitions: [] };
        for (const link of list(entry.link)) {
          const target = sameOrigin(link['@_href'], url, config); if (!target) continue;
          const rel = String(link['@_rel'] || ''), type = String(link['@_type'] || '').split(';')[0].trim();
          if (rel.startsWith('http://opds-spec.org/acquisition') && formats.has(type)) item.acquisitions.push({ format: formats.get(type), id: remember({ kind: 'book', url: target, details: { title, author } }, visitor, config) });
          else if (type === 'application/atom+xml' && !item.node) item.node = remember({ kind: 'feed', url: target }, visitor, config);
          else if (/^https?:\/\/opds-spec.org\/image(?:\/thumbnail)?$/u.test(rel) && /^image\/(?:jpeg|png|webp|gif)$/u.test(type)) item.cover = remember({ kind: 'cover', url: target }, visitor, config);
        }
        return item;
      });
      return { title: text(feed.title) || 'Kavita', node: current, searchable: Boolean(search), entries,
        navigation: links.flatMap((link) => { const rel = link['@_rel']; if (!['next','previous','prev','up','start'].includes(rel)) return []; const target = sameOrigin(link['@_href'], url, config); return target ? [{ label: ({ next: 'Next page', previous: 'Previous page', prev: 'Previous page', up: 'Up', start: 'Home' })[rel], node: remember({ kind: 'feed', url: target }, visitor, config) }] : []; }) };
    } finally { browsing.delete(owner(visitor)); }
  }
  return {
    settings, catalogue,
    async save(body, visitor) {
      if (demo) throw new RequestError(403, 'Connect Kavita on your self-hosted installation.');
      if (typeof body.url !== 'string' || !body.url.trim()) throw new RequestError(422, 'Paste your complete Kavita OPDS URL.');
      const url = connectionURL(body.url.trim()).href;
      if (typeof body.username !== 'string' || body.username.length > 200 || /[:\r\n]/u.test(body.username) || typeof body.password !== 'string' || body.password.length > 4096) throw new RequestError(422, 'Enter valid optional login credentials.');
      const config = { id: randomUUID(), url, username: body.username.trim(), password: body.password };
      const result = await document(config, url); if (!result.feed) throw new RequestError(422, 'This URL did not return an OPDS feed.');
      db.prepare('INSERT INTO connections VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET json=excluded.json').run(owner(visitor), JSON.stringify(config));
      return settings(visitor);
    },
    remove(visitor) { db.prepare('DELETE FROM connections WHERE owner=?').run(owner(visitor)); for (const [key, value] of tokens) if (value.owner === owner(visitor)) tokens.delete(key); return settings(visitor); },
    selection(key, visitor) { const config = requireConfig(visitor), item = resolveToken(key, visitor, config, 'book'); return { url: item.url, connection: config.id, details: item.details }; },
    async download(selection, visitor, signal) {
      const config = requireConfig(visitor);
      if (selection.connection !== config.id || !sameOrigin(selection.url, config.url, config)) throw new RequestError(409, 'Your Kavita connection changed. Browse and import this book again.');
      try { return await request(config, selection.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1800000)]) }); }
      catch (error) { if (signal.aborted) throw signal.reason; throw new RequestError(502, 'The Kavita book could not be downloaded. Check the connection and retry.'); }
    },
    async cover(key, visitor) {
      const config = requireConfig(visitor), item = resolveToken(key, visitor, config, 'cover');
      return downloadCover('https://kavita.invalid/cover', { request: async (_url, options) => request(config, item.url, options) });
    },
    close() { db.close(); tokens.clear(); },
  };
}
