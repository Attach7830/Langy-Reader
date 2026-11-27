import { chromium } from 'playwright';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const output = 'browser-results'; await mkdir(output, { recursive: true });
const dir = await mkdtemp(join(tmpdir(), 'langy-browser-'));
const base = 'http://127.0.0.1:19391', serverLog = [], errors = [], results = [];
const adminPassword = 'browser-administrator-test-password', memberPassword = 'browser-member-test-password';
const adminHeaders = { Authorization: 'Basic ' + Buffer.from(`reader:${adminPassword}`).toString('base64') };
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: '19391', READER_DATA: dir, READER_DEMO: '0', READER_USER: 'reader', READER_PASSWORD: adminPassword, READER_SYNC_USER: '', READER_SYNC_PASSWORD: '', READER_LANGUAGE_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'] });
for (const pipe of [server.stdout, server.stderr]) pipe.on('data', (part) => { if (serverLog.length < 200) serverLog.push(part.toString()); });
let browser, context, page, demoServer;
try {
  for (let i = 0; i < 100; i++) { if (await fetch(base + '/healthz').then((r) => r.ok).catch(() => false)) break; if (server.exitCode != null) throw new Error('Server failed: ' + serverLog.join('')); await delay(100); }
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: 'block', extraHTTPHeaders: adminHeaders });
  await context.addInitScript(() => { if (window.top === window) { const prefs = JSON.parse(localStorage.getItem('langy-settings-v1') || '{}'); localStorage.setItem('langy-settings-v1', JSON.stringify({ ...prefs, progressSyncEnabled: false })); } });
  page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/ai/word', (route) => route.fulfill({ json: { text: 'A useful dictionary definition.', language: 'en', senses: [
    { label: 'First contextual meaning', terms: [], source: 'Test dictionary' }, { label: 'Second contextual meaning', terms: [], source: 'Test dictionary' },
  ] } }));
  const zip = new JSZip(); zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/book.opf', '<?xml version="1.0"?><package version="3.0" unique-identifier="id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">langy-browser-fixture</dc:identifier><dc:title>Reader interactions</dc:title><dc:language>es</dc:language></metadata><manifest><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/><itemref idref="notes"/></spine></package>');
  zip.file('OEBPS/cover.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=', 'base64'));
  zip.file('OEBPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">Primera parte</a></li><li><a href="two.xhtml">Segunda parte</a></li><li><a href="notes.xhtml">Notas</a></li></ol></nav></body></html>');
  const paragraph = 'La viajera llegó a una casa tranquila cerca del río. En la ventana había una planta pequeña y un libro abierto. Quería conocer la historia del pueblo, así que se sentó a conversar con la mujer que cuidaba el jardín. Todavía quedaban muchas cosas por descubrir.';
  for (const name of ['one', 'two']) zip.file(`OEBPS/${name}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${name}</title></head><body><h1>${name === 'one' ? 'Primera parte' : 'Segunda parte'}</h1><p id="source">${paragraph} <a href="notes.xhtml#note">Leer nota</a></p>${Array.from({ length: 90 }, (_, i) => `${name === 'two' && i === 45 ? '<p>En el puerto, el <em id="search-destination">faro violeta</em> ilumina la costa.</p>' : ''}<p id="passage-${i}">${paragraph} ${paragraph}</p>`).join('')}</body></html>`);
  zip.file('OEBPS/notes.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Notas</title></head><body><h1 id="note">Una nota del libro</h1><p>Esta explicación ayuda a comprender el pasaje.</p></body></html>');
  const uploaded = await context.request.post(base + '/api/books', { multipart: { title: 'Reader interactions', language: 'es', autoAudiobook: 'true', audiobookDelayMinutes: '7', file: { name: 'reader.epub', mimeType: 'application/epub+zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) } } });
  assert.equal(uploaded.status(), 201, await uploaded.text()); const book = await uploaded.json();
  const importAudio = await (await context.request.get(base + '/api/books/' + book.id + '/narration')).json();
  const samples = 120 * 8000, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  // Match Express sendFile's byte-range support so native media seeks can
  // reach later chapters while preload="metadata" has buffered only the start.
  await page.route('**/browser-audio.wav', (route) => {
    const range = /^bytes=(\d+)-(\d*)$/u.exec(route.request().headers().range || '');
    if (!range) return route.fulfill({ body: wav, contentType: 'audio/wav', headers: { 'Accept-Ranges': 'bytes' } });
    const start = Number(range[1]), end = Math.min(wav.length - 1, range[2] ? Number(range[2]) : wav.length - 1);
    if (start > end) return route.fulfill({ status: 416, headers: { 'Content-Range': `bytes */${wav.length}` } });
    return route.fulfill({ status: 206, body: wav.subarray(start, end + 1), contentType: 'audio/wav',
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${wav.length}` } });
  });
  await page.route('**/api/books/' + book.id + '/narration*', (route) => route.fulfill({ json: { connected: true, recordings: [], audio: {
    id: 'browser', state: 'ready', url: '/browser-audio.wav', duration: 120,
    segments: [{ key: 'epub:0', start: 0, end: 50, scale: 1 }, { key: 'epub:1', start: 50, end: 110, scale: 1 }, { key: 'epub:2', start: 110, end: 120, scale: 1 }],
    markers: [{ title: 'Primera parte', time: 0 }, { title: 'Segunda parte', time: 50 }],
  } } }));
  await page.route('**/api/books/' + book.id + '/chapters/*', (route) => route.fulfill({ json: { key: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)), tokens: [], audio: { timings: [] } } }));
  const cdp = await context.newCDPSession(page);
  const position = () => page.evaluate((id) => JSON.parse(localStorage.getItem('langy-progress-v1') || '{}')[id]?.target, book.id);
  async function open() {
    await page.goto(base + '/#read/' + book.id);
    await page.locator('#viewer iframe').first().waitFor({ timeout: 20000 });
    await page.waitForFunction((id) => Boolean(JSON.parse(localStorage.getItem('langy-progress-v1') || '{}')[id]?.target), book.id);
    await page.locator('#reader-message').waitFor({ state: 'hidden', timeout: 20000 });
    await page.waitForTimeout(250);
  }
  async function check(name, action) {
    try { await action(); results.push({ name, pass: true }); console.log('PASS', name); }
    catch (error) { const diagnostic = await page.evaluate(() => { const prefs = JSON.parse(localStorage.getItem('langy-settings-v1') || '{}'), audio = document.querySelector('#narration-audio'); return { page: document.querySelector('#page-label')?.textContent, section: document.querySelector('#position-detail')?.textContent, size: prefs.size, touchSize: prefs.touchSize, touch: matchMedia('(pointer:coarse)').matches, scale: visualViewport.scale, feedback: document.querySelector('#text-size-feedback')?.textContent, status: document.querySelector('#narration-status')?.textContent, src: audio?.getAttribute('src'), ready: audio?.readyState, paused: audio?.paused, time: audio?.currentTime, selection: document.querySelector('#viewer iframe')?.contentWindow?.getSelection()?.toString(), error: audio?.error?.message }; }).catch(() => null); results.push({ name, pass: false, error: error.stack, diagnostic }); console.error('FAIL', name, error.message, JSON.stringify(diagnostic)); await page.screenshot({ path: `${output}/${results.length}-failure.png` }).catch(() => {}); }
  }
  async function swipe(dx, dy = 0, wiggle = false, selector = '.reading-main') {
    const box = await page.locator(selector).boundingBox(), x = box.x + box.width * .65, y = box.y + box.height * .5;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    if (wiggle) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 3, y: y + 18 }] });
    for (let n = 1; n <= 8; n++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * n / 8, y: y + dy * n / 8 }] }); await delay(12); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  async function changed(before) { await page.waitForFunction(({ id, before }) => JSON.parse(localStorage.getItem('langy-progress-v1') || '{}')[id]?.target !== before, { id: book.id, before }, { timeout: 4000 }); }
  async function useAndroidApp(browserContext, currentPage) {
    const bridge = (await readFile('android/app/src/main/assets/reader-fullscreen.js', 'utf8')).replace('__LANGY_FULLSCREEN_TOKEN__', 'browser-test-native-channel');
    await browserContext.addInitScript({ content: bridge + `\ndocument.addEventListener('DOMContentLoaded', () => { const channel = new MessageChannel(); window.postMessage('browser-test-native-channel', location.origin, [channel.port2]); }, { once: true });` });
    await currentPage.reload(); await currentPage.locator('#android-app-controls').waitFor({ state: 'attached' });
  }
  await page.goto(base + '/#library');
  await page.locator('#books a[href="#read/' + book.id + '"]').waitFor();
  await check('unlimited accounts show the actual library drive capacity bar', async () => {
    await page.locator('#storage-meter').waitFor({ state: 'visible' });
    const capacity = await page.evaluate(() => ({ max: document.querySelector('#storage-meter').max, value: document.querySelector('#storage-meter').value,
      label: document.querySelector('#storage-meter').getAttribute('aria-label'), summary: document.querySelector('#storage-summary').textContent,
      detail: document.querySelector('#storage-detail').textContent }));
    const storage = await (await context.request.get(base + '/api/storage')).json();
    assert.equal(storage.unlimited, true); assert.equal(storage.drive.available, true);
    assert.equal(capacity.max, storage.drive.totalBytes);
    assert.ok(capacity.value > storage.usedBytes, 'the bar includes other drive files, not just this account');
    assert.equal(capacity.label, 'Library drive space used or reserved');
    assert.match(capacity.summary, /^Library drive · .+ available$/u);
    assert.match(capacity.detail, /shared with other files on this drive/u);
  });
  await check('mobile library uses compact controls and book actions contain no statistics', async () => {
    assert.equal(await page.locator('#mobile-navigation').isVisible(), true);
    assert.equal(await page.locator('.mobile-collections').isVisible(), true);
    assert.equal(await page.locator('.library-rail').isVisible(), false);
    assert.equal(await page.locator('.book-reading-details').first().isVisible(), false);
    await page.locator('.book-mobile-menu').first().click();
    await page.locator('#book-actions-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#book-actions-dialog .book-word-count, #book-actions-dialog .book-metrics').count(), 0);
    assert.equal(await page.locator('#book-actions-dialog').getByRole('button', { name: 'Save offline', exact: true }).count(), 0, 'a phone browser is still the web version');
    await page.locator('#book-actions-dialog [data-close]').click();
    await page.locator('#mobile-filters-toggle').click(); await page.locator('#book-format-filter').selectOption('pdf');
    await page.locator('#empty-title').filter({ hasText: 'No matching books' }).waitFor();
    await page.waitForFunction(() => { const saved = JSON.parse(localStorage.getItem('langy-account-settings-v1') || '{}'); return saved.accountId && !Object.keys(saved.pending || {}).length; });
    await page.reload(); await page.locator('#empty-title').filter({ hasText: 'No matching books' }).waitFor();
    await page.locator('#mobile-filters-toggle').click(); assert.equal(await page.locator('#book-format-filter').inputValue(), 'pdf');
    await page.screenshot({ path: output + '/mobile-format-filter.png' });
    await page.locator('#book-format-filter').selectOption('epub'); await page.locator('#books a[href="#read/' + book.id + '"]').waitFor();
    await page.locator('#book-format-filter').selectOption(''); await page.locator('#mobile-filters-toggle').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: output + '/mobile-library.png', fullPage: true });
  });
  await check('cover cache defaults on, survives reload, clears on request and disables per account', async () => {
    await page.waitForFunction((id) => document.querySelector(`[data-book="${id}"] .book-cover img`)?.src.startsWith('data:image/'), book.id);
    let requests = 0; const count = (request) => { if (new URL(request.url()).pathname.endsWith('/cover')) requests++; }; page.on('request', count);
    await page.reload(); await page.waitForFunction((id) => document.querySelector(`[data-book="${id}"] .book-cover img`)?.src.startsWith('data:image/'), book.id);
    assert.equal(requests, 0, 'cached images require no cover request after reload'); page.off('request', count);
    await page.locator('#mobile-navigation [data-settings]').click(); await page.locator('[data-settings-tab="reading"]').click();
    assert.equal(await page.locator('[name=cacheCovers]').isChecked(), true);
    await page.locator('#clear-cover-cache').click(); await page.locator('#cover-cache-status').filter({ hasText: 'Cached cover images cleared.' }).waitFor();
    assert.equal(await page.evaluate(async () => (await caches.keys()).some((key) => key.startsWith('langy-covers-'))), false);
    await page.locator('[name=cacheCovers]').uncheck(); await page.locator('#settings-form button[type=submit]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('langy-settings-v1')).cacheCovers === false);
    await page.waitForFunction(() => !Object.keys(JSON.parse(localStorage.getItem('langy-account-settings-v1') || '{}').pending || {}).length);
    await page.reload(); await page.locator('#mobile-navigation [data-settings]').click(); await page.locator('[data-settings-tab="reading"]').click();
    assert.equal(await page.locator('[name=cacheCovers]').isChecked(), false);
    assert.equal((await (await context.request.get(base + '/api/settings/reader')).json()).preferences.cacheCovers, false);
    await page.locator('[name=cacheCovers]').check(); await page.locator('#settings-form button[type=submit]').click(); await page.locator('#books .book-card').first().waitFor();
  });
  await check('Devices saves and tests the optional OCR connector without exposing its key', async () => {
    let saved = { configurable: true, provider: 'builtin', baseUrl: '', hasKey: false }, key;
    await page.route('**/api/settings/ocr', async (route) => {
      if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); key = body.apiKey; saved = { ...saved, provider: body.provider, baseUrl: body.baseUrl, hasKey: Boolean(key) }; }
      await route.fulfill({ json: saved });
    });
    await page.locator('#mobile-navigation [data-settings]').click(); await page.locator('[data-settings-tab="devices"]').click();
    await page.locator('#ocr-service-controls').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#ocr-external-fields').isVisible(), false);
    await page.locator('#ocr-provider').selectOption('paddle'); await page.locator('#ocr-service-url').fill('http://ocr.test:8093'); await page.locator('#ocr-service-key').fill('browser-synthetic-ocr-key');
    await page.locator('#ocr-service-save').click(); await page.locator('#ocr-service-status').filter({ hasText: 'tested and saved' }).waitFor();
    assert.equal(key, 'browser-synthetic-ocr-key'); assert.equal(await page.locator('#ocr-service-key').inputValue(), ''); assert.equal(await page.locator('#ocr-remove-key').isVisible(), true);
    await page.screenshot({ path: output + '/ocr-connector-mobile.png' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#ocr-provider').selectOption('builtin'); await page.locator('#ocr-service-save').click(); await page.locator('#ocr-service-status').filter({ hasText: 'Built-in OCR selected.' }).waitFor();
    await page.locator('#settings-back').click(); await page.unroute('**/api/settings/ocr');
  });
  await check('cover imports close book details immediately and remain visible in Process queue until finished', async () => {
    let importedURL, release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/books/' + book.id + '/cover', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      importedURL = route.request().postDataJSON().url;
      await held;
      await route.fulfill({ json: { ...book, thumbnailType: 'image/png', coverRevision: 'browser-cover', updatedAt: Date.now() } });
    });
    try {
      await page.locator(`[data-book="${book.id}"] .book-mobile-menu`).click();
      await page.locator('#book-actions-body button').filter({ hasText: /^Edit book details$/ }).click();
      await page.locator('#book-form [name=coverUrl]').fill('https://images.example.org/cover.png'); await page.locator('#book-import-cover').click();
      await page.locator('#book-dialog').waitFor({ state: 'hidden' });
      await page.locator('#mobile-navigation [data-open-processes]').click();
      await page.locator('.process-card').filter({ hasText: 'Import book cover' }).waitFor();
      await page.locator('#downloads-dialog [data-close]').first().click(); release();
      await page.locator('#toast').filter({ hasText: 'Cover imported.' }).waitFor();
      assert.equal(importedURL, 'https://images.example.org/cover.png'); assert.equal(await page.locator('#book-form [name=coverUrl]').inputValue(), '');
    } finally { release(); await page.unroute('**/api/books/' + book.id + '/cover'); }
  });
  await check('automatic cover search uses the current title and author and selects a stored Google cover', async () => {
    let searched;
    await page.route('**/api/covers/search', async(route)=>{searched=route.request().postDataJSON();await route.fulfill({json:{covers:[{id:'browser-cover',provider:'google',title:'Matching edition',author:'A Writer',source:'https://books.google.com/books?id=browser',url:'https://books.google.com/books/content?id=browser',preview:'/api/books/'+book.id+'/cover'}]}});});
    await page.locator(`[data-book="${book.id}"] .book-mobile-menu`).click();await page.locator('#book-actions-body button').filter({hasText:/^Edit book details$/}).click();
    const title=await page.locator('#book-form [name=title]').inputValue();await page.locator('#book-cover-provider').selectOption('google');await page.locator('#find-book-covers').click();await page.getByRole('button',{name:'Use this cover',exact:true}).click();
    assert.equal(searched.title,title);assert.equal(searched.provider,'google');assert.equal(await page.locator('#book-form [name=coverUrl]').inputValue(),'https://books.google.com/books/content?id=browser');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'Close book details',exact:true}).click();await page.unroute('**/api/covers/search');
  });
  await check('key-free automatic cover search defaults to public sources and shows available results with provider notices',async()=>{
    let searched;
    await page.route('**/api/covers/search',async(route)=>{searched=route.request().postDataJSON();await route.fulfill({json:{notice:'Google Books is temporarily unavailable; showing results from the other source.',covers:[{id:'open-library-cover',provider:'openlibrary',title:'Public catalogue edition',author:'A Writer',source:'https://openlibrary.org/works/OL1W',url:'https://covers.openlibrary.org/b/id/123-L.jpg?default=false',preview:'/api/books/'+book.id+'/cover'}]}});});
    await page.locator('#import-book').click();
    assert.equal(await page.locator('#book-cover-provider').inputValue(),'auto');
    await page.locator('#book-form [name=title]').fill('Public catalogue book');
    await page.locator('#find-book-covers').click();
    await page.getByRole('link',{name:'Open Library edition',exact:true}).waitFor();
    await page.locator('#book-cover-error').filter({hasText:'Google Books is temporarily unavailable'}).waitFor();
    await page.getByRole('button',{name:'Use this cover',exact:true}).click();
    assert.equal(searched.provider,'auto');assert.equal(await page.locator('#book-form [name=coverUrl]').inputValue(),'https://covers.openlibrary.org/b/id/123-L.jpg?default=false');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'Close book details',exact:true}).click();await page.unroute('**/api/covers/search');
  });
  await check('series metadata saves on mobile, filters books across folders and sorts by numeric reading order', async () => {
    const ids = [], bytes = await zip.generateAsync({ type: 'nodebuffer' });
    try {
      for (const number of ['2.5', '1']) {
        const result = await context.request.post(base + '/api/books', { multipart: { title: 'Series book ' + number, language: 'es', series: 'Browser stories', seriesIndex: number, file: { name: 'series.epub', mimeType: 'application/epub+zip', buffer: bytes } } });
        assert.equal(result.status(), 201); ids.push((await result.json()).id);
      }
      await page.reload(); await page.locator(`[data-book="${ids[0]}"]`).waitFor();
      await page.locator('#mobile-filters-toggle').click(); await page.locator('#book-series-filter').selectOption('series:browser stories');
      assert.equal(await page.locator('#book-sort').inputValue(), 'series');
      assert.deepEqual(await page.locator('#books .book-card').evaluateAll((cards) => cards.map((card) => card.dataset.book)), [ids[1], ids[0]]);
      await page.locator(`[data-book="${ids[0]}"] .book-mobile-menu`).click(); await page.locator('#book-actions-body button').filter({ hasText: /^Edit book details$/ }).click();
      assert.equal(await page.locator('#book-form [name=series]').inputValue(), 'Browser stories'); assert.equal(await page.locator('#book-form [name=seriesIndex]').inputValue(), '2.5');
      await page.locator('#book-form [name=seriesIndex]').fill('3'); await page.locator('#book-submit').click(); await page.locator('#book-dialog').waitFor({ state: 'hidden' });
      await page.locator(`[data-book="${ids[0]}"] .book-series`).filter({ hasText: 'Book 3' }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: output + '/series-mobile.png' });
    } finally { for (const id of ids) await context.request.delete(base + '/api/books/' + id); await page.reload(); await page.locator(`[data-book="${book.id}"]`).waitFor(); }
  });
  await check('queuing OCR closes its dialog and Process queue Details can reopen the active scan', async () => {
    const created = await context.request.post(base + '/api/books', { multipart: { title: 'OCR browser PDF', language: 'es', file: { name: 'ocr.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') } } });
    assert.equal(created.status(), 201); const pdf = await created.json(); let job = null;
    const ocrPath = '**/api/books/' + pdf.id + '/ocr';
    await page.route(ocrPath, async (route) => {
      if (route.request().method() === 'POST') { assert.deepEqual(route.request().postDataJSON().languages, ['spa']); job = { id: 'browser-ocr', state: 'queued' }; await route.fulfill({ json: job }); }
      else await route.fulfill({ json: { available: true, languages: ['spa'], job } });
    });
    await page.route('**/api/processes', async (route) => { const response = await route.fetch(), result = await response.json(); await route.fulfill({ json: { ...result, jobs: [...result.jobs, ...(job ? [{ id: 'ocr:browser-ocr', kind: 'ocr', label: 'Scan PDF with OCR', state: 'queued', bookId: pdf.id, title: pdf.title, created: Date.now() }] : [])] } }); });
    try {
      await page.reload(); await page.locator(`[data-book="${pdf.id}"] .book-mobile-menu`).click(); await page.locator('#book-actions-body button').filter({ hasText: /^Scan PDF with OCR$/ }).click();
      await page.locator('#ocr-submit').click(); await page.locator('#ocr-dialog').waitFor({ state: 'hidden' });
      await page.locator('#mobile-navigation [data-open-processes]').click(); await page.locator('[data-process="ocr:browser-ocr"]').getByRole('button', { name: 'Details', exact: true }).click();
      await page.locator('#ocr-dialog').waitFor({ state: 'visible' }); await page.locator('#ocr-progress').filter({ hasText: 'queued' }).waitFor();
      assert.equal(await page.locator('#ocr-dialog').isVisible(), true); await page.getByRole('button', { name: 'Close OCR', exact: true }).click();
    } finally { await page.unroute(ocrPath); await page.unroute('**/api/processes'); await context.request.delete(base + '/api/books/' + pdf.id); await page.reload(); await page.locator(`[data-book="${book.id}"]`).waitFor(); }
  });
  await check('document uploads queue EPUB conversion, close the dialog and appear without blocking the library', async () => {
    let imported;
    try {
      await page.locator('#import-book').click();
      await page.locator('#book-file').setInputFiles({ name:'A converted story.txt',mimeType:'text/plain',buffer:Buffer.from('Una historia sencilla. La viajera llegó a una casa cerca del río. Había un libro abierto en la ventana.') });
      await page.locator('#book-form [name=title]').fill('Browser conversion story'); await page.locator('#book-form [name=language]').fill('es');
      const response=page.waitForResponse((item)=>item.url().endsWith('/api/imports/convert')&&item.request().method()==='POST');await page.locator('#book-submit').click();const queued=await(await response).json();assert.equal(queued.kind,'conversion');
      await page.locator('#book-dialog').waitFor({state:'hidden'});
      for(let index=0;index<100;index++){const jobs=await(await context.request.get(base+'/api/imports/web')).json();const job=jobs.jobs.find((item)=>item.id===queued.id);if(job?.state==='error')throw new Error(job.error);if(job?.state==='ready'){imported=job.book;break;}await delay(100);}
      assert.ok(imported);await page.locator(`[data-book="${imported}"]`).waitFor({timeout:10000});assert.equal(await page.locator(`[data-book="${imported}"] .book-format`).textContent(),'EPUB');
    }finally{if(imported)await context.request.delete(base+'/api/books/'+imported);await page.reload();await page.locator(`[data-book="${book.id}"]`).waitFor();}
  });
  await check('personal Kavita OPDS connects, browses and queues an EPUB import on mobile', async () => {
    const bytes=await zip.generateAsync({type:'nodebuffer'});const source=createServer((req,res)=>{if(req.url==='/book.epub'){res.setHeader('Content-Type','application/epub+zip');return res.end(bytes);}res.setHeader('Content-Type','application/atom+xml');res.end('<feed xmlns="http://www.w3.org/2005/Atom"><title>My Kavita library</title><entry><title>Browser Kavita story</title><author><name>A Writer</name></author><link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="/book.epub"/></entry></feed>');});
    await new Promise((resolve)=>source.listen(0,'127.0.0.1',resolve));let imported;
    try{
      await page.goto(base+'/#settings/sources');await page.locator('#kavita-url').fill('http://127.0.0.1:'+source.address().port+'/feed/browser-test-key');await page.locator('#kavita-save').click();await page.locator('#kavita-browse:not([disabled])').waitFor();assert.equal(await page.locator('#kavita-url').inputValue(),'');
      await page.locator('#kavita-browse').click();await page.locator('#kavita-entries').getByRole('button',{name:'Import EPUB',exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:output+'/kavita-mobile.png'});
      await page.locator('#kavita-entries').getByRole('button',{name:'Import EPUB',exact:true}).click();await page.locator('#kavita-entries').getByRole('button',{name:'Queued',exact:true}).waitFor();
      for(let index=0;index<100;index++){const jobs=await(await context.request.get(base+'/api/imports/web')).json();const job=jobs.jobs.find((item)=>item.kind==='kavita');if(job?.state==='error')throw new Error(job.error);if(job?.state==='ready'){imported=job.book;break;}await delay(100);}assert.ok(imported);
      await page.getByRole('button',{name:'Close Kavita',exact:true}).click();await page.goto(base+'/#library');await page.locator(`[data-book="${imported}"]`).waitFor({timeout:10000});
    }finally{await context.request.delete(base+'/api/settings/kavita');if(imported)await context.request.delete(base+'/api/books/'+imported);await new Promise((resolve)=>source.close(resolve));await page.goto(base+'/#library');await page.reload();await page.locator(`[data-book="${book.id}"]`).waitFor();}
  });
  await check('reading profile excludes L1, saves input hours and comprehension checks and fits mobile',async()=>{
    const preferences=await(await context.request.get(base+'/api/settings/reader')).json();
    await context.request.patch(base+'/api/settings/reader',{data:{revision:preferences.revision,changes:{nativeLanguage:'en-US',readingLanguages:['en-GB','es','zh-Hans']}}});
    try{
      await page.reload();await page.goto(base+'/#proficiency');await page.locator('#proficiency-content').waitFor({state:'visible'});
      assert.equal(await page.locator('#proficiency-language option[value=en]').count(),0);await page.locator('#proficiency-language').selectOption('es');
      await page.locator('#proficiency-input-hours').fill('125.5');await page.locator('#proficiency-reading').selectOption('3');await page.locator('#proficiency-listening').selectOption('2');await page.locator('#proficiency-save').click();await page.locator('#proficiency-status').filter({hasText:'saved to your account'}).waitFor();
      assert.equal(await page.locator('#proficiency-reading-range').textContent(),'Intermediate–Advanced');await page.locator('#proficiency-metric').selectOption('hours');assert.equal(await page.locator('#proficiency-chart svg').count(),1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:output+'/reading-profile-mobile.png',fullPage:true});
      await page.locator('#proficiency-language').selectOption('zh');await page.locator('#proficiency-metric').selectOption('seen');assert.match(await page.locator('#proficiency-chart-label').textContent(),/Han characters/);await page.reload();await page.locator('#proficiency-language').selectOption('es');assert.equal(await page.locator('#proficiency-input-hours').inputValue(),'125.5');
    }finally{const latest=await(await context.request.get(base+'/api/settings/reader')).json();await context.request.patch(base+'/api/settings/reader',{data:{revision:latest.revision,changes:{nativeLanguage:preferences.preferences.nativeLanguage||'',readingLanguages:preferences.preferences.readingLanguages||[]}}});await page.goto(base+'/#library');await page.reload();await page.locator(`[data-book="${book.id}"]`).waitFor();}
  });
  await check('web imports select a Gutenberg edition and retain its folder and scheduled audiobook options',async()=>{
    let queued;
    await page.route('**/api/book-catalogue/gutenberg?*',route=>route.fulfill({json:{more:false,books:[{id:123,title:'A free classic',author:'A Writer',language:'en',url:'https://www.gutenberg.org/ebooks/123.epub3.images'}]}}));
    await page.route('**/api/imports/web',async(route)=>{queued=route.request().postDataJSON();await route.fulfill({status:202,json:{id:'browser-web',state:'queued'}});});
    await page.locator('#import-book').click();await page.locator('#book-source').selectOption('web');await page.locator('#web-book-fields summary').click();await page.locator('#gutenberg-query').fill('A free classic');await page.locator('#gutenberg-search').click();await page.getByRole('button',{name:'Use this EPUB',exact:true}).click();
    assert.equal(await page.locator('#book-form [name=title]').inputValue(),'A free classic');await page.locator('[name=autoAudiobook]').check();await page.locator('[name=audiobookDelayMinutes]').fill('9');
    const folder=await page.locator('#book-categories').inputValue();await page.locator('#book-submit').click();await page.locator('#book-dialog').waitFor({state:'hidden'});
    assert.equal(queued.url,'https://www.gutenberg.org/ebooks/123.epub3.images');assert.equal(queued.categoryId,folder);assert.equal(queued.autoAudiobook,'true');assert.equal(queued.audiobookDelayMinutes,'9');
    await page.unroute('**/api/imports/web');await page.unroute('**/api/book-catalogue/gutenberg?*');
  });
  await check('imported fonts render in EPUB pages, reload from the device cache and can be removed', async () => {
    await page.locator('#mobile-navigation [data-settings]').click(); await page.locator('[data-settings-tab=reading]').click();
    await page.locator('#font-file').setInputFiles({ name: 'reading.woff2', mimeType: 'font/woff2', buffer: await readFile('node_modules/@fontsource/spectral/files/spectral-latin-400-normal.woff2') });
    await page.locator('#font-import-name').fill('My reading font'); await page.locator('#import-font').click();
    await page.locator('#font-import-status').filter({ hasText: 'Font imported and selected.' }).waitFor(); const id = await page.locator('#font-options').inputValue(); assert.ok(id.startsWith('custom-'));
    await page.locator('#settings-form button[type=submit]').click(); await page.locator('#books .book-card').first().waitFor();
    await open(); const family = 'LangyFont' + id.slice(7).replaceAll('-', '');
    await page.waitForFunction((family) => [...(document.querySelector('#viewer iframe')?.contentDocument?.fonts || [])].some((font) => font.family.replaceAll('"', '') === family && font.status === 'loaded'), family);
    assert.ok((await page.frameLocator('#viewer iframe').locator('body').evaluate((body) => getComputedStyle(body).fontFamily)).includes(family));
    assert.equal(await page.evaluate(async (id) => Boolean(await (await caches.open('langy-fonts-' + localStorage.getItem('langy-offline-owner'))).match('/api/fonts/' + id.slice(7) + '/file')), id), true);
    await page.route('**/api/fonts**', (route) => route.abort()); await page.reload(); await page.locator('#viewer iframe').first().waitFor();
    await page.waitForFunction((family) => [...(document.querySelector('#viewer iframe')?.contentDocument?.fonts || [])].some((font) => font.family.replaceAll('"', '') === family && font.status === 'loaded'), family);
    await page.unroute('**/api/fonts**'); await page.goto(base + '/#settings/reading'); await page.getByRole('button', { name: 'Remove font My reading font', exact: true }).click();
    await page.locator('#font-import-status').filter({ hasText: 'Font removed.' }).waitFor(); assert.equal(await page.locator('#font-options').inputValue(), 'spectral');
    await page.locator('#settings-form button[type=submit]').click(); await page.goto(base + '/#library');
  });
  await check('the Process queue closes on an outside tap', async () => {
    await page.locator('#mobile-navigation [data-open-processes]').click();
    await page.locator('#downloads-dialog').waitFor({ state: 'visible' });
    await page.touchscreen.tap(3, 3); await page.locator('#downloads-dialog').waitFor({ state: 'hidden' });
  });
  await check('mobile library supports all column counts, list, covers only and a persistent queue dismissal delay', async () => {
    const options = page.locator('.library-view-options'); await options.locator('summary').click();
    for (const layout of ['1', '2', '3', '4', 'list']) {
      await page.locator('#library-layout').selectOption(layout);
      await page.waitForFunction((value) => document.querySelector('#books').dataset.layout === value, layout);
      const columns = await page.locator('#books').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
      assert.equal(columns, layout === 'list' ? 1 : Number(layout));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    assert.equal(await page.locator(`[data-book="${book.id}"] .book-format`).textContent(), 'EPUB');
    await page.locator('#library-covers-only').check(); assert.equal(await page.locator('.book-info').first().isVisible(), false);
    await page.locator('#library-covers-only').uncheck(); await page.locator('#library-layout').selectOption('auto'); await options.locator('summary').click();
    await page.locator('#mobile-navigation [data-open-processes]').click(); await page.locator('#process-dismiss-minutes').fill('2.5'); await page.locator('#process-dismiss-minutes').press('Tab');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('langy-settings-v1')).processDismissMinutes === 2.5);
    await page.waitForFunction(() => !Object.keys(JSON.parse(localStorage.getItem('langy-account-settings-v1') || '{}').pending || {}).length);
    await page.reload(); await page.locator('#mobile-navigation [data-open-processes]').click(); assert.equal(await page.locator('#process-dismiss-minutes').inputValue(), '2.5');
    await page.locator('#process-dismiss-minutes').fill('0'); await page.locator('#process-dismiss-minutes').press('Tab');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('langy-settings-v1')).processDismissMinutes === 0);
    await page.waitForFunction(() => !Object.keys(JSON.parse(localStorage.getItem('langy-account-settings-v1') || '{}').pending || {}).length);
    assert.equal((await (await context.request.get(base + '/api/settings/reader')).json()).preferences.processDismissMinutes, 0);
    await page.locator('#downloads-dialog [data-close]').click();
  });
  await check('blocked download titles can be retried and named on mobile without restarting their download', async () => {
    let job = { id: 'title-fixture', state: 'queued', source: 'fast', title: '', titleError: 'blocked', titlePending: false,
      reference: '0123456789abcdef0123456789abcdef', details: {}, attempts: 0 }, retries = 0, saves = 0;
    await page.route('**/api/library', async (route) => {
      const response = await route.fetch(), data = await response.json();
      await route.fulfill({ json: { ...data, archive: { ...data.archive, available: true, job, jobs: [job] } } });
    });
    await page.route('**/api/imports/anna/title-fixture/title**', async (route) => {
      if (route.request().method() === 'PATCH') { job = { ...job, title: route.request().postDataJSON().title, titleError: null }; saves++; }
      else { assert.ok(route.request().url().endsWith('/title/retry')); retries++; }
      await route.fulfill({ json: job });
    });
    try {
      await page.reload(); await page.locator('#books .book-card').first().waitFor();
      await page.locator('#archive-downloads > summary').click();
      const row = page.locator('#archive-download-list .archive-download-row');
      await row.getByText('Anna’s Archive blocked the title lookup. It will retry automatically.', { exact: true }).waitFor();
      assert.equal((await row.innerText()).includes(job.reference), false);
      const retried = page.waitForResponse((response) => response.url().endsWith('/title-fixture/title/retry'));
      await row.getByRole('button', { name: 'Retry title lookup', exact: true }).click(); await retried; assert.equal(retries, 1);
      await row.getByRole('button', { name: 'Set title', exact: true }).click();
      const dialog = page.locator('#archive-title-dialog'); await dialog.waitFor({ state: 'visible' });
      await dialog.locator('input').fill('O capital no século XXI');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: output + '/download-title-mobile.png' });
      await dialog.getByRole('button', { name: 'Save title', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      await row.getByText('O capital no século XXI', { exact: true }).waitFor();
      assert.equal(saves, 1); assert.equal(job.state, 'queued'); assert.equal(job.attempts, 0);
    } finally { await page.unroute('**/api/library'); await page.unroute('**/api/imports/anna/title-fixture/title**'); await page.reload(); await page.locator('#books .book-card').first().waitFor(); }
  });
  await check('Import book offers a per-import audiobook delay and the server retains that schedule', async () => {
    assert.equal(importAudio.scheduled.state, 'waiting'); assert.equal(importAudio.scheduled.minutes, 7);
    assert.equal(importAudio.scheduled.due, book.addedAt + 7 * 60000);
    await page.locator('#import-book').click(); await page.locator('#book-dialog').waitFor({ state: 'visible' });
    const enabled = page.locator('[name=autoAudiobook]'), delayInput = page.locator('[name=audiobookDelayMinutes]');
    assert.equal(await enabled.isChecked(), false); assert.equal(await delayInput.isDisabled(), true);
    await enabled.check(); assert.equal(await delayInput.isEnabled(), true); await delayInput.fill('7');
    await page.locator('#book-dialog [data-close]').first().click();
  });
  await check('completed book packs show Downloaded and open locally even when the source URL fails', async () => {
    await useAndroidApp(context, page);
    await page.waitForFunction(() => Boolean(localStorage.getItem('langy-offline-owner')));
    const file = await context.request.get(base + '/api/books/' + book.id + '/file'); assert.equal(file.status(), 200);
    await page.evaluate(async ({ id, source }) => {
      const owner = localStorage.getItem('langy-offline-owner'), cache = await caches.open(`langy-pack-${owner}-${id}-browser`);
      await cache.put(`/api/books/${id}/file`, new Response(Uint8Array.from(atob(source), (c) => c.charCodeAt(0))));
      await cache.put('/__langy_pack_ready__', Response.json({ book: id, owner }));
      window.dispatchEvent(new CustomEvent('langy-packs-changed'));
    }, { id: book.id, source: (await file.body()).toString('base64') });
    await page.locator('.book-download-badge').filter({ hasText: /^Downloaded$/ }).waitFor();
    await page.route('**/api/books/' + book.id + '/file', (route) => route.abort());
    await open();
  });
  await open();
  await check('offline background book-tool checks do not create repeated attention alerts', async () => {
    let aborted = 0;
    const unavailable = async (route) => { await delay(550); await route.abort(); aborted++; };
    const paths = ['**/api/books/' + book.id + '/narration*', '**/api/books/' + book.id + '/learning'];
    for (const path of paths) await page.route(path, unavailable);
    try {
      await page.reload();
      await open();
      for (let n = 0; n < 60 && aborted < 2; n++) await delay(50);
      assert.ok(aborted >= 2); await delay(100);
      await page.locator('#reader-more > summary').click(); await page.locator('#reader-more [data-open-processes]').click();
      await page.locator('#downloads-dialog').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#process-list .process-card').filter({ hasText: 'Load book tools' }).filter({ hasText: 'Needs attention' }).count(), 0);
      await page.locator('#downloads-dialog [data-close]').click();
    } finally { for (const path of paths) await page.unroute(path, unavailable); }
  });
  await check('whole-book search jumps to an unrendered chapter, returns to the prior page and survives repeated jumps and reload', async () => {
    const before = await position();
    const passageVisible = () => {
      const frame = document.querySelector('#viewer iframe'), marker = frame?.contentDocument?.getElementById('search-destination'); if (!marker) return false;
      const range = marker.ownerDocument.createRange(); range.setStart(marker.firstChild, 0); range.setEnd(marker.firstChild, 4);
      const box = range.getBoundingClientRect(), offset = frame.getBoundingClientRect(), host = document.querySelector('#viewer').getBoundingClientRect();
      return box.width > 0 && box.left + offset.left < host.right && box.right + offset.left > host.left && box.top + offset.top < host.bottom && box.bottom + offset.top > host.top;
    };
    async function searchJump() {
      await page.locator('#reader-more > summary').click();
      await page.locator('#book-tools-button').click(); await page.locator('#book-search-form [name=query]').fill('faro violeta');
      await page.getByRole('button', { name: 'Search whole book', exact: true }).click();
      const result = page.locator('.book-search-result'); await result.waitFor(); assert.equal(await result.count(), 1); await result.click();
      await page.waitForFunction(() => document.querySelector('#position-detail').textContent === 'Section 2 of 3');
      assert.equal(await page.locator('#reading-subtitle').textContent(), 'Segunda parte');
      await page.waitForFunction(passageVisible);
      assert.ok(Number((await page.locator('#page-label').textContent()).match(/Page (\d+)/)[1]) > 1, 'the jump must reach the passage within the chapter');
      assert.equal(await page.locator('#reader-message[data-problem="true"]').isVisible(), false);
    }
    await searchJump(); await page.locator('#return-location').click();
    await page.waitForFunction(({ id, before }) => JSON.parse(localStorage.getItem('langy-progress-v1') || '{}')[id]?.target === before, { id: book.id, before });
    assert.equal(await page.locator('#reading-subtitle').textContent(), 'Primera parte');
    await searchJump(); const savedTarget = await position(); await page.reload(); await page.locator('#viewer iframe').first().waitFor();
    await page.waitForFunction(passageVisible);
    assert.equal(await position(), savedTarget, 'reload must retain the exact search anchor even when web fonts change pagination');
    assert.equal(await page.locator('#reading-subtitle').textContent(), 'Segunda parte');
    assert.equal(await page.locator('#reader-message[data-problem="true"]').isVisible(), false);
    await page.locator('#contents-button').click(); await page.getByRole('button', { name: 'Primera parte', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#position-detail').textContent === 'Section 1 of 3');
  });
  await check('page buttons advance reliably without duplicate positions', async () => {
    const positions = [];
    for (let i = 0; i < 12; i++) { const before = await position(); await page.locator('#next').click(); await changed(before); positions.push(await position()); }
    assert.equal(new Set(positions).size, positions.length); assert.equal(await page.locator('#reader-message[data-problem="true"]').isVisible(), false);
  });
  await check('trusted Android-style swipes advance and reverse', async () => {
    let before = await position(); await swipe(-180); await changed(before);
    before = await position(); await swipe(180); await changed(before);
  });
  await check('a natural initial vertical wobble does not discard a horizontal swipe', async () => {
    const before = await position(); await swipe(-180, 10, true); await changed(before);
  });
  await check('a center word tap opens word help without toggling fullscreen', async () => {
    const host = await page.locator('.reading-main').boundingBox(), frame = await (await page.locator('#viewer iframe').first().elementHandle()).contentFrame();
    assert.ok(frame, 'An EPUB frame must be present');
    const point = await frame.evaluate(({ host }) => {
      const offset = window.frameElement.getBoundingClientRect(), walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { const node = walker.currentNode; if (node.parentElement.closest('a,script,style')) continue;
        for (const match of node.data.matchAll(/\p{L}{4,}/gu)) { const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length); const rect = range.getBoundingClientRect();
          const x = offset.x + rect.x + rect.width / 2, y = offset.y + rect.y + rect.height / 2;
          if (x > host.x + host.width / 3 && x < host.x + host.width * 2 / 3 && y > host.y + 10 && y < host.y + host.height - 10) return { x, y }; }
      }
    }, { host });
    assert.ok(point); const fullscreen = await page.locator('#fullscreen').getAttribute('aria-pressed');
    await page.touchscreen.tap(point.x, point.y); await page.locator('#word-help').waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await page.locator('#fullscreen').getAttribute('aria-pressed'), fullscreen);
  });
  await check('tapping the mobile definition popup cycles meanings and keeps it open', async () => {
    const gloss = page.locator('#word-help .word-gloss'); await gloss.filter({ hasText: 'First contextual meaning' }).waitFor();
    await gloss.tap(); await page.locator('#word-help .word-gloss').filter({ hasText: 'Second contextual meaning' }).waitFor();
    await page.locator('#word-help .word-gloss').tap(); await page.locator('#word-help .word-gloss').filter({ hasText: 'First contextual meaning' }).waitFor();
    assert.equal(await page.locator('#word-help').isVisible(), true);
  });
  await check('hyperlink jumps expose an immediately usable Back to text control', async () => {
    await page.goto(base + '/#library'); await page.evaluate(() => localStorage.removeItem('langy-progress-v1')); await page.reload(); await open();
    await page.frameLocator('#viewer iframe').first().getByText('Leer nota', { exact: true }).tap();
    await page.locator('#return-location').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#return-location').click();
    await page.locator('#return-location').waitFor({ state: 'hidden', timeout: 5000 });
    await page.frameLocator('#viewer iframe').first().getByText('Leer nota', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
  });
  await check('section boundaries remain stable after forward/back turns and a viewport resize', async () => {
    await page.locator('#contents-button').click();
    await page.getByRole('button', { name: 'Segunda parte', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#position-detail').textContent.includes('Section 2'));
    for (let n = 0; n < 3; n++) {
      await page.locator('#previous').click();
      await page.waitForFunction(() => document.querySelector('#position-detail').textContent.includes('Section 1'));
      await page.locator('#next').click();
      await page.waitForFunction(() => document.querySelector('#position-detail').textContent.includes('Section 2'));
    }
    await page.setViewportSize({ width: 393, height: 800 }); await delay(500);
    const before = await position(); await page.locator('#next').click(); await changed(before);
    const after = await position(); await delay(700); assert.equal(await position(), after, 'a delayed layout must not restore the previous page');
  });
  await check('an outer double tap turns once and a single tap does not turn', async () => {
    const box = await page.locator('.reading-main').boundingBox(), x = box.x + box.width * .9, y = box.y + box.height * .55;
    const before = await position(); await page.touchscreen.tap(x, y); await delay(400); assert.equal(await position(), before);
    await page.touchscreen.tap(x, y); await delay(70); await page.touchscreen.tap(x, y); await changed(before);
    const after = await position(); await delay(500); assert.equal(await position(), after);
  });
  await check('repeated pinch gestures enlarge and reduce touch text without changing desktop size or browser zoom', async () => {
    const before = await page.evaluate(() => ({ size: 20, ...JSON.parse(localStorage.getItem('langy-settings-v1')) }));
    const box = await page.locator('.reading-main').boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    async function resize(from, to) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x - from, y }, { id: 2, x: x + from, y }] });
      for (let i = 1; i <= 6; i++) { const distance = from + (to - from) * i / 6; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x - distance, y }, { id: 2, x: x + distance, y }] }); await delay(20); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    for (let n = 0; n < 2; n++) {
      const previous = await page.evaluate(() => JSON.parse(localStorage.getItem('langy-settings-v1')).touchSize || 20);
      await resize(35, 53); await page.waitForFunction((size) => JSON.parse(localStorage.getItem('langy-settings-v1')).touchSize > size, previous, { timeout: 4000 }); await delay(250);
      const enlarged = await page.evaluate(() => JSON.parse(localStorage.getItem('langy-settings-v1')).touchSize);
      await resize(53, 35); await page.waitForFunction((size) => JSON.parse(localStorage.getItem('langy-settings-v1')).touchSize < size, enlarged, { timeout: 4000 }); await delay(250);
    }
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('langy-settings-v1')));
    assert.equal(after.size, before.size); assert.equal(await page.evaluate(() => visualViewport.scale), 1);
    await delay(500);
  });
  await check('swiping down with audio controls closed opens sections and expandable bookmarks without changing pages', async () => {
    const before = await position(); await swipe(0, 160);
    await page.locator('#contents-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: 'Primera parte', exact: true }).isVisible(), true);
    await page.locator('.toc-bookmarks summary').click();
    await page.locator('.toc-bookmarks').getByText('No bookmarks yet.').waitFor();
    await page.locator('#contents-dialog [data-close]').click(); assert.equal(await position(), before);
  });
  await check('center double taps reveal temporary audio controls and play or pause without stopping when controls hide', async () => {
    const before = await position();
    const doubleCenter = async () => { await delay(350); const host = await page.locator('.reading-main').boundingBox();
      const frame = await (await page.locator('#viewer iframe').first().elementHandle()).contentFrame();
      const point = await frame.evaluate((host) => {
        const box = window.frameElement.getBoundingClientRect(), x = host.x + host.width / 2;
        for (let y = Math.max(host.y, box.y) + 6; y < Math.min(host.y + host.height, box.bottom) - 6; y += 4) {
          const px = x - box.x, py = y - box.y, caret = document.caretRangeFromPoint(px, py), node = caret?.startContainer;
          if (document.elementFromPoint(px, py)?.closest('a,button,input')) continue;
          if (node?.nodeType === Node.TEXT_NODE) {
            const segmenter = new Intl.Segmenter('es', { granularity: 'word' }), segments = segmenter.segment(node.data);
            const candidates = [segments.containing(caret.startOffset), segments.containing(caret.startOffset - 1)].filter((item) => item?.isWordLike);
            if (candidates.some((item) => { const range = document.createRange(); range.setStart(node, item.index); range.setEnd(node, item.index + item.segment.length);
              return [...range.getClientRects()].some((r) => px >= r.left - 1 && px <= r.right + 1 && py >= r.top && py <= r.bottom); })) continue;
          }
          return { x, y };
        }
      }, host);
      assert.ok(point, 'Blank center space must be available');
      await page.touchscreen.tap(point.x, point.y); await delay(65); await page.touchscreen.tap(point.x, point.y); };
    await doubleCenter(); await page.locator('#narration-player').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#narration-audio').paused, null, { timeout: 4000 });
    assert.equal((await position()).split('!')[0], before.split('!')[0], 'revealing controls keeps the same source section during reflow');
    await doubleCenter(); await page.waitForFunction(() => document.querySelector('#narration-audio').paused, null, { timeout: 4000 });
    await doubleCenter(); await page.waitForFunction(() => !document.querySelector('#narration-audio').paused, null, { timeout: 4000 });
    await page.locator('#narration-player').waitFor({ state: 'hidden', timeout: 7000 });
    assert.equal(await page.evaluate(() => document.querySelector('#narration-audio').paused), false, 'hiding controls must not pause playback');
    await doubleCenter(); await page.waitForFunction(() => document.querySelector('#narration-audio').paused, null, { timeout: 4000 });
  });
  await check('swiping up only toggles audio controls; either direction can hide them without pausing', async () => {
    assert.equal(await page.evaluate(() => document.querySelector('#narration-audio').paused), true);
    await swipe(0, -160); await page.locator('#narration-player').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#contents-dialog').isVisible(), false);
    assert.equal(await page.evaluate(() => document.querySelector('#narration-audio').paused), true, 'revealing controls must not start playback');
    await page.locator('#narration-play').click();
    await page.waitForFunction(() => !document.querySelector('#narration-audio').paused);
    for (let n = 0; n < 2; n++) {
      await swipe(0, -160); await page.locator('#narration-player').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#contents-dialog').isVisible(), false, 'an upward closing swipe must never open sections');
      await swipe(0, -160); await page.locator('#narration-player').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#contents-dialog').isVisible(), false, 'an upward opening swipe must never open sections');
      assert.equal(await page.evaluate(() => document.querySelector('#narration-audio').paused), false);
    }
    await swipe(0, 160); await page.locator('#narration-player').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#contents-dialog').isVisible(), false);
    await swipe(0, -160); await page.locator('#narration-player').waitFor({ state: 'visible' });
    await page.locator('#podcast-toggle').click(); await page.locator('#podcast-info').waitFor({ state: 'visible' });
    await swipe(0, 100, false, '#podcast-info'); await page.locator('#narration-player').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.querySelector('#narration-audio').paused), false, 'a downward swipe on the toolbar preserves playback');
    await swipe(0, -160); await page.locator('#narration-player').waitFor({ state: 'visible' });
    await swipe(0, -100, false, '#podcast-info'); await page.locator('#narration-player').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.querySelector('#narration-audio').paused), false, 'an upward swipe on the toolbar preserves playback');
    await page.keyboard.press('Space'); await page.waitForFunction(() => document.querySelector('#narration-audio').paused);
  });
  await check('manual page turns with missing word alignment do not snap back while narration is enabled', async () => {
    const before = await position(); await page.locator('#next').click(); await changed(before);
    const after = await position(); await delay(1000); assert.equal(await position(), after);
  });
  await check('the audio close button hides both player modes without pausing playback', async () => {
    await page.locator('#audio-toggle').click(); await page.locator('#narration-player').waitFor({ state: 'visible' });
    await page.locator('#narration-play').click();
    await page.waitForFunction(() => !document.querySelector('#narration-audio').paused);
    await page.locator('#narration-close').click(); await page.locator('#narration-player').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.querySelector('#narration-audio').paused), false);
    await page.locator('#audio-toggle').click(); await page.locator('#narration-player').waitFor({ state: 'visible' });
    await page.locator('#podcast-toggle').click(); await page.locator('#narration-close').click();
    await page.locator('#narration-player').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.querySelector('#narration-audio').paused), false);
    await page.locator('#audio-toggle').click(); await page.locator('#narration-play').click();
    await page.locator('#narration-close').click();
  });
  await check('double tapping a word starts at its timestamp, including with audio disabled, and never pauses it', async () => {
    const pattern = '**/api/books/' + book.id + '/chapters/*';
    const aligned = (route) => route.fulfill({ json: { key: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)), tokens: [], audio: { timings: [{ word: 'viajera', from: 0, to: 7, start: 10, end: 10.5 }] } } });
    await page.route(pattern, aligned);
    await page.evaluate(() => { const prefs = JSON.parse(localStorage.getItem('langy-settings-v1')); localStorage.setItem('langy-settings-v1', JSON.stringify({ ...prefs, audioEnabled: false, audioToolbarHidden: true })); });
    await page.reload(); await page.locator('#viewer iframe').first().waitFor();
    await page.locator('#contents-button').click(); await page.getByRole('button', { name: 'Primera parte', exact: true }).click();
    await delay(350);
    const frame = await (await page.locator('#viewer iframe').first().elementHandle()).contentFrame();
    const point = await frame.evaluate(() => { const node = document.querySelector('#source').firstChild, from = node.data.indexOf('viajera'), range = document.createRange();
      range.setStart(node, from); range.setEnd(node, from + 7); const rect = range.getBoundingClientRect(), box = window.frameElement.getBoundingClientRect();
      return { x: box.x + rect.x + rect.width / 2, y: box.y + rect.y + rect.height / 2 }; });
    await page.touchscreen.tap(point.x, point.y); await page.locator('#word-help').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.querySelector('#narration-audio').paused), true, 'single word taps only show help');
    for (let n = 0; n < 2; n++) {
      await delay(350); await page.touchscreen.tap(point.x, point.y); await delay(65); await page.touchscreen.tap(point.x, point.y);
      await page.waitForFunction(() => { const audio = document.querySelector('#narration-audio'); return !audio.paused && audio.currentTime >= 10 && audio.currentTime < 12; });
      assert.equal(await page.locator('#contents-dialog').isVisible(), false);
      await page.locator('#word-help').waitFor({ state: 'hidden' });
    }
    await page.keyboard.press('Space'); await page.waitForFunction(() => document.querySelector('#narration-audio').paused);
    await page.unroute(pattern, aligned);
  });
  await check('sections dismiss on an outside tap and page jumps reach the first and last pages of any section', async () => {
    await page.locator('#contents-button').click(); await page.locator('#contents-dialog').waitFor({ state: 'visible' });
    await page.touchscreen.tap(3, 3); await page.locator('#contents-dialog').waitFor({ state: 'hidden' });
    await page.locator('#reader-more > summary').click(); await page.locator('#jump-page').click();
    await page.locator('#page-jump-dialog').waitFor({ state: 'visible' });
    await page.locator('#page-jump-section').selectOption('0'); await page.locator('#page-jump-number').fill('5');
    await page.getByRole('button', { name: 'Go to page', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#position-detail').textContent === 'Section 1 of 3' && /^Page 5 of /.test(document.querySelector('#page-label').textContent));
    await page.locator('#reader-more > summary').click(); await page.locator('#jump-page').click();
    const last = await page.locator('#page-jump-number').getAttribute('max'); await page.locator('#page-jump-number').fill(last);
    await page.getByRole('button', { name: 'Go to page', exact: true }).click();
    await page.waitForFunction((last) => document.querySelector('#page-label').textContent === `Page ${last} of ${last}`, last);
    await page.locator('#next').click(); await page.waitForFunction(() => document.querySelector('#position-detail').textContent === 'Section 2 of 3');
    await page.locator('#reader-more > summary').click(); await page.locator('#jump-page').click();
    await page.locator('#page-jump-section').selectOption('2'); await page.locator('#page-jump-number').fill('1');
    await page.getByRole('button', { name: 'Go to page', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#position-detail').textContent === 'Section 3 of 3');
  });
  await check('Settings opens as its own page, keeps drafts between tabs and returns to the saved book position', async () => {
    const before = await position();
    await page.locator('#reader-more > summary').click(); await page.locator('#reader-more [data-settings="reading"]').click();
    await page.waitForURL('**/#settings/reading'); await page.locator('#settings').waitFor({ state: 'visible' });
    assert.equal(await page.locator('dialog#settings').count(), 0); assert.equal(await page.locator('#reader-screen').isVisible(), false);
    await page.locator('[data-settings-tab="language"]').click(); await page.locator('[name="cacheAI"]').uncheck();
    await page.locator('[data-settings-tab="reading"]').click(); await page.locator('[data-settings-tab="language"]').click();
    assert.equal(await page.locator('[name="cacheAI"]').isChecked(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: output + '/settings-mobile.png' });
    await page.locator('#settings-back').click(); await page.waitForURL('**/#read/' + book.id);
    await page.waitForFunction(({ id, before }) => JSON.parse(localStorage.getItem('langy-progress-v1') || '{}')[id]?.target === before, { id: book.id, before });
    await page.locator('#viewer iframe').first().waitFor();
    assert.equal(await page.locator('#pinyin-toggle').isVisible(), false);
    const updated = await context.request.patch(base + '/api/books/' + book.id, { data: { language: 'zh-Hans', languages: [] } }); assert.equal(updated.status(), 200);
    await page.goto(base + '/#library'); await page.reload(); await open();
    await page.locator('#pinyin-toggle').waitFor({ state: 'visible' }); await page.locator('#pinyin-toggle').click();
    assert.equal(await page.locator('#pinyin-toggle').getAttribute('aria-pressed'), 'true');
    await page.locator('#pinyin-toggle').click(); assert.equal(await page.locator('#pinyin-toggle').getAttribute('aria-pressed'), 'false');
    const edges = await page.evaluate(() => { const host = document.querySelector('#viewer').getBoundingClientRect(), area = document.querySelector('.reading-main').getBoundingClientRect(); return { left: host.left - area.left, right: area.right - host.right, radius: getComputedStyle(document.querySelector('#viewer')).borderRadius }; });
    assert.equal(edges.left, 0); assert.equal(edges.right, 0); assert.equal(edges.radius, '0px');
    await page.screenshot({ path: output + '/reader-mobile.png' });
  });
  await check('About and How to are available to self-hosted readers and fit a phone screen', async () => {
    await page.goto(base + '/#about'); await page.locator('#about-title').waitFor({ state: 'visible' });
    assert.equal(await page.getByText('A note from the project’s creator', { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('heading', { name: 'Your library, connected.', exact: true }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: output + '/about-mobile.png' });
    await page.goto(base + '/#howto'); await page.locator('#howto-title').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: output + '/howto-mobile.png' });
  });
  await check('AI answer saving is on by default, can be disabled and persists across reloads', async () => {
    await page.goto(base + '/#library'); await page.locator('#mobile-navigation [data-settings]').click();
    await page.locator('[data-settings-tab="language"]').click();
    assert.equal(await page.locator('[name="cacheAI"]').isChecked(), true);
    await page.locator('[name="cacheAI"]').uncheck(); await page.locator('#settings-form button[type="submit"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('langy-settings-v1')).cacheAI === false);
    await delay(1000); await page.reload(); await page.locator('#mobile-navigation [data-settings]').click();
    await page.locator('[data-settings-tab="language"]').click(); assert.equal(await page.locator('[name="cacheAI"]').isChecked(), false);
    await page.locator('#clear-ai-cache').click(); await page.locator('#ai-cache-status').filter({ hasText: 'Saved AI answers cleared.' }).waitFor();
    await page.locator('#settings-back').click();
  });
  await check('shared or per-language output defaults persist to the account and control summaries and deeper explanations', async () => {
    await page.goto(base + '/#settings/language');
    const mode = page.locator('#language-defaults-mode'), choice = page.locator('#language-default-language');
    assert.equal(await mode.inputValue(), 'shared');
    assert.equal(await page.locator('#language-defaults-panel').isVisible(), false);
    await mode.selectOption('per-language');
    await choice.selectOption('pt'); await page.locator('#language-translation-default').fill('Spanish'); await page.locator('#language-summary-default').fill('Portuguese');
    await choice.selectOption('zh'); await page.locator('#language-translation-default').fill('English'); await page.locator('#language-summary-default').fill('Spanish');
    await choice.selectOption('pt'); assert.equal(await page.locator('#language-summary-default').inputValue(), 'Portuguese');
    await page.locator('#settings-form button[type=submit]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('langy-settings-v1') || '{}').languageDefaultsMode === 'per-language');
    await page.waitForFunction(() => !Object.keys(JSON.parse(localStorage.getItem('langy-account-settings-v1') || '{}').pending || {}).length);
    await page.reload(); await page.goto(base + '/#settings/language'); await page.locator('#settings').waitFor({ state: 'visible' });
    assert.equal(await mode.inputValue(), 'per-language'); await choice.selectOption('zh'); assert.equal(await page.locator('#language-summary-default').inputValue(), 'es');
    const saved = (await (await context.request.get(base + '/api/settings/reader')).json()).preferences;
    assert.equal(saved.languageDefaults.pt.translationLanguage, 'es'); assert.equal(saved.languageDefaults.pt.summaryLanguage, 'pt'); assert.equal(saved.languageDefaults.zh.summaryLanguage, 'es');
    assert.equal(saved.summaryLanguage || 'en', 'en'); assert.equal(saved.uiLanguage || 'en', 'en');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: output + '/language-defaults-mobile.png' });
    const requests = [];
    await page.route('**/api/ai/summary', async (route) => {
      const body = route.request().postDataJSON(); requests.push(body);
      await route.fulfill({ json: { text: body.mode === 'deeper' ? 'Una explicación del pasaje actual.' : 'Un resumen de esta página.', suggestions: [] } });
    });
    try {
      await open(); await page.locator('#reader-more > summary').click(); await page.locator('#summarize').click(); await page.locator('#summary-body').filter({ hasText: 'Un resumen de esta página.' }).waitFor();
      assert.equal(requests.at(-1).language, 'es'); assert.equal(await page.locator('#summary-body').getAttribute('lang'), 'es');
      await page.locator('#summary-actions').getByRole('button', { name: 'Go deeper', exact: true }).click();
      await page.locator('#summary-detail-body').filter({ hasText: 'Una explicación del pasaje actual.' }).waitFor(); assert.equal(requests.at(-1).language, 'es');
      await page.locator('#close-summary').click();
    } finally { await page.unroute('**/api/ai/summary'); }
    await page.goto(base + '/#settings/language'); await mode.selectOption('shared'); await page.locator('#settings-form button[type=submit]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('langy-settings-v1')).languageDefaultsMode === 'shared');
    await page.goto(base + '/#settings/language'); await mode.selectOption('per-language'); await choice.selectOption('pt'); assert.equal(await page.locator('#language-summary-default').inputValue(), 'pt');
    await page.locator('#settings-back').click(); await page.goto(base + '/#library');
  });
  await check('L1 Folder persists, disables comprehension help without AI requests and restores it without changing preferences', async () => {
    await page.goto(base + '/#library'); await page.locator('#mobile-add-category').click();
    await page.locator('#category-dialog').waitFor({ state: 'visible' });
    const categoryForm = page.locator('#category-form');
    await categoryForm.locator('[name=name]').fill('Native reading');
    assert.equal(await categoryForm.locator('[name=l1Folder]').isChecked(), false);
    assert.match(await page.locator('#l1-folder-help').textContent(), /Removes comprehension assistance/);
    await categoryForm.locator('[name=l1Folder]').check(); await categoryForm.locator('button[type=submit]').click();
    await page.locator('#category-dialog').waitFor({ state: 'hidden' });
    const folder = (await (await context.request.get(base + '/api/library')).json()).categories.find(item => item.name === 'Native reading');
    assert.equal(folder.l1Folder, true);
    try {
    const moved = await context.request.patch(base + '/api/books/' + book.id, { data: { title: book.title, author: book.author || '', language: book.language, categoryId: folder.id } });
    assert.equal(moved.status(), 200); assert.equal((await moved.json()).l1Folder, true);
    await page.reload(); await open();
    await page.locator('#contents-button').click(); await page.getByRole('button', { name: 'Primera parte', exact: true }).click();
    const preferences = await page.evaluate(() => JSON.parse(localStorage.getItem('langy-settings-v1')));
    assert.equal(await page.locator('#summarize').isVisible(), false); assert.equal(await page.locator('.word-settings').isVisible(), false);
    let helpRequests = 0;
    const onRequest = request => { if (/\/api\/ai\/(word|phrase|summary)$|\/(character-guide|question)$/.test(new URL(request.url()).pathname)) helpRequests++; };
    page.on('request', onRequest);
    const source = page.frameLocator('#viewer iframe').first().locator('#source');
    await source.waitFor({ state: 'visible' });
    const point = await source.evaluate(paragraph => { const node = paragraph.firstChild, from = node.data.indexOf('viajera'), range = document.createRange();
      range.setStart(node, from); range.setEnd(node, from + 7); const r = range.getBoundingClientRect(), f = window.frameElement.getBoundingClientRect(); return { x: f.x + r.x + r.width / 2, y: f.y + r.y + r.height / 2 }; });
    await page.touchscreen.tap(point.x, point.y); await delay(450); assert.equal(await page.locator('#word-help').isVisible(), false);
    await page.keyboard.press('s'); assert.equal(await page.locator('#summary-panel').isVisible(), false);
    await source.evaluate(paragraph => { const range = document.createRange(), node = paragraph.firstChild; range.setStart(node, 0); range.setEnd(node, 10); getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange')); });
    await page.locator('[data-bookmark-selection]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-explain-phrase]').isVisible(), false);
    await source.evaluate(() => getSelection().removeAllRanges());
    await page.locator('#reader-more > summary').click(); await page.locator('#book-tools-button').click();
    assert.equal(await page.locator('#book-search-form').isVisible(), true); assert.equal(await page.locator('#character-guide-tools').isVisible(), false);
    await page.locator('#book-tools-dialog [data-close]').click();
    if (!await page.locator('#narration-player').isVisible()) await page.locator('#audio-toggle').click();
    await page.locator('#narration-play').click(); await page.waitForFunction(() => !document.querySelector('#narration-audio').paused);
    await page.locator('#narration-play').click(); assert.equal(helpRequests, 0);
    await page.screenshot({ path: output + '/l1-folder-reader-mobile.png' });
    await page.locator('.back-button').click(); await page.locator('#mobile-category').selectOption(folder.id); await page.locator('#mobile-edit-category').click();
    assert.equal(await categoryForm.locator('[name=l1Folder]').isChecked(), true);
    await categoryForm.locator('[name=l1Folder]').uncheck(); await categoryForm.locator('button[type=submit]').click(); await page.locator('#category-dialog').waitFor({ state: 'hidden' });
    await open(); assert.equal(await page.locator('.word-settings').isVisible(), true);
    await page.locator('#reader-more > summary').click(); assert.equal(await page.locator('#summarize').isVisible(), true);
    const restoredSummary = route => route.fulfill({ json: { text: 'Assistance is available again.', suggestions: [] } });
    await page.route('**/api/ai/summary', restoredSummary); await page.locator('#summarize').click();
    await page.locator('#summary-body').filter({ hasText: 'Assistance is available again.' }).waitFor();
    await page.unroute('**/api/ai/summary', restoredSummary); page.off('request', onRequest);
    const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('langy-settings-v1')));
    assert.equal(restored.mode, preferences.mode); assert.equal(restored.showPinyin, preferences.showPinyin);
    await page.locator('#close-summary').click();
    } finally { await context.request.patch(base + '/api/categories/' + folder.id, { data: { name: folder.name, l1Folder: false } }); }
  });
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: adminHeaders, serviceWorkers: 'block' }), desktopPage = await desktop.newPage();
  desktopPage.on('pageerror', (error) => errors.push(error.message));
  await check('desktop library and project pages retain their full layout', async () => {
    await desktopPage.goto(base + '/#library'); await desktopPage.locator('#books a').first().waitFor();
    assert.equal(await desktopPage.locator('.library-rail').isVisible(), true); assert.equal(await desktopPage.locator('#mobile-navigation').isVisible(), false);
    await desktopPage.locator('.library-view-options > summary').click(); await desktopPage.locator('#library-covers-only').check();
    await desktopPage.locator('.library-view-options > summary').click();
    await desktopPage.locator('[data-book="' + book.id + '"] .book-mobile-menu').click();
    await desktopPage.locator('#book-actions-dialog').waitFor({ state: 'visible' });
    assert.equal(await desktopPage.locator('#book-actions-dialog').getByRole('button', { name: 'Analysis & audio', exact: true }).isVisible(), true);
    assert.equal(await desktopPage.locator('#book-actions-dialog').getByRole('button', { name: 'Edit book details', exact: true }).isVisible(), true);
    assert.equal(await desktopPage.locator('#book-actions-dialog').getByRole('button', { name: 'Save offline', exact: true }).count(), 0);
    await desktopPage.locator('#book-actions-dialog').getByRole('button', { name: 'Analysis & audio', exact: true }).click();
    await desktopPage.locator('#learning-dialog').waitFor({ state: 'visible' }); await desktopPage.locator('#learning-dialog > header [data-close]').click();
    await desktopPage.screenshot({ path: output + '/library-desktop.png' });
    await desktopPage.goto(base + '/#about'); await desktopPage.locator('#about-title').waitFor({ state: 'visible' });
    await desktopPage.screenshot({ path: output + '/about-desktop.png' });
    await desktopPage.goto(base+'/#proficiency'); await desktopPage.locator('#proficiency-content').waitFor({state:'visible'});
    assert.equal(await desktopPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await desktopPage.screenshot({path:output+'/reading-profile-desktop.png',fullPage:true});
    assert.equal(await desktopPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
  await check('matched ABS books resume and sync reading progress on mobile and desktop without local narration', async () => {
    const readingZip = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));
    // KOSync identifies identical EPUB bytes as the same document, even when
    // library titles differ. Keep this fixture's progress separate.
    readingZip.file('OEBPS/book.opf', (await readingZip.file('OEBPS/book.opf').async('string')).replace('langy-browser-fixture', 'langy-browser-reading-sync-fixture').replace('Reader interactions', 'Reading without narration'));
    const created = await context.request.post(base + '/api/books', { multipart: { title: 'Reading without narration', author: 'An Author', language: 'es', file: { name: 'reading-only.epub', mimeType: 'application/epub+zip', buffer: await readingZip.generateAsync({ type: 'nodebuffer' }) } } });
    assert.equal(created.status(), 201); const readingBook = await created.json();
    for (const currentPage of [page, desktopPage]) {
      try {
      let remote = { linked: true, recording: 'reading', mode: 'reading', automatic: true, approximate: true, currentTime: .3, duration: 1, updated: 1000, version: 'initial' }, writes = [];
      await currentPage.route('**/api/books/' + readingBook.id + '/narration*', (route) => route.fulfill({ json: { connected: false, absConnected: true, recordings: [], audio: { state: 'missing' } } }));
      await currentPage.route('**/api/books/' + readingBook.id + '/chapters/*', (route) => route.fulfill({ json: { key: 'epub:0', tokens: [], audio: { timings: [] } } }));
      await currentPage.route('**/api/books/' + readingBook.id + '/audiobookshelf/progress*', async (route) => {
        if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); writes.push(body); remote = { ...remote, currentTime: body.currentTime, version: 'saved-' + writes.length }; }
        await route.fulfill({ json: remote });
      });
      await currentPage.goto(base + '/?abs-reading-check=' + readingBook.id + '#read/' + readingBook.id);
      await currentPage.locator('#abs-sync-status').filter({ hasText: 'synced by book percentage' }).waitFor();
      assert.equal(writes.length, 0, 'opening must not overwrite ABS progress');
      const before = await currentPage.evaluate((id) => JSON.parse(localStorage.getItem('langy-progress-v1') || '{}')[id]?.target, readingBook.id);
      const countBeforeTurn = writes.length;
      await currentPage.locator('#next').click();
      await currentPage.waitForFunction(({ id, before }) => JSON.parse(localStorage.getItem('langy-progress-v1') || '{}')[id]?.target !== before, { id: readingBook.id, before });
      const expected = await currentPage.evaluate((id) => JSON.parse(localStorage.getItem('langy-progress-v1') || '{}')[id]?.syncPayload?.percentage, readingBook.id);
      assert.ok(Number.isFinite(expected));
      await currentPage.evaluate(() => document.querySelector('#narration-audio').dispatchEvent(new Event('pause')));
      for (let n = 0; n < 80 && !writes.slice(countBeforeTurn).some((body) => Math.abs(body.currentTime - expected) < .000001); n++) await delay(50);
      assert.ok(writes.slice(countBeforeTurn).some((body) => body.recording === 'reading' && Math.abs(body.currentTime - expected) < .000001), JSON.stringify({ expected, writes }));
      } finally { await currentPage.goto(base + '/#library'); await currentPage.locator('#books .book-card').first().waitFor(); }
    }
  });
  await check('desktop reader supports trackpad text size, section shortcuts, contextual phrase help and one process queue', async () => {
    await desktopPage.goto(base + '/#read/' + book.id);
    await desktopPage.waitForFunction((title) => document.querySelector('#reading-title').textContent === title, book.title);
    await desktopPage.waitForFunction(() => document.querySelector('#position-detail').textContent === 'Section 1 of 3');
    await desktopPage.locator('#reader-message').waitFor({ state: 'hidden' });
    await desktopPage.waitForFunction(() => !document.querySelector('#contents-button').disabled);
    await desktopPage.frameLocator('#viewer iframe').locator('#source').waitFor({ state: 'attached' });
    const before = await desktopPage.evaluate(() => ({ size: 20, ...JSON.parse(localStorage.getItem('langy-settings-v1')) }));
    assert.equal(await desktopPage.frameLocator('#viewer iframe').locator('body').evaluate((body) => {
      const visible = parent.document.querySelector('#viewer').getBoundingClientRect(), frame = window.frameElement.getBoundingClientRect();
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -24, clientX: visible.left + visible.width / 2 - frame.left, clientY: visible.top + visible.height / 2 - frame.top });
      body.dispatchEvent(event); return event.defaultPrevented;
    }), true);
    await desktopPage.waitForFunction((size) => JSON.parse(localStorage.getItem('langy-settings-v1')).size > size, before.size);
    assert.equal((await desktopPage.evaluate(() => JSON.parse(localStorage.getItem('langy-settings-v1')))).touchSize, before.touchSize);
    assert.equal(await desktopPage.evaluate(() => visualViewport.scale), 1); await delay(700);
    await desktopPage.keyboard.press('Control+ArrowRight');
    await desktopPage.waitForFunction(() => document.querySelector('#position-detail').textContent === 'Section 2 of 3');
    await desktopPage.keyboard.press('Control+ArrowLeft');
    await desktopPage.waitForFunction(() => document.querySelector('#position-detail').textContent === 'Section 1 of 3'); await delay(300);
    const phrases = [], selection = desktopPage.frameLocator('#viewer iframe').locator('#source');
    await desktopPage.route('**/api/ai/phrase', async (route) => {
      const data = route.request().postDataJSON(); phrases.push(data.web === true);
      assert.equal(data.phrase, 'La viajera'); assert.ok(data.context.includes('casa tranquila'));
      await route.fulfill({ json: data.web ? { text: 'A traveler is someone on a journey. [1]', sources: [{ id: 1, title: 'Dictionary entry', url: 'https://example.org/traveler' }] }
        : { text: Array(90).fill('The traveler is the woman arriving at the house.').join('\n') } });
    });
    const select = (from, to) => selection.evaluate((source, [start, end]) => {
      const node = source.firstChild, range = document.createRange(), selected = getSelection();
      range.setStart(node, start); range.setEnd(node, end); selected.removeAllRanges(); selected.addRange(range);
    }, [from, to]);
    await select(0, 10);
    const panel = desktopPage.locator('#phrase-help'), answer = desktopPage.locator('[data-phrase-answer]');
    await panel.waitFor({ state: 'visible' });
    assert.equal(await panel.locator('button:visible > svg').count(), 2);
    assert.deepEqual(phrases, []);
    await selection.dispatchEvent('keydown', { key: 'e', bubbles: true, cancelable: true });
    await answer.filter({ hasText: 'The traveler' }).waitFor(); assert.deepEqual(phrases, [false]);
    assert.equal(await panel.evaluate((element) => {
      const box = element.getBoundingClientRect(), scroll = element.querySelector('.phrase-response');
      return box.top >= 0 && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && scroll.scrollHeight > scroll.clientHeight;
    }), true);
    await panel.getByRole('button', { name: 'Search the web', exact: true }).click();
    assert.equal(await panel.getByRole('link', { name: 'Dictionary entry' }).getAttribute('href'), 'https://example.org/traveler');
    assert.deepEqual(phrases, [false, true]);
    await desktopPage.screenshot({ path: output + '/contextual-phrase-desktop.png' });
    await desktopPage.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' });
    await select(3, 10);
    await panel.getByRole('button', { name: 'Bookmark selection', exact: true }).click();
    const bookmarkDialog = desktopPage.locator('#bookmarks-dialog'), note = bookmarkDialog.locator('textarea');
    assert.equal(await note.evaluate((node) => node === document.activeElement), true);
    await desktopPage.keyboard.press('Enter'); await bookmarkDialog.waitFor({ state: 'hidden' });
    await select(11, 16);
    await selection.dispatchEvent('keydown', { key: 'k', bubbles: true, cancelable: true });
    await note.fill('Review this verb.'); await desktopPage.keyboard.press('Enter');
    await bookmarkDialog.waitFor({ state: 'hidden' });
    const { bookmarks } = await (await desktop.request.get(base + `/api/books/${book.id}/bookmarks`)).json();
    const withoutNote = bookmarks.find(({ label }) => label === 'viajera'), withNote = bookmarks.find(({ label }) => label === 'llegó');
    assert.equal(withoutNote?.note, ''); assert.equal(withNote?.note, 'Review this verb.');
    assert.match(withoutNote.target, /^epubcfi\(.+:3\)$/u); assert.match(withNote.target, /^epubcfi\(.+:11\)$/u);
    await desktopPage.locator('#open-process-queue').click(); await desktopPage.locator('#downloads-dialog').waitFor({ state: 'visible' });
    assert.equal(await desktopPage.locator('#process-dismiss-minutes').inputValue(), '0');
    assert.equal(await desktopPage.locator('#downloads-title').textContent(), 'Process queue');
    assert.equal(await desktopPage.locator('#open-offline-downloads').count(), 0);
    await desktopPage.screenshot({ path: output + '/process-queue-desktop.png' });
    const accountId = (await (await desktop.request.get(base + '/api/settings/reader')).json()).accountId; let state = 'running';
    await desktopPage.route('**/api/processes', (route) => route.fulfill({ json: { accountId, jobs: [{ id: 'browser-task', label: 'Test processing', state }], unavailable: false } }));
    await desktopPage.evaluate(() => window.dispatchEvent(new CustomEvent('langy-processes-changed')));
    await desktopPage.locator('[data-process="browser-task"]').waitFor(); state = 'completed';
    await desktopPage.evaluate(() => window.dispatchEvent(new CustomEvent('langy-processes-changed')));
    await desktopPage.locator('[data-process="browser-task"]').waitFor({ state: 'detached' });
    await desktopPage.unroute('**/api/processes');
  });
  let memberContext, memberPage, memberBook;
  await check('administrator creates an account and the new reader signs in to an empty private library', async () => {
    if (await desktopPage.locator('#downloads-dialog').isVisible()) await desktopPage.locator('#downloads-dialog [data-close]').click();
    await desktopPage.goto(base + '/#settings/account'); await desktopPage.locator('#account-panel').waitFor({ state: 'visible' });
    assert.equal(await desktopPage.locator('#account-name').textContent(), 'reader');
    await desktopPage.locator('#account-new-name').fill('member'); await desktopPage.locator('#account-new-password').fill(memberPassword);
    await desktopPage.locator('#account-create').click(); await desktopPage.locator('#account-users strong').filter({ hasText: /^member$/ }).waitFor();
    await desktopPage.screenshot({ path: output + '/administrator-accounts.png' });
    memberContext = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    memberPage = await memberContext.newPage(); memberPage.on('pageerror', (error) => errors.push(error.message));
    await memberPage.goto(base + '/#library'); await memberPage.locator('#login-form').waitFor({ state: 'visible' });
    assert.equal(await memberPage.locator('#login-form [name=rememberMe]').isChecked(), false);
    await memberPage.locator('#login-form [name=username]').fill('member'); await memberPage.locator('#login-form [name=password]').fill(memberPassword);
    await memberPage.locator('#login-form [type=submit]').click(); await memberPage.locator('#shared-books-control').waitFor({ state: 'visible' });
    assert.equal((await memberContext.cookies()).find((cookie) => cookie.name === 'langy_session').expires, -1);
    assert.equal(await memberPage.locator('#books .book-card').count(), 0);
    assert.equal((await memberContext.request.get(base + '/api/books/' + book.id + '/file')).status(), 404);
  });
  await check('Remember me persists a secure session across browser reopening without saving the password locally', async () => {
    await memberPage.goto(base + '/#settings/account'); await memberPage.locator('#account-panel').waitFor({ state: 'visible' });
    await memberPage.locator('#account-panel [data-switch-user]').click(); await memberPage.locator('#sign-out-dialog').waitFor({ state: 'visible' }); assert.equal(await memberPage.locator('#sign-out-remove-downloads').isChecked(), false); await memberPage.locator('#sign-out-confirm').click();
    await memberPage.locator('#login-form').waitFor({ state: 'visible' }); await memberPage.locator('#login-form [name=rememberMe]').check();
    await memberPage.locator('#login-form [name=username]').fill('member'); await memberPage.locator('#login-form [name=password]').fill(memberPassword);
    await memberPage.screenshot({ path: output + '/remember-me-mobile.png' });
    await memberPage.locator('#login-form [type=submit]').click(); await memberPage.locator('#shared-books-control').waitFor({ state: 'visible' });
    const persisted = (await memberContext.cookies()).filter((cookie) => cookie.expires > Date.now() / 1000), session = persisted.find((cookie) => cookie.name === 'langy_session');
    assert.equal(session.httpOnly, true); assert.equal(session.sameSite, 'Lax'); assert.ok(session.expires > Date.now() / 1000 + 29 * 86400);
    assert.equal(await memberPage.evaluate((password) => Object.values(localStorage).some((value) => value.includes(password)), memberPassword), false);
    const resumed = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    try {
      await resumed.addCookies(persisted); const reopened = await resumed.newPage(); await reopened.goto(base + '/#library');
      await reopened.locator('#shared-books-control').waitFor({ state: 'visible' });
      assert.equal((await (await resumed.request.get(base + '/api/account')).json()).user.username, 'member');
    } finally { await resumed.close(); }
  });
  await check('mobile readers can import privately and share an existing book from Edit', async () => {
    await memberPage.locator('#import-book').click(); await memberPage.locator('#book-dialog').waitFor({ state: 'visible' });
    assert.equal(await memberPage.locator('#book-form [name=shared]').isChecked(), false);
    await memberPage.locator('#book-file').setInputFiles({ name: 'member.epub', mimeType: 'application/epub+zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
    await memberPage.waitForFunction(() => document.querySelector('#book-form [name=title]').value === 'Reader interactions');
    await memberPage.locator('#book-form [name=title]').fill('Member private book'); await memberPage.locator('#book-submit').click();
    await memberPage.locator('#book-dialog').waitFor({ state: 'hidden' }); await memberPage.locator('#books .book-card').filter({ hasText: 'Member private book' }).waitFor();
    memberBook = (await (await memberContext.request.get(base + '/api/library')).json()).books.find((item) => item.title === 'Member private book');
    assert.ok(memberBook?.id); assert.equal(memberBook.shared, false);
    assert.equal((await context.request.get(base + '/api/books/' + memberBook.id + '/file')).status(), 404);
    await memberPage.locator('.book-mobile-menu').click(); await memberPage.locator('#book-actions-body button').filter({ hasText: /^Edit book details$/ }).click();
    await memberPage.locator('#book-form [name=shared]').check(); await memberPage.locator('#book-submit').click(); await memberPage.locator('#book-dialog').waitFor({ state: 'hidden' });
    assert.equal((await context.request.get(base + '/api/books/' + memberBook.id + '/file')).status(), 200);
    assert.equal((await context.request.patch(base + '/api/books/' + memberBook.id, { data: { title: 'Cannot edit someone else’s book' } })).status(), 403);
  });
  await check('Show shared books persists across reloads while keeping the reader’s own shared books visible', async () => {
    assert.equal((await context.request.patch(base + '/api/books/' + book.id, { data: { shared: true } })).status(), 200);
    await memberPage.reload(); await memberPage.locator('#books .book-card').filter({ hasText: 'Reader interactions' }).waitFor();
    assert.equal(await memberPage.locator('#books .book-card').count(), 2);
    assert.equal(await memberPage.locator('[aria-label="Edit Reader interactions"]').count(), 0);
    await memberPage.locator('#show-shared-books').uncheck();
    await memberPage.waitForFunction(() => document.querySelectorAll('#books .book-card').length === 1);
    await memberPage.waitForFunction(() => { const saved = JSON.parse(localStorage.getItem('langy-account-settings-v1') || '{}'); return saved.accountId && !Object.keys(saved.pending || {}).length; });
    assert.equal((await (await memberContext.request.get(base + '/api/settings/reader')).json()).preferences.showSharedBooks, false);
    await memberPage.reload(); await memberPage.locator('#books .book-card').filter({ hasText: 'Member private book' }).waitFor();
    assert.equal(await memberPage.locator('#show-shared-books').isChecked(), false); assert.equal(await memberPage.locator('#books .book-card').count(), 1);
    await memberPage.screenshot({ path: output + '/member-private-library.png' });
  });
  let retainedPack, retainedOwner;
  await check('Switch user keeps downloaded books by default and clears the active account', async () => {
    await useAndroidApp(memberContext, memberPage);
    await memberContext.setExtraHTTPHeaders(adminHeaders);
    assert.equal((await (await memberContext.request.get(base + '/api/account')).json()).user.username, 'member');
    const otherTab = await memberContext.newPage(); await otherTab.goto(base + '/#library'); await otherTab.locator('#shared-books-control').waitFor({ state: 'visible' });
    retainedOwner = await memberPage.evaluate(() => localStorage.getItem('langy-offline-owner')); retainedPack = 'langy-pack-' + retainedOwner + '-retained-test';
    await memberPage.evaluate(async ({ name, book, bytes }) => {
      const cache = await caches.open(name); await cache.put('/__langy_pack_ready__', Response.json({ book: book.id }));
      await cache.put('/api/books/' + book.id + '/offline-data', Response.json({ book, analysis: { state: 'ready' } }));
      await cache.put('/api/books/' + book.id + '/file', new Response(Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0))));
    }, { name: retainedPack, book: memberBook, bytes: await zip.generateAsync({ type: 'base64' }) });
    await memberPage.goto(base + '/#settings/account'); await memberPage.locator('#account-panel').waitFor({ state: 'visible' });
    assert.equal(await memberPage.locator('#account-admin').isVisible(), false);
    await memberPage.evaluate(async () => { const cache = await caches.open('langy-covers-signout-check'); await cache.put('/signout-cover', new Response('private cover')); });
    await memberPage.locator('#account-panel [data-switch-user]').click(); await memberPage.locator('#sign-out-dialog').waitFor({ state: 'visible' });
    assert.equal(await memberPage.locator('#sign-out-remove-downloads').isChecked(), false); await memberPage.locator('#sign-out-confirm').click();
    await memberPage.locator('#login-form').waitFor({ state: 'visible' }); await otherTab.locator('#login-form').waitFor({ state: 'visible' });
    assert.equal(await memberPage.evaluate(() => localStorage.getItem('langy-progress-v1')), null); assert.equal(await memberPage.evaluate(() => localStorage.getItem('langy-auth-account')), null);
    assert.equal(await memberPage.evaluate(async () => (await caches.keys()).some((key) => key.startsWith('langy-covers-'))), false);
    assert.equal(await memberPage.evaluate(async (name) => (await caches.keys()).includes(name), retainedPack), true);
    assert.equal((await (await memberContext.request.get(base + '/api/account')).json()).authenticated, false);
    await otherTab.close(); await memberPage.screenshot({ path: output + '/sign-in-mobile.png' });
  });
  await check('retained downloads stay with their owner and removal is an explicit account-scoped choice', async () => {
    async function login(name, password) { await memberPage.locator('#login-form [name=username]').fill(name); await memberPage.locator('#login-form [name=password]').fill(password); await memberPage.locator('#login-form [type=submit]').click(); await memberPage.locator('#shared-books-control').waitFor({ state: 'visible' }); }
    async function leave(remove) { await memberPage.goto(base + '/#settings/account'); await memberPage.locator('#account-panel [data-switch-user]').click(); await memberPage.locator('#sign-out-dialog').waitFor({ state: 'visible' }); if (remove) await memberPage.locator('#sign-out-remove-downloads').check(); await memberPage.locator('#sign-out-confirm').click(); await memberPage.locator('#login-form').waitFor({ state: 'visible' }); }
    await login('reader', adminPassword); assert.notEqual(await memberPage.evaluate(() => localStorage.getItem('langy-offline-owner')), retainedOwner);
    assert.equal(await memberPage.locator(`[data-book="${memberBook.id}"]`).getByText('Downloaded', { exact: true }).count(), 0);
    await leave(true); assert.equal(await memberPage.evaluate(async (name) => (await caches.keys()).includes(name), retainedPack), true);
    await login('member', memberPassword); assert.equal(await memberPage.evaluate(() => localStorage.getItem('langy-offline-owner')), retainedOwner);
    await memberPage.locator(`[data-book="${memberBook.id}"]`).getByText('Downloaded', { exact: true }).waitFor();
    await leave(true); assert.equal(await memberPage.evaluate(async (name) => (await caches.keys()).includes(name), retainedPack), false);
    await memberContext.close();
  });
  await check('demo starts with Mandarin and English story folders and both sample EPUBs open on mobile', async () => {
    const demoBase = 'http://127.0.0.1:19392';
    demoServer = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: '19392', READER_DATA: join(dir, 'demo'), READER_DEMO: '1', READER_PASSWORD: '', READER_LANGUAGE_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const pipe of [demoServer.stdout, demoServer.stderr]) pipe.on('data', (part) => { if (serverLog.length < 400) serverLog.push(part.toString()); });
    for (let index = 0; index < 100; index++) { if (await fetch(demoBase + '/healthz').then((response) => response.ok).catch(() => false)) break; await delay(100); }
    const demoContext = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    try {
      const demoPage = await demoContext.newPage(); demoPage.on('pageerror', (error) => errors.push(error.message));
      for (const [folder, id, title] of [['demo-mandarin', 'demo-story-zh', '蓝色的伞'], ['demo-english', 'demo-story-en', 'The Note in the Book']]) {
        await demoPage.goto(demoBase + '/#library'); await demoPage.locator('#mobile-category').selectOption(folder);
        await demoPage.waitForFunction(() => document.querySelectorAll('#books .book-card').length === 1);
        assert.equal(await demoPage.locator('#books .book-card').count(), 1);
        await demoPage.locator('#books a[href="#read/' + id + '"]').click(); await demoPage.locator('#viewer iframe').first().waitFor();
        await demoPage.waitForFunction((title) => document.querySelector('#reading-title')?.textContent.includes(title), title);
        if (id === 'demo-story-zh') await demoPage.locator('#pinyin-toggle').waitFor({ state: 'visible' });
        assert.equal(await demoPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await demoPage.screenshot({ path: output + '/' + id + '-mobile.png' });
      }
    } finally { await demoContext.close(); }
  });
  await desktop.close(); assert.deepEqual(errors, [], 'the app must not emit uncaught browser errors');
} catch (error) { results.push({ name: 'browser setup', pass: false, error: error.stack }); console.error(error); }
finally {
  await writeFile(join(output, 'report.json'), JSON.stringify({ results, errors }, null, 2));
  await writeFile(join(output, 'server.log'), serverLog.join(''));
  await context?.close(); await browser?.close();
  if (server.exitCode == null) { const stopped = new Promise((resolve) => server.once('exit', resolve)); server.kill('SIGTERM'); await stopped; }
  if (demoServer?.exitCode === null) { const stopped = new Promise((resolve) => demoServer.once('exit', resolve)); demoServer.kill('SIGTERM'); await stopped; }
  await rm(dir, { recursive: true, force: true });
}
if (results.some((result) => !result.pass)) process.exitCode = 1;
