import { randomUUID } from 'node:crypto';
import { bookLanguages, languageSpans } from '../shared/language.js';
import { validPdfBoxes } from '../shared/pdf-regions.js';
import { RequestError } from './books.js';

const empty = { excluded: [], edits: {}, boxes: {} };
const contentRevision = (book) => book.contentRevision || '';
const hasText = (text) => /[\p{L}\p{N}]/u.test(text);

export function pdfTranscripts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pdf_transcripts (
    book TEXT PRIMARY KEY REFERENCES analyses(book) ON DELETE CASCADE,
    sourceRevision TEXT NOT NULL, revision TEXT NOT NULL, draft TEXT NOT NULL, textRevision TEXT NOT NULL
  ) STRICT`);
  if (!db.prepare('PRAGMA table_info(pdf_transcripts)').all().some(({ name }) => name === 'textRevision')) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE pdf_transcripts ADD COLUMN textRevision TEXT NOT NULL DEFAULT '';
      UPDATE pdf_transcripts SET textRevision=revision;
      COMMIT;`);
  }
  if (!db.prepare('PRAGMA table_info(chapters)').all().some(({ name }) => name === 'pdfSourceText')) {
    db.exec('ALTER TABLE chapters ADD COLUMN pdfSourceText TEXT');
  }
  const find = db.prepare('SELECT revision,textRevision,draft FROM pdf_transcripts WHERE book=? AND sourceRevision=?');
  const findRevision = db.prepare('SELECT revision,textRevision FROM pdf_transcripts WHERE book=? AND sourceRevision=?');
  const current = (book) => find.get(book.id, contentRevision(book));
  const read = (row) => row ? { ...empty, ...JSON.parse(row.draft) } : empty;
  function revision(book, field = 'revision') {
    const source = contentRevision(book);
    const row = book.format === 'pdf' && findRevision.get(book.id, source);
    return row?.[field] ? `pdf-review:${JSON.stringify([source, row[field]])}` : source;
  }

  const pageCount = db.prepare('SELECT count(*) AS total FROM chapters WHERE book=?');
  const pageText = db.prepare('SELECT COALESCE(pdfSourceText,text) AS original FROM chapters WHERE book=? AND key=?');
  function page(book, number) {
    const total = pageCount.get(book.id).total, review = read(current(book));
    if (!Number.isSafeInteger(number) || number < 1 || number > total) throw new RequestError(422, `Choose a PDF page from 1 to ${total}.`);
    const { original } = pageText.get(book.id, `pdf:${number}`);
    return { state: 'ready', revision: revision(book), sourceRevision: contentRevision(book), total, excluded: review.excluded,
      page: { number, original, text: review.edits[number] ?? original, boxes: review.boxes[number] || [] } };
  }

  function save(book, body, invalidate) {
    if (body.revision !== revision(book)) throw new RequestError(409, 'This PDF or its reviewed text changed. Reopen the editor before saving.');
    const stored = current(book), before = read(stored), total = pageCount.get(book.id).total;
    const validPage = (number) => Number.isSafeInteger(number) && number > 0 && number <= total;
    const boxEdits = body.boxes === undefined ? [] : body.boxes;
    if (!Array.isArray(body.excluded) || body.excluded.length > total || !body.excluded.every(validPage)
      || !Array.isArray(body.edits) || body.edits.length > total || !Array.isArray(boxEdits) || boxEdits.length > total) {
      throw new RequestError(422, 'Choose valid PDF page numbers.');
    }
    const next = { excluded: [...new Set(body.excluded)].sort((a, b) => a - b), edits: { ...before.edits }, boxes: { ...before.boxes } };
    const changedPages = new Set();
    for (const edit of body.edits) {
      if (!validPage(edit?.page) || changedPages.has(edit.page) || typeof edit.text !== 'string') throw new RequestError(422, 'Provide one text edit per PDF page.');
      const { original } = pageText.get(book.id, `pdf:${edit.page}`);
      const text = edit.text.replace(/\r\n?/gu, '\n').trim();
      if (text === original) delete next.edits[edit.page];
      else next.edits[edit.page] = text;
      changedPages.add(edit.page);
    }
    changedPages.clear();
    for (const edit of boxEdits) {
      if (!validPage(edit?.page) || changedPages.has(edit.page) || !validPdfBoxes(edit.boxes)) {
        throw new RequestError(422, 'Draw valid boxes inside each PDF page.');
      }
      if (edit.boxes.length) next.boxes[edit.page] = edit.boxes;
      else delete next.boxes[edit.page];
      changedPages.add(edit.page);
    }
    const draft = JSON.stringify(next);
    if (draft === JSON.stringify(before)) return false;
    const textChanged = JSON.stringify([next.excluded, next.edits]) !== JSON.stringify([before.excluded, before.edits]);
    if (textChanged) {
      const excluded = new Set(next.excluded);
      const readable = db.prepare('SELECT ordinal+1 AS page,COALESCE(pdfSourceText,text) AS original FROM chapters WHERE book=? ORDER BY ordinal').iterate(book.id);
      let hasIncludedText = false;
      for (const { page, original } of readable) {
        if (!excluded.has(page) && hasText(next.edits[page] ?? original)) { hasIncludedText = true; break; }
      }
      if (!hasIncludedText) throw new RequestError(422, 'Keep at least one PDF page with readable text.');
    }

    const updated = randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO pdf_transcripts(book,sourceRevision,revision,draft,textRevision) VALUES(?,?,?,?,?) ON CONFLICT(book) DO UPDATE SET
        sourceRevision=excluded.sourceRevision,revision=excluded.revision,draft=excluded.draft,textRevision=excluded.textRevision`)
        .run(book.id, contentRevision(book), updated, draft, textChanged ? updated : stored?.textRevision || '');
      if (textChanged) invalidate();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return true;
  }

  function apply(book, sections) {
    const saved = book.format === 'pdf' && current(book);
    if (!saved) return sections;
    const { excluded, edits } = read(saved), skipped = new Set(excluded), languages = bookLanguages(book);
    return sections.map((section) => {
      const page = Number(section.key.slice(4));
      const text = skipped.has(page) ? '' : edits[page] ?? section.text;
      if (text === section.text) return section;
      return { ...section, text, pdfSourceText: section.text, languages: text ? languageSpans({ text, runs: [{ start: 0, end: text.length, node: null }] }, book.language, languages) : [] };
    });
  }

  return { revision, textRevision: (book) => revision(book, 'textRevision'), page, save, apply };
}
