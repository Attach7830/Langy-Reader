import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RequestError } from './books.js';
const run = promisify(execFile);
const formats = 'mp3,mov,ogg,wav,flac,aac';
const escapeMetadata = (text) => String(text).replace(/[\r\n]/gu, ' ').replace(/[\\=;#]/gu, '\\$&');
export const chapterFileLimit = 200;
export const chapterByteLimit = 1024 ** 3;
export function chapterAudio({ db, folder, library, wake, reserveStorage = async () => () => {} }) {
  if (!db.prepare('PRAGMA table_info(recordings)').all().some((item) => item.name === 'sourceChapters')) db.exec("ALTER TABLE recordings ADD COLUMN sourceChapters TEXT NOT NULL DEFAULT '[]'");
  const originals = (id) => join(folder, `${id}.chapters`);
  const temporary = (id) => join(folder, `${id}.assembly`);
  async function accept(book, files, body = {}) {
    if (!Array.isArray(files) || !files.length || files.length > chapterFileLimit) throw new RequestError(422, `Choose 1–${chapterFileLimit} chapter files.`);
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    const id = randomUUID();
    let saved = false, release = () => {};
    try {
      if (bytes > chapterByteLimit) throw new RequestError(413, 'Chapter files must total 1 GiB or less per recording.');
      release = await reserveStorage(library.getBook(book.id).owner || '', bytes);
      await mkdir(originals(id));
      const chapters = [];
      for (const [index, file] of files.entries()) {
        const name = basename(file.originalname).slice(0, 240);
        await rename(file.path, join(originals(id), String(index)));
        chapters.push({ index, name, title: basename(name, extname(name)).slice(0, 120) });
      }
      library.getBook(book.id);
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : `${book.title || 'Book'} · chapter files`;
      db.prepare("INSERT INTO recordings(id,book,name,originalName,mime,bytes,duration,state,created,sourceChapters) VALUES(?,?,?,?,?,?,0,'assembling',?,?)")
        .run(id, book.id, name, `${book.title || 'Audiobook'}.mp3`, 'audio/mpeg', bytes, Date.now(), JSON.stringify(chapters));
      saved = true; wake(); return id;
    } finally {
      if (!saved) { await rm(originals(id), { recursive: true, force: true }); await Promise.allSettled(files.map((file) => rm(file.path, { force: true }))); }
      release();
    }
  }
  async function assemble(job) {
    library.getBook(job.book);
    const chapters = JSON.parse(job.sourceChapters);
    const stage = temporary(job.id);
    const valid = () => db.prepare("SELECT id FROM recordings WHERE id=? AND state='assembling'").get(job.id);
    await mkdir(stage, { recursive: true });
    const next = chapters.find((chapter) => !chapter.samples);
    if (next) {
      const source = join(originals(job.id), String(next.index)), wav = join(stage, `${next.index}.wav`);
      const remaining = 72 * 3600 - chapters.reduce((sum, chapter) => sum + (chapter.samples || 0), 0) / 24000;
      try {
        const original = JSON.parse((await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats,
          '-show_entries', 'format=duration', '-of', 'json', source], { timeout: 30000 })).stdout);
        const duration = Number(original.format?.duration);
        if (!Number.isFinite(duration) || duration <= 0 || duration > remaining + .1) throw new RequestError(422, 'The combined audiobook must be at most 72 hours.');
        await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats,
          '-i', source, '-t', String(remaining + .1), '-vn', '-map', '0:a:0', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', '-rf64', 'auto', wav], { timeout: 1800000 });
        const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration_ts,sample_rate', '-of', 'json', wav], { timeout: 30000 })).stdout);
        const stream = probe.streams?.[0];
        if (!stream || Number(stream.sample_rate) !== 24000 || !(Number(stream.duration_ts) > 0)) throw new Error();
        next.samples = Number(stream.duration_ts);
      } catch (error) { throw error instanceof RequestError ? error : new RequestError(415, `Chapter ${next.index + 1} is not a supported, playable audio file.`); }
      if (!valid()) { await rm(stage, { recursive: true, force: true }); return; }
      let samples = 0;
      for (const chapter of chapters) {
        if (!chapter.samples) break;
        chapter.start = samples / 24000; samples += chapter.samples; chapter.end = samples / 24000;
      }
      if (samples > 72 * 3600 * 24000) throw new RequestError(422, 'The combined audiobook must be at most 72 hours.');
      db.prepare('UPDATE recordings SET sourceChapters=?,progress=? WHERE id=?')
        .run(JSON.stringify(chapters), chapters.filter((chapter) => chapter.samples).length / (chapters.length + 1), job.id);
      return;
    }
    const manifest = chapters.map((chapter) => `file '${join(stage, `${chapter.index}.wav`).replaceAll("'", "'\\''")}'`).join('\n');
    await writeFile(join(stage, 'chapters.txt'), manifest);
    await writeFile(join(stage, 'chapters.ffmeta'), [';FFMETADATA1', ...chapters.flatMap((chapter) => [
      '[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.floor(chapter.start * 1000)}`,
      `END=${Math.max(Math.floor(chapter.start * 1000) + 1, Math.floor(chapter.end * 1000))}`,
      `title=${escapeMetadata(chapter.title)}`,
    ])].join('\n'));
    const output = join(stage, 'complete.mp3');
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(stage, 'chapters.txt'),
      '-f', 'ffmetadata', '-i', join(stage, 'chapters.ffmeta'), '-map_metadata', '1', '-map_chapters', '1',
      '-c:a', 'libmp3lame', '-b:a', '96k', '-id3v2_version', '3', output], { timeout: 1800000 });
    if ((await stat(output)).size > chapterByteLimit) throw new RequestError(413, 'The combined MP3 exceeds the 1 GiB recording limit.');
    if (!valid()) { await rm(stage, { recursive: true, force: true }); return; }
    const release = await reserveStorage(library.getBook(job.book).owner || '', (await stat(output)).size);
    try {
      if (!valid()) return;
      await rename(output, join(folder, `${job.id}.source`));
      db.prepare("UPDATE recordings SET state='uploaded',duration=?,progress=0,error=NULL WHERE id=?").run(chapters.at(-1).end, job.id);
    } finally { release(); }
    await rm(stage, { recursive: true, force: true });
  }
  function original(book, id, index) {
    const row = db.prepare('SELECT sourceChapters FROM recordings WHERE book=? AND id=?').get(book.id, id);
    const chapter = row && JSON.parse(row.sourceChapters).find((item) => item.index === index);
    if (!chapter) throw new RequestError(404, 'Audio chapter not found.');
    return { path: join(originals(id), String(index)), name: chapter.name };
  }
  return { accept, assemble, original,
    files: (id) => [originals(id), temporary(id)] };
}
