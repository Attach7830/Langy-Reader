import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import express from 'express';
import multer from 'multer';
import { maxUpload, openLibrary, RequestError } from './books.js';
import { openAISettings } from './ai.js';
import { openThesaurus } from './thesaurus.js';
import { openLearning } from './learning.js';
import { openArchive } from './annas-archive.js';
import { maxAudioUpload } from './uploaded-audio.js';
import { opdsPageSize, opdsRouter } from './opds.js';
import { openProgressSync } from './progress-sync.js';
import { demoUploadLimit, demoBookLimit, demoStorageLimit, limitJobs, visitorMiddleware } from './demo.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const demo = process.env.READER_DEMO === '1';
const dir = resolve(process.env.READER_DATA || join(root, 'data'));
const limits = demo ? { upload: demoUploadLimit, books: demoBookLimit, storage: demoStorageLimit } : null;
const library = await openLibrary(dir, limits);
const password = process.env.READER_PASSWORD || '';
const progressSync = openProgressSync(dir, { library, demo,
  username: process.env.READER_SYNC_USER || process.env.READER_USER || 'reader',
  password: process.env.READER_SYNC_PASSWORD || password,
});
const ai = await openAISettings(dir, demo);
const lookupSynonyms = openThesaurus();
const learning = await openLearning(dir, library, demo, ai);
const archive = await openArchive(dir, { library, demo, onImport: (book) => learning.ensure(library.getBook(book.id)) });
const uploadLimit = limits?.upload ?? maxUpload;
const upload = multer({ dest: library.uploads, limits: { fileSize: uploadLimit, files: 1, fields: 4, fieldSize: 1024 } });
const audioUpload = multer({ dest: library.uploads, limits: { fileSize: maxAudioUpload, files: 1, fields: 1, fieldSize: 1024 } });
const demoUploads = demo ? [limitJobs({ perMinute: 32, perVisitor: 8 })] : [];
const demoGenerations = demo ? [limitJobs({ perMinute: 45, perVisitor: 16 })] : [];
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
  app.use(['/api/library', '/api/categories', '/api/books', '/api/storage'], identifyVisitor);
  app.post(['/api/ai/word', '/api/ai/summary'], identifyVisitor);
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
  res.json({
    ...snapshot,
    progress: demo ? null : progressSync.snapshot(),
    storage: await library.storage(req.visitor),
    archive: { available: !demo, hasKey: archive.settings().hasKey, job: demo ? null : archive.latest() },
    books: snapshot.books.map((book) => ({ ...book, learning: learning.info(library.getBook(book.id, req.visitor)) })),
  });
});
app.post('/api/categories', (req, res) => res.status(201).json(library.saveCategory(randomUUID(), req.body ?? {}, true, req.visitor)));
app.patch('/api/categories/:id', (req, res) => res.json(library.saveCategory(req.params.id, req.body ?? {}, false, req.visitor)));
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
app.patch('/api/books/:id', (req, res) => res.json(library.editBook(req.params.id, req.body ?? {}, req.visitor)));
app.delete('/api/books/:id', async (req, res) => {
  await library.removeBook(req.params.id, req.visitor);
  await learning.remove(req.params.id);
  if (!demo) progressSync.forgetBook(req.params.id);
  res.sendStatus(204);
});
app.get('/api/books/:id/learning', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  res.json(learning.chapters(book));
});
app.post('/api/books/:id/learning', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  learning.ensure(book, true);
  res.status(202).json(learning.info(book));
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
  res.json({ available: !demo, maxUpload: maxAudioUpload, recordings: demo ? [] : learning.recordings.list(book) });
});
if (!demo) {
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
      error: err.code === 'LIMIT_FILE_SIZE' ? 'Audio files must be 1 GiB or smaller.' : 'Upload one audiobook at a time.',
    });
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? `Books must be ${uploadLimit / 1024 / 1024} MiB or smaller.` : 'Upload one EPUB or PDF at a time.',
    });
  }
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error(err);
  const error = err instanceof RequestError ? err.message
    : ({ 400: 'Invalid request.', 404: 'File not found.', 413: 'The request is too large.' }[status] ?? 'The server could not complete the request.');
  res.status(status).json({ error });
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, '0.0.0.0', () => console.log(`Langy Reader listening on port ${port}`));
