import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { textWords } from '../shared/reading-text.js';
import { RequestError } from './books.js';
import { extractBook, textChunks, readingSamples } from './book-text.js';
import { bookNarration } from './book-audio.js';

const run = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const asText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export async function openLearning(dir, library, demo, ai) {
  const folder = join(dir, 'narration');
  await mkdir(folder, { recursive: true });
  const db = new DatabaseSync(join(dir, 'learning.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id=1), json TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS analyses (
      book TEXT PRIMARY KEY, owner TEXT NOT NULL, language TEXT NOT NULL, state TEXT NOT NULL,
      lemmas TEXT, wordCount INTEGER, method TEXT, error TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS chapters (
      book TEXT NOT NULL REFERENCES analyses(book) ON DELETE CASCADE,
      key TEXT NOT NULL, ordinal INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
      digest TEXT NOT NULL, tokens TEXT, lemmas TEXT,
      PRIMARY KEY(book, key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS audio (
      id TEXT PRIMARY KEY, book TEXT NOT NULL, chapter TEXT NOT NULL,
      digest TEXT NOT NULL, options TEXT NOT NULL, state TEXT NOT NULL,
      timings TEXT, duration REAL, error TEXT, created INTEGER NOT NULL,
      FOREIGN KEY(book, chapter) REFERENCES chapters(book, key) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS audio_chapter ON audio(book, chapter, created);
    CREATE TABLE IF NOT EXISTS estimates (
      book TEXT PRIMARY KEY REFERENCES analyses(book) ON DELETE CASCADE, state TEXT NOT NULL, json TEXT, error TEXT
    ) STRICT;
    UPDATE analyses SET state='queued', error=NULL WHERE state='running';
    UPDATE audio SET state='queued', error=NULL WHERE state IN ('generating', 'aligning');
    UPDATE estimates SET state='queued' WHERE state='running';
  `);
  if (!db.prepare('PRAGMA table_info(chapters)').all().some(({ name }) => name === 'markers')) {
    db.exec("ALTER TABLE chapters ADD COLUMN markers TEXT NOT NULL DEFAULT '[]'; UPDATE analyses SET state='queued',error=NULL WHERE state='ready';");
  }
  let config = {
    baseUrl: process.env.READER_KOKORO_URL || '', voice: process.env.READER_KOKORO_VOICE || 'ef_dora',
    model: 'kokoro', speed: 1, apiKey: process.env.READER_KOKORO_API_KEY || '',
    ...JSON.parse(db.prepare('SELECT json FROM settings WHERE id=1').get()?.json || '{}'),
  };
  const previewAudio = demo && process.env.READER_DEMO_AUDIO_PREVIEW !== '0';
  const audioConfig = () => previewAudio ? { ...config, baseUrl: '', apiKey: '' } : config;
  let working = false;
  const completeAudio = bookNarration({
    db, folder, library, demo, previewAudio, configuration: audioConfig,
    queuePart: (book, key, replace) => queue(book, key, replace, false), wake: () => void work(),
  });
  if (previewAudio) {
    for (const { book } of db.prepare('SELECT book FROM analyses').all()) completeAudio.cancel({ id: book });
    db.exec("UPDATE audio SET state='cancelled' WHERE state IN ('queued','generating','aligning')");
  }
  const workerURL = process.env.READER_LANGUAGE_URL || 'http://127.0.0.1:8091';

  async function languageCall(path, body, type = 'application/json') {
    let response;
    try {
      response = await fetch(new URL(path, workerURL), {
        method: 'POST', headers: { 'Content-Type': type },
        body: type === 'application/json' ? JSON.stringify(body) : body,
        signal: AbortSignal.timeout(path === '/align' ? 600_000 : 180_000),
      });
    } catch {
      throw new RequestError(503, 'Language processing is unavailable. Start the language service and try again.');
    }
    if (!response.ok) throw new RequestError(502, path === '/align'
      ? 'Word synchronization failed. Check the language service and try again.'
      : 'The language service could not read this text.');
    return response.json();
  }

  function settings() {
    if (demo) return { connected: Boolean(audioConfig().baseUrl), configurable: false, previewAudio };
    const { apiKey, ...publicSettings } = config;
    return { ...publicSettings, hasKey: Boolean(apiKey), configurable: !demo, connected: Boolean(config.baseUrl) };
  }

  function save(body) {
    let baseUrl = asText(body.baseUrl, 2000);
    if (baseUrl) {
      let url;
      try { url = new URL(baseUrl); } catch { throw new RequestError(422, 'Enter a valid Kokoro API URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new RequestError(422, 'Enter an HTTP or HTTPS Kokoro API URL.');
      }
      url.pathname = url.pathname.replace(/\/(?:audio\/speech|audio\/voices)\/?$/u, '').replace(/\/+$/u, '');
      if (url.pathname === '/') url.pathname = '/v1';
      baseUrl = url.href.replace(/\/+$/u, '');
    }
    const voice = asText(body.voice, 120);
    const model = asText(body.model, 120);
    const speed = Number(body.speed);
    const key = asText(body.apiKey, 4096);
    if (!voice || !model || !Number.isFinite(speed) || speed < .5 || speed > 2 || /[\r\n]/u.test(key)) {
      throw new RequestError(422, 'Choose a voice, model, and speed between 0.5 and 2.');
    }
    const updated = {
      baseUrl, voice, model, speed,
      apiKey: body.clearKey ? '' : key || (baseUrl === config.baseUrl ? config.apiKey : ''),
    };
    db.prepare('INSERT INTO settings VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(updated));
    config = updated;
    return settings();
  }

  async function kokoro(path, body, captured = config) {
    if (previewAudio) throw new RequestError(422, 'Narration is not connected in this demo. Connect Kokoro on your self-hosted installation.');
    if (!captured.baseUrl) throw new RequestError(422, 'Connect a Kokoro server in Settings → Narration.');
    let response;
    try {
      response = await fetch(`${captured.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(captured.apiKey ? { Authorization: `Bearer ${captured.apiKey}` } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(body ? 300_000 : 15_000),
      });
    } catch {
      throw new RequestError(503, 'The Kokoro server could not be reached.');
    }
    if ([401, 403].includes(response.status)) throw new RequestError(502, 'Kokoro rejected the API key.');
    if (!response.ok) throw new RequestError(502, `Kokoro returned HTTP ${response.status}.`);
    return response;
  }

  async function voices() {
    const data = await (await kokoro('/audio/voices')).json();
    const entries = Array.isArray(data) ? data : data.voices ?? data.data;
    const ids = (Array.isArray(entries) ? entries : []).map((entry) =>
      typeof entry === 'string' ? entry : entry?.id || entry?.name).filter((id) => typeof id === 'string' && id.length < 120);
    if (!ids.length) throw new RequestError(502, 'Kokoro returned no voices. Check its /v1 API URL.');
    return { voices: [...new Set(ids)] };
  }

  function ensure(book, retry = false) {
    const previous = db.prepare('SELECT * FROM analyses WHERE book=?').get(book.id);
    if (!previous || previous.language !== book.language || (retry && !['queued', 'running'].includes(previous.state))) {
      db.prepare(`INSERT INTO analyses(book, owner, language, state) VALUES(?,?,?,'queued')
        ON CONFLICT(book) DO UPDATE SET language=excluded.language,state='queued',error=NULL`)
        .run(book.id, book.owner || '', book.language);
    }
    if (retry) db.prepare("UPDATE estimates SET state='queued',error=NULL WHERE book=? AND state='error'").run(book.id);
    void work();
  }

  function info(book) {
    ensure(book);
    const row = db.prepare('SELECT state, lemmas, wordCount, method, error FROM analyses WHERE book=?').get(book.id);
    const count = row.lemmas ? JSON.parse(row.lemmas).length : null;
    const estimate = db.prepare('SELECT * FROM estimates WHERE book=?').get(book.id);
    const reading = estimate ? { state: estimate.state, error: estimate.error, ...JSON.parse(estimate.json || '{}') } : null;
    return { state: row.state, lemmaCount: count, wordCount: row.wordCount, reading, method: row.method, error: row.error };
  }

  function chapter(book, key) {
    const row = db.prepare('SELECT * FROM chapters WHERE book=? AND key=?').get(book.id, key);
    if (!row) throw new RequestError(409, 'This book is still being analyzed. Try again shortly.');
    return row;
  }

  function audioRow(book, key) {
    return db.prepare('SELECT * FROM audio WHERE book=? AND chapter=? ORDER BY created DESC, rowid DESC LIMIT 1').get(book.id, key);
  }

  function publicAudio(row) {
    if (!row) return { state: 'missing' };
    return {
      id: row.id, state: row.state === 'cancelled' ? 'missing' : row.state, error: row.error, duration: row.duration,
      ...(row.state === 'ready' ? { url: `/api/books/${row.book}/audio/${row.id}`, timings: JSON.parse(row.timings), textHash: row.digest } : {}),
    };
  }

  function unit(book, key, recording) {
    const row = chapter(book, key);
    const pinned = recording ? completeAudio.segment(book, key, recording) : null;
    if (pinned && pinned.textHash !== row.digest) throw new RequestError(409, 'The book text changed. Generate book audio again.');
    const audio = pinned ? db.prepare('SELECT * FROM audio WHERE id=? AND book=?').get(pinned.audioId, book.id) : audioRow(book, key);
    return {
      key: row.key, title: row.title, text: row.text, textHash: row.digest,
      tokens: JSON.parse(row.tokens || '[]'), audio: publicAudio(audio), connected: Boolean(audioConfig().baseUrl),
      method: db.prepare('SELECT method FROM analyses WHERE book=?').get(book.id)?.method,
      lemmaCount: JSON.parse(row.lemmas || '[]').length,
      nextKey: db.prepare('SELECT key FROM chapters WHERE book=? AND ordinal>? ORDER BY ordinal LIMIT 1').get(book.id, row.ordinal)?.key,
    };
  }

  function chapters(book) {
    return {
      analysis: info(book),
      narration: completeAudio.status(book),
      chapters: db.prepare('SELECT key, title, lemmas, length(trim(text)) AS characters FROM chapters WHERE book=? ORDER BY ordinal').all(book.id)
        .map(({ lemmas, ...row }) => ({ ...row, narratable: row.characters > 0 && (!demo || row.characters <= 20000),
          lemmaCount: JSON.parse(lemmas || '[]').length, audio: publicAudio(audioRow(book, row.key)) })),
    };
  }

  function queue(book, key, replace = false, start = true) {
    if (!config.baseUrl) throw new RequestError(422, 'Connect a Kokoro server in Settings → Narration.');
    const row = chapter(book, key);
    if (!row.text) throw new RequestError(422, 'This section has no selectable text for narration.');
    if (demo && row.text.length > 20000) throw new RequestError(422, 'Demo narration supports sections of up to 20,000 characters.');
    const options = { voice: config.voice, model: config.model, speed: config.speed, baseUrl: config.baseUrl };
    const candidates = db.prepare('SELECT * FROM audio WHERE book=? AND chapter=? AND digest=? AND options=? ORDER BY created DESC,rowid DESC')
      .all(book.id, key, row.digest, JSON.stringify(options));
    const running = candidates.find((candidate) => ['queued', 'generating', 'aligning'].includes(candidate.state));
    if (running) return publicAudio(running);
    const cached = candidates.find((candidate) => candidate.state === 'ready');
    if (!replace && cached) return publicAudio(cached);
    db.prepare('INSERT INTO audio(id, book, chapter, digest, options, state, created) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), book.id, key, row.digest, JSON.stringify(options), 'queued', Date.now());
    if (start) void work();
    return publicAudio(audioRow(book, key));
  }

  async function analyze(row) {
    db.prepare("UPDATE analyses SET state='running', error=NULL WHERE book=?").run(row.book);
    const book = library.getBook(row.book, { id: row.owner });
    const sections = await extractBook(book, library.filePath(book), languageCall);
    const stillCurrent = () => db.prepare("SELECT book FROM analyses WHERE book=? AND language=? AND state='running'").get(book.id, row.language);
    if (!stillCurrent()) return;
    const unique = new Set();
    let wordCount = 0;
    let method = 'contextual';
    for (const [ordinal, section] of sections.entries()) {
      const tokens = [];
      const lemmas = new Set();
      for (const chunk of textChunks(section.text, 95000)) {
        const result = await languageCall('/analyze', { text: chunk.text, language: book.language });
        if (!stillCurrent()) return;
        tokens.push(...result.tokens.map((token) => ({ ...token, from: token.from + chunk.from, to: token.to + chunk.from })));
        for (const lemma of result.lemmas) { unique.add(lemma); lemmas.add(lemma); }
        if (result.method !== 'contextual') method = result.method;
      }
      wordCount += tokens.length;
      db.prepare(`INSERT INTO chapters(book,key,ordinal,title,text,digest,tokens,lemmas,markers) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(book,key) DO UPDATE SET ordinal=excluded.ordinal,title=excluded.title,text=excluded.text,
        digest=excluded.digest,tokens=excluded.tokens,lemmas=excluded.lemmas,markers=excluded.markers`).run(
        book.id, section.key, ordinal, section.title, section.text, hash(section.text), JSON.stringify(tokens), JSON.stringify([...lemmas]),
        JSON.stringify(section.markers || [{ title: section.title, from: 0 }]),
      );
    }
    if (!db.prepare('SELECT book FROM analyses WHERE book=? AND language=?').get(book.id, row.language)) return;
    db.prepare("UPDATE analyses SET state='ready', lemmas=?, wordCount=?, method=? WHERE book=?")
      .run(JSON.stringify([...unique].sort()), wordCount, method, book.id);
    db.prepare("INSERT INTO estimates(book,state) VALUES(?,'queued') ON CONFLICT(book) DO UPDATE SET state='queued',json=NULL,error=NULL").run(book.id);
  }

  async function estimate(row) {
    db.prepare("UPDATE estimates SET state='running',error=NULL WHERE book=?").run(row.book);
    const chapters = db.prepare('SELECT text FROM chapters WHERE book=? ORDER BY ordinal').all(row.book);
    const sample = readingSamples(chapters);
    if (sample.passages.join('').length < 80) {
      db.prepare("UPDATE estimates SET state='ready',json=? WHERE book=?")
        .run(JSON.stringify({ band: null, text: 'More text is needed to estimate reading demand.' }), row.book);
      return;
    }
    const result = await ai.readingLevel(sample, new AbortController().signal);
    db.prepare("UPDATE estimates SET state='ready',json=? WHERE book=?").run(JSON.stringify(result), row.book);
  }

  async function generate(job) {
    const row = db.prepare('SELECT * FROM chapters WHERE book=? AND key=?').get(job.book, job.chapter);
    const analysis = db.prepare('SELECT owner FROM analyses WHERE book=?').get(job.book);
    library.getBook(job.book, { id: analysis?.owner });
    if (!row || row.digest !== job.digest) throw new Error('The text changed. Generate narration again.');
    const options = JSON.parse(job.options);
    if (options.baseUrl !== config.baseUrl) throw new Error('The Kokoro connection changed. Queue narration again.');
    const captured = { ...config, ...options };
    const temporary = join(folder, job.id);
    await mkdir(temporary, { recursive: true });
    const language = db.prepare('SELECT language FROM analyses WHERE book=?').get(job.book).language;
    const words = textWords(row.text, language);
    const timings = words.map((word) => ({ ...word, start: null, end: null }));
    const files = [];
    let offset = 0;
    try {
      for (const [index, chunk] of textChunks(row.text, 1800).entries()) {
        if (!db.prepare('SELECT id FROM audio WHERE id=?').get(job.id)) return;
        db.prepare("UPDATE audio SET state='generating' WHERE id=?").run(job.id);
        const response = await kokoro('/audio/speech', {
          model: captured.model, voice: captured.voice, speed: captured.speed, input: chunk.text,
          response_format: 'wav', stream: false,
        }, captured);
        const data = Buffer.from(await response.arrayBuffer());
        if (data.length > 18 * 1024 * 1024) throw new Error('Kokoro returned an unexpectedly large audio chunk.');
        const source = join(temporary, `source-${index}.wav`);
        const wav = join(temporary, `part-${index}.wav`);
        await writeFile(source, data);
        await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { timeout: 60000 });
        const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', wav], { timeout: 15000 });
        const duration = Number(stdout.trim());
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('Kokoro returned invalid audio.');
        db.prepare("UPDATE audio SET state='aligning' WHERE id=?").run(job.id);
        const chunkWords = words.map((word, tokenIndex) => ({ ...word, tokenIndex })).filter((word) => word.from >= chunk.from && word.from < chunk.to);
        const aligned = await languageCall('/align', {
          audio: (await readFile(wav)).toString('base64'), words: chunkWords.map((word) => word.word),
          language,
        });
        for (const [position, stamp] of aligned.timings.entries()) {
          if (!stamp || !chunkWords[position] || stamp.start < 0 || stamp.end > duration + .2 || stamp.end <= stamp.start) continue;
          Object.assign(timings[chunkWords[position].tokenIndex], { start: stamp.start + offset, end: stamp.end + offset, review: stamp.review });
        }
        files.push(wav);
        offset += duration;
      }
      const concat = join(temporary, 'parts.txt');
      await writeFile(concat, files.map((file) => `file '${file}'`).join('\n'));
      const result = join(temporary, 'narration.mp3');
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat, '-c:a', 'libmp3lame', '-b:a', '96k', result], { timeout: 180000 });
      if (!db.prepare('SELECT id FROM audio WHERE id=?').get(job.id)) return;
      await rename(result, join(folder, `${job.id}.mp3`));
      const saved = db.prepare("UPDATE audio SET state='ready', timings=?, duration=?, error=NULL WHERE id=?")
        .run(JSON.stringify(timings), offset, job.id);
      if (!saved.changes) await rm(join(folder, `${job.id}.mp3`), { force: true });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async function work() {
    if (working) return;
    working = true;
    let job;
    let type;
    try {
      job = db.prepare("SELECT * FROM analyses WHERE state='queued' ORDER BY rowid LIMIT 1").get();
      type = 'analysis';
      if (job) await analyze(job);
      else {
        type = 'audio';
        job = db.prepare("SELECT * FROM audio WHERE state='queued' ORDER BY created, rowid LIMIT 1").get();
        if (job) await generate(job);
        else {
          type = 'book';
          job = completeAudio.next();
          if (job) await completeAudio.assemble(job);
          else {
            type = 'estimate';
            job = db.prepare("SELECT * FROM estimates WHERE state='queued' ORDER BY rowid LIMIT 1").get();
            if (job) await estimate(job);
          }
        }
      }
    } catch (error) {
      const text = error instanceof RequestError ? error.message
        : ['audio', 'book'].includes(type) ? 'Narration failed. Check Kokoro and the language service, then try again.'
          : type === 'estimate' ? 'Reading estimate unavailable. Check the AI connection and try again.'
            : 'This book could not be analyzed. Check the language service and try again.';
      if (job && type === 'book') completeAudio.fail(job, text);
      else if (job) {
        const query = type === 'analysis' ? "UPDATE analyses SET state='error', error=? WHERE book=?"
          : type === 'estimate' ? "UPDATE estimates SET state='error',error=? WHERE book=?"
            : "UPDATE audio SET state='error', error=? WHERE id=?";
        db.prepare(query).run(text, type === 'audio' ? job.id : job.book);
      }
      console.error(type === 'audio' ? 'Narration job failed' : 'Book analysis failed', error.name);
    } finally {
      working = false;
    }
  }
  const timer = setInterval(() => void work(), 1000);
  timer.unref();

  async function remove(id) {
    const recordings = db.prepare('SELECT id FROM audio WHERE book=?').all(id);
    const completeFiles = completeAudio.files(id);
    db.prepare('DELETE FROM analyses WHERE book=?').run(id);
    await Promise.allSettled([...recordings.flatMap(({ id: audioId }) => [
      rm(join(folder, `${audioId}.mp3`), { force: true }), rm(join(folder, audioId), { recursive: true, force: true }),
    ]), ...completeFiles.map((file) => rm(file, { recursive: true, force: true }))]);
  }

  function audioFile(book, id) {
    const complete = completeAudio.audioFile(book, id);
    if (complete) return complete;
    const row = db.prepare("SELECT id FROM audio WHERE book=? AND id=? AND state='ready'").get(book.id, id);
    if (!row) throw new RequestError(404, 'Narration not found.');
    return join(folder, `${row.id}.mp3`);
  }
  function cancel(book) {
    const cancelled = completeAudio.cancel(book);
    db.prepare("UPDATE audio SET state='cancelled' WHERE book=? AND state='queued'").run(book.id);
    return cancelled;
  }

  async function prune() {
    for (const row of db.prepare('SELECT book,owner FROM analyses').all()) {
      try { library.getBook(row.book, { id: row.owner }); }
      catch { await remove(row.book); }
    }
  }
  return {
    settings, save, voices, info, ensure, unit, chapters, remove, audioFile, prune, cancel,
    narration: completeAudio.status, queueBook: completeAudio.queue,
  };
}
