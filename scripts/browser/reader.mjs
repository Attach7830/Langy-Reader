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
const adminPassword = 'browser-administrator-test-password', memberPassword = 'browser-member-test-password';
const adminHeaders = { Authorization: 'Basic ' + Buffer.from(`reader:${adminPassword}`).toString('base64') };
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: '19391', READER_DATA: dir, READER_DEMO: '0', READER_USER: 'reader', READER_PASSWORD: adminPassword, READER_SYNC_USER: '', READER_SYNC_PASSWORD: '', READER_LANGUAGE_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'] });
for (const pipe of [server.stdout, server.stderr]) pipe.on('data', (part) => { if (serverLog.length < 200) serverLog.push(part.toString()); });
let browser, context, page;
try {
  for (let i = 0; i < 100; i++) { if (await fetch(base + '/healthz').then((r) => r.ok).catch(() => false)) break; if (server.exitCode != null) throw new Error('Server failed: ' + serverLog.join('')); await delay(100); }
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: 'block', extraHTTPHeaders: adminHeaders });
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
  await check('the Process queue closes on an outside tap', async () => {
    await page.locator('#mobile-navigation [data-open-processes]').click();
    await page.locator('#downloads-dialog').waitFor({ state: 'visible' });
    await page.touchscreen.tap(3, 3); await page.locator('#downloads-dialog').waitFor({ state: 'hidden' });
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
  await check('pinch enlarges touch text and leaves desktop font size unchanged', async () => {
    const before = await page.evaluate(() => ({ size: 20, ...JSON.parse(localStorage.getItem('langy-settings-v1')) }));
    const box = await page.locator('.reading-main').boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x - 35, y }, { id: 2, x: x + 35, y }] });
    for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x - 35 - i * 3, y }, { id: 2, x: x + 35 + i * 3, y }] }); await delay(20); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction((size) => JSON.parse(localStorage.getItem('langy-settings-v1')).touchSize > size, before.touchSize || before.size, { timeout: 4000 });
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
    await delay(250); assert.equal(await page.locator('#phrase-help').isVisible(), false);
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
    await desktopPage.screenshot({ path: output + '/library-desktop.png' });
    await desktopPage.goto(base + '/#about'); await desktopPage.locator('#about-title').waitFor({ state: 'visible' });
    await desktopPage.screenshot({ path: output + '/about-desktop.png' });
    assert.equal(await desktopPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
  await check('desktop reader supports trackpad text size, section shortcuts, contextual phrase help and one process queue', async () => {
    await desktopPage.goto(base + '/#read/' + book.id);
    await desktopPage.waitForFunction(() => document.querySelector('#position-detail').textContent === 'Section 1 of 3');
    await desktopPage.locator('#reader-message').waitFor({ state: 'hidden' });
    const before = await desktopPage.evaluate(() => ({ size: 20, ...JSON.parse(localStorage.getItem('langy-settings-v1')) }));
    let frame = await (await desktopPage.locator('#viewer iframe').elementHandle()).contentFrame();
    assert.equal(await frame.evaluate(() => { const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -24, clientX: 120, clientY: 180 }); document.body.dispatchEvent(event); return event.defaultPrevented; }), true);
    await desktopPage.waitForFunction((size) => JSON.parse(localStorage.getItem('langy-settings-v1')).size > size, before.size);
    assert.equal((await desktopPage.evaluate(() => JSON.parse(localStorage.getItem('langy-settings-v1')))).touchSize, before.touchSize);
    assert.equal(await desktopPage.evaluate(() => visualViewport.scale), 1); await delay(700);
    await desktopPage.keyboard.press('Control+ArrowRight');
    await desktopPage.waitForFunction(() => document.querySelector('#position-detail').textContent === 'Section 2 of 3');
    await desktopPage.keyboard.press('Control+ArrowLeft');
    await desktopPage.waitForFunction(() => document.querySelector('#position-detail').textContent === 'Section 1 of 3'); await delay(300);
    let phrases = 0;
    await desktopPage.route('**/api/ai/phrase', async (route) => { phrases++; const data = route.request().postDataJSON(); assert.equal(data.phrase, 'La viajera'); assert.ok(data.context.includes('casa tranquila')); await route.fulfill({ json: { text: 'The traveler is the woman arriving at the house.' } }); });
    frame = await (await desktopPage.locator('#viewer iframe').elementHandle()).contentFrame();
    await frame.evaluate(() => { const node = document.querySelector('#source').firstChild, range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 10); const selected = getSelection(); selected.removeAllRanges(); selected.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
    await desktopPage.locator('#phrase-help').waitFor({ state: 'visible' }); assert.equal(phrases, 0);
    await desktopPage.locator('[data-explain-phrase]').click(); await desktopPage.locator('[data-phrase-answer]').filter({ hasText: 'The traveler' }).waitFor(); assert.equal(phrases, 1);
    await desktopPage.screenshot({ path: output + '/contextual-phrase-desktop.png' });
    await desktopPage.locator('[data-close-phrase]').click();
    await desktopPage.locator('#open-process-queue').click(); await desktopPage.locator('#downloads-dialog').waitFor({ state: 'visible' });
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
    await desktopPage.locator('#downloads-dialog [data-close]').click();
    await desktopPage.goto(base + '/#settings/account'); await desktopPage.locator('#account-panel').waitFor({ state: 'visible' });
    assert.equal(await desktopPage.locator('#account-name').textContent(), 'reader');
    await desktopPage.locator('#account-new-name').fill('member'); await desktopPage.locator('#account-new-password').fill(memberPassword);
    await desktopPage.locator('#account-create').click(); await desktopPage.locator('#account-users strong').filter({ hasText: /^member$/ }).waitFor();
    await desktopPage.screenshot({ path: output + '/administrator-accounts.png' });
    memberContext = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    memberPage = await memberContext.newPage(); memberPage.on('pageerror', (error) => errors.push(error.message));
    await memberPage.goto(base + '/#library'); await memberPage.locator('#login-form').waitFor({ state: 'visible' });
    await memberPage.locator('#login-form [name=username]').fill('member'); await memberPage.locator('#login-form [name=password]').fill(memberPassword);
    await memberPage.locator('#login-form [type=submit]').click(); await memberPage.locator('#shared-books-control').waitFor({ state: 'visible' });
    assert.equal(await memberPage.locator('#books .book-card').count(), 0);
    assert.equal((await memberContext.request.get(base + '/api/books/' + book.id + '/file')).status(), 404);
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
  await check('sign-out clears local reader data and cached administrator Basic credentials cannot sign the member back in', async () => {
    // Simulate the native app or an older browser still sending its saved Basic login.
    await memberContext.setExtraHTTPHeaders(adminHeaders);
    assert.equal((await (await memberContext.request.get(base + '/api/account')).json()).user.username, 'member');
    const otherTab = await memberContext.newPage(); await otherTab.goto(base + '/#library'); await otherTab.locator('#shared-books-control').waitFor({ state: 'visible' });
    await memberPage.goto(base + '/#settings/account'); await memberPage.locator('#account-panel').waitFor({ state: 'visible' });
    assert.equal(await memberPage.locator('#account-admin').isVisible(), false);
    memberPage.once('dialog', (dialog) => dialog.accept()); await memberPage.locator('[data-sign-out]').click();
    await memberPage.locator('#login-form').waitFor({ state: 'visible' }); await otherTab.locator('#login-form').waitFor({ state: 'visible' });
    assert.equal(await memberPage.evaluate(() => localStorage.getItem('langy-progress-v1')), null);
    assert.equal(await memberPage.evaluate(() => localStorage.getItem('langy-auth-account')), null);
    assert.equal((await (await memberContext.request.get(base + '/api/account')).json()).authenticated, false);
    await memberPage.screenshot({ path: output + '/sign-in-mobile.png' }); await memberContext.close();
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
