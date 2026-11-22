import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { openLearning } from '../server/learning.js';
import { textWords } from '../shared/reading-text.js';
import { hanPattern } from '../shared/language.js';
const run = promisify(execFile);
async function until(check) { for (let i = 0; i < 600; i++) { const result = check(); if (result) return result; await delay(20); } throw new Error('Background job timed out'); }

test('a mixed book keeps Mandarin totals separate, categorizes with characters, routes speech voices, and synchronizes uploaded multilingual audio', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-mixed-book-'));
  const previousFetch = globalThis.fetch, previousURL = process.env.READER_KOKORO_URL;
  process.env.READER_KOKORO_URL = 'http://kokoro.test/v1';
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
  zip.file('book.opf', '<package><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>');
  zip.file('chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" lang="zh"><body><p>我喜欢读书。我在银行读中文。</p><p lang="en">People read books. They were reading books in the library.</p><p lang="pt-PT">As pessoas estavam lendo os livros da biblioteca durante toda a tarde.</p><p lang="es">Las personas leían libros en la biblioteca.</p></body></html>');
  const path = join(dir, 'mixed.epub'); await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
  const wav = join(dir, 'sample.wav');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', '-ar', '24000', wav]);
  const speech = await readFile(wav), analysisLanguages = [], voices = [], alignmentLanguages = [], transcriptionLanguages = [];
  let sample;
  const book = { id: 'mixed', title: 'Mixed book', language: 'zh' };
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body), path = new URL(url).pathname;
    if (path === '/analyze') {
      analysisLanguages.push(body.language);
      const source = body.language === 'zh'
        ? [...body.text.matchAll(new RegExp(hanPattern, 'gu'))].map((match) => ({ word: match[0], from: match.index, to: match.index + match[0].length }))
        : textWords(body.text, body.language).filter((word) => /\p{L}/u.test(word.word));
      const tokens = source.map((word) => ({ ...word, lemma: ({ livros: 'livro', pessoas: 'pessoa', estavam: 'estar', lendo: 'ler', libros: 'libro', personas: 'persona', leían: 'leer' })[word.word] || word.word.toLowerCase() }));
      return Response.json({ tokens, lemmas: [...new Set(tokens.map((word) => word.lemma))], method: body.language === 'zh' ? 'characters' : 'contextual' });
    }
    if (path === '/v1/audio/speech') { voices.push(body.voice); return new Response(speech); }
    if (path === '/align') {
      alignmentLanguages.push(body.language);
      return Response.json({ timings: body.words.map((_, index) => ({ start: index / body.words.length, end: (index + .8) / body.words.length })) });
    }
    if (path === '/transcribe') { transcriptionLanguages.push(body.language); return Response.json({ heard: [{ word: 'speech', start: 0, end: 1 }] }); }
    if (path === '/match-recording') return Response.json({ timings: body.words.map((_, index) => ({ start: index / body.words.length, end: (index + .8) / body.words.length })),
      matchedWords: body.words.length, matchedSpeechRatio: 1, strongMatchCharacters: 200 });
    throw new Error('Unexpected request: ' + path);
  };
  const learning = await openLearning(dir, { getBook: () => book, filePath: () => path }, false,
    { async readingLevel(source) { sample = source; return { band: 'Intermediate', text: 'Character-based estimate', evidence: ['我喜欢读书'] }; } });
  const db = new DatabaseSync(join(dir, 'learning.sqlite'));
  t.after(async () => {
    await learning.remove(book.id); globalThis.fetch = previousFetch;
    if (previousURL === undefined) delete process.env.READER_KOKORO_URL; else process.env.READER_KOKORO_URL = previousURL;
    db.close(); await rm(dir, { recursive: true, force: true });
  });
  learning.ensure(book);
  const analysis = await until(() => { const result = learning.info(book); if (result.state === 'error') throw new Error(result.error); return result.state === 'ready' && result; });
  assert.deepEqual([...new Set(analysisLanguages)], ['zh', 'en', 'pt', 'es']);
  const metrics = analysis.vocabulary, chinese = metrics.byLanguage.find((item) => item.language === 'zh');
  assert.deepEqual(chinese, { language: 'zh', unit: 'characters', count: 10, total: 12 });
  assert.equal(metrics.byLanguage.find((item) => item.language === 'es').unit, 'lemmas');
  assert.equal(analysis.wordCount, metrics.byLanguage.filter((item) => item.language !== 'zh').reduce((sum, item) => sum + item.total, 0));
  assert.equal(analysis.lemmaCount, metrics.byLanguage.filter((item) => item.language !== 'zh').reduce((sum, item) => sum + item.count, 0));
  await until(() => sample);
  assert.equal(sample.vocabulary.unit, 'characters');
  assert.equal(sample.vocabulary.characterProfile.unique, 10);
  const unit = learning.unit(book, 'epub:0');
  assert.ok(unit.tokens.some((token) => token.language === 'pt' && token.lemma === 'livro'));
  for (const token of unit.tokens) assert.equal(unit.text.slice(token.from, token.to), token.word);
  learning.queueBook(book);
  const generated = await until(() => { const result = learning.narration(book).audio; if (result.state === 'error') throw new Error(result.error); return result.state === 'ready' && result; });
  assert.deepEqual(voices, ['zf_xiaobei', 'af_heart', 'pf_dora', 'ef_dora']);
  assert.deepEqual(alignmentLanguages, ['zh', 'en', 'pt', 'es']);
  assert.ok(Math.abs(generated.duration - 4) < .01);
  const uploaded = join(dir, 'own.wav'); await writeFile(uploaded, speech);
  const recording = await learning.recordings.accept(book, { path: uploaded, size: speech.length, originalname: 'own.wav' }, {});
  learning.recordings.queue(book, recording.id);
  await until(() => { const result = learning.recordings.list(book).find((item) => item.id === recording.id); if (result.state === 'error') throw new Error(result.error); return result.state === 'ready'; });
  assert.deepEqual(transcriptionLanguages, ['mul']);
  assert.equal(learning.narration(book, recording.id).audio.state, 'ready');
  assert.equal(learning.narration(book).audio.id, generated.id);
});
