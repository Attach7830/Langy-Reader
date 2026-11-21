import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { openLearning } from '../server/learning.js';
import { textWords } from '../shared/reading-text.js';

const run = promisify(execFile);

test('retry replaces unusable cached sections, keeps valid audio, and completes with disclosed timing estimates', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-narration-retry-'));
  const originalURL = process.env.READER_KOKORO_URL;
  const originalFetch = globalThis.fetch;
  let db, learning, speechCalls = 0;
  try {
    process.env.READER_KOKORO_URL = 'http://kokoro.test/v1';
    const book = { id: 'book', title: 'A book with headings', language: 'es' };
    learning = await openLearning(folder, { getBook() { return book; } }, false, {});
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
    db.prepare('INSERT INTO analyses(book,owner,language,state) VALUES(?,?,?,?)').run(book.id, 'owner', 'es', 'ready');
    const options = JSON.stringify({ voice: 'ef_dora', model: 'kokoro', speed: 1, baseUrl: 'http://kokoro.test/v1' });
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
