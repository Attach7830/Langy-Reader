import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { openLibrary } from '../server/books.js';
import { openLearning } from '../server/learning.js';
import { textWords } from '../shared/reading-text.js';

async function until(check) {
  for (let n = 0; n < 500; n++) { const value = check(); if (value) return value; await delay(10); }
  throw new Error('Text counting timed out');
}

async function fixture(t, { failed = false, scanned = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-text-counts-')), zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
  zip.file('book.opf', `<package><metadata><title>Illustrated story</title><language>es</language></metadata><manifest>
    <item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="page" href="image.xhtml" media-type="application/xhtml+xml"/>
    <item id="image" href="picture.png" media-type="image/png"/>
    <item id="end" href="end.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine><itemref idref="c"/><itemref idref="page"/><itemref idref="image"/><itemref idref="end"/></spine></package>`);
  zip.file('chapter.xhtml', `<html><body>${scanned ? '' : '<p>Ana leyó dos libros 2026.</p>'}<img src="picture.png" alt="Not readable story text"/>${scanned ? '' : '<p>Después descansó.</p>'}</body></html>`);
  zip.file('image.xhtml', '<html><body><img src="picture.png" alt="A whole image-only page"/></body></html>');
  zip.file('picture.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]));
  zip.file('end.xhtml', `<html><body>${scanned ? '<img src="picture.png"/>' : '<p>Fin del relato.</p>'}</body></html>`);
  const library = await openLibrary(dir), bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const path = join(library.uploads, 'illustrated.epub'); await writeFile(path, bytes);
  await library.importBook('illustrated', { path, originalname: 'illustrated.epub', size: bytes.length }, {});
  const previousFetch = globalThis.fetch;
  let available = false, calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    if (!available) throw new TypeError('NLP is offline');
    assert.equal(new URL(url).pathname, '/analyze');
    const { text, language } = JSON.parse(options.body);
    const tokens = textWords(text, language).map((word) => ({ ...word, lemma: word.word.toLowerCase(), properName: false }));
    return Response.json({ tokens, lemmas: [...new Set(tokens.map((token) => token.lemma))], method: 'contextual' });
  };
  const learning = await openLearning(dir, library, false, { async readingLevel() { return { band: 'Intermediate', text: 'Test estimate.' }; } });
  const db = new DatabaseSync(join(dir, 'learning.sqlite'));
  if (failed) db.prepare(`INSERT INTO analyses(book,owner,language,languageSelection,state,error)
    VALUES('illustrated','','es','["es"]','error','Previous analysis failed')`).run();
  t.after(async () => {
    await learning.remove('illustrated'); await learning.remove('sample');
    globalThis.fetch = previousFetch; db.close(); await rm(dir, { recursive: true, force: true });
  });
  return { dir, library, learning, db, bytes, book: library.getBook('illustrated'), calls: () => calls, connect: () => { available = true; } };
}

test('EPUB word counts and reading totals recover an existing NLP error, skip image sections, and replay exposures after successful analysis', async (t) => {
  const f = await fixture(t, { failed: true });
  f.library.setReadStatus(f.book.id, { read: true });
  assert.equal(f.learning.vocabulary.profile().reading.pendingBooks, 1);
  const result = await until(() => { const info = f.learning.info(f.book); return info.counts && info; });
  assert.equal(result.state, 'error', 'lemma failure does not need to be cleared before counting text');
  assert.equal(result.counting.state, 'ready'); assert.deepEqual(result.counts, { words: 10, characters: 0 });
  assert.equal(f.calls(), 0, 'recovering an EPUB count does not call NLP or AI');
  assert.deepEqual(f.learning.chapters(f.book).chapters.map(({ key, characters }) => [key, characters > 0]),
    [['epub:0', true], ['epub:1', false], ['epub:2', false], ['epub:3', true]], 'image sections retain their spine positions');
  const section = f.learning.vocabulary.section(f.book, 'epub:0');
  assert.equal(section.textReady, true); assert.equal(section.analysisState, 'error');
  f.learning.vocabulary.record(f.book, { key: section.key, digest: section.textHash, session: 'read-once', ranges: [{ from: 0, to: 8 }] });
  let reading = f.learning.vocabulary.profile().reading;
  assert.equal(reading.words, 10); assert.equal(reading.trackedWords, 2); assert.equal(reading.completedWords, 8); assert.equal(reading.pendingBooks, 0);
  assert.equal(f.learning.vocabulary.catalogue().total, 0, 'surface counts do not invent lemma entries');
  f.library.setReadStatus(f.book.id, { read: false });
  assert.equal(f.learning.vocabulary.profile().reading.words, 2);
  const persisted = new DatabaseSync(join(f.dir, 'learning.sqlite'));
  assert.equal(persisted.prepare('SELECT words FROM reading_book_counts WHERE book=?').get(f.book.id).words, 10); persisted.close();
  f.connect(); f.learning.ensure(f.book, true);
  await until(() => f.learning.info(f.book).state === 'ready');
  assert.equal(f.learning.vocabulary.profile().reading.words, 2, 'NLP recovery does not count tracked words twice');
  assert.equal(f.learning.vocabulary.catalogue().total, 2, 'saved reading ranges enter the lemma catalogue once NLP is available');
  assert.deepEqual(await readFile(f.library.filePath(f.book)), f.bytes);
});

test('a fresh illustrated EPUB has a count even when its first NLP request fails', async (t) => {
  const f = await fixture(t);
  const result = await until(() => { const info = f.learning.info(f.book); return info.state === 'error' && info; });
  assert.deepEqual(result.counts, { words: 10, characters: 0 }); assert.equal(result.counting.state, 'ready');
  assert.equal(f.calls(), 1);
});

test('image-only EPUB sections count zero selectable words without parsing binary image data as XML', async (t) => {
  const f = await fixture(t, { scanned: true });
  const result = await until(() => { const info = f.learning.info(f.book); return info.state === 'ready' && info; });
  assert.deepEqual(result.counts, { words: 0, characters: 0 }); assert.equal(f.calls(), 0);
});
