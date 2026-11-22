import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('saved book languages override incorrect tags, rebuild existing analysis and reclassify seen terms without reupload', async (t) => {
  const f = await fixture(t);
  const original = await f.ready();
  assert.deepEqual(original.vocabulary.languages.sort(), ['de', 'jv', 'zh']);
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
