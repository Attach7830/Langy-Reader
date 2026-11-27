import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { textWords } from '../shared/reading-text.js';
import { RequestError } from './books.js';
import { extractBook, languageChunks } from './book-text.js';
import { narrationChunks } from './narration-text.js';
import { narrationOptions, sectionLanguages } from './language-voices.js';
import { addVocabulary, vocabularySummary } from './vocabulary.js';
import { bookLanguages } from '../shared/language.js';
import { bookCountSignature } from './reading-counts.js';
import { readerVocabulary } from './reader-vocabulary.js';
import { readingEstimates } from './reading-estimates.js';
import { bookNarration } from './book-audio.js';
import { importNarration } from './import-narration.js';
import { hasUsableTimings, synchronizeChunk } from './audio-timing.js';
import { uploadedAudio } from './uploaded-audio.js';
import { audioRescans } from './audio-rescan.js';
import { openIvoox } from './ivoox.js';
import { consumeProcesses, PROCESS_YIELD } from './process-scheduler.js';
import { migrateSpanishFutureSubjunctive, migrateSpanishVerbForms, migrateSpanishTaggedMorphology, migrateLexicalFilters } from './analysis-migrations.js';

const run = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const asText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export async function openLearning(dir, library, demo, ai, { autoRepair = true, nativeLanguage = () => '', withAI = (_visitor, task) => task(), now = Date.now, reserveStorage = async () => () => {}, scheduler } = {}) {
  const workerContext = new AsyncLocalStorage(); let activeExecution;
  const operationSignal = (milliseconds) => AbortSignal.any([AbortSignal.timeout(milliseconds), ...[workerContext.getStore()?.signal].filter(Boolean)]);
  const folder = join(dir, 'narration');
  await mkdir(folder, { recursive: true });
  // A priority switch happens between completed operations, never while a
  // remote request or publication is still in flight. These checkpoints keep
  // completed passages intact while another job owns the shared worker slot.
  const pausedAnalyses = new Map(), pausedAudio = new Map();
  function discardPausedAudio(id) {
    if (!pausedAudio.delete(id)) return;
    void rm(join(folder, id), { recursive: true, force: true }).catch(() => {});
  }
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
    CREATE TABLE IF NOT EXISTS worker_progress (
      id TEXT PRIMARY KEY, book TEXT NOT NULL REFERENCES analyses(book) ON DELETE CASCADE, json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS estimates (
      book TEXT PRIMARY KEY REFERENCES analyses(book) ON DELETE CASCADE, state TEXT NOT NULL, json TEXT, error TEXT
    ) STRICT;
    UPDATE analyses SET state='queued', error=NULL WHERE state='running';
    UPDATE audio SET state='queued', error=NULL WHERE state IN ('generating', 'aligning');
    DELETE FROM worker_progress;
  `);
  function trackWork(id, book) {
    const startedAt = Date.now();
    const save = db.prepare('INSERT INTO worker_progress(id,book,json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json');
    return (phase, complete, total, unit, detail = '') => save.run(id, book,
      JSON.stringify({ phase, complete, total, unit, detail, startedAt, updatedAt: Date.now() }));
  }
  if (!db.prepare('PRAGMA table_info(chapters)').all().some(({ name }) => name === 'markers')) {
    db.exec("ALTER TABLE chapters ADD COLUMN markers TEXT NOT NULL DEFAULT '[]'; UPDATE analyses SET state='queued',error=NULL WHERE state='ready';");
  }
  let languageUpgrade = false;
  for (const [table, name, definition] of [['chapters', 'languages', "TEXT NOT NULL DEFAULT '[]'"],
    ['chapters', 'metrics', 'TEXT'], ['analyses', 'metrics', 'TEXT']]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`); languageUpgrade = true;
    }
  }
  if (languageUpgrade) db.exec("UPDATE analyses SET state='queued',error=NULL WHERE state='ready'");
  if (!db.prepare('PRAGMA table_info(chapters)').all().some(({ name }) => name === 'speechBlocks')) db.exec("ALTER TABLE chapters ADD COLUMN speechBlocks TEXT NOT NULL DEFAULT '[]'");
  if (!db.prepare('PRAGMA table_info(analyses)').all().some(({ name }) => name === 'textVersion')) db.exec('ALTER TABLE analyses ADD COLUMN textVersion INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(analyses)').all().some(({ name }) => name === 'contentRevision')) db.exec("ALTER TABLE analyses ADD COLUMN contentRevision TEXT NOT NULL DEFAULT ''");
  if (!db.prepare('PRAGMA table_info(analyses)').all().some(({ name }) => name === 'languageSelection')) {
    db.exec("ALTER TABLE analyses ADD COLUMN languageSelection TEXT NOT NULL DEFAULT '[]'");
  }
  migrateSpanishFutureSubjunctive(db);
  migrateSpanishVerbForms(db);
  migrateSpanishTaggedMorphology(db);
  migrateLexicalFilters(db);
  const vocabulary = readerVocabulary(db, { completedBooks: library.readBooks ? (visitor) => library.readBooks(visitor) : null, nativeLanguage });
  const estimates = readingEstimates({ db, ai, withAI, scheduler, visitorForBook(id) {
    const row = db.prepare('SELECT owner FROM analyses WHERE book=?').get(id);
    const book = library.getBook(id, { id: row?.owner });
    return { id: book.owner, expires: book.expires };
  } });
  let config = {
    baseUrl: process.env.READER_KOKORO_URL || '', voice: process.env.READER_KOKORO_VOICE || 'ef_dora',
    model: 'kokoro', speed: 1, apiKey: process.env.READER_KOKORO_API_KEY || '', autoLanguageVoices: true, voicesByLanguage: {},
    ...JSON.parse(db.prepare('SELECT json FROM settings WHERE id=1').get()?.json || '{}'),
  };
  const previewAudio = demo && process.env.READER_DEMO_AUDIO_PREVIEW !== '0';
  const audioConfig = () => previewAudio ? { ...config, baseUrl: '', apiKey: '' } : config;
  let working = false, workerLane = 0;
  const completeAudio = bookNarration({
    db, folder, library, demo, previewAudio, configuration: audioConfig, reserveStorage,
    queuePart: (book, key, replace) => queue(book, key, replace, false), wake: () => void work(),
  });
  const scheduledAudio = importNarration({ db, library, demo, configuration: audioConfig, queue: completeAudio.queue, now });
  if (previewAudio) {
    for (const { book } of db.prepare('SELECT book FROM analyses').all()) completeAudio.cancel({ id: book });
    db.exec("UPDATE audio SET state='cancelled' WHERE state IN ('queued','generating','aligning')");
  }
  const workerURL = process.env.READER_LANGUAGE_URL || 'http://127.0.0.1:8091';
  let rescans;
  const recordings = uploadedAudio({ db, folder, library, languageCall, reserveStorage, wake: () => void work(), isRescanning: (id) => rescans?.busy(id) });
  rescans = audioRescans({ db, folder, library, languageCall, publishUploaded: recordings.publish, wake: () => void work() });
  const ivoox = demo ? null : await openIvoox({ db, folder, library, recordings, scheduler });

  async function languageCall(path, body, type = 'application/json') {
    const synchronizing = ['/align', '/transcribe', '/match-recording', '/rescan'].includes(path);
    let response;
    try {
      response = await fetch(new URL(path, workerURL), {
        method: 'POST', headers: { 'Content-Type': type },
        body: type === 'application/json' ? JSON.stringify(body) : body,
        signal: operationSignal(synchronizing ? 600_000 : 180_000),
      });
    } catch (error) {
      workerContext.getStore()?.signal.throwIfAborted();
      if (error.name === 'TimeoutError') throw new RequestError(504, synchronizing
        ? 'Word synchronization exceeded ten minutes. Check the language service CPU and memory, then retry.'
        : 'Language processing timed out. Check the language service and retry.');
      throw new RequestError(503, 'Language processing is unavailable. Start the language service and try again.');
    }
    if (!response.ok) {
      let detail; if (synchronizing) try { detail = (await response.json()).detail; } catch {}
      throw new RequestError(502, synchronizing
        ? 'Word synchronization failed. ' + (typeof detail === 'string' ? detail.replace(/[\x00-\x1f]/gu, ' ').slice(0, 300) : 'Check the language service and try again.')
        : 'The language service could not read this text.');
    }
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
    const voicesByLanguage = body.voicesByLanguage === undefined ? config.voicesByLanguage : body.voicesByLanguage;
    if (!voicesByLanguage || typeof voicesByLanguage !== 'object' || Array.isArray(voicesByLanguage) || Object.keys(voicesByLanguage).length > 20
      || Object.entries(voicesByLanguage).some(([language, value]) => !/^[a-z]{2,3}$/u.test(language) || typeof value !== 'string' || value.length > 120 || /[\r\n]/u.test(value))) throw new RequestError(422, 'Enter valid language voice IDs.');
    if (!voice || !model || !Number.isFinite(speed) || speed < .5 || speed > 2 || /[\r\n]/u.test(key)) {
      throw new RequestError(422, 'Choose a voice, model, and speed between 0.5 and 2.');
    }
    const updated = {
      baseUrl, voice, model, speed,
      autoLanguageVoices: body.autoLanguageVoices === undefined ? config.autoLanguageVoices : body.autoLanguageVoices === true,
      voicesByLanguage: Object.fromEntries(Object.entries(voicesByLanguage).map(([language, value]) => [language, value.trim()]).filter(([, value]) => value)),
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
        body: body ? JSON.stringify(body) : undefined, signal: operationSignal(body ? 300_000 : 15_000),
      });
    } catch {
      workerContext.getStore()?.signal.throwIfAborted();
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

  const textJobs = new Map(), textLanes = { epub: Promise.resolve(), pdf: Promise.resolve() };
  const selectionOf = (book) => JSON.stringify(bookLanguages(book).sort());
  function prepareText(book, retry = false) {
    if (vocabulary.bookCounts(book) && db.prepare('SELECT textVersion FROM analyses WHERE book=?').get(book.id)?.textVersion === 1) return Promise.resolve(true);
    const signature = bookCountSignature(book), previous = textJobs.get(book.id);
    if (previous?.signature === signature) {
      if (!retry && previous.state === 'cancelled') return Promise.resolve(false);
      if (previous.promise) return scheduler ? scheduler.join(`indexing:${book.id}`, previous.promise) : previous.promise;
      if (!retry && previous.state === 'error') return Promise.reject(previous.error);
    }
    const job = { signature, state: 'queued', controller: new AbortController() }, lane = book.format === 'pdf' ? 'pdf' : 'epub';
    textJobs.set(book.id, job);
    const current = () => job.state !== 'cancelled' && textJobs.get(book.id) === job && db.prepare('SELECT book FROM analyses WHERE book=? AND language=? AND languageSelection=? AND contentRevision=?')
      .get(book.id, book.language, selectionOf(book), book.contentRevision || '');
    const extract = async () => {
      if (!current()) return false;
      job.state = 'running';
      const sections = await workerContext.run(job.controller, () => extractBook(book, library.filePath(book), languageCall));
      if (!current()) return false;
      // Persist selectable text before calling NLP. Illustrations and a failed
      // lemma service must not prevent counting or recording reading progress.
      db.exec('BEGIN');
      try {
        const save = db.prepare(`INSERT INTO chapters(book,key,ordinal,title,text,digest,markers,languages,speechBlocks) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(book,key) DO UPDATE SET ordinal=excluded.ordinal,title=excluded.title,text=excluded.text,
          tokens=CASE WHEN chapters.digest=excluded.digest THEN chapters.tokens ELSE NULL END,
          lemmas=CASE WHEN chapters.digest=excluded.digest THEN chapters.lemmas ELSE NULL END,
          metrics=CASE WHEN chapters.digest=excluded.digest THEN chapters.metrics ELSE NULL END,
          digest=excluded.digest,markers=excluded.markers,languages=excluded.languages,speechBlocks=excluded.speechBlocks`);
        for (const [ordinal, section] of sections.entries()) save.run(book.id, section.key, ordinal, section.title, section.text,
          hash(section.text), JSON.stringify(section.markers || [{ title: section.title, from: 0 }]), JSON.stringify(section.languages || []), JSON.stringify(section.speechBlocks || []));
        vocabulary.saveBookCounts(book, sections);
        db.prepare('UPDATE analyses SET textVersion=1 WHERE book=?').run(book.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      vocabulary.reindexReading(book);
      job.state = 'ready';
      return true;
    };
    job.promise = (scheduler ? scheduler.run(`indexing:${book.id}`, extract, { valid: current }) : textLanes[lane].then(extract)).catch((error) => {
      if (job.state === 'cancelled') return false;
      job.state = 'error';
      job.error = error instanceof RequestError ? error : new RequestError(502, book.format === 'pdf'
        ? 'The PDF text could not be extracted. Check the language service and retry analysis. Scanned pages need OCR.'
        : 'The EPUB text could not be extracted. Check the file and retry analysis.');
      throw job.error;
    }).finally(() => { job.promise = null; if (job.state === 'ready' && textJobs.get(book.id) === job) textJobs.delete(book.id); });
    if (!scheduler) textLanes[lane] = job.promise.catch(() => {});
    return scheduler ? scheduler.join(`indexing:${book.id}`, job.promise) : job.promise;
  }

  function ensure(book, retry = false) {
    const previous = db.prepare('SELECT * FROM analyses WHERE book=?').get(book.id);
    const selection = selectionOf(book);
    if (!previous || previous.language !== book.language || previous.languageSelection !== selection || previous.contentRevision !== (book.contentRevision || '') || (retry && !['queued', 'running'].includes(previous.state))) {
      pausedAnalyses.delete(book.id);
      db.prepare(`INSERT INTO analyses(book, owner, language, languageSelection,contentRevision, state) VALUES(?,?,?,?,?,'queued')
        ON CONFLICT(book) DO UPDATE SET language=excluded.language,languageSelection=excluded.languageSelection,contentRevision=excluded.contentRevision,state='queued',error=NULL,
        metrics=NULL,lemmas=NULL,wordCount=NULL,method=NULL,textVersion=0`)
        .run(book.id, book.owner || '', book.language, selection, book.contentRevision || '');
      estimates.invalidate(book.id);
      db.prepare('DELETE FROM reading_book_counts WHERE book=?').run(book.id);
    }
    void prepareText(book, retry).catch(() => {});
    void work();
  }

  function info(book) {
    ensure(book);
    const row = db.prepare('SELECT state, lemmas, wordCount, method, error, metrics FROM analyses WHERE book=?').get(book.id);
    const count = row.lemmas ? JSON.parse(row.lemmas).length : null;
    if (row.state === 'ready' && !estimates.status(book)) estimates.queue(book);
    const reading = estimates.status(book);
    const counts = vocabulary.bookCounts(book), textJob = textJobs.get(book.id);
    const counting = { state: counts ? 'ready' : textJob?.state || 'queued', error: textJob?.error?.message || null };
    return { state: row.state, lemmaCount: count, wordCount: row.wordCount, counts, counting, reading, method: row.method, error: row.error,
      vocabulary: row.metrics ? JSON.parse(row.metrics) : null };
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
      analysisState: db.prepare('SELECT state FROM analyses WHERE book=?').get(book.id)?.state,
      tokens: JSON.parse(row.tokens || '[]'), audio: publicAudio(audio), connected: Boolean(audioConfig().baseUrl),
      method: db.prepare('SELECT method FROM analyses WHERE book=?').get(book.id)?.method,
      lemmaCount: JSON.parse(row.lemmas || '[]').length,
      languages: JSON.parse(row.languages || '[]'), vocabulary: row.metrics ? JSON.parse(row.metrics) : null,
      nextKey: db.prepare('SELECT key FROM chapters WHERE book=? AND ordinal>? ORDER BY ordinal LIMIT 1').get(book.id, row.ordinal)?.key,
    };
  }

  function chapters(book) {
    return {
      analysis: info(book),
      narration: narration(book), rescanAvailable: !demo,
      chapters: db.prepare('SELECT key, title, lemmas,metrics, length(trim(text)) AS characters,has_spoken_text(text) AS spoken FROM chapters WHERE book=? ORDER BY ordinal').all(book.id)
        .map(({ lemmas, spoken, metrics, ...row }) => ({ ...row, vocabulary: metrics ? JSON.parse(metrics) : null, narratable: Boolean(spoken) && (!demo || row.characters <= 20000),
          lemmaCount: JSON.parse(lemmas || '[]').length, audio: publicAudio(audioRow(book, row.key)) })),
    };
  }

  function queue(book, key, replace = false, start = true) {
    if (!config.baseUrl) throw new RequestError(422, 'Connect a Kokoro server in Settings → Narration.');
    const row = chapter(book, key);
    if (!/[\p{L}\p{N}]/u.test(row.text)) throw new RequestError(422, 'This section has no selectable text for narration.');
    if (demo && row.text.length > 20000) throw new RequestError(422, 'Demo narration supports sections of up to 20,000 characters.');
    const options = narrationOptions(config, sectionLanguages(db.prepare('SELECT languages FROM chapters WHERE book=?').all(book.id), book.language));
    const candidates = db.prepare('SELECT * FROM audio WHERE book=? AND chapter=? AND digest=? AND options=? ORDER BY created DESC,rowid DESC')
      .all(book.id, key, row.digest, JSON.stringify(options));
    const running = candidates.find((candidate) => ['queued', 'generating', 'aligning'].includes(candidate.state));
    if (running) return publicAudio(running);
    const cached = candidates.find((candidate) => candidate.state === 'ready' && hasUsableTimings(candidate.timings, candidate.duration));
    if (!replace && cached) return publicAudio(cached);
    db.prepare('INSERT INTO audio(id, book, chapter, digest, options, state, created) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), book.id, key, row.digest, JSON.stringify(options), 'queued', Date.now());
    if (start) void work();
    return publicAudio(audioRow(book, key));
  }

  async function analyze(row) {
    db.prepare("UPDATE analyses SET state='running', error=NULL WHERE book=?").run(row.book);
    const book = library.getBook(row.book, { id: row.owner });
    if (!await prepareText(book)) return;
    const stillCurrent = () => db.prepare("SELECT book FROM analyses WHERE book=? AND language=? AND languageSelection=? AND contentRevision=? AND state='running'").get(book.id, row.language, row.languageSelection, row.contentRevision);
    if (!stillCurrent()) return;
    const signature = JSON.stringify([row.language, row.languageSelection, row.contentRevision]);
    let checkpoint = pausedAnalyses.get(book.id); pausedAnalyses.delete(book.id);
    if (checkpoint?.signature !== signature) checkpoint = null;
    checkpoint ||= { signature, ordinal: 0, passage: null, unique: new Set(), vocabularyGroups: new Map(), chinesePassages: [], wordCount: 0, method: 'contextual',
      sections: db.prepare('SELECT * FROM chapters WHERE book=? ORDER BY ordinal').all(book.id)
        .map((section) => ({ ...section, languages: JSON.parse(section.languages || '[]'), markers: JSON.parse(section.markers || '[]') })),
      report: trackWork(`analysis:${book.id}`, book.id) };
    const { sections, unique, vocabularyGroups, chinesePassages, report } = checkpoint;
    report('analyzing', checkpoint.ordinal, sections.length, 'sections');
    for (; checkpoint.ordinal < sections.length; checkpoint.ordinal++) {
      const ordinal = checkpoint.ordinal, section = sections[ordinal];
      checkpoint.passage ||= { index: 0, tokens: [], lemmas: new Set(), sectionGroups: new Map(), chinese: [], chunks: languageChunks(section, 95000, book.language) };
      const { tokens, lemmas, sectionGroups, chinese, chunks } = checkpoint.passage;
      while (checkpoint.passage.index < chunks.length) {
        const index = checkpoint.passage.index, chunk = chunks[index];
        report('analyzing', ordinal, sections.length, 'sections', `Section ${ordinal + 1} of ${sections.length} · passage ${index + 1} of ${chunks.length}`);
        const result = await languageCall('/analyze', { text: chunk.text, language: chunk.language });
        if (!stillCurrent()) return;
        addVocabulary(vocabularyGroups, chunk.language, result); addVocabulary(sectionGroups, chunk.language, result);
        if (chunk.language === 'zh') { chinese.push(chunk.text); chinesePassages.push(chunk.text); }
        tokens.push(...result.tokens.map((token) => ({ ...token, language: chunk.language, from: token.from + chunk.from, to: token.to + chunk.from })));
        if (chunk.language !== 'zh') for (const lemma of result.lemmas) { const identity = `${chunk.language}:${lemma}`; unique.add(identity); lemmas.add(identity); }
        if (!['contextual', 'characters'].includes(result.method)) checkpoint.method = result.method;
        checkpoint.passage.index++;
        if (scheduler?.shouldYield()) {
          pausedAnalyses.set(book.id, checkpoint);
          db.prepare("UPDATE analyses SET state='queued' WHERE book=? AND state='running'").run(book.id);
          return PROCESS_YIELD;
        }
      }
      checkpoint.wordCount += tokens.filter((token) => token.language !== 'zh').length;
      db.prepare(`INSERT INTO chapters(book,key,ordinal,title,text,digest,tokens,lemmas,markers,languages,metrics) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(book,key) DO UPDATE SET ordinal=excluded.ordinal,title=excluded.title,text=excluded.text,
        digest=excluded.digest,tokens=excluded.tokens,lemmas=excluded.lemmas,markers=excluded.markers,languages=excluded.languages,metrics=excluded.metrics`).run(
        book.id, section.key, ordinal, section.title, section.text, hash(section.text), JSON.stringify(tokens), JSON.stringify([...lemmas]),
        JSON.stringify(section.markers || [{ title: section.title, from: 0 }]),
        JSON.stringify(section.languages || []), JSON.stringify(vocabularySummary(chinese.join('\n'), sectionGroups, book.language)),
      );
      report('analyzing', ordinal + 1, sections.length, 'sections');
      checkpoint.passage = null;
    }
    if (!stillCurrent()) return;
    const metrics = vocabularySummary(chinesePassages.join('\n'), vocabularyGroups, book.language);
    db.prepare("UPDATE analyses SET state='ready', lemmas=?, wordCount=?, method=?,metrics=? WHERE book=?")
      .run(JSON.stringify([...unique].sort()), checkpoint.wordCount, metrics.unit === 'characters' ? 'characters' : checkpoint.method, JSON.stringify(metrics), book.id);
    vocabulary.reindex(book);
    db.prepare('DELETE FROM worker_progress WHERE id=?').run(`analysis:${book.id}`);
    estimates.queue(book);
  }

  async function generate(job) {
    const analysis = db.prepare('SELECT owner FROM analyses WHERE book=?').get(job.book);
    const book = library.getBook(job.book, { id: analysis?.owner });
    if (!await prepareText(book)) throw new Error('The book text changed. Generate narration again.');
    const row = db.prepare('SELECT * FROM chapters WHERE book=? AND key=?').get(job.book, job.chapter);
    if (!row || row.digest !== job.digest) throw new Error('The text changed. Generate narration again.');
    const options = JSON.parse(job.options);
    if (options.baseUrl !== config.baseUrl) throw new Error('The Kokoro connection changed. Queue narration again.');
    const captured = { ...config, ...options };
    const temporary = join(folder, job.id);
    await mkdir(temporary, { recursive: true });
    const language = db.prepare('SELECT language FROM analyses WHERE book=?').get(job.book).language;
    const signature = JSON.stringify([job.digest, job.options, row.text, row.speechBlocks, row.languages]);
    let checkpoint = pausedAudio.get(job.id); pausedAudio.delete(job.id);
    if (checkpoint?.signature !== signature) checkpoint = null;
    const words = checkpoint?.words || textWords(row.text, language);
    checkpoint ||= { signature, book: job.book, words, timings: words.map((word) => ({ ...word, start: null, end: null })), files: [],
      chunks: narrationChunks(row, language), index: 0, offset: 0, report: trackWork(`audio:${job.id}`, job.book) };
    const { timings, files, chunks, report } = checkpoint;
    report('generating', checkpoint.index, chunks.length, 'passages');
    let offset = checkpoint.offset, paused = false;
    try {
      for (let index = checkpoint.index; index < chunks.length; index++) {
        const chunk = chunks[index];
        if (!db.prepare("SELECT id FROM audio WHERE id=? AND state!='cancelled'").get(job.id)) return;
        const chunkWords = words.map((word, tokenIndex) => ({ ...word, tokenIndex })).filter((word) => word.from >= chunk.from && word.from < chunk.to);
        if (!chunkWords.length) continue;
        db.prepare("UPDATE audio SET state='generating' WHERE id=?").run(job.id);
        report('generating', index, chunks.length, 'passages');
        const response = await kokoro('/audio/speech', {
          model: captured.model, voice: options.voiceMap?.[chunk.language] || captured.voice, speed: captured.speed, input: chunk.input,
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
        report('aligning', index, chunks.length, 'passages');
        const aligned = await languageCall('/align', {
          audio: (await readFile(wav)).toString('base64'), words: chunkWords.map((word) => word.word),
          language: chunk.language, text: chunk.text,
        });
        for (const stamp of synchronizeChunk(chunkWords, aligned.timings, duration)) {
          if (stamp.start == null) continue;
          Object.assign(timings[stamp.tokenIndex], { start: stamp.start + offset, end: stamp.end + offset,
            review: stamp.review || chunk.kind === 'label', ...(stamp.estimated || chunk.kind === 'label' ? { estimated: true } : {}) });
        }
        if (chunk.pauseAfter) {
          const padded = join(temporary, `padded-${index}.wav`);
          await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', wav, '-af', `apad=pad_dur=${chunk.pauseAfter}`, '-c:a', 'pcm_s16le', padded], { timeout: 60000 });
          files.push(padded);
        } else files.push(wav);
        offset += duration + chunk.pauseAfter;
        checkpoint.index = index + 1; checkpoint.offset = offset;
        report('generating', index + 1, chunks.length, 'passages');
        workerContext.getStore()?.signal.throwIfAborted();
        if (scheduler?.shouldYield()) {
          pausedAudio.set(job.id, checkpoint); paused = true;
          db.prepare("UPDATE audio SET state='queued' WHERE id=? AND state!='cancelled'").run(job.id);
          return PROCESS_YIELD;
        }
      }
      report('saving', chunks.length, chunks.length, 'passages');
      const concat = join(temporary, 'parts.txt');
      await writeFile(concat, files.map((file) => `file '${file}'`).join('\n'));
      const result = join(temporary, 'narration.mp3');
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat, '-c:a', 'libmp3lame', '-b:a', '96k', result], { timeout: 180000 });
      if (!db.prepare("SELECT id FROM audio WHERE id=? AND state!='cancelled'").get(job.id)) return;
      const release = await reserveStorage(library.getBook(job.book).owner || '', (await stat(result)).size);
      try {
        await rename(result, join(folder, `${job.id}.mp3`));
        const saved = db.prepare("UPDATE audio SET state='ready', timings=?, duration=?, error=NULL WHERE id=? AND state!='cancelled'")
          .run(JSON.stringify(timings), offset, job.id);
        if (!saved.changes) await rm(join(folder, `${job.id}.mp3`), { force: true });
        db.prepare('DELETE FROM worker_progress WHERE id=?').run(`audio:${job.id}`);
      } finally { release(); }
    } finally {
      if (!paused) await rm(temporary, { recursive: true, force: true });
    }
  }

  function failed(type, job, error) {
    if (type === 'analysis' && job) pausedAnalyses.delete(job.book);
    if (type === 'audio' && job) discardPausedAudio(job.id);
    const text = error instanceof RequestError ? error.message
      : type === 'rescan' ? 'Audio rescan failed. Your existing alignment is unchanged. Check the language service and retry.'
        : type === 'recording' ? 'Recording synchronization failed. Check the language service and retry Sync with book.'
        : ['audio', 'book'].includes(type) ? 'Narration failed. Check Kokoro and the language service, then try again.'
        : 'This book could not be analyzed. Check the language service and try again.';
    if (job && type === 'book') completeAudio.fail(job, text);
    else if (job && type === 'rescan') rescans.fail(job, text);
    else if (job && type === 'recording') recordings.fail(job, text);
    else if (job && type === 'analysis') {
      db.prepare("UPDATE analyses SET state='error',error=? WHERE book=? AND language=? AND languageSelection=? AND contentRevision=? AND state IN ('queued','running')")
        .run(text, job.book, job.language, job.languageSelection, job.contentRevision || '');
    } else if (job) db.prepare("UPDATE audio SET state='error', error=? WHERE id=? AND state!='cancelled'").run(text, job.id);
    console.error(type === 'rescan' ? 'Audio rescan failed' : type === 'recording' ? 'Recording synchronization failed' : type === 'audio' ? 'Narration job failed' : 'Book analysis failed', error.name);
  }

  async function scheduledWork() {
    void estimates.pump();
    if (working) return;
    working = true;
    try {
      scheduledAudio.pump();
      // Admit text extraction first; analysis can then acquire the shared slot
      // without waiting on a different queued worker that needs that same slot.
      for (const row of db.prepare("SELECT * FROM analyses WHERE state='queued'").all()) {
        try { void prepareText(library.getBook(row.book, { id: row.owner })).catch((error) => failed('analysis', row, error)); }
        catch (error) { failed('analysis', row, error); }
      }
      const candidates = () => {
        const rows = [], parents = db.prepare("SELECT * FROM book_audio WHERE state='queued' AND kind='generated' ORDER BY created,rowid").all();
        const parts = new Set(parents.flatMap((row) => JSON.parse(row.parts).map((part) => part.id)));
        const add = (type, id, row, created) => {
          const text = textJobs.get(row.book), blocked = text && ['queued','running'].includes(text.state);
          rows.push({ id, created, ready: !blocked, dependencies: blocked ? [`indexing:${row.book}`] : [], data: { type, job: row } });
        };
        for (const row of db.prepare("SELECT * FROM analyses WHERE state='queued' ORDER BY rowid").all()) add('analysis', `analysis:${row.book}`, row);
        for (const row of parents) add('book', `narration:${row.id}`, row, row.created);
        for (const row of db.prepare("SELECT * FROM audio WHERE state='queued' ORDER BY created,rowid").all()) if (!parts.has(row.id)) add('audio', `audio-section:${row.id}`, row, row.created);
        if (!demo) {
          for (const row of db.prepare("SELECT * FROM recordings WHERE state IN ('queued','syncing','assembling') ORDER BY created,id").all()) add('recording', `recording:${row.id}`, row, row.created);
          for (const row of db.prepare("SELECT * FROM audio_rescans WHERE state='queued' ORDER BY created,id").all()) add('rescan', `repair:${row.id}`, row, row.created);
        }
        return rows;
      };
      await consumeProcesses(scheduler, candidates, async ({ type, job }) => {
        const controller = new AbortController(); activeExecution = { type, job, controller };
        try {
          const result = await workerContext.run(controller, async () => {
            if (type === 'book') {
              for (const part of JSON.parse(job.parts)) {
                if (!db.prepare("SELECT id FROM book_audio WHERE id=? AND state='queued'").get(job.id)) return;
                const row = db.prepare('SELECT * FROM audio WHERE id=?').get(part.id);
                if (!row || ['error','cancelled'].includes(row.state)) throw new RequestError(502, row?.error || 'A section could not be narrated. Retry book audio.');
                if (row.state !== 'ready') {
                  activeExecution = { type: 'audio', job: row, controller };
                  if (await generate(row) === PROCESS_YIELD) return PROCESS_YIELD;
                }
                if (scheduler.shouldYield()) return PROCESS_YIELD;
              }
              activeExecution = { type: 'book', job, controller }; await completeAudio.assemble(job);
            } else if (type === 'recording' || type === 'rescan') {
              const table = type === 'recording' ? 'recordings' : 'audio_rescans';
              const process = type === 'recording' ? recordings.process : rescans.process;
              for (;;) {
                const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(job.id);
                if (!row || !['queued','syncing','assembling'].includes(row.state)) break;
                await process(row);
                const next = db.prepare(`SELECT state FROM ${table} WHERE id=?`).get(job.id);
                if (next && ['queued','syncing','assembling'].includes(next.state) && scheduler.shouldYield()) return PROCESS_YIELD;
              }
            } else return (type === 'analysis' ? analyze : generate)(job);
          });
          if (result === PROCESS_YIELD) return PROCESS_YIELD;
          if (autoRepair && !demo && ['analysis','book','recording'].includes(type)) autoRepairBook(job.book);
        } catch (error) {
          if (type === 'book' && activeExecution?.type === 'audio') failed('audio', activeExecution.job, error);
          failed(type, job, error);
        }
        finally { activeExecution = undefined; }
      });
    } finally { working = false; }
  }

  async function work() {
    if (scheduler) return scheduledWork();
    void estimates.pump();
    if (working) return;
    working = true;
    let job;
    let type;
    try {
      scheduledAudio.pump();
      // Give every queue a turn. Continually importing/generating books must
      // not starve existing alignment repairs, or vice versa.
      const lanes = [
        ['analysis', () => db.prepare("SELECT * FROM analyses WHERE state='queued' ORDER BY rowid LIMIT 1").get(), analyze],
        ['audio', () => db.prepare("SELECT * FROM audio WHERE state='queued' ORDER BY created,rowid LIMIT 1").get(), generate],
        ['book', completeAudio.next, completeAudio.assemble],
        ['recording', () => demo ? null : recordings.next(), recordings.process],
        ['rescan', () => demo ? null : rescans.next(), rescans.process],
      ];
      for (let offset = 0; offset < lanes.length; offset++) {
        const lane = (workerLane + offset) % lanes.length, [kind, next, process] = lanes[lane];
        const selected = next(); if (!selected) continue;
        job = selected; type = kind; workerLane = (lane + 1) % lanes.length;
        activeExecution = { type, job, controller: new AbortController() };
        await workerContext.run(activeExecution.controller, () => process(job)); break;
      }
      if (job && autoRepair && !demo && ['analysis', 'book', 'recording'].includes(type)) autoRepairBook(job.book);
    } catch (error) {
      failed(type, job, error);
    } finally {
      activeExecution = undefined;
      working = false;
    }
  }
  const timer = setInterval(() => void work(), 1000);
  timer.unref();
  function autoRepairBook(id) {
    const row = db.prepare("SELECT owner FROM analyses WHERE book=? AND state='ready'").get(id);
    if (!row) return;
    let book; try { book = library.getBook(id, { id: row.owner }); } catch { return; }
    for (const recording of db.prepare("SELECT id FROM book_audio WHERE book=? AND state='ready'").all(id)) {
      try { rescans.automatic(book, recording.id); } catch { /* Text changes or a concurrent rescan wait for a compatible recording. */ }
    }
  }
  if (autoRepair && !demo) setImmediate(() => { for (const row of db.prepare("SELECT book FROM analyses WHERE state='ready'").all()) autoRepairBook(row.book); });

  async function remove(id) {
    textJobs.delete(id);
    pausedAnalyses.delete(id);
    for (const [audioId, checkpoint] of pausedAudio) if (checkpoint.book === id) pausedAudio.delete(audioId);
    estimates.invalidate(id);
    ivoox?.cancel({ id });
    const sectionRecordings = db.prepare('SELECT id FROM audio WHERE book=?').all(id);
    const completeFiles = completeAudio.files(id);
    const recordingFiles = recordings.files(id);
    const rescanFiles = rescans.files(id);
    db.prepare('DELETE FROM analyses WHERE book=?').run(id);
    await Promise.allSettled([...sectionRecordings.flatMap(({ id: audioId }) => [
      rm(join(folder, `${audioId}.mp3`), { force: true }), rm(join(folder, audioId), { recursive: true, force: true }),
    ]), ...[...completeFiles, ...recordingFiles, ...rescanFiles].map((file) => rm(file, { recursive: true, force: true }))]);
  }

  function audioFile(book, id) {
    const complete = completeAudio.audioFile(book, id);
    if (complete) return complete;
    const row = db.prepare("SELECT id,options FROM audio WHERE book=? AND id=? AND state='ready'").get(book.id, id);
    if (!row) throw new RequestError(404, 'Narration not found.');
    const options = JSON.parse(row.options);
    return join(folder, `${options.source === 'uploaded' ? options.recording : row.id}.mp3`);
  }
  function cancel(book) {
    scheduledAudio.cancel(book);
    const cancelled = completeAudio.cancel(book);
    db.prepare("UPDATE audio SET state='cancelled' WHERE book=? AND state IN ('queued','generating','aligning')").run(book.id);
    for (const [id, checkpoint] of pausedAudio) if (checkpoint.book === book.id) discardPausedAudio(id);
    if (activeExecution?.job.book === book.id && ['audio','book'].includes(activeExecution.type)) activeExecution.controller.abort(new DOMException('Cancelled','AbortError'));
    return cancelled;
  }
  function cancelProcess(kind, book, id) {
    if (kind === 'estimate') estimates.cancel(book.id);
    else if (kind === 'scheduled-narration') scheduledAudio.cancel(book);
    else if (kind === 'recording') recordings.cancel(book, id);
    else if (kind === 'repair') { const row = db.prepare('SELECT recording FROM audio_rescans WHERE book=? AND id=?').get(book.id, id); if (row) rescans.cancel(book,row.recording); }
    else if (kind === 'narration') completeAudio.cancel(book,id);
    else if (kind === 'audio-section') db.prepare("UPDATE audio SET state='cancelled',error=NULL WHERE book=? AND id=? AND state IN ('queued','generating','aligning')").run(book.id,id);
    else if (['analysis','indexing'].includes(kind)) {
      pausedAnalyses.delete(book.id);
      db.prepare("UPDATE analyses SET state='cancelled',error=NULL WHERE book=? AND state IN ('queued','running')").run(book.id);
      const text=textJobs.get(book.id); if (text) {text.state='cancelled';text.controller.abort(new DOMException('Cancelled','AbortError'));}
    } else throw new RequestError(422,'This process cannot be cancelled.');
    for (const [audioId, checkpoint] of pausedAudio) if (checkpoint.book === book.id
      && !db.prepare("SELECT id FROM audio WHERE id=? AND state!='cancelled'").get(audioId)) discardPausedAudio(audioId);
    const types={analysis:'analysis',indexing:'analysis',narration:'book','audio-section':'audio',recording:'recording',repair:'rescan'};
    if (activeExecution?.job.book === book.id) {
      const sameJob = ['analysis','indexing'].includes(kind) || activeExecution.job.id === id;
      const cancelledPart = kind === 'narration' && activeExecution.type === 'audio' && db.prepare("SELECT 1 FROM audio WHERE id=? AND state='cancelled'").get(activeExecution.job.id);
      if (sameJob && activeExecution.type === types[kind] || cancelledPart) activeExecution.controller.abort(new DOMException('Cancelled','AbortError'));
    }
    return {cancelled:true};
  }

  async function removeRecording(book, id) {
    rescans.cancel(book, id);
    if (recordings.list(book).some((item) => item.id === id)) return recordings.remove(book, id);
    const item = db.prepare('SELECT id,parts,kind FROM book_audio WHERE book=? AND id=?').get(book.id, id);
    if (!item) return; // Replacement cleanup is safe to resume after a restart.
    if (item.kind !== 'generated') throw new RequestError(409, 'This recording cannot be removed.');
    const parts = JSON.parse(item.parts);
    db.prepare('DELETE FROM book_audio WHERE book=? AND id=?').run(book.id, id);
    // Section files can be shared by other generated recordings. Retain those references.
    const used = new Set(db.prepare('SELECT parts FROM book_audio WHERE book=?').all(book.id).flatMap((row) => JSON.parse(row.parts).map((part) => part.id)));
    const unused = parts.filter((part) => !used.has(part.id));
    for (const part of unused) { pausedAudio.delete(part.id); db.prepare('DELETE FROM audio WHERE book=? AND id=?').run(book.id, part.id); }
    await Promise.allSettled([join(folder, `${id}.mp3`), join(folder, `book-${id}`), ...unused.flatMap((part) => [join(folder, `${part.id}.mp3`), join(folder, part.id)])]
      .map((path) => rm(path, { force: true, recursive: true })));
  }

  async function prune() {
    for (const row of db.prepare('SELECT book,owner FROM analyses').all()) {
      try { library.getBook(row.book, { id: row.owner }); }
      catch { await remove(row.book); }
    }
  }
  function narration(book, selected) {
    const result = completeAudio.status(book, selected);
    result.audio.rescan = result.audio.id ? rescans.status(book, result.audio.id) : null;
    return { ...result, scheduled: scheduledAudio.status(book), recordings: demo ? [] : recordings.list(book).filter((item) => item.state === 'ready').map(({ id, name }) => ({ id, name })) };
  }
  return {
    storageFiles(book) {
      const audio = db.prepare('SELECT id FROM audio WHERE book=?').all(book).map(({ id }) => join(folder, `${id}.mp3`));
      const complete = db.prepare('SELECT id FROM book_audio WHERE book=?').all(book).map(({ id }) => join(folder, `${id}.mp3`));
      const uploaded = db.prepare('SELECT id FROM recordings WHERE book=?').all(book).flatMap(({ id }) => ['.source', '.mp3', '.transcript.json', '.chapters'].map((suffix) => join(folder, id + suffix)));
      return [...audio, ...complete, ...uploaded];
    },
    settings, save, voices, info, ensure, unit, chapters, remove, audioFile, prune, cancel, cancelProcess,
    textProcesses: () => [...textJobs].map(([book, job]) => ({ book, state: job.state, error: job.error?.message || null })),
    textSections(book) {
      const rows = db.prepare('SELECT key,ordinal,title,text,digest,tokens,languages FROM chapters WHERE book=? ORDER BY ordinal').all(book.id);
      if (!rows.length) throw new RequestError(409, 'Wait for this book’s text to finish indexing.');
      return rows.map((row) => ({ ...row, tokens: JSON.parse(row.tokens || '[]'), languages: JSON.parse(row.languages || '[]') }));
    },
    narration, queueBook: completeAudio.queue,
    audioSynced(book) {
      const current = db.prepare('SELECT 1 FROM analyses WHERE book=? AND contentRevision=? AND textVersion=1').get(book.id, book.contentRevision || '');
      return Boolean(current && completeAudio.isSynced(book));
    },
    scheduleAudiobook(book, options) { ensure(book); return scheduledAudio.schedule(book, options); },
    readyAudiobooks: () => db.prepare("SELECT book,id AS recording FROM book_audio WHERE state='ready' ORDER BY created DESC,rowid DESC").all(),
    recordings, removeRecording, rescans, ivoox, vocabulary, estimates,
  };
}
