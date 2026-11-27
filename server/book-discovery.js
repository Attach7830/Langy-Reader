import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { baseLanguage } from '../shared/language.js';
import { normalizeLanguage, RequestError } from './books.js';
import { waitForOpenLibrary } from './open-library-rate.js';
import { consumeProcesses, PROCESS_YIELD } from './process-scheduler.js';
import { openWebSearch, searchJson } from './web-search.js';
export { searchLink as discoveryLink } from './web-search.js';

const clean = (value, limit) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit) : '';
const titleKey = (value) => clean(value, 500).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const busy = (state) => ['queued', 'scanning', 'searching', 'ranking'].includes(state);
const ownerOf = (visitor) => visitor?.id || '';
const languageCodes = { en: 'eng', es: 'spa', pt: 'por', zh: 'chi', fr: 'fre', de: 'ger', it: 'ita', ja: 'jpn', ko: 'kor', ar: 'ara', ru: 'rus', nl: 'dut', sv: 'swe', pl: 'pol', hi: 'hin', tr: 'tur', el: 'gre', he: 'heb', uk: 'ukr', ca: 'cat', fa: 'per', vi: 'vie', id: 'ind' };
const quote = (text) => '"' + text.replace(/[\\"]/gu, '\\$&') + '"';
const boundedRows = (rows, budget) => {
  const selected = []; let size = 0;
  for (const row of rows) { const bytes = Buffer.byteLength(JSON.stringify(row)); if (size + bytes <= budget) { selected.push(row); size += bytes; } }
  return selected;
};

async function abortable(task, signal) {
  signal.throwIfAborted(); let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([task(), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export function openBookDiscovery(dir, { library, ai, demo = false, searchUrl,
  fetcher = (...args) => fetch(...args), catalogueDelay = 1100, timeoutMs = 240000, withAI = (_visitor, task) => task(), visitorForOwner = (id, expires) => id ? { id, expires } : undefined, scheduler } = {}) {
  const webSearch = openWebSearch({ searchUrl, fetcher });
  const db = new DatabaseSync(join(dir, 'discovery.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS discoveries (
      owner TEXT PRIMARY KEY,id TEXT NOT NULL,state TEXT NOT NULL,signature TEXT NOT NULL,
      request TEXT NOT NULL,result TEXT,error TEXT,created INTEGER NOT NULL,expires INTEGER
    ) STRICT;
    UPDATE discoveries SET state='error',error='Discovery was interrupted by a restart. Try again.'
      WHERE state IN ('queued','scanning','searching','ranking');`);
  let active, running, stopped = false, catalogueLane = Promise.resolve();
  const catalogueCache = new Map(), checkpoints = new Map();
  const rowFor = (visitor) => db.prepare('SELECT * FROM discoveries WHERE owner=?').get(ownerOf(visitor));
  const prune = () => db.prepare('DELETE FROM discoveries WHERE expires<=?').run(Date.now());
  function booksFor(visitor) {
    const snapshot = library.snapshot(visitor), categories = new Map(snapshot.categories.map((item) => [item.id, item.name]));
    const books = snapshot.books.filter((book) => book.id !== 'sample' || snapshot.books.length === 1);
    return books.map((book) => ({ id: book.id, title: clean(book.title, 180), author: clean(book.author, 140),
      language: baseLanguage(book.language), category: clean(categories.get(book.categoryId), 80), read: Boolean(book.readAt), addedAt: book.addedAt || 0 }));
  }
  function preferences(body, books) {
    const raw = clean(body.language, 35);
    if (raw && !normalizeLanguage(raw)) throw new RequestError(422, 'Choose a valid book language.');
    const languages = new Map();
    for (const book of books) languages.set(book.language, (languages.get(book.language) || 0) + 1);
    return { language: raw ? baseLanguage(raw) : [...languages].sort((a, b) => b[1] - a[1])[0]?.[0] || 'en', focus: clean(body.focus, 300) };
  }
  function signature(books, input) {
    const model = ai.settings();
    return createHash('sha256').update(JSON.stringify([books, input.language, input.focus, model.provider, model.model])).digest('hex');
  }
  function status(visitor) {
    prune(); const row = rowFor(visitor), books = booksFor(visitor), config = ai.settings();
    const result = row?.result ? JSON.parse(row.result) : null;
    if (result) { const owned = new Set(books.map((book) => titleKey(book.title))); result.books = result.books.filter((book) => !owned.has(titleKey(book.title))); }
    const input = row ? JSON.parse(row.request) : {};
    return { state: row?.state || 'idle', id: row?.id || null, error: row?.error || null, result, libraryCount: books.length,
      language: input.language || preferences({}, books).language, focus: input.focus || '', model: config.model, provider: config.provider,
      stale: Boolean(row && (row.signature !== signature(books, input) || Date.now() - row.created > 86400000)),
      demo, busy: busy(row?.state) };
  }
  function queue(body, visitor) {
    prune();
    const books = booksFor(visitor);
    if (!books.length) throw new RequestError(422, 'Add a book to your library before requesting recommendations.');
    const input = preferences(body, books), saved = rowFor(visitor), digest = signature(books, input);
    if (busy(saved?.state)) return status(visitor);
    if (ai.reuseEnabled?.() !== false && !body.refresh && saved?.state === 'ready' && saved.signature === digest && Date.now() - saved.created < 86400000) return status(visitor);
    if (db.prepare("SELECT count(*) AS n FROM discoveries WHERE state IN ('queued','scanning','searching','ranking')").get().n >= 12)
      throw new RequestError(503, 'Book discovery is busy. Try again shortly.');
    const config = ai.settings();
    db.prepare(`INSERT INTO discoveries VALUES(?,?,'queued',?,?,NULL,NULL,?,?) ON CONFLICT(owner)
      DO UPDATE SET id=excluded.id,state=excluded.state,signature=excluded.signature,request=excluded.request,result=NULL,error=NULL,created=excluded.created,expires=excluded.expires`)
      .run(ownerOf(visitor), randomUUID(), digest, JSON.stringify({ ...input, model: config.model, provider: config.provider }), Date.now(), visitor?.expires ?? null);
    void pump(); return status(visitor);
  }
  function cancel(visitor) {
    const row = rowFor(visitor);
    if (row && busy(row.state)) {
      db.prepare("UPDATE discoveries SET state='cancelled',error=NULL WHERE owner=? AND id=?").run(row.owner, row.id);
      checkpoints.delete(row.id);
      if (active?.id === row.id) active.control.abort();
    }
    return status(visitor);
  }
  async function catalogue(query, signal) {
    const cached = catalogueCache.get(query);
    if (cached?.expires > Date.now()) return cached.docs;
    const pending = catalogueLane.then(async () => {
      signal.throwIfAborted();
      await waitForOpenLibrary(signal, catalogueDelay);
      const url = new URL('https://openlibrary.org/search.json');
      url.searchParams.set('q', query); url.searchParams.set('limit', '24');
      url.searchParams.set('fields', 'key,title,author_name,first_publish_year,language,subject');
      const response = await fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': 'Langy-Reader/0.1 (https://github.com/Attach7830/Langy-Reader)' },
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      const data = await searchJson(response), docs = Array.isArray(data.docs) ? data.docs : [];
      catalogueCache.set(query, { expires: Date.now() + 86400000, docs });
      if (catalogueCache.size > 100) catalogueCache.delete(catalogueCache.keys().next().value);
      return docs;
    });
    catalogueLane = pending.catch(() => {}); return pending;
  }
  async function generate(row, signal) {
    const saved = checkpoints.get(row.id) || {};
    const yieldIfNeeded = () => {
      signal.throwIfAborted();
      if (!scheduler?.shouldYield()) return false;
      checkpoints.set(row.id, saved);
      db.prepare("UPDATE discoveries SET state='queued' WHERE owner=? AND id=? AND state!='cancelled'").run(row.owner, row.id);
      return true;
    };
    const input = JSON.parse(row.request);
    const visitor = visitorForOwner(row.owner, row.expires);
    const all = booksFor(visitor), ordered = [...all].sort((a, b) => Number(b.read) - Number(a.read) || b.addedAt - a.addedAt);
    const sample = ordered.length <= 40 ? ordered : [...ordered.slice(0, 20), ...Array.from({ length: 20 }, (_, n) => ordered[20 + Math.floor(n * (ordered.length - 20) / 20)])];
    const selected = boundedRows(sample, 14000);
    const current = () => !stopped && db.prepare('SELECT 1 FROM discoveries WHERE owner=? AND id=? AND state!=?').get(row.owner, row.id, 'cancelled');
    const stage = (state) => { signal.throwIfAborted(); if (!current()) throw new DOMException('Cancelled', 'AbortError'); db.prepare('UPDATE discoveries SET state=? WHERE owner=? AND id=?').run(state, row.owner, row.id); };
    const modelUnchanged = () => { const config = ai.settings(); if (config.model !== input.model || config.provider !== input.provider) throw new RequestError(409, 'The AI model changed. Request fresh recommendations.'); };
    stage('scanning'); modelUnchanged();
    const plan = saved.plan ||= await ai.discoveryPlan({ library: selected, requestedLanguage: input.language, focus: input.focus, totalBooks: all.length }, signal);
    if (yieldIfNeeded()) return PROCESS_YIELD;
    const queries = [...new Set((Array.isArray(plan.queries) ? plan.queries : []).map((value) => clean(value, 300)).filter(Boolean))].slice(0, 3);
    const catalogueQueries = [...new Set((Array.isArray(plan.catalogueQueries) ? plan.catalogueQueries : []).map((value) => clean(value, 250)).filter(Boolean))].slice(0, 2);
    const leads = (Array.isArray(plan.candidates) ? plan.candidates : []).filter((item) => clean(item?.title, 180) && clean(item?.author, 140)).slice(0, 8);
    if (!queries.length || !catalogueQueries.length) throw new RequestError(502, 'The model did not provide useful book searches. Try again.');
    stage('searching');
    const warnings = [], webResults = [], seenLinks = new Set();
    const searches = saved.searches ||= await Promise.allSettled(queries.map((query) => webSearch(query, signal)));
    if (yieldIfNeeded()) return PROCESS_YIELD;
    for (const result of searches) if (result.status === 'fulfilled') for (const item of result.value) if (!seenLinks.has(item.url)) { seenLinks.add(item.url); webResults.push({ ...item, id: `web-${webResults.length + 1}` }); }
    if (!webResults.length) warnings.push('General web search returned no usable results. These recommendations use Open Library catalogue records only. Check that the search service is running with JSON enabled.');
    const code = languageCodes[input.language], languageFilter = code ? ` AND language:${code}` : '';
    const batch = leads.map((item) => `(title:${quote(clean(item.title, 180))} AND author:${quote(clean(item.author, 140))})`).join(' OR ');
    const lookups = [...(batch ? ['(' + batch + ')' + languageFilter] : []), ...catalogueQueries.map((query) => '(' + query + ')' + languageFilter)];
    const catalogues = saved.catalogues ||= await Promise.allSettled(lookups.map((query) => catalogue(query, signal)));
    signal.throwIfAborted();
    if (yieldIfNeeded()) return PROCESS_YIELD;
    const owned = new Set(booksFor(visitor).map((book) => titleKey(book.title))), candidates = new Map(), identities = new Set();
    for (const result of catalogues) if (result.status === 'fulfilled') for (const item of result.value) {
      const title = clean(item.title, 250), authors = (Array.isArray(item.author_name) ? item.author_name : []).map((author) => clean(author, 160)).filter(Boolean).slice(0, 3);
      const languages = [...new Set((Array.isArray(item.language) ? item.language : []).map((code) => baseLanguage(code, '')).filter(Boolean))];
      const key = titleKey(title) + ':' + titleKey(authors.join(' '));
      if (!/^\/works\/OL\d+W$/u.test(item.key) || !title || !authors.length || owned.has(titleKey(title)) || !languages.includes(input.language) || identities.has(key)) continue;
      identities.add(key); candidates.set(item.key, { id: item.key, title, authors, languages, url: 'https://openlibrary.org' + item.key,
        year: Number.isInteger(item.first_publish_year) ? item.first_publish_year : null,
        subjects: (Array.isArray(item.subject) ? item.subject : []).slice(0, 6).map((subject) => clean(subject, 70)) });
    }
    if (!candidates.size) throw new RequestError(503, 'No new books could be verified in the requested language. Try a different focus or language, or retry when catalogue search is available.');
    stage('ranking'); modelUnchanged();
    const offered = boundedRows([...candidates.values()].slice(0, 24).map(({ id, title, authors, languages, year, subjects }) =>
      ({ id, title: title.slice(0, 180), authors: authors.slice(0, 2), languages: languages.slice(0, 8), year, subjects: subjects.slice(0, 3) })), 7500);
    const allowed = new Set(offered.map((item) => item.id)), rankLibrary = boundedRows(selected.slice(0, 16), 3000);
    const answer = await ai.discoveryRecommendations({ library: rankLibrary, requestedLanguage: input.language, focus: input.focus,
      interests: clean(plan.text, 400), candidates: offered,
      webResults: boundedRows(webResults.slice(0, 8).map(({ id, title, snippet }) => ({ id, title: title.slice(0, 120), snippet: snippet.slice(0, 220) })), 2500) }, signal);
    modelUnchanged(); signal.throwIfAborted();
    const libraryBooks = new Map(rankLibrary.map((book) => [book.id, book])), seen = new Set(), recommendations = [];
    const ownedNow = new Set(booksFor(visitor).map((book) => titleKey(book.title)));
    for (const suggestion of Array.isArray(answer.recommendations) ? answer.recommendations : []) {
      const book = candidates.get(suggestion?.id), reason = clean(suggestion?.reason, 600);
      const basedOn = [...new Set(Array.isArray(suggestion?.basedOn) ? suggestion.basedOn : [])].filter((id) => libraryBooks.has(id)).slice(0, 3).map((id) => ({ id, title: libraryBooks.get(id).title }));
      if (!book || !allowed.has(book.id) || seen.has(book.id) || ownedNow.has(titleKey(book.title)) || !reason || !basedOn.length) continue;
      seen.add(book.id);
      const sourceIds = new Set(Array.isArray(suggestion.sourceIds) ? suggestion.sourceIds : []);
      const sources = webResults.filter((item) => sourceIds.has(item.id) && titleKey(item.title + item.snippet).includes(titleKey(book.title))).slice(0, 2).map(({ title, url }) => ({ title, url }));
      recommendations.push({ ...book, reason, basedOn, sources: [{ title: 'Open Library record', url: book.url }, ...sources] });
      if (recommendations.length === 6) break;
    }
    if (!recommendations.length) throw new RequestError(502, 'The model did not select verified books with a connection to your library. Try again.');
    if (!current()) return;
    const result = { text: clean(answer.text, 700), interests: clean(plan.text, 600), books: recommendations, queries, warnings,
      scannedBooks: all.length, sampledBooks: selected.length, language: input.language, model: input.model, provider: input.provider, generatedAt: Date.now(), webSourceCount: webResults.length };
    db.prepare("UPDATE discoveries SET state='ready',result=?,error=NULL WHERE owner=? AND id=?").run(JSON.stringify(result), row.owner, row.id);
  }
  function pump() {
    if (running || stopped) return running;
    prune();
    running = consumeProcesses(scheduler, () => stopped ? [] : db.prepare("SELECT * FROM discoveries WHERE state='queued' ORDER BY created").all()
      .map((row) => ({ id: `discovery:${row.id}`, created: row.created, data: row })), async (row) => {
      active = { id: row.id, control: new AbortController() };
      const signal = AbortSignal.any([active.control.signal, AbortSignal.timeout(timeoutMs)]);
      try { return await abortable(() => withAI(visitorForOwner(row.owner, row.expires), () => generate(row, signal)), signal); }
      catch (error) {
        if (stopped || active?.control.signal.aborted) return;
        const message = error instanceof RequestError ? error.message : error.name === 'TimeoutError' ? 'Book discovery timed out. Retry or choose a faster local model.' : 'Book discovery failed. Check the AI connection and search service, then retry.';
        db.prepare("UPDATE discoveries SET state='error',error=? WHERE owner=? AND id=? AND state!='cancelled'").run(message, row.owner, row.id);
      } finally {
        if (db.prepare('SELECT state FROM discoveries WHERE owner=? AND id=?').get(row.owner, row.id)?.state !== 'queued') checkpoints.delete(row.id);
        active = undefined;
      }
    }).finally(() => { running = undefined; });
    return running;
  }
  const timer = setInterval(() => void pump(), 1000); timer.unref();
  return { status, queue, cancel, pump,
    async close() { if (stopped) return; stopped = true; clearInterval(timer); active?.control.abort(); await running; db.close(); },
  };
}
