import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { openLearning } from '../server/learning.js';
import { textWords } from '../shared/reading-text.js';
import { speechVersion } from '../server/narration-text.js';
import { extractBook } from '../server/book-text.js';

const run = promisify(execFile);

test('retry replaces unusable cached sections, keeps valid audio, and completes with disclosed timing estimates', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-narration-retry-'));
  const originalURL = process.env.READER_KOKORO_URL;
  const originalFetch = globalThis.fetch;
  let db, learning, speechCalls = 0;
  try {
    process.env.READER_KOKORO_URL = 'http://kokoro.test/v1';
    const book = { id: 'book', title: 'A book with headings', language: 'es' };
    learning = await openLearning(folder, { getBook() { return book; } }, false, {}, { autoRepair: false });
    const narration = join(folder, 'narration');
    const wav = join(folder, 'sample.wav');
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-ar', '24000', wav]);
    const speech = await readFile(wav);
    globalThis.fetch = async (url) => {
      if (new URL(url).pathname === '/v1/audio/speech') { speechCalls++; return new Response(speech); }
      if (new URL(url).pathname === '/align') return Response.json({ timings: [] });
      throw new Error('Unexpected request');
    };
    db = new DatabaseSync(join(folder, 'learning.sqlite'));
    db.prepare('INSERT INTO analyses(book,owner,language,state,textVersion) VALUES(?,?,?,?,1)').run(book.id, 'owner', 'es', 'ready');
    const options = JSON.stringify({ voice: 'ef_dora', model: 'kokoro', speed: 1, baseUrl: 'http://kokoro.test/v1', speechVersion });
    const sections = [['good', 'Una frase normal.'], ['heading', 'Tiliches'], ['number', '42'], ['decoration', '*** —']];
    for (const [ordinal, [key, text]] of sections.entries()) {
      db.prepare('INSERT INTO chapters(book,key,ordinal,title,text,digest,tokens,lemmas,markers) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(book.id, key, ordinal, key, text, key, '[]', '[]', JSON.stringify([{ title: key, from: 0 }]));
    }
    const goodTimings = textWords(sections[0][1], 'es').map((word, index) => ({ ...word, start: index / 3, end: (index + 1) / 3 }));
    for (const [id, key, timings] of [['good-audio', 'good', goodTimings], ['bad-audio', 'heading', []]]) {
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', wav, '-c:a', 'libmp3lame', join(narration, `${id}.mp3`)]);
      db.prepare('INSERT INTO audio(id,book,chapter,digest,options,state,timings,duration,created) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, book.id, key, key, options, 'ready', JSON.stringify(timings), 1, Date.now());
    }
    learning.queueBook(book);
    const pending = learning.narration(book).audio;
    const parts = JSON.parse(db.prepare('SELECT parts FROM book_audio WHERE id=?').get(pending.id).parts);
    assert.equal(parts.length, 3);
    assert.equal(parts.find((part) => part.key === 'good').id, 'good-audio');
    assert.notEqual(parts.find((part) => part.key === 'heading').id, 'bad-audio');
    let complete;
    for (let attempt = 0; attempt < 250; attempt++) {
      complete = learning.narration(book).audio;
      assert.notEqual(complete.state, 'error', complete.error);
      if (complete.state === 'ready') break;
      await delay(50);
    }
    assert.equal(complete.state, 'ready');
    assert.equal(speechCalls, 2, 'only the failed heading and numeric heading need generation');
    assert.equal(complete.approximateSections, 2);
    assert.equal(complete.segments[0].approximate, false);
    const heading = learning.unit(book, 'heading', complete.id);
    assert.ok(heading.audio.timings.every((stamp) => stamp.estimated && stamp.end > stamp.start));
    const number = learning.unit(book, 'number', complete.id);
    assert.equal(number.audio.timings[0].word, '42');
    assert.equal(learning.queueBook(book).id, complete.id);
    const recording = learning.audioFile(book, complete.id);
    assert.ok((await readFile(recording)).length > 100);
    const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', recording])).stdout);
    assert.equal(probe.chapters.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalURL === undefined) delete process.env.READER_KOKORO_URL;
    else process.env.READER_KOKORO_URL = originalURL;
    if (learning) await learning.remove('book');
    db?.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('existing Mandarin EPUBs recover heading structure and generate padded audio with matching canonical text positions', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-mandarin-audio-'));
  const originalFetch = globalThis.fetch, originalURL = process.env.READER_KOKORO_URL;
  process.env.READER_KOKORO_URL = 'http://kokoro.test/v1';
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
  zip.file('book.opf', '<package><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>');
  zip.file('chapter.xhtml', '<html><body><h1>1</h1><hr/><h2>有意思的案子</h2><p>今天，小明在图书馆读书。</p></body></html>');
  const path = join(folder, 'book.epub'), book = { id: 'book', title: '中文故事', language: 'zh', format: 'epub' };
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
  const [section] = await extractBook(book, path, () => { throw new Error('No language service needed for EPUB extraction'); });
  const digest = createHash('sha256').update(section.text).digest('hex');
  const wav = join(folder, 'speech.wav'); await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-ar', '24000', wav]);
  const bytes = await readFile(wav), spoken = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body), endpoint = new URL(url).pathname;
    if (endpoint === '/v1/audio/speech') { spoken.push(body.input); assert.equal(body.voice, 'zf_xiaobei'); return new Response(bytes); }
    if (endpoint === '/align') return Response.json({ timings: body.words.map((_, index) => ({ start: index / body.words.length, end: (index + .8) / body.words.length })) });
    throw new Error('Unexpected request: ' + endpoint);
  };
  const learning = await openLearning(folder, { getBook: () => book, filePath: () => path }, false, {}, { autoRepair: false });
  const db = new DatabaseSync(join(folder, 'learning.sqlite'));
  t.after(async () => { await learning.remove(book.id); db.close(); globalThis.fetch = originalFetch;
    if (originalURL === undefined) delete process.env.READER_KOKORO_URL; else process.env.READER_KOKORO_URL = originalURL;
    await rm(folder, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO analyses(book,owner,language,languageSelection,state) VALUES('book','','zh','["zh"]','ready')`).run();
  db.prepare('INSERT INTO chapters(book,key,ordinal,title,text,digest,tokens,lemmas,markers,languages) VALUES(?,?,0,?,?,?,\'[]\',\'[]\',?,?)')
    .run(book.id, section.key, section.title, section.text, digest, JSON.stringify(section.markers), JSON.stringify(section.languages));
  learning.queueBook(book);
  let audio;
  for (let attempt = 0; attempt < 250; attempt++) {
    audio = learning.narration(book).audio; assert.notEqual(audio.state, 'error', audio.error);
    if (audio.state === 'ready') break; await delay(20);
  }
  assert.equal(audio.state, 'ready'); assert.deepEqual(spoken, ['第1章。', '有意思的案子。', '今天，小明在图书馆读书。']);
  assert.ok(Math.abs(audio.duration - 5.05) < .01);
  const unit = learning.unit(book, section.key, audio.id);
  assert.equal(unit.text, section.text); assert.equal(unit.textHash, digest);
  assert.equal(db.prepare('SELECT textVersion FROM analyses').get().textVersion, 1);
  assert.equal(JSON.parse(db.prepare('SELECT speechBlocks FROM chapters').get().speechBlocks).length, 3);
  const title = unit.audio.timings.find((word) => word.from >= section.speechBlocks[1].from);
  const body = unit.audio.timings.find((word) => word.from >= section.speechBlocks[2].from);
  assert.ok(title.start >= 1.8); assert.ok(body.start >= 3.7);
  assert.equal(unit.audio.timings[0].word, '1'); assert.equal(unit.audio.timings[0].estimated, true);
  assert.ok(body.end > body.start); assert.equal(body.estimated, undefined);
  for (const word of unit.audio.timings) assert.equal(unit.text.slice(word.from, word.to), word.word);
});
