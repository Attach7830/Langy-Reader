import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import express from 'express';
import multer from 'multer';
import { maxUpload, openLibrary, RequestError } from './books.js';
import { openAISettings } from './ai.js';
import { openThesaurus } from './thesaurus.js';
import { vocabularyMeanings } from './vocabulary-meanings.js';
import { openLearning } from './learning.js';
import { openArchive } from './annas-archive.js';
import { maxAudioUpload } from './uploaded-audio.js';
import { opdsPageSize, opdsRouter } from './opds.js';
import { openProgressSync } from './progress-sync.js';
import { chapterStorage } from './audio-upload.js';
import { chapterFileLimit } from './chapter-audio.js';
import { verifyStorage } from './storage-location.js';
import { openMandarin } from './mandarin.js';
import { demoUploadLimit, demoBookLimit, demoStorageLimit, limitJobs, visitorMiddleware } from './demo.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const demo = process.env.READER_DEMO === '1';
const dir = resolve(process.env.READER_DATA || join(root, 'data'));
await verifyStorage(dir);
const limits = demo ? { upload: demoUploadLimit, books: demoBookLimit, storage: demoStorageLimit } : null;
const library = await openLibrary(dir, limits);
const password = process.env.READER_PASSWORD || '';
const progressSync = openProgressSync(dir, { library, demo,
  username: process.env.READER_SYNC_USER || process.env.READER_USER || 'reader',
  password: process.env.READER_SYNC_PASSWORD || password,
});
const ai = await openAISettings(dir, demo);
const lookupSynonyms = openThesaurus();
const mandarin = openMandarin();
const learning = await openLearning(dir, library, demo, ai);
const vocabularyMeaning = vocabularyMeanings({ vocabulary: learning.vocabulary, ai, lookupSynonyms });
const archive = await openArchive(dir, { library, demo, onImport: (book) => learning.ensure(library.getBook(book.id)) });
const uploadLimit = limits?.upload ?? maxUpload;
const upload = multer({ dest: library.uploads, limits: { fileSize: uploadLimit, files: 1, fields: 5, fieldSize: 1024 } });
const audioUpload = multer({ dest: library.uploads, limits: { fileSize: maxAudioUpload, files: 1, fields: 1, fieldSize: 1024 } });
const chapterUpload = multer({ storage: chapterStorage(library.uploads), limits: { fileSize: maxAudioUpload, files: chapterFileLimit, fields: 1, fieldSize: 1024 } });
const demoUploads = demo ? [limitJobs({ perMinute: 32, perVisitor: 8 })] : [];
const demoGenerations = demo ? [limitJobs({ perMinute: 45, perVisitor: 16 })] : [];
const demoDictionaryRequests = demo ? [limitJobs({ perMinute: 600, perVisitor: 240 })] : [];
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' blob: data:; frame-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' blob: data:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; object-src 'none'",
  });
  next();
});

app.get('/healthz', (_, res) => res.type('text/plain').send('ok'));

// KOReader clients authenticate with x-auth-user/x-auth-key. Only this isolated
// router accepts those headers; they never grant access to the library/settings.
app.use('/kosync', progressSync.router);

if (password) {
  const digest = (text) => createHash('sha256').update(text).digest();
  const expected = digest(`${process.env.READER_USER || 'reader'}:${password}`);
  app.use((req, res, next) => {
    const auth = req.get('Authorization') || '';
    if (auth.startsWith('Basic ') && timingSafeEqual(digest(Buffer.from(auth.slice(6), 'base64')), expected)) {
      return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Langy Reader", charset="UTF-8"').status(401).send('Sign in to Langy Reader.');
  });
}

app.use('/opds', opdsRouter({ library, demo, onDownload: demo ? undefined : progressSync.bookDocument }));

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (['GET', 'HEAD'].includes(req.method)) return next();
  const site = req.get('Sec-Fetch-Site');
  const origin = req.get('Origin');
  if (site ? !['same-origin', 'none'].includes(site)
    : origin && ![`http://${req.get('Host')}`, `https://${req.get('Host')}`].includes(origin)) {
    return next(new RequestError(403, 'Open Langy Reader directly to make this change.'));
  }
  next();
}, express.json({ limit: '320kb', strict: true }));

if (demo) {
  const identifyVisitor = await visitorMiddleware(dir);
  app.use(['/api/library', '/api/categories', '/api/books', '/api/storage', '/api/vocabulary'], identifyVisitor);
  app.post(['/api/ai/word', '/api/ai/summary', '/api/mandarin/word', '/api/mandarin/readings', '/api/mandarin/pinyin'], identifyVisitor);
  await library.pruneDemoBooks();
  await learning.prune();
  setInterval(() => library.pruneDemoBooks().then(() => learning.prune()).catch(console.error), 15 * 60_000).unref();
} else {
  app.get('/api/settings/ai', (_, res) => res.json(ai.settings()));
  app.put('/api/settings/ai', async (req, res) => res.json(await ai.save(req.body ?? {})));
  app.post('/api/settings/ai/models', async (req, res) => res.json({ models: await ai.models(req.body ?? {}) }));
  app.put('/api/settings/learning', (req, res) => res.json(learning.save(req.body ?? {})));
  app.post('/api/settings/learning/voices', async (req, res) => res.json(await learning.voices()));
  app.put('/api/settings/archive', async (req, res) => res.json(await archive.save(req.body ?? {})));
  app.post('/api/imports/anna', (req, res) => res.status(202).json(archive.queue(req.body ?? {})));
  app.get('/api/imports/anna/:id', (req, res) => res.json(archive.job(req.params.id)));
}

app.get('/api/settings/learning', (req, res) => res.json(learning.settings()));
app.get('/api/settings/archive', (_, res) => res.json(archive.settings()));
app.get('/api/settings/sync', (_, res) => res.json(progressSync.settings()));
if (!demo) {
  app.get('/api/books/:id/progress', async (req, res) => res.json(await progressSync.get(library.getBook(req.params.id))));
  app.put('/api/books/:id/progress', async (req, res) => {
    const result = await progressSync.put(library.getBook(req.params.id), req.body);
    res.status(result.conflict ? 409 : 200).json(result);
  });
}
app.get('/api/settings/opds', (_, res) => res.json({
  available: !demo, path: '/opds', username: !demo && password ? process.env.READER_USER || 'reader' : '',
  authenticated: !demo && Boolean(password), pageSize: opdsPageSize,
}));
app.get('/api/storage', async (req, res) => res.json(await library.storage(req.visitor)));
app.get('/api/library', async (req, res) => {
  const snapshot = library.snapshot(req.visitor);
  const books = snapshot.books.map((book) => ({ ...book, learning: learning.info(library.getBook(book.id, req.visitor)) }));
  const reader = learning.vocabulary.profile(req.visitor);
  res.json({
    ...snapshot,
    progress: demo ? null : progressSync.snapshot(),
    storage: await library.storage(req.visitor),
    archive: { available: !demo, hasKey: archive.settings().hasKey, job: demo ? null : archive.latest() },
    vocabulary: { byLanguage: reader.byLanguage, likelyKnown: reader.knownByLanguage, threshold: reader.threshold, reading: reader.reading },
    books: books.map((book) => ({ ...book, familiarity: learning.vocabulary.familiarity(book, reader) })),
  });
});
app.get('/api/vocabulary', (req, res) => res.json(learning.vocabulary.catalogue(req.visitor, req.query)));
app.get('/api/vocabulary/settings', (req, res) => res.json(learning.vocabulary.preferences(req.visitor)));
app.put('/api/vocabulary/settings', (req, res) => res.json(learning.vocabulary.savePreferences(req.body ?? {}, req.visitor)));
app.get('/api/books/:id/vocabulary/below-threshold', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  learning.ensure(book);
  res.json(learning.vocabulary.belowThreshold(book, req.visitor, req.query));
});
app.post('/api/books/:id/vocabulary/meaning', ...demoGenerations, async (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  learning.ensure(book);
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const answer = await vocabularyMeaning(book, req.body ?? {}, controller.signal);
  if (!controller.signal.aborted) res.json(answer);
});
app.get('/api/books/:id/vocabulary/sections/:key', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  learning.ensure(book);
  res.json(learning.vocabulary.section(book, req.params.key));
});
app.post('/api/books/:id/vocabulary/seen', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  learning.ensure(book);
  res.json(learning.vocabulary.record(book, req.body ?? {}, req.visitor));
});
app.get('/api/books/:id/recommendations', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  const reader = learning.vocabulary.profile(req.visitor);
  res.json({ books: learning.vocabulary.recommendations(book, library.snapshot(req.visitor).books, reader) });
});
function saveCategory(req, res, isNew) {
  const category = library.saveCategory(isNew ? randomUUID() : req.params.id, req.body ?? {}, isNew, req.visitor);
  for (const book of library.snapshot(req.visitor).books.filter((item) => item.categoryId === category.id)) learning.ensure(library.getBook(book.id, req.visitor));
  res.status(isNew ? 201 : 200).json(category);
}
app.post('/api/categories', (req, res) => saveCategory(req, res, true));
app.patch('/api/categories/:id', (req, res) => saveCategory(req, res, false));
app.delete('/api/categories/:id', (req, res) => {
  library.removeCategory(req.params.id, req.visitor);
  res.sendStatus(204);
});

app.post('/api/books', ...demoUploads, (req, _res, next) => {
  if (Number(req.get('Content-Length')) > uploadLimit + 16_384) {
    return next(new RequestError(413, `Books must be ${uploadLimit / 1024 / 1024} MiB or smaller.`));
  }
  next();
}, upload.single('file'), async (req, res) => {
  const imported = await library.importBook(randomUUID(), req.file, req.body ?? {}, req.visitor);
  learning.ensure(library.getBook(imported.id, req.visitor));
  res.status(201).json(imported);
});
app.patch('/api/books/:id', (req, res) => {
  const book = library.editBook(req.params.id, req.body ?? {}, req.visitor);
  learning.ensure(library.getBook(book.id, req.visitor));
  res.json(book);
});
app.patch('/api/books/:id/read-status', (req, res) => {
  const status = library.setReadStatus(req.params.id, req.body ?? {}, req.visitor);
  if (status.readAt) learning.ensure(library.getBook(status.id, req.visitor));
  learning.vocabulary.syncCompletions(req.visitor);
  res.json(status);
});
app.delete('/api/books/:id', async (req, res) => {
  await library.removeBook(req.params.id, req.visitor);
  await learning.remove(req.params.id);
  if (!demo) progressSync.forgetBook(req.params.id);
  res.sendStatus(204);
});
app.get('/api/books/:id/learning', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  res.json({ ...learning.chapters(book), familiarity: learning.vocabulary.familiarity(book, learning.vocabulary.profile(req.visitor)) });
});
app.post('/api/books/:id/learning', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  learning.ensure(book, true);
  res.status(202).json(learning.info(book));
});
app.post('/api/books/:id/reading-estimate', ...demoGenerations, (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  learning.ensure(book);
  learning.estimates.queue(book);
  void learning.estimates.pump();
  res.status(202).json(learning.estimates.status(book));
});
app.get('/api/books/:id/chapters/:key', (req, res) => {
  res.json(learning.unit(library.getBook(req.params.id, req.visitor), req.params.key,
    typeof req.query.recording === 'string' ? req.query.recording : undefined));
});
app.get('/api/books/:id/narration', (req, res) => {
  res.json(learning.narration(library.getBook(req.params.id, req.visitor), typeof req.query.recording === 'string' ? req.query.recording : undefined));
});
app.get('/api/books/:id/recordings', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  res.json({ available: !demo, maxUpload: maxAudioUpload, recordings: demo ? [] : learning.recordings.list(book).map((item) => ({ ...item, rescan: learning.rescans.status(book, item.id) })) });
});
if (!demo) {
  app.post('/api/books/:id/recordings/chapters', (req, _res, next) => {
    req.audioBook = library.getBook(req.params.id); req.audioUpload = true; req.chapterUpload = true;
    learning.ensure(req.audioBook);
    if (Number(req.get('Content-Length')) > maxAudioUpload + 1024 * 1024) throw new RequestError(413, 'Chapter files must total 1 GiB or less per recording.');
    next();
  }, chapterUpload.array('files', chapterFileLimit), async (req, res) => {
    res.status(202).json(await learning.recordings.acceptChapters(req.audioBook, req.files, req.body ?? {}));
  });
  app.get('/api/books/:id/recordings/:recording/chapters/:chapter/file', (req, res) => {
    const file = learning.recordings.originalChapter(library.getBook(req.params.id), req.params.recording, Number(req.params.chapter));
    res.type('application/octet-stream').download(file.path, file.name, { dotfiles: 'allow' });
  });
  app.get('/api/books/:id/ivoox', (req, res) => res.json({ job: learning.ivoox.latest(library.getBook(req.params.id)) }));
  app.post('/api/books/:id/ivoox', (req, res) => {
    const book = library.getBook(req.params.id); learning.ensure(book);
    res.status(202).json({ job: learning.ivoox.queue(book, req.body) });
  });
  app.delete('/api/books/:id/ivoox', (req, res) => { learning.ivoox.cancel(library.getBook(req.params.id)); res.sendStatus(204); });
  app.post('/api/books/:id/audio/:recording/rescan', (req, res) => res.status(202).json(learning.rescans.queue(library.getBook(req.params.id), req.params.recording)));
  app.delete('/api/books/:id/audio/:recording/rescan', (req, res) => res.json(learning.rescans.cancel(library.getBook(req.params.id), req.params.recording)));
  app.post('/api/books/:id/recordings', (req, _res, next) => {
    library.getBook(req.params.id);
    req.audioUpload = true;
    if (Number(req.get('Content-Length')) > maxAudioUpload + 16384) return next(new RequestError(413, 'Audio files must be 1 GiB or smaller.'));
    next();
  }, audioUpload.single('file'), async (req, res) => {
    res.status(201).json(await learning.recordings.accept(library.getBook(req.params.id), req.file, req.body ?? {}));
  });
  app.post('/api/books/:id/recordings/:recording/sync', (req, res) => {
    res.status(202).json(learning.recordings.queue(library.getBook(req.params.id), req.params.recording));
  });
  app.delete('/api/books/:id/recordings/:recording', async (req, res) => {
    await learning.recordings.remove(library.getBook(req.params.id), req.params.recording);
    res.sendStatus(204);
  });
  app.get('/api/books/:id/recordings/:recording/file', (req, res) => {
    const file = learning.recordings.original(library.getBook(req.params.id), req.params.recording);
    res.type(file.mime).download(file.path, file.name, { dotfiles: 'allow' });
  });
}
app.post('/api/books/:id/narration', ...(demo ? [limitJobs({ perMinute: 12, perVisitor: 4 })] : []), (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  const body = req.body ?? {};
  res.status(202).json({ audio: learning.queueBook(book, body.replace === true) });
});
app.get('/api/books/:id/audio/:audio', (req, res) => {
  res.type('audio/mpeg').sendFile(learning.audioFile(library.getBook(req.params.id, req.visitor), req.params.audio), { dotfiles: 'allow' });
});
app.delete('/api/books/:id/narration', (req, res) => {
  res.json({ cancelled: learning.cancel(library.getBook(req.params.id, req.visitor)) });
});
app.get('/api/books/:id/file', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  res.type(book.format === 'pdf' ? 'application/pdf' : 'application/epub+zip').sendFile(library.filePath(book), { dotfiles: 'allow' });
});
app.get('/api/books/:id/cover', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  if (!book.thumbnailType) throw new RequestError(404, 'Cover not found.');
  res.type(book.thumbnailType).sendFile(library.coverPath(book), { dotfiles: 'allow' });
});

app.get('/api/ai/status', async (_, res) => res.json(await ai.status()));
app.post('/api/mandarin/word', ...demoDictionaryRequests, (req, res) => res.json(mandarin.lookup(req.body ?? {})));
app.post('/api/mandarin/readings', ...demoDictionaryRequests, (req, res) => res.json(mandarin.readings(req.body ?? {})));
app.post('/api/mandarin/pinyin', ...demoDictionaryRequests, (req, res) => res.json(mandarin.annotation(req.body ?? {})));
app.post('/api/ai/word', (req, res, next) => {
  if (req.body?.mode !== 'synonyms') return next();
  res.json(lookupSynonyms(req.body));
});
for (const [path, generate] of [['word', ai.word], ['summary', ai.summary]]) {
  app.post(`/api/ai/${path}`, ...demoGenerations, async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const answer = await generate(req.body ?? {}, controller.signal);
    if (!controller.signal.aborted) res.json(typeof answer === 'string' ? { text: answer } : answer);
  });
}

for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  app.use(`/pdf-assets/${name}`, express.static(join(root, 'node_modules/pdfjs-dist', name), { maxAge: '1d' }));
}
app.use('/assets', express.static(join(root, 'dist/assets'), { immutable: true, maxAge: '1y' }));
app.use(express.static(join(root, 'dist')));
app.use('/api', (_, res) => res.status(404).json({ error: 'Endpoint not found.' }));

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (res.destroyed) return;
  if (err instanceof multer.MulterError) {
    if (_req.audioUpload) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? 'Audio files must be 1 GiB or smaller.' : _req.chapterUpload ? 'Choose at most 200 chapter files and one recording name.' : 'Upload one audiobook at a time.',
    });
    const errors = {
      LIMIT_FILE_SIZE: `Books must be ${uploadLimit / 1024 / 1024} MiB or smaller.`,
      LIMIT_FILE_COUNT: 'Upload one EPUB or PDF at a time.',
      LIMIT_FIELD_COUNT: 'Too many book details were submitted. Refresh the page and try again.',
      LIMIT_FIELD_VALUE: 'One of the book details is too long. Shorten it and try again.',
      LIMIT_FIELD_KEY: 'A book detail has an invalid field name.',
      LIMIT_UNEXPECTED_FILE: err.field === 'file' ? 'Upload one EPUB or PDF at a time.' : 'Unexpected file field in the book upload.',
    };
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: errors[err.code] || 'The book upload could not be processed. Try again.' });
  }
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error(err);
  const error = err instanceof RequestError ? err.message
    : ({ 400: 'Invalid request.', 404: 'File not found.', 413: 'The request is too large.' }[status] ?? 'The server could not complete the request.');
  res.status(status).json({ error });
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, '0.0.0.0', () => console.log(`Langy Reader listening on port ${port}`));
