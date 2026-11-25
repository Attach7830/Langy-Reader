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
  await open();
  await check('page buttons advance reliably across section boundaries', async () => {
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
    const host = await page.locator('.reading-main').boundingBox(), frame = page.frames().find((f) => f.url().startsWith('blob:'));
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
} catch (error) { results.push({ name: 'browser setup', pass: false, error: error.stack }); console.error(error); }
finally {
  await writeFile(join(output, 'report.json'), JSON.stringify({ results, errors }, null, 2));
  await writeFile(join(output, 'server.log'), serverLog.join(''));
  await context?.close(); await browser?.close(); server.kill('SIGTERM'); await rm(dir, { recursive: true, force: true });
}
if (results.some((result) => !result.pass)) process.exitCode = 1;
