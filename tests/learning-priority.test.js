import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { openLearning } from '../server/learning.js';
import { openProcessScheduler } from '../server/process-scheduler.js';
import { textWords } from '../shared/reading-text.js';

const gate = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
async function until(check) { for (let i = 0; i < 600; i++) { if (check()) return; await delay(20); } throw new Error('Learning worker did not finish'); }

test('promoting another audiobook pauses after a passage and resumes without regenerating completed audio', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-audio-priority-')), scheduler = openProcessScheduler(dir, { paused: true });
  const originalFetch = globalThis.fetch, originalURL = process.env.READER_KOKORO_URL;
  process.env.READER_KOKORO_URL = 'http://kokoro.test/v1';
  const firstStarted = gate(), releaseFirst = gate(), order = [];
  const books = { one: { id: 'one', title: 'First book', language: 'en' }, two: { id: 'two', title: 'Urgent book', language: 'en' } };
  const wav = join(dir, 'speech.wav');
  await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-ar', '24000', wav]);
  const bytes = await readFile(wav);
  let inFlight = 0, maxInFlight = 0, onSpeech;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body), endpoint = new URL(url).pathname;
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (endpoint === '/v1/audio/speech') {
        order.push(body.input);
        onSpeech?.();
        if (order.length === 1) { firstStarted.release(); await releaseFirst.promise; }
        return new Response(bytes);
      }
      if (endpoint === '/align') return Response.json({ timings: body.words.map((_, index) => ({ start: index / body.words.length, end: (index + .8) / body.words.length })) });
      throw new Error('Unexpected endpoint: ' + endpoint);
    } finally { inFlight--; }
  };
  const learning = await openLearning(dir, { getBook: (id) => books[id] }, false, {}, { scheduler, autoRepair: false });
  const db = new DatabaseSync(join(dir, 'learning.sqlite'));
  t.after(async () => {
    releaseFirst.release();
    await until(() => !scheduler.snapshot().active);
    await learning.remove('one'); await learning.remove('two'); await scheduler.close(); db.close();
    globalThis.fetch = originalFetch;
    if (originalURL === undefined) delete process.env.READER_KOKORO_URL; else process.env.READER_KOKORO_URL = originalURL;
    await rm(dir, { recursive: true, force: true });
  });
  const firstText = 'First heading\nFirst body keeps the completed passage.', urgentText = 'Urgent book runs before the first book resumes.';
  for (const [id, text, blocks] of [
    ['one', firstText, [{ from: 0, to: 13, kind: 'heading' }, { from: 14, to: firstText.length, kind: 'paragraph' }]],
    ['two', urgentText, []],
  ]) {
    db.prepare("INSERT INTO analyses(book,owner,language,languageSelection,state,textVersion) VALUES(?,'','en','[\"en\"]','ready',1)").run(id);
    db.prepare("INSERT INTO chapters(book,key,ordinal,title,text,digest,tokens,lemmas,speechBlocks) VALUES(?,'epub:0',0,'Chapter',?,?,'[]','[]',?)")
      .run(id, text, id, JSON.stringify(blocks));
  }
  const first = learning.queueBook(books.one); scheduler.resume(); await firstStarted.promise;
  const urgent = learning.queueBook(books.two); scheduler.top(`narration:${urgent.id}`);
  assert.equal(scheduler.snapshot().active.id, `narration:${first.id}`, 'the in-flight speech request still owns the slot');
  releaseFirst.release();
  await until(() => {
    const rows = db.prepare('SELECT state,error FROM book_audio').all();
    assert.ok(rows.every((row) => row.state !== 'error'), JSON.stringify(rows));
    return rows.length === 2 && rows.every((row) => row.state === 'ready');
  });
  await until(() => !scheduler.snapshot().active);
  assert.deepEqual(order, ['First heading.', urgentText, 'First body keeps the completed passage.']);
  assert.equal(maxInFlight, 1, 'a priority switch never overlaps remote operations');
  assert.ok((await readFile(learning.audioFile(books.one, first.id))).length > 100);
  const completed = learning.unit(books.one, 'epub:0', first.id);
  assert.ok(completed.audio.timings.every((word) => word.start !== null && word.end > word.start));

  // Cancelling a paused replacement must clean its partial audio while the
  // previous completed recording remains available.
  const blockerStarted = gate(), releaseBlocker = gate(); let blocker;
  onSpeech = () => {
    onSpeech = undefined;
    blocker = scheduler.run('archive:cancel-check', async () => { blockerStarted.release(); await releaseBlocker.promise; });
    scheduler.top('archive:cancel-check');
  };
  const replacement = learning.queueBook(books.one, true);
  await blockerStarted.promise;
  try {
    const part = JSON.parse(db.prepare('SELECT parts FROM book_audio WHERE id=?').get(replacement.id).parts)[0];
    assert.ok(existsSync(join(dir, 'narration', part.id)), 'the paused passage files are retained');
    learning.cancelProcess('narration', books.one, replacement.id);
    await until(() => !existsSync(join(dir, 'narration', part.id)));
    assert.equal(db.prepare('SELECT state FROM audio WHERE id=?').get(part.id).state, 'cancelled');
    assert.ok((await readFile(learning.audioFile(books.one, first.id))).length > 100);
  } finally { releaseBlocker.release(); await blocker; }
  await until(() => !scheduler.snapshot().active);
  assert.deepEqual(order.slice(3), ['First heading.'], 'the cancelled replacement never resumes its next passage');
});

test('analysis resumes saved passage results and aggregate counts after a same-provider priority switch', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-analysis-priority-')), scheduler = openProcessScheduler(dir, { paused: true });
  const originalFetch = globalThis.fetch, firstStarted = gate(), releaseFirst = gate(), order = [];
  const books = { one: { id: 'one', language: 'en' }, two: { id: 'two', language: 'en' } };
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/analyze');
    const { text } = JSON.parse(options.body); order.push(text);
    if (order.length === 1) { firstStarted.release(); await releaseFirst.promise; }
    const tokens = textWords(text, 'en').map((word) => ({ ...word, lemma: word.word.toLowerCase() }));
    return Response.json({ tokens, lemmas: [...new Set(tokens.map((word) => word.lemma))], method: 'contextual' });
  };
  const learning = await openLearning(dir, { getBook: (id) => books[id] }, false, {}, { scheduler, autoRepair: false });
  const db = new DatabaseSync(join(dir, 'learning.sqlite'));
  t.after(async () => {
    releaseFirst.release(); await until(() => !scheduler.snapshot().active);
    await learning.remove('one'); await learning.remove('two'); await scheduler.close(); db.close();
    globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true });
  });
  const texts = { one: ['Apple pear apple.', 'Plum pear.'], two: ['Urgent orange.'] };
  for (const [id, sections] of Object.entries(texts)) {
    db.prepare("INSERT INTO analyses(book,owner,language,languageSelection,state,textVersion) VALUES(?,'','en','[\"en\"]','queued',1)").run(id);
    for (const [ordinal, text] of sections.entries()) db.prepare("INSERT INTO chapters(book,key,ordinal,title,text,digest) VALUES(?,?,?,'Chapter',?,?)")
      .run(id, `epub:${ordinal}`, ordinal, text, `${id}-${ordinal}`);
    learning.vocabulary.saveBookCounts(books[id], sections.map((text) => ({ text })));
  }
  learning.ensure(books.one); scheduler.resume(); await firstStarted.promise;
  scheduler.top('analysis:two'); releaseFirst.release();
  await until(() => {
    const rows = db.prepare('SELECT state,error FROM analyses').all();
    assert.ok(rows.every((row) => row.state !== 'error'), JSON.stringify(rows));
    return rows.every((row) => row.state === 'ready');
  });
  await until(() => !scheduler.snapshot().active);
  assert.deepEqual(order, ['Apple pear apple.', 'Urgent orange.', 'Plum pear.']);
  const result = db.prepare("SELECT wordCount,lemmas,metrics FROM analyses WHERE book='one'").get();
  assert.equal(result.wordCount, 5);
  assert.deepEqual(JSON.parse(result.lemmas), ['en:apple', 'en:pear', 'en:plum']);
  assert.equal(JSON.parse(result.metrics).byLanguage[0].total, 5, 'completed passages contribute exactly once');
});
