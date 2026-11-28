import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { openLibrary } from '../server/books.js';
import { openLearning } from '../server/learning.js';
import { openProcessScheduler } from '../server/process-scheduler.js';
import { textWords } from '../shared/reading-text.js';
import { pdfEpub } from '../src/pdf-epub.js';

async function until(check) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const value = check();
    if (value) return value;
    await delay(50);
  }
  throw new Error('Audiobook preparation did not finish.');
}

test('EPUB audiobook boundaries and exclusions affect generation while keeping canonical reading and alignment offsets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-epub-narration-'));
  const library = await openLibrary(dir), scheduler = openProcessScheduler(dir);
  const passages = ['Foreword to skip.', 'Skip opening. Keep this sentence. Ignore this aside. Keep the ending.',
    'Skip the entire interlude.', 'Last words here. Skip closing.'];
  const bytes = Buffer.from(await pdfEpub({ id: 'book', title: 'EPUB narration', language: 'en' }, {
    pages: passages.map((text, index) => ({ number: index + 1, title: `Section ${index + 1}`, text })),
  }));
  const path = join(library.uploads, 'source.epub');
  await writeFile(path, bytes);
  const book = await library.importBook('book', { path, size: bytes.length, originalname: 'source.epub' }, { title: 'EPUB narration', language: 'en' });
  const wave = join(dir, 'sample.wav'), spoken = [];
  await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=1', '-ar', '24000', wave]);
  const sample = await readFile(wave);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    switch (new URL(url).pathname) {
      case '/analyze': {
        const tokens = textWords(body.text, body.language).map((word) => ({ ...word, lemma: word.word }));
        return Response.json({ tokens, lemmas: tokens.map((word) => word.lemma), method: 'contextual' });
      }
      case '/v1/audio/speech': spoken.push(body.input); return new Response(sample);
      case '/align': return Response.json({ timings: body.words.map((_, index) => ({
        start: index / body.words.length, end: (index + .8) / body.words.length,
      })) });
      default: throw new Error('Unexpected language request: ' + url);
    }
  });
  const learning = await openLearning(dir, library, false, { readingLevel: async () => ({ band: 'Intermediate' }) }, { scheduler, autoRepair: false });
  t.after(async () => {
    await until(() => !scheduler.snapshot().active);
    await scheduler.close();
    await learning.remove(book.id); await rm(dir, { recursive: true, force: true });
  });
  await learning.save({ baseUrl: 'http://kokoro.test/v1', model: 'kokoro', voice: 'ef_dora', speed: 1 });
  const analysis = await until(() => { const result = learning.info(book); return result.state === 'ready' && result; });
  const initial = learning.epubAudioText(book, 'epub:1');
  assert.equal(initial.section.text, passages[1]);
  assert.deepEqual(initial.selection, { start: null, end: null, exclusions: [] });
  assert.throws(() => learning.saveEpubAudioText(book, {
    revision: initial.revision, start: { key: 'epub:3', offset: 0 }, end: { key: 'epub:1', offset: 2 }, exclusions: [],
  }), { status: 422 });
  assert.throws(() => learning.saveEpubAudioText(book, {
    revision: initial.revision, start: { key: 'epub:1', offset: 0 },
    end: { key: 'epub:1', offset: passages[1].length }, exclusions: [{ key: 'epub:1', from: 0, to: passages[1].length }],
  }), { status: 422 });
  function ready(id) {
    return until(() => {
      const audio = learning.narration(book, id).audio;
      assert.notEqual(audio.state, 'error', audio.error);
      return audio.id === id && audio.state === 'ready' && audio;
    });
  }

  const full = await ready(learning.queueBook(book).id);
  assert.equal(full.segments.length, passages.length);
  const settings = learning.saveEpubAudioText(book, {
    revision: initial.revision,
    start: { key: 'epub:1', offset: passages[1].indexOf('Keep') + 2 },
    end: { key: 'epub:3', offset: 'Last words here.'.length },
    exclusions: [{ key: 'epub:1', from: passages[1].indexOf('Ignore'), to: passages[1].indexOf(' Keep the ending.') },
      { key: 'epub:2', from: 0, to: passages[2].length }],
  });
  assert.equal(settings.selection.start.offset, passages[1].indexOf('Keep'));
  assert.equal(settings.selection.exclusions[0].preview, 'Ignore this aside.');
  assert.equal(learning.narration(book).audio.id, full.id);
  assert.throws(() => learning.saveEpubAudioText(book, { revision: initial.revision, start: null, end: null, exclusions: [] }), { status: 409 });
  spoken.length = 0;
  const selected = await ready(learning.queueBook(book).id);
  assert.notEqual(selected.id, full.id);
  assert.deepEqual(spoken, ['Keep this sentence.', 'Keep the ending.', 'Last words here.']);
  assert.deepEqual(selected.segments.map(({ key }) => key), ['epub:1', 'epub:3']);
  assert.equal(learning.unit(book, 'epub:2', selected.id).audio.state, 'missing');
  const unit = learning.unit(book, 'epub:1', selected.id);
  assert.equal(unit.text, passages[1]);
  assert.equal(unit.audio.timings.find(({ word }) => word === 'Ignore').start, null);
  const first = unit.audio.timings.find(({ start }) => start != null);
  assert.equal(first.word, 'Keep');
  assert.equal(first.from, passages[1].indexOf('Keep'));
  const edit = learning.epubTiming.get(book, selected.id, 'epub:1');
  assert.deepEqual(edit.sections.map(({ key }) => key), ['epub:1', 'epub:3']);
  const excluded = passages[1].indexOf('Ignore');
  assert.ok(!edit.section.words.some(([from]) => from === excluded));
  const last = edit.section.words.at(-1);
  const points = [{ from: first.from, time: edit.section.start + .13 }, { from: last[0], time: last[2] + .12 }];
  const setPoints = (values, revision = edit.revision) => learning.epubTiming.save(book, selected.id, { revision, key: 'epub:1', points: values });
  assert.throws(() => setPoints([{ from: excluded, time: .5 }]), { status: 422 });
  assert.throws(() => setPoints([{ ...points[0], time: edit.section.end }]), { status: 422 });
  assert.throws(() => setPoints(points.map((point, index) => ({ ...point, time: points[1 - index].time }))), { status: 422 });
  const audioBytes = await readFile(learning.audioFile(book, selected.id));
  const otherTiming = learning.unit(book, 'epub:1', full.id).audio.timings;
  const updated = setPoints(points);
  assert.equal(updated.revision, edit.revision + 1);
  assert.deepEqual(learning.epubTiming.get(book, selected.id, 'epub:1').section.points, points);
  const synced = learning.unit(book, 'epub:1', selected.id).audio.timings;
  const segment = selected.segments[0];
  for (const { from, time } of points) {
    const word = synced.find((item) => item.from === from);
    assert.ok(Math.abs(segment.start + word.start * segment.scale - time) < .000001);
    assert.equal(word.estimated, false);
    assert.ok(word.end > word.start);
  }
  assert.notEqual(synced.find(({ word }) => word === 'sentence').start, unit.audio.timings.find(({ word }) => word === 'sentence').start);
  assert.equal(synced.find(({ word }) => word === 'Ignore').start, null);
  assert.deepEqual(learning.unit(book, 'epub:1', full.id).audio.timings, otherTiming);
  assert.deepEqual(await readFile(learning.audioFile(book, selected.id)), audioBytes);
  assert.throws(() => setPoints([]), { status: 409 });
  assert.equal(setPoints([], updated.revision).section.points.length, 0);
  assert.deepEqual(learning.unit(book, 'epub:1', selected.id).audio.timings, unit.audio.timings);
  assert.equal(learning.rescans.queue(book, selected.id).totalWords, 9, 'repair considers only narrated words');
  assert.equal(learning.queueBook(book).id, selected.id);
  assert.equal(learning.info(book).wordCount, analysis.wordCount);
  assert.deepEqual(await readFile(library.filePath(book)), bytes);
  const restored = learning.saveEpubAudioText(book, { revision: settings.revision, start: null, end: null, exclusions: [] });
  assert.deepEqual(restored.selection, { start: null, end: null, exclusions: [] });
  spoken.length = 0;
  const nextFull = await ready(learning.queueBook(book).id);
  assert.equal(nextFull.segments.length, passages.length);
  assert.equal(spoken.length, 0, 'unchanged full-book sections still use cached audio');
});
