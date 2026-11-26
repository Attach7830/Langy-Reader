import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { rm } from 'node:fs/promises';
import express from 'express';
import multer from 'multer';
import { maxUpload, openLibrary, RequestError } from './books.js';
import { openAccounts } from './accounts.js';
import { userStorage } from './user-storage.js';
import { fontDownloads } from './font-downloads.js';
import { openBookImports } from './book-imports.js';
import { openKavita } from './kavita.js';
import { conversionLimit } from '../shared/import-formats.js';
import { openCoverSearch } from './cover-search.js';
import { openFonts, fontUploadLimit } from './fonts.js';
import { openAIProfiles } from './ai-profiles.js';
import { openAISettings } from './ai.js';
import { openProcesses } from './processes.js';
import { openAICache } from './ai-cache.js';
import { openThesaurus } from './thesaurus.js';
import { vocabularyMeanings } from './vocabulary-meanings.js';
import { openLearning } from './learning.js';
import { openArchive } from './annas-archive.js';
import { importNarrationOptions } from './import-narration.js';
import { maxAudioUpload } from './uploaded-audio.js';
import { opdsPageSize, opdsRouter } from './opds.js';
import { openProgressSync } from './progress-sync.js';
import { chapterStorage } from './audio-upload.js';
import { chapterFileLimit } from './chapter-audio.js';
import { verifyStorage } from './storage-location.js';
import { openBookDiscovery } from './book-discovery.js';
import { openMandarin } from './mandarin.js';
import { openBookPinyin } from './book-pinyin.js';
import { openReaderSettings } from './reader-settings.js';
import { openPDFOCR } from './pdf-ocr.js';
import { openReadingTime } from './reading-time.js';
import { openProficiency } from './proficiency.js';
import { bookTools } from './book-tools.js';
import { openAudiobookshelf } from './audiobookshelf.js';
import { offlinePacks } from './offline-pack.js';
import { learningLanguages } from '../shared/learning-languages.js';
import { demoUploadLimit, demoBookLimit, demoStorageLimit, limitJobs, visitorMiddleware } from './demo.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const demo = process.env.READER_DEMO === '1';
const dir = resolve(process.env.READER_DATA || join(root, 'data'));
await verifyStorage(dir);
const limits = demo ? { upload: demoUploadLimit, books: demoBookLimit, storage: demoStorageLimit } : null;
let accountStorage;
const reserveStorage = (owner, bytes) => accountStorage ? accountStorage.reserve(owner, bytes) : Promise.resolve(() => {});
const library = await openLibrary(dir, limits, { reserveStorage });
const password = process.env.READER_PASSWORD || '';
const accounts = await openAccounts(dir, { demo, username: process.env.READER_USER || 'reader', password, reservedUsernames: [process.env.READER_SYNC_USER] });
const readerSettings = openReaderSettings(dir, { demo, username: process.env.READER_USER || 'reader', ownerFor: accounts.preferenceOwner });
const syncUsername = process.env.READER_SYNC_USER || process.env.READER_USER || 'reader';
const syncPassword = process.env.READER_SYNC_PASSWORD || '';
const syncExpected = syncPassword ? createHash('sha256').update(`${syncUsername}:${createHash('md5').update(syncPassword).digest('hex')}`).digest() : null;
const progressSync = openProgressSync(dir, { library, demo,
  username: process.env.READER_SYNC_USER || process.env.READER_USER || 'reader',
  password: syncPassword || password,
  authenticate: accounts.enabled ? async (name, key, req) => {
    const rootName = process.env.READER_USER || 'reader';
    if (syncExpected && name === syncUsername) { const policy = accounts.policyForOwner(''); if (!policy.active || !policy.allowDevices) return null; return timingSafeEqual(syncExpected, createHash('sha256').update(`${name}:${key}`).digest()) ? accounts.visitorForOwner('') : null; }
    if ((syncPassword || syncUsername !== rootName) && name.toLowerCase() === rootName.toLowerCase()) return null;
    const loginName = name === syncUsername && !syncPassword ? rootName : name;
    return accounts.authenticate(loginName, key, { sync: true, source: `sync:${req.ip}` });
  } : undefined,
});
const aiSettings = await openAISettings(dir, demo);
const aiProfiles = await openAIProfiles(dir, aiSettings, accounts, { demo });
const aiCache = openAICache(dir, { identity: aiProfiles.cacheIdentity,
  policy(visitor) {
    if (demo && !visitor?.id) return null;
    const account = readerSettings.get(visitor);
    return { owner: account.accountId, enabled: account.preferences.cacheAI !== false, expires: demo ? visitor.expires : null };
  },
});
const ai = aiCache.wrap(aiProfiles), withAI = (visitor, task) => aiProfiles.run(visitor, () => aiCache.run(visitor, task));
const discovery = openBookDiscovery(dir, { library, ai, demo, withAI, visitorForOwner: accounts.visitorForOwner });
const lookupSynonyms = openThesaurus();
const mandarin = openMandarin();
const bookPinyin = openBookPinyin(dir, mandarin, { demo });
const nativeLanguage = (visitor) => readerSettings.get(visitor).preferences.nativeLanguage || '';
const learning = await openLearning(dir, library, demo, ai, { nativeLanguage, withAI, reserveStorage });
const readingTime = openReadingTime(dir, { section: (book, key) => learning.vocabulary.section(book, key) });
const toolsForBook = bookTools({ learning, ai });
const offlinePack = offlinePacks({ learning, mandarin, lookupSynonyms });
const readingAccount = (visitor) => ({ id: readerSettings.get(visitor).accountId, owner: visitor?.id || '', expires: visitor?.expires ?? null });
const proficiency = openProficiency(dir, { vocabulary:learning.vocabulary, readingTime, library, readerSettings, account:readingAccount });
const userFonts = await openFonts(dir, { reserveStorage });
accountStorage = userStorage(dir, {
  policy: (owner) => demo ? { active: true, storageLimit: null } : accounts.policyForOwner(owner),
  paths: (owner) => [...library.storageFiles(owner), ...library.ownedBooks(owner).flatMap((book) => learning.storageFiles(book.id)),
    ...userFonts.storageFiles(readingAccount(accounts.visitorForOwner(owner)).id)],
});
const storageFor = (visitor) => demo ? library.storage(visitor) : accountStorage.summary(visitor?.id || '');
const covers = await openCoverSearch(dir,{demo});
const freeFonts = fontDownloads({fonts:userFonts,uploads:library.uploads});
const vocabularyMeaning = vocabularyMeanings({ vocabulary: learning.vocabulary, ai, lookupSynonyms });
const archive = await openArchive(dir, { library, demo, canUseShared: accounts.canUseArchiveKey, visitorForOwner: accounts.visitorForOwner, activeOwner: (owner) => accounts.policyForOwner(owner).active, onImport: (book, details) => learning.scheduleAudiobook(library.getBook(book.id), details) });
const ocr = await openPDFOCR(dir, { library, demo, onImport: (book) => learning.ensure(library.getBook(book.id)) });
const audiobookshelf = await openAudiobookshelf(dir, { library, learning, demo });
const kavita = await openKavita(dir, { demo });
const webImports = await openBookImports(dir,{library,demo,connector:kavita,reserveStorage,visitorForOwner:accounts.visitorForOwner,activeOwner:(owner)=>demo||accounts.policyForOwner(owner).active,onImport:(book,details)=>{learning.ensure(library.getBook(book.id));learning.scheduleAudiobook(library.getBook(book.id),details);}});
const processes = openProcesses(dir, { library, webImports, archive, discovery, learning, demo, account: readingAccount });
const uploadLimit = limits?.upload ?? maxUpload;
const upload = multer({ dest: library.uploads, limits: { fileSize: uploadLimit, files: 1, fields: 12, fieldSize: 4096 } });
const audioUpload = multer({ dest: library.uploads, limits: { fileSize: maxAudioUpload, files: 1, fields: 1, fieldSize: 1024 } });
const chapterUpload = multer({ storage: chapterStorage(library.uploads), limits: { fileSize: maxAudioUpload, files: chapterFileLimit, fields: 1, fieldSize: 1024 } });
const demoUploads = demo ? [limitJobs({ perMinute: 32, perVisitor: 8 })] : [];
const demoGenerations = demo ? [limitJobs({ perMinute: 45, perVisitor: 16 })] : [];
const demoDictionaryRequests = demo ? [limitJobs({ perMinute: 600, perVisitor: 240 })] : [];
const app = express();
app.disable('x-powered-by');
// Keep route and authorization matching consistent, including owner-only tools.
app.set('case sensitive routing', true);

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


const isAdministrator = (req) => !accounts.enabled || req.visitor?.role === 'admin';
const usesOwnerAudiobookshelf = (req) => !accounts.enabled || req.visitor?.id === '';
const accountInfo = (visitor) => ({ ...accounts.describe(visitor), legacyAccount: visitor?.id === '', readerAccountId: visitor ? readerSettings.get(visitor).accountId : null });
app.get('/api/account', async (req, res) => { req.visitor = await accounts.identify(req); res.json(accountInfo(req.visitor)); });
app.post('/api/account/login', async (req, res) => {
  if (!accounts.enabled) throw new RequestError(403, 'Accounts are not enabled on this installation.');
  if (req.body?.rememberMe !== undefined && typeof req.body.rememberMe !== 'boolean') throw new RequestError(422, 'Choose whether to remember this sign-in.');
  const visitor = await accounts.authenticate(req.body?.username, req.body?.password, { source: `login:${req.ip}` });
  if (!visitor) return res.status(401).json({ error: 'Incorrect username or password.' });
  accounts.issue(req, res, visitor, { rememberMe: req.body?.rememberMe === true }); res.json(accountInfo(visitor));
});
app.post('/api/account/logout', (req, res) => { accounts.logout(req, res); res.json({ signedOut: true }); });
app.use(async (req, res, next) => {
  if (demo || !accounts.enabled || !/^\/(?:api|opds)(?:\/|$)/iu.test(req.path)) return next();
  req.visitor = await accounts.identify(req);
  if (req.visitor) return next();
  if (req.path.startsWith('/opds')) res.set('WWW-Authenticate', 'Basic realm="Langy Reader", charset="UTF-8"');
  res.status(401).json({ error: 'Sign in to Langy Reader.', authenticationRequired: true });
});
app.post('/api/account/password', async (req, res) => {
  if (!accounts.enabled) throw new RequestError(403, 'Accounts are not enabled.');
  const verified = await accounts.authenticate(req.visitor.username, req.body?.currentPassword, { source: `password:${req.ip}` });
  if (!verified) throw new RequestError(403, 'The current password is incorrect.');
  const rememberMe = accounts.remembered(req);
  await accounts.resetPassword(req.visitor.userId, req.body?.newPassword);
  accounts.issue(req, res, req.visitor, { rememberMe }); res.json({ saved: true });
});
app.get('/api/admin/users', async (req, res) => { accounts.requireAdmin(req.visitor); res.json({ users: await Promise.all(accounts.list().map(async (user) => ({ ...user, storage: await accountStorage.summary(accounts.ownerForUser(user.id)) }))) }); });
app.post('/api/admin/users', async (req, res) => {
  accounts.requireAdmin(req.visitor); const user = await accounts.create(req.body ?? {}); await aiProfiles.prepare(user); res.status(201).json(user);
});
app.patch('/api/admin/users/:id', (req, res) => { accounts.requireAdmin(req.visitor); res.json(accounts.update(req.params.id, req.body ?? {})); });
app.post('/api/admin/users/:id/sessions/revoke', (req, res) => { accounts.requireAdmin(req.visitor); res.json(accounts.revokeSessions(req.params.id)); });
app.post('/api/admin/users/:id/password', async (req, res) => { accounts.requireAdmin(req.visitor); res.json(await accounts.resetPassword(req.params.id, req.body?.password)); });
app.use('/opds', opdsRouter({ library, demo, onDownload: demo ? undefined : progressSync.bookDocument }));
app.use((req, _res, next) => {
  if (accounts.enabled && !usesOwnerAudiobookshelf(req) && /^\/api\/(?:audiobookshelf(?:\/|$)|settings\/audiobookshelf(?:\/|$))/u.test(req.path) && (req.method !== 'GET' || req.path.startsWith('/api/audiobookshelf/'))) throw new RequestError(403, 'Audiobookshelf is managed by the instance owner.');
  if (accounts.enabled && !isAdministrator(req)) {
    const service = /^\/api\/(?:settings\/(?:learning|audiobookshelf|ocr|covers)(?:\/|$)|audiobookshelf(?:\/|$))/u.test(req.path);
    if (service && (req.method !== 'GET' || req.path.startsWith('/api/audiobookshelf/'))) throw new RequestError(403, 'Server connections are managed by the administrator.');
  }
  next();
});
app.use('/api/books/:id', (req, _res, next) => {
  if (demo) return next();
  const book = library.getBook(req.params.id, req.visitor);
  if (accounts.enabled && /^\/audiobookshelf(?:\/|$)/u.test(req.path) && !usesOwnerAudiobookshelf(req) && (req.method !== 'GET' || req.path !== '/audiobookshelf')) throw new RequestError(403, 'Audiobookshelf is managed by the instance owner.');
  const modifiesBook = !['GET', 'HEAD'].includes(req.method) && (req.path === '/' && ['PATCH','DELETE'].includes(req.method)
    || /^\/(?:learning|reading-estimate|narration|recordings|ivoox|audio|ocr|audiobookshelf)(?:\/|$)/u.test(req.path));
  if (modifiesBook && book.canEdit === false) throw new RequestError(403, 'Only the book owner can change this shared book.');
  next();
});
app.use('/api', (req, _res, next) => demo ? next() : withAI(req.visitor, next));

if (demo) {
  const identifyVisitor = await visitorMiddleware(dir);
  app.use(['/api/library', '/api/categories', '/api/books', '/api/storage', '/api/vocabulary', '/api/discovery', '/api/processes', '/api/settings/reader', '/api/settings/ai-cache', '/api/reading-time', '/api/imports/convert', '/api/imports/web', '/api/proficiency'], identifyVisitor);
  app.post(['/api/ai/word', '/api/ai/summary', '/api/ai/phrase', '/api/mandarin/word', '/api/mandarin/readings', '/api/mandarin/pinyin'], identifyVisitor);
  await library.pruneDemoBooks();
  await learning.prune();
  setInterval(() => library.pruneDemoBooks().then(() => learning.prune()).catch(console.error), 15 * 60_000).unref();
} else {
  app.get('/api/settings/ai', (_, res) => res.json(ai.settings()));
  app.put('/api/settings/ai', async (req, res) => res.json(await ai.save(req.body ?? {})));
  app.delete('/api/settings/ai/key', async (_req, res) => res.json(await ai.removeKey()));
  app.delete('/api/settings/ai/override', async (_req, res) => res.json(await aiProfiles.useServer()));
  app.post('/api/settings/ai/models', async (req, res) => res.json({ models: await ai.models(req.body ?? {}) }));
  app.put('/api/settings/learning', (req, res) => res.json(learning.save(req.body ?? {})));
  app.delete('/api/settings/learning/key', (_req, res) => res.json(learning.save({ ...learning.settings(), clearKey: true })));
  app.post('/api/settings/learning/voices', async (req, res) => res.json(await learning.voices()));
  app.put('/api/settings/archive', async (req, res) => res.json(await archive.save(req.body ?? {}, req.visitor)));
  app.delete('/api/settings/archive/key', async (req, res) => res.json(await archive.removeKey(req.visitor)));
  app.post('/api/imports/anna', (req, res) => res.status(202).json(archive.queue(req.body ?? {}, req.visitor)));
  app.get('/api/imports/anna', (req, res) => res.json({ jobs: archive.list(req.visitor) }));
  app.post('/api/imports/anna/batch', (req, res) => res.status(202).json(archive.queueBatch(req.body ?? {}, req.visitor)));
  app.post('/api/imports/anna/:id/retry', (req, res) => res.status(202).json(archive.retry(req.params.id, req.visitor)));
  app.delete('/api/imports/anna/:id', (req, res) => res.json(archive.cancel(req.params.id, req.visitor)));
  app.get('/api/imports/anna/:id', (req, res) => res.json(archive.job(req.params.id, req.visitor)));
  app.post('/api/imports/anna/:id/continue', (req, res) => res.status(202).json(archive.continue(req.params.id, req.body, req.visitor)));
  app.post('/api/imports/anna/:id/file', upload.single('file'), async (req, res) => res.json(await archive.accept(req.params.id, req.file, req.body?.details, req.visitor)));
}

if (demo) app.use('/api', (req, _res, next) => withAI(req.visitor, next));
app.delete('/api/settings/ai-cache', (req, res) => { aiCache.clear(req.visitor); res.json({ cleared: true }); });
app.get('/api/settings/reader', (req, res) => res.json(readerSettings.get(req.visitor)));
app.patch('/api/settings/reader', (req, res) => {
  const result = readerSettings.patch(req.body, req.visitor);
  if (!result.conflict && result.preferences.cacheAI === false) aiCache.clear(req.visitor);
  res.status(result.conflict ? 409 : 200).json(result);
});
app.get('/api/settings/covers',(req,res)=>{const config=covers.settings();res.json(accounts.enabled&&!isAdministrator(req)?{configurable:false,hasGoogleKey:config.hasGoogleKey,amazonConnected:config.amazonConnected}:config);});
app.put('/api/settings/covers',async(req,res)=>res.json(await covers.save(req.body ?? {})));
app.post('/api/covers/search',async(req,res)=>res.json(await covers.search(req.body ?? {},req.visitor?.id||'')));
app.get('/api/covers/previews/:id',async(req,res)=>{const image=await covers.preview(req.params.id,req.visitor?.id||'');res.set('Cache-Control','private, no-store').type(image.thumbnailType).send(image.thumbnail);});
app.get('/api/fonts', async (req, res) => res.json({ accountId: readingAccount(req.visitor).id, fonts: await userFonts.list(readingAccount(req.visitor).id) }));
const fontUpload = multer({ dest: library.uploads, limits: { fileSize: fontUploadLimit, files: 1, fields: 1, fieldSize: 400 } }).single('file');
app.post('/api/fonts', ...demoUploads, (req, res, next) => { req.fontUpload = true; fontUpload(req, res, next); }, async (req, res) => res.status(201).json(await userFonts.add(req.file, readingAccount(req.visitor), req.body?.name)));
app.get('/api/fonts/catalogue', async (req,res) => res.json(await freeFonts.search(req.query.q)));
app.get('/api/fonts/catalogue/:id', async (req,res) => res.json(await freeFonts.variants(req.params.id)));
app.post('/api/fonts/download', ...demoUploads, async (req,res) => {
  const controller=new AbortController();res.on('close',()=>controller.abort());if(res.destroyed)controller.abort();
  const font=await freeFonts.download(req.body ?? {},readingAccount(req.visitor),controller.signal);
  if(!controller.signal.aborted)res.status(201).json(font);
});
app.get('/api/fonts/:id/file', (req, res) => { const font = userFonts.file(req.params.id, readingAccount(req.visitor).id); res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff').type(font.type).sendFile(font.path, { dotfiles: 'allow', cacheControl: false }); });
app.delete('/api/fonts/:id', async (req, res) => { await userFonts.remove(req.params.id, readingAccount(req.visitor).id); res.json({ fonts: await userFonts.list(readingAccount(req.visitor).id) }); });
app.get('/api/settings/learning', (req, res) => res.json({ ...learning.settings(), ...(accounts.enabled && !isAdministrator(req) ? { configurable: false, managed: true } : {}) }));
app.get('/api/settings/ocr', (req, res) => res.json(accounts.enabled && !isAdministrator(req) ? { configurable: false, managed: true, provider: ocr.settings().provider } : ocr.settings()));
app.put('/api/settings/ocr', async (req, res) => res.json(await ocr.save(req.body ?? {})));
app.delete('/api/settings/ocr/key', async (_req, res) => res.json(await ocr.removeKey()));
app.get('/api/settings/audiobookshelf', (req, res) => res.json(usesOwnerAudiobookshelf(req) ? audiobookshelf.settings() : { configurable: false, managed: true, connected: false, hasKey: false }));
app.put('/api/settings/audiobookshelf', async (req, res) => res.json(await audiobookshelf.save(req.body ?? {})));
app.patch('/api/settings/audiobookshelf/categories/:id', async (req, res) => {
  if (!library.snapshot(req.visitor).categories.some((category) => category.id === req.params.id)) throw new RequestError(404, 'Folder not found.');
  res.json(await audiobookshelf.linkCategory(req.params.id, req.body?.destination));
});
if (!demo) app.delete('/api/settings/audiobookshelf/key', async (_req, res) => res.json(await audiobookshelf.removeKey()));
app.get('/api/audiobookshelf/libraries', async (_req, res) => res.json(await audiobookshelf.libraries()));
app.get('/api/audiobookshelf/libraries/:id/items', async (req, res) => res.json(await audiobookshelf.items(req.params.id, Number(req.query.page || 0))));
app.get('/api/books/:id/audiobookshelf', (req, res) => res.json(usesOwnerAudiobookshelf(req) ? audiobookshelf.status(library.getBook(req.params.id, req.visitor)) : { configurable: false, connected: false, managed: true, jobs: [] }));
app.post('/api/books/:id/audiobookshelf/export', (req, res) => res.status(202).json(audiobookshelf.queue(library.getBook(req.params.id, req.visitor), 'export', req.body ?? {})));
app.post('/api/books/:id/audiobookshelf/import', (req, res) => res.status(202).json(audiobookshelf.queue(library.getBook(req.params.id, req.visitor), 'import', req.body ?? {})));
app.post('/api/books/:id/audiobookshelf/jobs/:job/decision', async (req, res) => res.json(await audiobookshelf.decide(library.getBook(req.params.id, req.visitor), req.params.job, req.body?.replace)));
app.post('/api/books/:id/audiobookshelf/jobs/:job/check', (req, res) => res.status(202).json(audiobookshelf.checkUpload(library.getBook(req.params.id, req.visitor), req.params.job)));
app.post('/api/books/:id/ocr/jobs/:job/retry', (req, res) => res.status(202).json(ocr.retry(library.getBook(req.params.id, req.visitor), req.params.job)));
app.post('/api/books/:id/audiobookshelf/link', async (req, res) => res.json(await audiobookshelf.attach(library.getBook(req.params.id, req.visitor), req.body ?? {})));
app.get('/api/books/:id/audiobookshelf/progress', async (req, res) => res.json(await audiobookshelf.remote(library.getBook(req.params.id, req.visitor), req.query.recording)));
app.put('/api/books/:id/audiobookshelf/progress', async (req, res) => {
  const result = await audiobookshelf.push(library.getBook(req.params.id, req.visitor), req.body ?? {}); res.status(result.conflict ? 409 : 200).json(result);
});
app.get('/api/books/:id/ocr', async (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  let languages = [], error;
  if (!demo && book.format === 'pdf') { try { languages = await ocr.languages(); } catch (failure) { error = failure.message; } }
  res.json({ available: !demo && book.format === 'pdf', job: ocr.status(book), languages, error, provider: ocr.settings().provider });
});
app.get('/api/books/:id/bookmarks', (req, res) => res.json({ bookmarks: library.bookmarks(req.params.id, req.visitor) }));
app.get('/api/books/:id/search', (req, res) => res.json(toolsForBook.search(library.getBook(req.params.id, req.visitor), req.query.q)));
app.get('/api/books/:id/offline', async (req, res) => {
  const pack = await offlinePack(library.getBook(req.params.id, req.visitor), req.query.recording);
  pack.narration.absConnected = (usesOwnerAudiobookshelf(req) && audiobookshelf.settings().connected); res.json(pack);
});
app.post('/api/books/:id/bookmarks/remove', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor), existing = library.bookmarks(book.id, req.visitor).find((item) => item.target === req.body?.target);
  res.json(existing ? library.removeBookmark(book.id, existing.id, req.visitor) : { bookmarks: library.bookmarks(book.id, req.visitor) });
});
app.post('/api/books/:id/character-guide', ...demoGenerations, async (req, res) => {
  const controller = new AbortController(); res.on('close', () => controller.abort());
  res.json(await toolsForBook.guide(library.getBook(req.params.id, req.visitor), req.body ?? {}, controller.signal));
});
app.post('/api/books/:id/question', ...demoGenerations, async (req, res) => {
  const controller = new AbortController(); res.on('close', () => controller.abort());
  res.json(await toolsForBook.question(library.getBook(req.params.id, req.visitor), req.body ?? {}, controller.signal));
});
app.post('/api/books/:id/bookmarks', (req, res) => res.json(library.saveBookmark(req.params.id, req.body ?? {}, req.visitor)));
app.delete('/api/books/:id/bookmarks/:bookmark', (req, res) => res.json(library.removeBookmark(req.params.id, req.params.bookmark, req.visitor)));
app.post('/api/books/:id/ocr', (req, res) => res.status(202).json(ocr.queue(library.getBook(req.params.id, req.visitor), req.body ?? {})));
app.get('/api/settings/archive', (req, res) => res.json(archive.settings(req.visitor)));
app.get('/api/settings/sync', (req, res) => res.json(progressSync.settings(req.visitor)));
if (!demo) {
  app.get('/api/books/:id/progress', async (req, res) => res.json(await progressSync.get(library.getBook(req.params.id, req.visitor), req.visitor)));
  app.put('/api/books/:id/progress', async (req, res) => {
    const result = await progressSync.put(library.getBook(req.params.id, req.visitor), req.body, req.visitor);
    res.status(result.conflict ? 409 : 200).json(result);
  });
}
app.get('/api/settings/opds', (req, res) => res.json({
  available: !demo, path: '/opds', username: !demo && accounts.enabled ? req.visitor?.username || process.env.READER_USER || 'reader' : '',
  authenticated: !demo && accounts.enabled, pageSize: opdsPageSize,
}));
app.get('/api/storage', async (req, res) => res.json(await storageFor(req.visitor)));
app.get('/api/proficiency', (req,res)=>res.json(proficiency.summary(req.visitor)));
app.put('/api/proficiency', (req,res)=>res.json(proficiency.save(req.body ?? {},req.visitor)));
app.get('/api/reading-time', (req, res) => res.json(readingTime.summary(readingAccount(req.visitor))));
app.post('/api/books/:id/reading-time', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor), account = readingAccount(req.visitor);
  try { res.json(readingTime.record(book, req.body ?? {}, account)); }
  catch (error) { if (error.accountChanged) return res.status(409).json({ error: error.message, accountChanged: true }); throw error; }
});
app.get('/api/discovery', (req, res) => res.json(discovery.status(req.visitor)));
app.get('/api/book-catalogue/gutenberg',async(req,res)=>res.json(await webImports.catalogue(req.query.q,Number(req.query.page||1))));
app.post('/api/imports/web', (req,res)=>res.status(202).json(webImports.queue(req.body ?? {},req.visitor)));
app.get('/api/settings/kavita', (req,res)=>res.json(kavita.settings(req.visitor)));
app.put('/api/settings/kavita', async(req,res)=>res.json(await kavita.save(req.body ?? {},req.visitor)));
app.delete('/api/settings/kavita', (req,res)=>res.json(kavita.remove(req.visitor)));
app.get('/api/kavita/catalogue', async(req,res)=>res.json(await kavita.catalogue(req.visitor,req.query)));
app.get('/api/kavita/covers/:id', async(req,res)=>{const image=await kavita.cover(req.params.id,req.visitor);res.set('Cache-Control','private, no-store').type(image.thumbnailType).send(image.thumbnail);});
app.post('/api/imports/kavita', (req,res)=>res.status(202).json(webImports.queueKavita(req.body ?? {},req.visitor)));
const conversionUpload = multer({dest:library.uploads,limits:{fileSize:Math.min(uploadLimit,conversionLimit),files:1,fields:12,fieldSize:4096}}).single('file');
app.post('/api/imports/convert', ...demoUploads, (req,res,next)=>{req.conversionUpload=true;conversionUpload(req,res,next);}, async(req,res)=>res.status(202).json(await webImports.queueFile(req.file,req.body ?? {},req.visitor)));
app.get('/api/imports/web', (req,res)=>res.json({jobs:webImports.list(req.visitor)}));
app.post('/api/imports/web/:id/retry',(req,res)=>res.status(202).json(webImports.retry(req.params.id,req.visitor)));
app.get('/api/processes', (req, res) => res.json(processes.list(req.visitor)));
app.delete('/api/processes/:id', async (req,res) => {
  const job=processes.list(req.visitor).jobs.find((item) => item.id === req.params.id);
  if (!job) throw new RequestError(404,'Process not found.');
  if (!job.cancellable) throw new RequestError(403,'Only the book owner can cancel this process, and completed files cannot be cancelled.');
  const id=job.id.slice(job.id.indexOf(':')+1), book=job.bookId ? library.getBook(job.bookId,req.visitor) : null;
  if (['web-import','conversion','kavita-import'].includes(job.kind)) webImports.cancel(id,req.visitor);
  else if (job.kind === 'archive') archive.cancel(id,req.visitor);
  else if (job.kind === 'discovery') discovery.cancel(req.visitor);
  else if (job.kind === 'ocr') ocr.cancel(book,id);
  else if (job.kind === 'audiobookshelf') { if (!usesOwnerAudiobookshelf(req)) throw new RequestError(403,'This Audiobookshelf connection belongs to the instance owner.'); audiobookshelf.cancel(book,id); }
  else if (job.kind === 'ivoox') learning.ivoox.cancel(book);
  else learning.cancelProcess(job.kind,book,id);
  res.json({cancelled:true});
});
app.post('/api/discovery', ...(demo ? [limitJobs({ perMinute: 6, perVisitor: 2 })] : []), (req, res) => res.status(202).json(discovery.queue(req.body ?? {}, req.visitor)));
app.delete('/api/discovery', (req, res) => res.json(discovery.cancel(req.visitor)));
app.get('/api/library', async (req, res) => {
  const snapshot = library.snapshot(req.visitor);
  const books = snapshot.books.map((book) => ({ ...book, learning: learningLanguages(learning.info(library.getBook(book.id, req.visitor)), nativeLanguage(req.visitor)) }));
  const reader = learning.vocabulary.profile(req.visitor);
  res.json({
    ...snapshot,
    progress: demo ? null : progressSync.snapshot(req.visitor),
    storage: await storageFor(req.visitor),
    imports: webImports.list(req.visitor),
    archive: { available: !demo, hasKey: archive.settings(req.visitor).hasKey, job: demo ? null : archive.latest(req.visitor), jobs: demo ? [] : archive.list(req.visitor) },
    vocabulary: { byLanguage: reader.byLanguage, likelyKnown: reader.knownByLanguage, threshold: reader.threshold, reading: reader.reading },
    readingTime: readingTime.summary(readingAccount(req.visitor)),
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
app.get('/api/categories', (req, res) => res.json({ categories: library.snapshot(req.visitor).categories }));
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
  let narrationOptions;
  try {
    const allowed = new Set(['title','author','language','languages','categoryId','coverStyle','coverUrl','autoAudiobook','audiobookDelayMinutes','shared','series','seriesIndex']);
    if (Object.keys(req.body ?? {}).some((key) => !allowed.has(key))) throw new RequestError(400, 'Too many book details were submitted. Refresh the page and try again.');
    if (Object.entries(req.body ?? {}).some(([key, value]) => typeof value !== 'string' || key !== 'coverUrl' && Buffer.byteLength(value) > 1024)) throw new RequestError(400, 'One of the book details is too long or invalid. Shorten it and try again.');
    narrationOptions = importNarrationOptions(req.body ?? {});
    if (demo && narrationOptions) throw new RequestError(403, 'Scheduled audiobook generation is available on self-hosted installations.');
  } catch (error) { if (req.file?.path) await rm(req.file.path, { force: true }); throw error; }
  const imported = await library.importBook(randomUUID(), req.file, req.body ?? {}, req.visitor);
  learning.scheduleAudiobook(library.getBook(imported.id, req.visitor), narrationOptions ?? {});
  res.status(201).json(imported);
});
app.post('/api/books/:id/cover', ...demoUploads, async (req, res) => res.json(await library.importCover(req.params.id, req.body?.url, req.visitor)));
app.patch('/api/books/:id', async (req, res) => {
  const details = await library.resolveBookDetails(req.params.id, req.body ?? {}, req.visitor);
  const book = library.editBook(req.params.id, details, req.visitor);
  learning.ensure(library.getBook(book.id, req.visitor));
  res.json(book);
});
app.patch('/api/books/:id/read-status', (req, res) => {
  const status = library.setReadStatus(req.params.id, req.body ?? {}, req.visitor);
  if (status.readAt) learning.ensure(library.getBook(status.id, req.visitor));
  learning.vocabulary.syncCompletions(req.visitor);
  res.json(status);
});
app.patch('/api/books/:id/currently-reading', (req, res) => res.json(library.setCurrentlyReading(req.params.id, req.body ?? {}, req.visitor)));
app.patch('/api/books/:id/set-aside', (req, res) => res.json(library.setAside(req.params.id, req.body ?? {}, req.visitor)));
app.get('/api/archive/search', (req, res) => {
  const title = typeof req.query.title === 'string' ? req.query.title.slice(0, 250) : '', author = typeof req.query.author === 'string' ? req.query.author.slice(0, 200) : '';
  if (!title.trim()) throw new RequestError(422, 'Choose a book title to search.');
  const url = new URL('/search', archive.settings().baseUrl || 'https://annas-archive.gl'); url.searchParams.set('q', [title.trim(), author.trim()].filter(Boolean).join(' ')); res.redirect(302, url.href);
});
app.delete('/api/books/:id', async (req, res) => {
  await library.removeBook(req.params.id, req.visitor);
  await learning.remove(req.params.id);
  bookPinyin.forget(req.params.id);
  if (!demo) progressSync.forgetBook(req.params.id);
  res.sendStatus(204);
});
app.get('/api/books/:id/learning', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  const result = learning.chapters(book), native = nativeLanguage(req.visitor);
  res.json({ ...result, rescanAvailable: result.rescanAvailable && book.canEdit !== false, analysis: learningLanguages(result.analysis, native), chapters: result.chapters.map((chapter) => learningLanguages(chapter, native)),
    familiarity: learning.vocabulary.familiarity(book, learning.vocabulary.profile(req.visitor)) });
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
  res.json({ ...learning.narration(library.getBook(req.params.id, req.visitor), typeof req.query.recording === 'string' ? req.query.recording : undefined), absConnected: usesOwnerAudiobookshelf(req) && audiobookshelf.settings().connected });
});
app.get('/api/books/:id/recordings', (req, res) => {
  const book = library.getBook(req.params.id, req.visitor);
  res.json({ available: !demo && book.canEdit !== false, maxUpload: maxAudioUpload, recordings: demo ? [] : learning.recordings.list(book).map((item) => ({ ...item, rescan: learning.rescans.status(book, item.id) })) });
});
if (!demo) {
  app.post('/api/books/:id/recordings/chapters', (req, _res, next) => {
    req.audioBook = library.getBook(req.params.id, req.visitor); req.audioUpload = true; req.chapterUpload = true;
    learning.ensure(req.audioBook);
    if (Number(req.get('Content-Length')) > maxAudioUpload + 1024 * 1024) throw new RequestError(413, 'Chapter files must total 1 GiB or less per recording.');
    next();
  }, chapterUpload.array('files', chapterFileLimit), async (req, res) => {
    res.status(202).json(await learning.recordings.acceptChapters(req.audioBook, req.files, req.body ?? {}));
  });
  app.get('/api/books/:id/recordings/:recording/chapters/:chapter/file', (req, res) => {
    const file = learning.recordings.originalChapter(library.getBook(req.params.id, req.visitor), req.params.recording, Number(req.params.chapter));
    res.type('application/octet-stream').download(file.path, file.name, { dotfiles: 'allow' });
  });
  app.get('/api/books/:id/ivoox', (req, res) => res.json({ job: learning.ivoox.latest(library.getBook(req.params.id, req.visitor)) }));
  app.post('/api/books/:id/ivoox', (req, res) => {
    const book = library.getBook(req.params.id, req.visitor); learning.ensure(book);
    res.status(202).json({ job: learning.ivoox.queue(book, req.body) });
  });
  app.delete('/api/books/:id/ivoox', (req, res) => { learning.ivoox.cancel(library.getBook(req.params.id, req.visitor)); res.sendStatus(204); });
  app.post('/api/books/:id/audio/:recording/rescan', (req, res) => res.status(202).json(learning.rescans.queue(library.getBook(req.params.id, req.visitor), req.params.recording)));
  app.delete('/api/books/:id/audio/:recording/rescan', (req, res) => res.json(learning.rescans.cancel(library.getBook(req.params.id, req.visitor), req.params.recording)));
  app.post('/api/books/:id/recordings', (req, _res, next) => {
    library.getBook(req.params.id, req.visitor);
    req.audioUpload = true;
    if (Number(req.get('Content-Length')) > maxAudioUpload + 16384) return next(new RequestError(413, 'Audio files must be 1 GiB or smaller.'));
    next();
  }, audioUpload.single('file'), async (req, res) => {
    res.status(201).json(await learning.recordings.accept(library.getBook(req.params.id, req.visitor), req.file, req.body ?? {}));
  });
  app.post('/api/books/:id/recordings/:recording/sync', (req, res) => {
    res.status(202).json(learning.recordings.queue(library.getBook(req.params.id, req.visitor), req.params.recording));
  });
  app.delete('/api/books/:id/recordings/:recording', async (req, res) => {
    await learning.recordings.remove(library.getBook(req.params.id, req.visitor), req.params.recording);
    res.sendStatus(204);
  });
  app.get('/api/books/:id/recordings/:recording/file', (req, res) => {
    const file = learning.recordings.original(library.getBook(req.params.id, req.visitor), req.params.recording);
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
app.post('/api/books/:id/pinyin', ...demoDictionaryRequests, (req, res) => res.json(bookPinyin.annotation(library.getBook(req.params.id, req.visitor), req.body ?? {}, req.visitor?.expires ?? null)));
app.post('/api/ai/word', (req, res, next) => {
  if (req.body?.mode !== 'synonyms') return next();
  res.json(lookupSynonyms(req.body));
});
for (const [path, generate] of [['word', ai.word], ['summary', ai.summary], ['phrase', ai.phrase]]) {
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
    if (_req.fontUpload) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Font files must be at most 32 MiB.' : 'Choose one font file and an optional name.' });
    if (_req.audioUpload) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? 'Audio files must be 1 GiB or smaller.' : _req.chapterUpload ? 'Choose at most 200 chapter files and one recording name.' : 'Upload one audiobook at a time.',
    });
    const errors = {
      LIMIT_FILE_SIZE: _req.conversionUpload ? `Documents for conversion must be ${Math.min(uploadLimit,conversionLimit)/1024**2} MiB or smaller.` : `Books must be ${uploadLimit / 1024 / 1024} MiB or smaller.`,
      LIMIT_FILE_COUNT: 'Upload one book at a time.',
      LIMIT_FIELD_COUNT: 'Too many book details were submitted. Refresh the page and try again.',
      LIMIT_FIELD_VALUE: 'One of the book details is too long. Shorten it and try again.',
      LIMIT_FIELD_KEY: 'A book detail has an invalid field name.',
      LIMIT_UNEXPECTED_FILE: err.field === 'file' ? 'Upload one book at a time.' : 'Unexpected file field in the book upload.',
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
