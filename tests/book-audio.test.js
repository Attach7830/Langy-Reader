import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bookNarration } from '../server/book-audio.js';

const run = promisify(execFile);

test('complete narration keeps sample timing, chapters, cache, cancellation, and restart recovery', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-book-audio-'));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE analyses(book TEXT PRIMARY KEY,owner TEXT);
      CREATE TABLE chapters(book TEXT,key TEXT,title TEXT,digest TEXT,markers TEXT,text TEXT,ordinal INTEGER);
      CREATE TABLE audio(id TEXT PRIMARY KEY,book TEXT,chapter TEXT,digest TEXT,options TEXT,state TEXT,timings TEXT,duration REAL,error TEXT);
      INSERT INTO analyses VALUES('book','owner');`);
    const book = { id: 'book', title: 'Sample book' };
    const config = { voice: 'voice', model: 'kokoro', speed: 1, baseUrl: 'http://kokoro.test/v1' };
    const options = JSON.stringify(config);
    // Durations deliberately fall between MP3 frames. Container-duration concatenation would drift.
    const lengths = [17777, 43123];
    for (const [index, samples] of lengths.entries()) {
      const id = `part-${index}`, key = `epub:${index}`, duration = samples / 24000;
      const pcm = Buffer.alloc(samples * 2);
      for (let sample = 0; sample < samples; sample++) pcm.writeInt16LE(Math.round(Math.sin(sample * .05) * 1000), sample * 2);
      const path = join(folder, `${id}.pcm`);
      await writeFile(path, pcm);
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', path,
        '-c:a', 'libmp3lame', '-b:a', '96k', join(folder, `${id}.mp3`)]);
      db.prepare('INSERT INTO chapters VALUES(?,?,?,?,?,?,?)').run(book.id, key, `Chapter ${index + 1}`, `digest-${index}`,
        JSON.stringify([{ title: `Chapter ${index + 1}`, from: 0 }]), 'First second', index);
      db.prepare('INSERT INTO audio VALUES(?,?,?,?,?,?,?,?,?)').run(id, book.id, key, `digest-${index}`, options, 'ready',
        JSON.stringify([{ word: 'First', from: 0, to: 5, start: 0, end: duration / 2 },
          { word: 'second', from: 6, to: 12, start: duration / 2, end: duration }]), duration, null);
    }
    let reused = 0;
    const settings = {
      db, folder, demo: false, configuration: () => config, wake() {},
      library: { getBook(id, owner) { assert.equal(id, book.id); assert.equal(owner.id, 'owner'); return book; } },
      queuePart(ownedBook, key) {
        assert.equal(ownedBook.id, book.id); reused++;
        return db.prepare('SELECT id FROM audio WHERE book=? AND chapter=?').get(book.id, key);
      },
    };
    db.exec("ALTER TABLE analyses ADD COLUMN state TEXT DEFAULT 'ready'");
    let service = bookNarration(settings);
    const queued = service.queue(book);
    assert.equal(service.queue(book).id, queued.id);
    await service.assemble(service.next());
    const complete = service.status(book).audio;
    assert.equal(complete.state, 'ready');
    assert.equal(complete.segments.length, 2);
    assert.equal(complete.markers.length, 2);
    assert.ok(Math.abs(complete.duration - lengths.reduce((sum, value) => sum + value, 0) / 24000) < 1 / 24000);
    assert.ok(Math.abs(complete.segments[1].start - lengths[0] / 24000) < 1 / 24000);
    assert.ok(complete.segments.every((segment) => Math.abs(segment.scale - 1) < .00001));
    const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', service.audioFile(book, complete.id)])).stdout);
    assert.equal(probe.chapters.length, 2);
    assert.equal(probe.chapters[1].tags.title, 'Chapter 2');
    assert.equal(service.queue(book).id, complete.id);
    assert.equal(reused, 2);

    const replacement = service.queue(book, true);
    assert.notEqual(replacement.id, complete.id);
    assert.equal(service.cancel(book), 1);
    assert.equal(service.status(book).audio.state, 'cancelled');
    await assert.rejects(access(join(folder, `${replacement.id}.mp3`)));
    assert.ok(service.audioFile(book, complete.id));

    const retry = service.queue(book);
    db.prepare("UPDATE book_audio SET state='assembling' WHERE id=?").run(retry.id);
    service = bookNarration(settings);
    assert.equal(service.next().state, 'queued');
    await service.assemble(service.next());
    assert.equal(service.status(book).audio.id, retry.id);
    assert.equal(service.status(book).audio.state, 'ready');
    assert.equal(service.segment(book, 'epub:1', retry.id).audioId, 'part-1');
    assert.throws(() => service.segment({ id: 'someone-else' }, 'epub:1', retry.id), /not found/u);
    db.prepare("UPDATE audio SET timings='[]' WHERE id='part-1'").run();
    const unsynchronized = service.queue(book, true);
    const failedJob = service.next();
    await assert.rejects(service.assemble(failedJob), /No usable synchronization in “Chapter 2”/u);
    assert.equal(db.prepare("SELECT state FROM audio WHERE id='part-1'").get().state, 'error');
    service.fail(failedJob, 'Synchronization failed');
    assert.equal(service.status(book).audio.state, 'error');
    assert.equal(service.audioFile(book, unsynchronized.id), null);
    assert.ok(service.audioFile(book, retry.id));
  } finally { db.close(); await rm(folder, { recursive: true, force: true }); }
});
