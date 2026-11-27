import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openLibrary } from '../server/books.js';
import { openLearning } from '../server/learning.js';
import { bookTools } from '../server/book-tools.js';
import { textWords } from '../shared/reading-text.js';

async function waitFor(read) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const outcome = read();
    if (outcome) return outcome;
    await delay(50);
  }
  throw new Error('PDF processing timed out');
}

function speechSample() {
  const rate = 24_000;
  const wav = Buffer.alloc(44 + 2 * rate);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(2 * rate, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(2 * rate, 40);
  return wav;
}

test('PDF review drives vocabulary and generated audio on the original pages, with editable page start times', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-pdf-review-'));
  const library = await openLibrary(dir);
  const bytes = Buffer.from('%PDF-1.4\n%%EOF');
  const path = join(library.uploads, 'scan.pdf');
  await writeFile(path, bytes);
  const book = await library.importBook('review', { path, originalname: 'scan.pdf', size: bytes.length }, { language: 'zh', title: '中文故事' });
  const original = ['导言。', '词汇：龙舟。端午节。', '练习。', '大家吃粽子。'];
  const revised = '五月是端午节。';
  const analyzed = [], spoken = [];
  const speech = speechSample();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const endpoint = new URL(url).pathname;
    if (endpoint === '/pdf') return Response.json({
      chapters: original.map((text, index) => ({ key: `pdf:${index + 1}`, title: `Page ${index + 1}`, text })),
    });
    const body = JSON.parse(options.body);
    if (endpoint === '/analyze') {
      analyzed.push(body.text);
      const tokens = textWords(body.text, body.language).map((word) => ({ ...word, lemma: word.word }));
      return Response.json({ tokens, lemmas: tokens.map((word) => word.lemma), method: 'contextual' });
    }
    if (endpoint === '/v1/audio/speech') {
      spoken.push(body.input);
      return new Response(speech);
    }
    if (endpoint === '/align') return Response.json({
      timings: body.words.map((_, index) => ({ start: index / body.words.length, end: (index + .8) / body.words.length })),
    });
    throw new Error('Unexpected request: ' + endpoint);
  });
  const ai = { async readingLevel() { return { band: 'Intermediate' }; } };
  const learning = await openLearning(dir, library, false, ai, { autoRepair: false });
  let reopened;
  t.after(async () => { await (reopened || learning).remove(book.id); await rm(dir, { recursive: true, force: true }); });
  await learning.save({ baseUrl: 'http://kokoro.test/v1', model: 'kokoro', voice: 'zf_xiaobei', speed: 1 });
  await waitFor(() => learning.info(book).state === 'ready');
  const initial = learning.pdfReview(book, 2);
  assert.equal(initial.total, 4);
  assert.deepEqual(initial.page, { number: 2, original: original[1], text: original[1] });
  assert.throws(() => learning.savePdfReview(book, { revision: initial.revision, excluded: [1, 2, 3, 4], edits: [] }), { status: 422 });

  analyzed.length = 0;
  const { revision } = learning.savePdfReview(book, {
    revision: initial.revision, excluded: [1, 3], edits: [{ page: 2, text: revised }],
  });
  assert.notEqual(revision, initial.revision);
  const analysis = await waitFor(() => { const result = learning.info(book); return result.state === 'ready' && result; });
  assert.deepEqual(analyzed, [revised, original[3]]);
  assert.deepEqual(analysis.counts, { words: 0, characters: 11 });
  assert.deepEqual(learning.textSections(book).map(({ key, text }) => [key, text]), [
    ['pdf:1', ''], ['pdf:2', revised], ['pdf:3', ''], ['pdf:4', original[3]],
  ]);
  const [glossary] = bookTools({ learning }).search(book, '龙舟').results;
  assert.equal(glossary.key, 'pdf:2');
  assert.equal(glossary.from, original[1].indexOf('龙舟'));
  assert.deepEqual(learning.pdfReview(book, 2).page, { number: 2, original: original[1], text: revised });
  assert.deepEqual(learning.pdfReview(book, 1).excluded, [1, 3]);
  assert.throws(() => learning.savePdfReview(book, { revision: initial.revision, excluded: [], edits: [] }), { status: 409 });

  learning.queueBook(book);
  const recording = await waitFor(() => {
    const audio = learning.narration(book).audio;
    assert.notEqual(audio.state, 'error', audio.error);
    return audio.state === 'ready' && audio;
  });
  assert.deepEqual(spoken, [revised, original[3]]);
  assert.deepEqual(recording.segments.map(({ key }) => key), ['pdf:2', 'pdf:4']);
  assert.equal(recording.segments[0].pageOnly, true);
  assert.equal(learning.unit(book, 'pdf:3', recording.id).audio.state, 'missing');

  const file = await readFile(learning.audioFile(book, recording.id));
  const timing = learning.pdfTiming(book, recording.id);
  const newStart = timing.pages[1].start - .25;
  const save = (starts) => learning.savePdfTiming(book, recording.id, { revision: timing.revision, starts });
  assert.throws(() => save({ 'pdf:2': .25 }), { status: 422 });
  assert.throws(() => save({ 'pdf:3': newStart }), { status: 422 });
  assert.equal(save({ 'pdf:4': newStart }).pages[1].start, newStart);
  assert.throws(() => save({}), { status: 409 });
  const adjusted = learning.narration(book).audio;
  assert.equal(adjusted.segments[0].end, newStart);
  assert.equal(adjusted.segments[1].start, newStart);
  assert.equal(adjusted.segments[1].pageOnly, true);
  assert.equal(adjusted.markers.find(({ key }) => key === 'pdf:4').time, newStart);
  assert.deepEqual(await readFile(learning.audioFile(book, recording.id)), file);
  assert.deepEqual(await readFile(library.filePath(book)), bytes);

  reopened = await openLearning(dir, library, false, ai, { autoRepair: false });
  assert.equal(reopened.pdfReview(book, 2).page.text, revised);
  const saved = reopened.pdfTiming(book, recording.id);
  assert.equal(saved.pages[1].start, newStart);
  reopened.savePdfTiming(book, recording.id, { revision: saved.revision, starts: {} });
  assert.deepEqual(reopened.narration(book).audio.segments, recording.segments);
});
