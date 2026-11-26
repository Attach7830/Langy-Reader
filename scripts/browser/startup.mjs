import { chromium } from 'playwright';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const folder = await mkdtemp(join(tmpdir(), 'langy-startup-')), base = 'http://127.0.0.1:19393';
const password = 'startup-browser-test-password', errors = [], log = [], results = [];
const headers = { Authorization: 'Basic ' + Buffer.from(`reader:${password}`).toString('base64') };
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: '19393', READER_DATA: folder,
  READER_DEMO: '0', READER_USER: 'reader', READER_PASSWORD: password, READER_LANGUAGE_URL: 'http://127.0.0.1:1', READER_KOKORO_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [server.stdout, server.stderr]) stream.on('data', (part) => log.push(part.toString()));
let browser;
const gate = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
const ready = (promise) => Promise.race([promise, delay(15000, undefined, { ref: false }).then(() => { throw new Error('Timed out waiting for startup request'); })]);
try {
  await mkdir('browser-results', { recursive: true });
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + '/healthz').then((response) => response.ok).catch(() => false)) break;
    if (server.exitCode != null) throw new Error(log.join(''));
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  const zip = new JSZip(); zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
  zip.file('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">startup-fixture</dc:identifier><dc:title>Startup fixture</dc:title><dc:language>es</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>');
  zip.file('one.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Una historia</title></head><body><p>La viajera lee un libro en la casa.</p></body></html>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  for (const mode of ['desktop', 'android']) {
    const context = await browser.newContext({ viewport: mode === 'desktop' ? { width: 1280, height: 850 } : { width: 393, height: 851 },
      isMobile: mode === 'android', hasTouch: mode === 'android', serviceWorkers: 'block', extraHTTPHeaders: headers });
    await context.addInitScript(() => localStorage.setItem('langy-settings-v1', JSON.stringify({ progressSyncEnabled: false })));
    if (mode === 'android') {
      const bridge = (await readFile('android/app/src/main/assets/reader-fullscreen.js', 'utf8')).replace('__LANGY_FULLSCREEN_TOKEN__', 'startup-test-native-channel');
      await context.addInitScript({ content: bridge + "\ndocument.addEventListener('DOMContentLoaded', () => { const channel = new MessageChannel(); window.postMessage('startup-test-native-channel', location.origin, [channel.port2]); }, { once: true });" });
    }
    const books = [];
    for (const title of ['First reading book', 'Second reading book']) {
      const response = await context.request.post(base + '/api/books', { multipart: { title, language: 'es',
        file: { name: `${mode}-${books.length}.epub`, mimeType: 'application/epub+zip', buffer: bytes } } });
      assert.equal(response.status(), 201, await response.text()); books.push(await response.json());
    }
    const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
    const held = gate(), arrived = gate();
    const hold = async (route) => { arrived.release(); await held.promise; await route.continue(); };
    await page.route('**/api/library', hold);
    const navigating = page.goto(base + '/#library');
    try {
      await ready(arrived.promise);
      assert.equal(await page.locator('#startup-loading').isVisible(), true);
      assert.equal(await page.locator('#library-screen').isVisible(), false);
      assert.equal(await page.locator('#startup-progress').getAttribute('value'), null);
      assert.ok(await page.locator('#library-screen').evaluate((node) => node.getBoundingClientRect().width) > 0, 'the overlay must preserve layout for direct book opens');
      await page.screenshot({ path: `browser-results/startup-${mode}.png`, animations: 'disabled' });
    } finally { held.release(); }
    await navigating; await page.locator('#startup-loading').waitFor({ state: 'hidden' });
    await page.locator(`[data-book="${books[0].id}"]`).waitFor(); await page.unroute('**/api/library', hold);
    results.push({ name: `${mode} shows startup until the library is ready`, pass: true });
    if (mode === 'desktop') {
      const refreshing = gate(), refreshArrived = gate(), patching = gate(), patchArrived = gate();
      const holdRefresh = async (route) => { refreshArrived.release(); await refreshing.promise; await route.continue(); };
      await page.locator(`[data-book="${books[0].id}"] .book-edit`).click();
      await page.locator('#book-form [name=series]').fill('First series');
      await page.locator('#book-form [name=seriesIndex]').fill('2.5');
      await page.route('**/api/library', holdRefresh);
      try {
        await page.locator('#book-submit').click(); await page.locator('#book-dialog').waitFor({ state: 'hidden' }); await ready(refreshArrived.promise);
        await page.locator(`[data-book="${books[1].id}"] .book-edit`).click();
        assert.equal(await page.locator('#book-form [name=title]').inputValue(), books[1].title);
        await page.locator('#book-form [name=series]').fill('Second series');
        await page.route(`**/api/books/${books[1].id}`, async (route) => {
          if (route.request().method() === 'PATCH') { patchArrived.release(); await patching.promise; } await route.continue();
        });
        await page.locator('#book-submit').click(); await ready(patchArrived.promise);
        refreshing.release(); await delay(100);
        assert.equal(await page.locator('#book-submit').isDisabled(), true, 'the first save must not unlock the second save');
        assert.equal(await page.locator('#book-dialog').isVisible(), true);
        assert.equal(await page.locator('#book-form [name=title]').inputValue(), books[1].title);
      } finally { refreshing.release(); patching.release(); }
      await page.locator('#book-dialog').waitFor({ state: 'hidden' }); await page.unroute('**/api/library', holdRefresh);
      const updated = await (await context.request.get(base + '/api/library')).json();
      assert.equal(updated.books.find((book) => book.id === books[0].id).series, 'First series');
      assert.equal(updated.books.find((book) => book.id === books[1].id).series, 'Second series');
      results.push({ name: 'rapid editing opens the requested book and isolates overlapping save cleanup', pass: true });
      const status = await (await context.request.get(base + '/api/processes')).json();
      let promoted = false;
      const queuedJobs = () => ['first', 'second'].map((name, index) => ({ id: `analysis:${name}`, kind: 'analysis', label: 'Analyze book vocabulary',
        title: `${name} queued book`, state: 'queued', canPrioritize: true, priority: promoted && index === 1 ? 1 : 0,
        queuePosition: promoted ? 2 - index : index + 1 }));
      await page.route('**/api/processes/analysis%3Asecond/priority', async (route) => { assert.equal(route.request().method(), 'POST'); promoted = true; await route.fulfill({ status: 202, json: { priority: 1 } }); });
      await page.route('**/api/processes', (route) => route.fulfill({ json: { accountId: status.accountId, sequential: true, jobs: [{
        id: 'narration:progress-fixture', kind: 'narration', label: 'Generate audiobook', state: 'running', phase: 'aligning',
        startedAt: Date.now() - 65000, progress: 12.5, counter: { complete: 1, total: 10, unit: 'sections' }, activity: { complete: 2, total: 8, unit: 'passages' },
      }, ...queuedJobs()] } }));
      await page.locator('#open-process-queue').click();
      const card = page.locator('[data-process="narration:progress-fixture"]'); await card.waitFor();
      assert.match(await card.innerText(), /1 \/ 10 sections completed/u); assert.match(await card.innerText(), /2 \/ 8 passages completed/u);
      assert.match(await card.innerText(), /Synchronizing spoken words/u); assert.match(await card.locator('.process-elapsed').innerText(), /1:0[5-9]/u);
      await page.screenshot({ path: 'browser-results/process-progress.png' });
      results.push({ name: 'background progress shows stage, section and passage counts, and elapsed time', pass: true });
      await page.locator('[data-process="analysis:second"]').getByRole('button', { name: 'Raise priority' }).click();
      await page.locator('[data-process="analysis:second"]').getByText('Priority raised').waitFor();
      assert.deepEqual(await page.locator('#process-list [data-process]').evaluateAll((cards) => cards.map((node) => node.dataset.process)),
        ['narration:progress-fixture', 'analysis:second', 'analysis:first']);
      assert.equal(await card.getByRole('button', { name: 'Raise priority' }).count(), 0, 'the current task remains active and cannot be promoted');
      await page.screenshot({ path: 'browser-results/process-priority.png' });
      results.push({ name: 'raising priority moves a queued book ahead while the current task keeps running', pass: true });
    }
    const failure = await context.newPage(); failure.on('pageerror', (error) => errors.push(error.message)); let broken = true;
    await failure.route('**/api/library', (route) => broken ? route.fulfill({ status: 503, json: { error: 'Synthetic unavailable library' } }) : route.continue());
    await failure.goto(base + '/#library'); await failure.locator('#startup-retry').waitFor();
    assert.equal(await failure.locator('#library-screen').isVisible(), false);
    assert.match(await failure.locator('#startup-error').innerText(), /Synthetic unavailable/u);
    broken = false; await failure.locator('#startup-retry').click(); await failure.locator('#startup-loading').waitFor({ state: 'hidden' });
    await failure.locator(`[data-book="${books[1].id}"]`).waitFor();
    results.push({ name: `${mode} shows startup failure and retry recovers`, pass: true });
    await context.close();
  }
  const anonymous = await browser.newContext(), signIn = await anonymous.newPage();
  await signIn.goto(base); await signIn.locator('#login-screen').waitFor(); assert.equal(await signIn.locator('#startup-loading').isVisible(), false);
  results.push({ name: 'startup overlay does not block sign-in', pass: true });
  assert.deepEqual(errors, []);
  for (const result of results) console.log('PASS', result.name);
} catch (error) {
  results.push({ name: 'startup and process regression checks', pass: false, error: error.stack }); throw error;
} finally {
  await writeFile('browser-results/startup-results.json', JSON.stringify(results, null, 2));
  await browser?.close(); server.kill('SIGTERM'); await delay(100); if (server.exitCode == null) server.kill('SIGKILL');
  await rm(folder, { recursive: true, force: true });
}
