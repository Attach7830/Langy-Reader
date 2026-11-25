import { chromium } from 'playwright';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const output = 'browser-results'; await mkdir(output, { recursive: true });
const dir = await mkdtemp(join(tmpdir(), 'langy-browser-'));
const base = 'http://127.0.0.1:19391', serverLog = [], errors = [], results = [];
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: '19391', READER_DATA: dir, READER_DEMO: '0', READER_PASSWORD: '', READER_LANGUAGE_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'] });
for (const pipe of [server.stdout, server.stderr]) pipe.on('data', (part) => { if (serverLog.length < 200) serverLog.push(part.toString()); });
let browser, context, page;
try {
  for (let i = 0; i < 100; i++) { if (await fetch(base + '/healthz').then((r) => r.ok).catch(() => false)) break; if (server.exitCode != null) throw new Error('Server failed: ' + serverLog.join('')); await delay(100); }
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await context.addInitScript(() => { if (window.top === window) { const prefs = JSON.parse(localStorage.getItem('langy-settings-v1') || '{}'); localStorage.setItem('langy-settings-v1', JSON.stringify({ ...prefs, progressSyncEnabled: false })); } });
  page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/ai/word', (route) => route.fulfill({ json: { text: 'A useful dictionary definition.', language: 'en' } }));
  const zip = new JSZip(); zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/book.opf', '<?xml version="1.0"?><package version="3.0" unique-identifier="id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">langy-browser-fixture</dc:identifier><dc:title>Reader interactions</dc:title><dc:language>es</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/><itemref idref="notes"/></spine></package>');
  zip.file('OEBPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">Primera parte</a></li><li><a href="two.xhtml">Segunda parte</a></li><li><a href="notes.xhtml">Notas</a></li></ol></nav></body></html>');
  const paragraph = 'La viajera llegó a una casa tranquila cerca del río. En la ventana había una planta pequeña y un libro abierto. Quería conocer la historia del pueblo, así que se sentó a conversar con la mujer que cuidaba el jardín. Todavía quedaban muchas cosas por descubrir.';
  for (const name of ['one', 'two']) zip.file(`OEBPS/${name}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${name}</title></head><body><h1>${name === 'one' ? 'Primera parte' : 'Segunda parte'}</h1><p id="source">${paragraph} <a href="notes.xhtml#note">Leer nota</a></p>${Array.from({ length: 90 }, (_, i) => `<p id="passage-${i}">${paragraph} ${paragraph}</p>`).join('')}</body></html>`);
  zip.file('OEBPS/notes.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Notas</title></head><body><h1 id="note">Una nota del libro</h1><p>Esta explicación ayuda a comprender el pasaje.</p></body></html>');
  const uploaded = await context.request.post(base + '/api/books', { multipart: { title: 'Reader interactions', language: 'es', file: { name: 'reader.epub', mimeType: 'application/epub+zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) } } });
  assert.equal(uploaded.status(), 201, await uploaded.text()); const book = await uploaded.json();
  const samples = 120 * 8000, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  await page.route('**/browser-audio.wav', (route) => route.fulfill({ body: wav, contentType: 'audio/wav' }));
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
    catch (error) { results.push({ name, pass: false, error: error.stack }); console.error('FAIL', name, error.message); await page.screenshot({ path: `${output}/${results.length}-failure.png` }).catch(() => {}); }
  }
  async function swipe(dx, dy = 0, wiggle = false) {
    const box = await page.locator('.reading-main').boundingBox(), x = box.x + box.width * .65, y = box.y + box.height * .5;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    if (wiggle) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 3, y: y + 18 }] });
    for (let n = 1; n <= 8; n++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * n / 8, y: y + dy * n / 8 }] }); await delay(12); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  async function changed(before) { await page.waitForFunction(({ id, before }) => JSON.parse(localStorage.getItem('langy-progress-v1') || '{}')[id]?.target !== before, { id: book.id, before }, { timeout: 4000 }); }
  await page.goto(base + '/#library');
  await page.locator('#books a[href="#read/' + book.id + '"]').waitFor();
  await check('mobile library uses compact controls and book actions contain no statistics', async () => {
    assert.equal(await page.locator('#mobile-navigation').isVisible(), true);
    assert.equal(await page.locator('.mobile-collections').isVisible(), true);
    assert.equal(await page.locator('.library-rail').isVisible(), false);
    assert.equal(await page.locator('.book-reading-details').first().isVisible(), false);
    await page.locator('.book-mobile-menu').first().click();
    await page.locator('#book-actions-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#book-actions-dialog .book-word-count, #book-actions-dialog .book-metrics').count(), 0);
    await page.locator('#book-actions-dialog [data-close]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: output + '/mobile-library.png', fullPage: true });
  });
  await check('completed book packs show Downloaded and open locally even when the source URL fails', async () => {
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
  await check('hyperlink jumps expose an immediately usable Back to text control', async () => {
    await page.goto(base + '/#library'); await page.evaluate(() => localStorage.removeItem('langy-progress-v1')); await page.reload(); await open();
    await page.frameLocator('#viewer iframe').first().getByText('Leer nota', { exact: true }).tap();
    await page.waitForTimeout(350); assert.equal(await page.locator('#return-location').isVisible(), true);
    await page.locator('#return-location').click(); await page.waitForTimeout(200);
    assert.equal(await page.frameLocator('#viewer iframe').first().getByText('Leer nota', { exact: true }).isVisible(), true);
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
  await check('pinch enlarges touch text and leaves desktop font size unchanged', async () => {
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('langy-settings-v1')));
    const box = await page.locator('.reading-main').boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x - 35, y }, { id: 2, x: x + 35, y }] });
    for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x - 35 - i * 3, y }, { id: 2, x: x + 35 + i * 3, y }] }); await delay(20); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction((size) => JSON.parse(localStorage.getItem('langy-settings-v1')).touchSize > size, before.touchSize || before.size, { timeout: 4000 });
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('langy-settings-v1')));
    assert.equal(after.size, before.size); assert.equal(await page.evaluate(() => visualViewport.scale), 1);
    await delay(500);
  });
  await check('swiping down opens sections and expandable bookmarks without changing pages', async () => {
    const before = await position(); await swipe(0, 160);
    await page.locator('#contents-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: 'Primera parte', exact: true }).isVisible(), true);
    await page.locator('.toc-bookmarks summary').click();
    await page.locator('.toc-bookmarks').getByText('No bookmarks yet.').waitFor();
    await page.locator('#contents-dialog [data-close]').click(); assert.equal(await position(), before);
  });
  await check('swiping up reveals the player temporarily and center double taps play and pause', async () => {
    const before = await position(); await swipe(0, -160);
    await page.locator('#narration-player').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#narration-play').disabled, null, { timeout: 5000 });
    assert.equal(await position(), before);
    const doubleCenter = async () => { const box = await page.locator('.reading-main').boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); await delay(65);
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); };
    await doubleCenter(); await page.waitForFunction(() => !document.querySelector('#narration-audio').paused);
    await doubleCenter(); await page.waitForFunction(() => document.querySelector('#narration-audio').paused);
    await page.locator('#narration-player').waitFor({ state: 'hidden', timeout: 7000 });
    assert.equal(await page.evaluate(() => document.querySelector('#narration-audio').paused), true);
  });
  await check('manual page turns with missing word alignment do not snap back while narration is enabled', async () => {
    const before = await position(); await page.locator('#next').click(); await changed(before);
    const after = await position(); await delay(1000); assert.equal(await position(), after);
  });
  await check('About and How to are available to self-hosted readers and fit a phone screen', async () => {
    await page.goto(base + '/#about'); await page.locator('#about-title').waitFor({ state: 'visible' });
    assert.equal(await page.getByText('A note from the project’s creator', { exact: true }).isVisible(), true);
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
    await page.locator('#settings [data-close]').first().click();
  });
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } }), desktopPage = await desktop.newPage();
  desktopPage.on('pageerror', (error) => errors.push(error.message));
  await check('desktop library and project pages retain their full layout', async () => {
    await desktopPage.goto(base + '/#library'); await desktopPage.locator('#books a').first().waitFor();
    assert.equal(await desktopPage.locator('.library-rail').isVisible(), true); assert.equal(await desktopPage.locator('#mobile-navigation').isVisible(), false);
    await desktopPage.screenshot({ path: output + '/library-desktop.png' });
    await desktopPage.goto(base + '/#about'); await desktopPage.locator('#about-title').waitFor({ state: 'visible' });
    await desktopPage.screenshot({ path: output + '/about-desktop.png' });
    assert.equal(await desktopPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
  await desktop.close(); assert.deepEqual(errors, [], 'the app must not emit uncaught browser errors');
} catch (error) { results.push({ name: 'browser setup', pass: false, error: error.stack }); console.error(error); }
finally {
  await writeFile(join(output, 'report.json'), JSON.stringify({ results, errors }, null, 2));
  await writeFile(join(output, 'server.log'), serverLog.join(''));
  await context?.close(); await browser?.close();
  if (server.exitCode == null) { const stopped = new Promise((resolve) => server.once('exit', resolve)); server.kill('SIGTERM'); await stopped; }
  await rm(dir, { recursive: true, force: true });
}
if (results.some((result) => !result.pass)) process.exitCode = 1;
