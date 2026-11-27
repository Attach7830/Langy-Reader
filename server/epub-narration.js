import { createHash, randomUUID } from 'node:crypto';
import { textWords } from '../shared/reading-text.js';
import { RequestError } from './books.js';

const empty = { start: null, end: null, exclusions: [] };
const hasSelection = ({ start, end, exclusions }) => Boolean(start || end || exclusions.length);
const sourceOf = (sections) => createHash('sha256').update(JSON.stringify(sections.map(({ key, digest }) => [key, digest]))).digest('hex');
export function includesWord(ranges, word) {
  if (ranges == null) return true;
  let low = 0, high = ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ranges[middle][0] <= word.from) low = middle + 1; else high = middle;
  }
  return low > 0 && word.to <= ranges[low - 1][1];
}

function keptRanges(text, start, end, exclusions) {
  const ranges = [];
  let next = start;
  for (const { from, to } of exclusions) {
    if (from >= end) break;
    if (to <= next) continue;
    if (from > next) ranges.push([next, from]);
    next = Math.max(next, to);
  }
  if (next < end) ranges.push([next, end]);
  return ranges.filter(([from, to]) => /[\p{L}\p{N}]/u.test(text.slice(from, to)));
}

export function epubNarration(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS epub_narration (
    book TEXT PRIMARY KEY REFERENCES analyses(book) ON DELETE CASCADE,
    source TEXT NOT NULL, revision TEXT NOT NULL, selection TEXT NOT NULL
  ) STRICT`);
  const stored = db.prepare('SELECT source,revision,selection FROM epub_narration WHERE book=?');
  const text = db.prepare('SELECT text FROM chapters WHERE book=? AND key=?');
  const chapters = (book) => db.prepare('SELECT key,title,digest,has_spoken_text(text) AS narratable FROM chapters WHERE book=? ORDER BY ordinal').all(book.id);
  const revision = (source, row) => `${source}:${row?.revision || ''}`;

  function get(book, key) {
    const sections = chapters(book), row = stored.get(book.id), source = sourceOf(sections);
    const current = key === undefined ? sections.find((section) => section.narratable) || sections[0] : sections.find((section) => section.key === key);
    if (!current) throw new RequestError(422, 'Choose a readable section of this EPUB.');
    const outdated = Boolean(row && row.source !== source && hasSelection(JSON.parse(row.selection)));
    const { start, end, exclusions } = row?.source === source ? JSON.parse(row.selection) : empty;
    const content = new Map();
    const read = (key) => {
      if (!content.has(key)) content.set(key, text.get(book.id, key).text);
      return content.get(key);
    };
    return {
      state: 'ready', revision: revision(source, row), outdated,
      selection: {
        start: start && { ...start, preview: read(start.key).slice(start.offset, start.offset + 100).trim() },
        end: end && { ...end, preview: read(end.key).slice(Math.max(0, end.offset - 100), end.offset).trim() },
        exclusions: exclusions.map((range) => ({ ...range, preview: read(range.key).slice(range.from, Math.min(range.to, range.from + 140)).trim() })),
      },
      sections: sections.map(({ key, title }) => ({ key, title })),
      section: { key: current.key, text: read(current.key) },
    };
  }

  function plan(book, sections, selection) {
    const start = selection.start ? sections.findIndex(({ key }) => key === selection.start.key) : 0;
    const end = selection.end ? sections.findIndex(({ key }) => key === selection.end.key) : sections.length - 1;
    const exclusions = Map.groupBy(selection.exclusions, ({ key }) => key);
    const included = new Map();
    for (let index = start; index <= end; index++) {
      const section = sections[index];
      if (!section.narratable) continue;
      const first = selection.start?.key === section.key ? selection.start.offset : 0;
      const last = selection.end?.key === section.key ? selection.end.offset : null;
      const cuts = exclusions.get(section.key) || [];
      if (!first && last == null && !cuts.length) { included.set(section.key, null); continue; }
      const value = text.get(book.id, section.key).text;
      const ranges = keptRanges(value, first, last ?? value.length, cuts);
      if (ranges.length) included.set(section.key, ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === value.length ? null : ranges);
    }
    return included;
  }

  function normalize(book, sections, body) {
    if (!body || !Array.isArray(body.exclusions)) throw new RequestError(422, 'Choose valid audiobook boundaries and exclusions.');
    const byKey = new Map(sections.map(({ key }, index) => [key, index])), cache = new Map();
    function offset(key, value, end) {
      if (!byKey.has(key) || !Number.isSafeInteger(value) || value < 0) throw new RequestError(422, 'Choose a valid location in the EPUB.');
      if (!cache.has(key)) {
        const { text: source } = text.get(book.id, key);
        cache.set(key, { source, words: textWords(source, book.language) });
      }
      const { source, words } = cache.get(key);
      if (value > source.length) throw new RequestError(422, 'Choose a valid location in the EPUB.');
      let low = 0, high = words.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (words[middle].from < value) low = middle + 1; else high = middle;
      }
      const word = words[low - 1];
      if (word && word.to > value) return end ? word.to : word.from;
      return /[\uDC00-\uDFFF]/u.test(source[value] || '') ? value + (end ? 1 : -1) : value;
    }
    const point = (value, end) => value === null ? null : { key: value?.key, offset: offset(value?.key, value?.offset, end) };
    const start = point(body.start, false), end = point(body.end, true);
    if (start && end && (byKey.get(start.key) > byKey.get(end.key) || start.key === end.key && start.offset >= end.offset)) {
      throw new RequestError(422, 'Set the audiobook start before its end.');
    }
    const cuts = body.exclusions.map((entry) => {
      const { key, from, to } = entry || {};
      if (!(from < to)) throw new RequestError(422, 'Select some text to exclude.');
      return { key, from: offset(key, from, false), to: offset(key, to, true) };
    }).sort((a, b) => byKey.get(a.key) - byKey.get(b.key) || a.from - b.from);
    const exclusions = [];
    for (const cut of cuts) {
      const previous = exclusions.at(-1);
      if (previous?.key === cut.key && cut.from <= previous.to) previous.to = Math.max(previous.to, cut.to);
      else exclusions.push(cut);
    }
    return { start, end, exclusions };
  }

  return {
    get,
    save(book, body) {
      const sections = chapters(book), row = stored.get(book.id), source = sourceOf(sections);
      if (body?.revision !== revision(source, row)) throw new RequestError(409, 'This EPUB or its audiobook settings changed. Reopen the editor.');
      const selection = normalize(book, sections, body);
      if (!plan(book, sections, selection).size) throw new RequestError(422, 'Keep some readable text in the audiobook.');
      const value = JSON.stringify(selection);
      if (row?.source !== source || row.selection !== value) {
        db.prepare(`INSERT INTO epub_narration(book,source,revision,selection) VALUES(?,?,?,?) ON CONFLICT(book) DO UPDATE SET
          source=excluded.source,revision=excluded.revision,selection=excluded.selection`).run(book.id, source, randomUUID(), value);
      }
      return get(book);
    },
    forBook(book, sections) {
      const row = book.format === 'epub' && stored.get(book.id);
      if (!row) return null;
      const selection = JSON.parse(row.selection);
      if (!hasSelection(selection)) return null;
      if (row.source !== sourceOf(sections)) throw new RequestError(409, 'The EPUB text changed. Review the audiobook boundaries before generating again.');
      return { key: row.selection, included: plan(book, sections, selection) };
    },
  };
}
