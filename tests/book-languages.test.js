import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { openLibrary } from '../server/books.js';
import { openLearning } from '../server/learning.js';
import { textWords } from '../shared/reading-text.js';
import { hanPattern } from '../shared/language.js';

async function until(check) { for (let n = 0; n < 500; n++) { const value = check(); if (value) return value; await delay(20); } throw new Error('Analysis timed out'); }
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'langy-book-languages-')), zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
  zip.file('book.opf', '<package><metadata><language>zh</language></metadata><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>');
  zip.file('chapter.xhtml', '<html lang="zh"><body><p>我喜欢读中文。</p><p lang="de">The people were reading books in the library during the afternoon.</p><p lang="jv">This short English note has an incorrect language tag.</p></body></html>');
  const library = await openLibrary(dir), bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const path = join(library.uploads, 'test.epub'); await writeFile(path, bytes);
  await library.importBook('mixed', { path, originalname: 'mixed.epub', size: bytes.length }, { title: 'Mixed', language: 'zh' });
  const previous = globalThis.fetch, calls = [];
  let hold, paused;
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/analyze');
    const body = JSON.parse(options.body); calls.push(body.language);
    if (hold) { paused = hold; hold = null; await paused.promise; }
    const words = body.language === 'zh' ? [...body.text.matchAll(new RegExp(hanPattern, 'gu'))].map((match) => ({ word: match[0], from: match.index, to: match.index + match[0].length })) : textWords(body.text, body.language);
    const tokens = words.map((word) => ({ ...word, lemma: word.word.toLowerCase(), properName: false }));
    return Response.json({ tokens, lemmas: [...new Set(tokens.map((token) => token.lemma))], method: body.language === 'zh' ? 'characters' : 'contextual' });
  };
  const learning = await openLearning(dir, library, false, { async readingLevel() { return { band: 'Intermediate', text: 'Sample estimate.' }; } });
  t.after(async () => { if (paused) paused.resolve(); globalThis.fetch = previous; await learning.remove('mixed'); await learning.remove('sample'); await rm(dir, { recursive: true, force: true }); });
  return { dir, library, learning, calls, bytes,
    ready: () => until(() => { const state = learning.info(library.getBook('mixed')); if (state.state === 'error') throw new Error(state.error); return state.state === 'ready' && state; }),
    pause() { let resolve; const promise = new Promise((done) => { resolve = done; }); hold = { promise, resolve }; return { release: resolve, started: () => until(() => paused != null) }; },
  };
}

test('books default to one primary language; explicit multilingual selection rebuilds analysis and seen terms without reupload', async (t) => {
  const f = await fixture(t);
  const original = await f.ready();
  assert.ok(original.counts.words > 0); assert.equal(original.counts.characters, 6);
  assert.deepEqual(original.vocabulary.languages, ['zh']);
  assert.ok(f.calls.every((language) => language === 'zh'), 'incorrect EPUB tags cannot enable extra languages by default');
  const unit = f.learning.unit(f.library.getBook('mixed'), 'epub:0');
  f.learning.vocabulary.record(f.library.getBook('mixed'), { key: unit.key, digest: unit.textHash, ranges: [{ from: 0, to: unit.text.length }] });
  const updated = f.library.editBook('mixed', { title: 'Mixed', language: 'zh', languages: '["zh","en"]' });
  assert.deepEqual(updated.languages, ['zh', 'en']);
  f.calls.length = 0; f.learning.ensure(f.library.getBook('mixed'));
  assert.equal(f.learning.info(f.library.getBook('mixed')).vocabulary, null, 'stale totals disappear while analysis runs');
  const result = await f.ready();
  assert.deepEqual(result.vocabulary.languages.sort(), ['en', 'zh']);
  assert.deepEqual([...new Set(f.calls)].sort(), ['en', 'zh']);
  assert.deepEqual(f.learning.vocabulary.catalogue().byLanguage.map((item) => item.language).sort(), ['en', 'zh']);
  assert.deepEqual(await readFile(f.library.filePath(f.library.getBook('mixed'))), f.bytes);
  assert.deepEqual((await openLibrary(f.dir)).snapshot().books.find((book) => book.id === 'mixed')?.languages, ['zh', 'en']);
  assert.throws(() => f.library.editBook('mixed', { title: 'Mixed', language: 'zh', languages: '["not a language"]' }), { status: 422 });
  const preserved = f.library.editBook('mixed', { title: 'Renamed', language: 'zh' });
  assert.deepEqual(preserved.languages, ['zh', 'en']);
  const automatic = f.library.editBook('mixed', { title: 'Mixed', language: 'zh', languages: [] });
  assert.deepEqual(automatic.languages, []);
  f.calls.length = 0;
  f.learning.ensure(f.library.getBook('mixed'));
  assert.deepEqual((await f.ready()).vocabulary.languages, ['zh']);
  assert.ok(f.calls.every((language) => language === 'zh'));
  assert.deepEqual(f.learning.vocabulary.catalogue().byLanguage.map((item) => item.language), ['zh']);
});

test('a language change during an outstanding analysis cannot publish obsolete language totals', async (t) => {
  const f = await fixture(t), paused = f.pause();
  f.learning.ensure(f.library.getBook('mixed')); await paused.started();
  f.library.editBook('mixed', { title: 'Mixed', language: 'zh', languages: ['en', 'zh'] });
  f.learning.ensure(f.library.getBook('mixed')); paused.release();
  const result = await f.ready();
  assert.deepEqual(result.vocabulary.languages.sort(), ['en', 'zh']);
  assert.ok(f.learning.unit(f.library.getBook('mixed'), 'epub:0').tokens.every((token) => ['en', 'zh'].includes(token.language)));
});

test('an existing unrestricted analysis is refreshed automatically to the primary language', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const db = new DatabaseSync(join(f.dir, 'learning.sqlite')); t.after(() => db.close());
  db.prepare("UPDATE analyses SET languageSelection='[]' WHERE book='mixed'").run();
  f.calls.length = 0;
  const refreshing = f.learning.info(f.library.getBook('mixed'));
  assert.ok(['queued', 'running'].includes(refreshing.state)); assert.equal(refreshing.vocabulary, null);
  assert.deepEqual((await f.ready()).vocabulary.languages, ['zh']);
  assert.ok(f.calls.length > 0 && f.calls.every((language) => language === 'zh'));
  assert.equal(db.prepare("SELECT languageSelection FROM analyses WHERE book='mixed'").get().languageSelection, '["zh"]');
});

test('completed-book vocabulary follows actual book analysis and folder language changes without counting tracked passages twice', async (t) => {
  const f = await fixture(t), book = f.library.getBook('mixed');
  f.library.setReadStatus(book.id, { read: true });
  f.learning.ensure(book);
  assert.equal(f.learning.vocabulary.catalogue().total, 0, 'pending analysis keeps the completion for later');
  await f.ready();
  const before = f.learning.vocabulary.catalogue();
  assert.ok(before.total > 0);
  assert.deepEqual(before.byLanguage.map((row) => row.language), ['zh']);
  const unit = f.learning.unit(book, 'epub:0');
  f.learning.vocabulary.record(book, { key: unit.key, digest: unit.textHash, session: 'one-pass', ranges: [{ from: 0, to: unit.text.length }] });
  assert.deepEqual(f.learning.vocabulary.catalogue().entries.map(({ term, exposures }) => [term, exposures]), before.entries.map(({ term, exposures }) => [term, exposures]));
  assert.ok(f.learning.vocabulary.catalogue().entries.every((row) => row.completionExposures === 0));
  f.library.saveCategory('bilingual', { name: 'Bilingual', language: 'en' }, true);
  f.library.editBook(book.id, { title: book.title, language: 'zh', languages: ['zh', 'en'], categoryId: 'bilingual' });
  f.learning.ensure(f.library.getBook(book.id));
  await f.ready();
  assert.deepEqual(f.learning.vocabulary.catalogue().byLanguage.map((row) => row.language), ['en', 'zh']);
  assert.ok(f.learning.vocabulary.catalogue().entries.every((row) => row.completionExposures === 0), 'source ranges are reclassified with the completed-book contribution');
  f.library.setReadStatus(book.id, { read: false });
  assert.deepEqual(f.learning.vocabulary.catalogue().byLanguage.map((row) => row.language), ['en', 'zh'], 'tracked passages survive clearing the completion flag');
});
