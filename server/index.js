import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import express from 'express';
import multer from 'multer';
import { maxUpload, openLibrary, RequestError } from './books.js';
import { openAISettings } from './ai.js';
import { demoUploadLimit, demoBookLimit, demoStorageLimit, limitJobs, visitorMiddleware } from './demo.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const demo = process.env.READER_DEMO === '1';
const dir = resolve(process.env.READER_DATA || join(root, 'data'));
const limits = demo ? { upload: demoUploadLimit, books: demoBookLimit, storage: demoStorageLimit } : null;
const library = await openLibrary(dir, limits);
const ai = await openAISettings(dir, demo);
const uploadLimit = limits?.upload ?? maxUpload;
const upload = multer({ dest: library.uploads, limits: { fileSize: uploadLimit, files: 1, fields: 4, fieldSize: 1024 } });
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

const password = process.env.READER_PASSWORD || '';
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
  app.use(['/api/library', '/api/categories', '/api/books'], identifyVisitor);
  app.post(['/api/ai/word', '/api/ai/summary'], identifyVisitor);
  await library.pruneDemoBooks();
  setInterval(() => library.pruneDemoBooks().catch(console.error), 15 * 60_000).unref();
} else {
  app.get('/api/settings/ai', (_, res) => res.json(ai.settings()));
  app.put('/api/settings/ai', async (req, res) => res.json(await ai.save(req.body ?? {})));
  app.post('/api/settings/ai/models', async (req, res) => res.json({ models: await ai.models(req.body ?? {}) }));
}

app.get('/api/library', (req, res) => res.json(library.snapshot(req.visitor)));
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
  res.status(201).json(await library.importBook(randomUUID(), req.file, req.body ?? {}, req.visitor));
});
app.patch('/api/books/:id', (req, res) => res.json(library.editBook(req.params.id, req.body ?? {}, req.visitor)));
app.delete('/api/books/:id', async (req, res) => {
  await library.removeBook(req.params.id, req.visitor);
  res.sendStatus(204);
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
for (const [path, generate] of [['word', ai.word], ['summary', ai.summary]]) {
  app.post(`/api/ai/${path}`, ...demoGenerations, async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const text = await generate(req.body ?? {}, controller.signal);
    if (!controller.signal.aborted) res.json({ text });
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
