import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { startupScreen } from '../src/startup.js';
import { processElapsed, processProgress } from '../src/process-progress.js';

test('startup stays visible through cache progress, offers retry on failure, and cannot reopen after completion', async (t) => {
  const dom = new JSDOM(await readFile('index.html', 'utf8'), { url: 'https://langy.test' });
  const document = dom.window.document; let now = 1000, retries = 0;
  const loading = startupScreen({ document, now: () => now, reload: () => retries++ });
  t.after(() => { loading.finish(); dom.window.close(); });
  loading.start('Loading your library…');
  assert.equal(document.querySelector('#startup-loading').hidden, false);
  assert.equal(document.querySelector('#startup-progress').hasAttribute('value'), false);
  loading.report({ label: 'Loading saved books…', complete: 2, total: 8 });
  assert.equal(document.querySelector('#startup-count').textContent, '2 / 8 · 25%');
  assert.equal(document.querySelector('#startup-progress').value, 2);
  now += 13000; loading.report({ label: 'Preparing your library…' });
  assert.equal(document.querySelector('#startup-slow').hidden, false);
  assert.equal(document.querySelector('#startup-elapsed').textContent, '0:13');
  assert.equal(document.querySelector('#startup-progress').hasAttribute('value'), false, 'unknown stages do not invent percentages');
  loading.fail(new Error('Reconnect to Langy.'));
  assert.equal(document.querySelector('#startup-loading').hidden, false);
  assert.equal(document.querySelector('#startup-error').textContent, 'Reconnect to Langy.');
  document.querySelector('#startup-retry').click(); assert.equal(retries, 1);
  loading.finish(); loading.report({ label: 'A background refresh' }); loading.fail(new Error('Background error'));
  assert.equal(document.querySelector('#startup-loading').hidden, true);
  assert.equal(document.body.dataset.startup, 'ready');
});

test('process progress describes real units and preserves unknown OCR progress', () => {
  const narrated = processProgress({ kind: 'narration', phase: 'aligning', progress: 12.5,
    counter: { complete: 1, total: 10, unit: 'sections' }, activity: { complete: 2, total: 8, unit: 'passages' } });
  assert.match(narrated.text, /1 \/ 10 sections completed/u);
  assert.match(narrated.text, /2 \/ 8 passages completed/u);
  assert.equal(narrated.phase, 'Synchronizing spoken words');
  assert.equal(narrated.percent, 12.5);
  const ocr = processProgress({ kind: 'ocr', phase: 'running', progress: null });
  assert.equal(ocr.percent, null); assert.equal(ocr.phase, 'Scanning PDF pages');
  assert.equal(ocr.unknown, 'This step does not report a percentage yet.');
  assert.equal(processElapsed({ startedAt: 1000 }, 62000), 'Elapsed · 1:01');
  assert.equal(processElapsed({}, 62000), '');
});
