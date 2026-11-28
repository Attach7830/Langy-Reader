import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, copyFile, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { openLearning } from '../server/learning.js';
import { uploadedAudio } from '../server/uploaded-audio.js';

const run = promisify(execFile);

test('replacing a generated recording deletes its files but retains section audio used by another recording', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-recording-replacement-')), book = { id: 'book', language: 'es', languages: ['es'] };
  const learning = await openLearning(folder, { getBook: () => book }, false, {}, { autoRepair: false }), db = new DatabaseSync(join(folder, 'learning.sqlite')), audioFolder = join(folder, 'narration');
  t.after(async () => { await learning.remove(book.id); db.close(); await rm(folder, { recursive: true, force: true }); });
  db.prepare("INSERT INTO analyses(book,owner,language,state) VALUES('book','','es','ready')").run();
  db.prepare("INSERT INTO chapters(book,key,ordinal,title,text,digest) VALUES('book','section',0,'Page','Una historia.','digest')").run();
  for (const id of ['shared', 'old-only']) {
    db.prepare("INSERT INTO audio(id,book,chapter,digest,options,state,created) VALUES(?,'book','section','digest','{}','ready',1)").run(id); await writeFile(join(audioFolder, `${id}.mp3`), id);
  }
  for (const [id, parts] of [['old', ['shared', 'old-only']], ['kept', ['shared']]]) {
    db.prepare("INSERT INTO book_audio(id,book,digest,options,state,parts,created) VALUES(?,'book','digest','{}','ready',?,1)").run(id, JSON.stringify(parts.map((id) => ({ id })))); await writeFile(join(audioFolder, `${id}.mp3`), id);
  }
  await learning.removeRecording(book, 'old'); await learning.removeRecording(book, 'old');
  assert.equal(db.prepare("SELECT id FROM book_audio WHERE id='old'").get(), undefined);
  await assert.rejects(access(join(audioFolder, 'old.mp3')), { code: 'ENOENT' }); await assert.rejects(access(join(audioFolder, 'old-only.mp3')), { code: 'ENOENT' });
  assert.equal(await readFile(join(audioFolder, 'shared.mp3'), 'utf8'), 'shared'); assert.equal(await readFile(join(audioFolder, 'kept.mp3'), 'utf8'), 'kept');
  assert.ok(db.prepare("SELECT id FROM audio WHERE id='shared'").get());
});

test('own recordings sync independently, can be selected and downloaded, reuse transcripts, and reject unrelated audio', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-own-audio-'));
  const original = globalThis.fetch;
  let db, learning, speechCalls = 0, mismatch = false;
  const book = { id: 'book', title: 'Two chapters', language: 'es', format: 'epub' };
  try {
    learning = await openLearning(folder, { getBook() { return book; } }, false, {});
    db = new DatabaseSync(join(folder, 'learning.sqlite'));
    db.prepare('INSERT INTO analyses(book,owner,language,state) VALUES(?,?,?,?)').run(book.id, 'owner', 'es', 'ready');
    for (const [ordinal, text] of ['La niña encontró un mapa antiguo.', 'Después cruzó el jardín hacia la montaña.'].entries()) {
      db.prepare('INSERT INTO chapters(book,key,ordinal,title,text,digest,tokens,lemmas,markers) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(book.id, 'epub:' + ordinal, ordinal, 'Chapter ' + (ordinal + 1), text, String(ordinal), '[]', '[]',
          JSON.stringify([{ title: 'Chapter ' + (ordinal + 1), from: 0 }]));
    }
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (new URL(url).pathname === '/transcribe') { speechCalls++; return Response.json({ heard: [{ word: 'narración', start: .2, end: 5.8 }] }); }
      if (new URL(url).pathname === '/match-recording') return Response.json({
        timings: body.words.map((_, index) => mismatch ? null : { start: index * 5 / body.words.length, end: (index + .8) * 5 / body.words.length }),
        matchedWords: mismatch ? 0 : body.words.length, matchedSpeechRatio: mismatch ? 0 : 1, strongMatchCharacters: mismatch ? 0 : 100,
      });
      throw new Error('Unexpected language request');
    };
    const sample = join(folder, 'sample.wav');
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-ar', '24000', sample]);
    async function upload(name) {
      const path = join(folder, name + '.wav'); await copyFile(sample, path);
      return learning.recordings.accept(book, { path, size: (await stat(path)).size, originalname: name + '.wav' }, { name });
    }
    async function ready(id) {
      for (let count = 0; count < 400; count++) {
        const row = learning.recordings.list(book).find((item) => item.id === id);
        if (['ready', 'error'].includes(row.state)) return row;
        await delay(25);
      }
      throw new Error('Synchronization did not finish');
    }
    const first = await upload('Narrator one'), second = await upload('Narrator two');
    assert.notEqual(first.id, second.id);
    learning.recordings.queue(book, first.id);
    assert.equal((await ready(first.id)).state, 'ready');
    learning.recordings.queue(book, second.id);
    assert.equal((await ready(second.id)).state, 'ready');
    assert.equal(learning.narration(book).audio.id, second.id, 'the latest synced recording becomes available without a selection step');
    const selected = learning.narration(book, first.id);
    assert.equal(selected.audio.kind, 'uploaded');
    assert.equal(selected.audio.name, 'Narrator one');
    assert.equal(selected.audio.segments.length, 2);
    assert.equal(selected.recordings.length, 2);
    assert.equal(selected.audio.quality.textPercent, 100);
    assert.ok((await readFile(learning.audioFile(book, first.id))).length > 0);
    assert.deepEqual(await readFile(learning.recordings.original(book, first.id).path), await readFile(sample));
    const edit = learning.epubTiming.get(book, first.id, 'epub:0');
    const [from, , originalTime] = edit.section.words[2];
    const time = originalTime + .1;
    const points = [{ from, time }];
    learning.epubTiming.save(book, first.id, { key: 'epub:0', revision: edit.revision, points });
    assert.equal(learning.unit(book, 'epub:0', first.id).audio.timings.find((word) => word.from === from).start, time);
    assert.equal(learning.unit(book, 'epub:0', second.id).audio.timings.find((word) => word.from === from).start, originalTime);
    const before = speechCalls;
    learning.recordings.queue(book, first.id);
    assert.equal((await ready(first.id)).state, 'ready');
    assert.equal(speechCalls, before, 'resync reuses the saved transcript');
    assert.deepEqual(learning.epubTiming.get(book, first.id, 'epub:0').section.points, points);
    assert.equal(learning.unit(book, 'epub:0', first.id).audio.timings.find((word) => word.from === from).start, time);
    db.prepare("UPDATE recordings SET state='syncing' WHERE id=?").run(second.id);
    uploadedAudio({ db, folder: join(folder, 'narration'), library: { getBook() { return book; } }, languageCall() {}, wake() {} });
    assert.equal(db.prepare('SELECT state FROM recordings WHERE id=?').get(second.id).state, 'queued');
    assert.equal((await ready(second.id)).state, 'ready');
    assert.equal(speechCalls, before, 'restart recovery also reuses transcript checkpoints');
    const invalid = join(folder, 'invalid.mp3');
    await writeFile(invalid, 'This is not an audiobook.');
    await assert.rejects(learning.recordings.accept(book, { path: invalid, size: 25, originalname: 'invalid.mp3' }, {}), /playable/u);
    await assert.rejects(access(invalid));
    assert.throws(() => learning.recordings.original({ id: 'other-book' }, first.id), /not found/u);
    await learning.recordings.remove(book, first.id);
    assert.equal(learning.recordings.list(book).length, 1);
    assert.equal(learning.narration(book, second.id).audio.state, 'ready');
    const third = await upload('Wrong edition'); mismatch = true;
    learning.recordings.queue(book, third.id);
    const rejected = await ready(third.id);
    assert.equal(rejected.state, 'error');
    assert.match(rejected.error, /Not enough/u);
    assert.equal(learning.narration(book).recordings.length, 1);
  } finally {
    globalThis.fetch = original;
    if (learning) await learning.remove(book.id);
    db?.close();
    await rm(folder, { recursive: true, force: true });
  }
});
