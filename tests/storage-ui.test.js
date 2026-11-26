import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { showStorage } from '../src/storage.js';

async function display(t) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'));
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  return { panel: document.querySelector('#library-storage'), meter: document.querySelector('#storage-meter'),
    summary: document.querySelector('#storage-summary'), detail: document.querySelector('#storage-detail') };
}

test('unlimited accounts show actual drive occupancy, including other files and reserved space', async (t) => {
  const ui = await display(t);
  showStorage({ available: true, scope: 'account', unlimited: true, usedBytes: 3, totalBytes: 67, availableBytes: 64,
    drive: { available: true, scope: 'drive', totalBytes: 1024, usedBytes: 900, reservedBytes: 60, availableBytes: 64 } });
  assert.equal(ui.panel.hidden, false); assert.equal(ui.meter.hidden, false);
  assert.equal(ui.meter.max, 1024); assert.equal(ui.meter.value, 960);
  assert.equal(ui.meter.getAttribute('aria-label'), 'Library drive space used or reserved');
  assert.equal(ui.summary.textContent, 'Library drive · 64 B available');
  assert.match(ui.detail.textContent, /1 KiB total · shared with other files on this drive · 3 B in your library/u);
  assert.equal(ui.panel.dataset.low, 'true');
});

test('account limits and demo allowances retain their own storage bars', async (t) => {
  const ui = await display(t);
  showStorage({ available: true, scope: 'account', unlimited: false, usedBytes: 120, totalBytes: 100, availableBytes: 0, overLimit: true,
    drive: { available: true, scope: 'drive', totalBytes: 1024, availableBytes: 500 } });
  assert.equal(ui.meter.hidden, false); assert.equal(ui.meter.max, 100); assert.equal(ui.meter.value, 100);
  assert.equal(ui.meter.getAttribute('aria-label'), 'Your saved library allowance used');
  assert.equal(ui.summary.textContent, 'Your library · 0 B available');
  assert.equal(ui.detail.textContent, '120 B saved of 100 B · storage limit reached');
  showStorage({ available: true, scope: 'demo', usedBytes: 20 * 1024 ** 2, totalBytes: 80 * 1024 ** 2, availableBytes: 60 * 1024 ** 2 });
  assert.equal(ui.meter.hidden, false); assert.equal(ui.meter.max, 80 * 1024 ** 2); assert.equal(ui.meter.value, 20 * 1024 ** 2);
  assert.equal(ui.meter.getAttribute('aria-label'), 'Demo storage allowance used');
  assert.equal(ui.summary.textContent, 'Demo allowance · 60 MiB available');
  assert.match(ui.detail.textContent, /up to 4 books, 20 MiB each/u); assert.equal(ui.panel.dataset.low, 'false');
});

test('unavailable drive stats never fabricate capacity and a later refresh restores the meter', async (t) => {
  const ui = await display(t);
  showStorage({ available: true, scope: 'account', unlimited: true, usedBytes: 3, totalBytes: 3, availableBytes: null, drive: { available: false, scope: 'drive' } });
  assert.equal(ui.meter.hidden, true); assert.equal(ui.summary.textContent, 'Your library · 3 B saved');
  assert.equal(ui.detail.textContent, 'No account limit · drive capacity unavailable');
  showStorage({ available: true, scope: 'drive', totalBytes: 1024, availableBytes: 800 });
  assert.equal(ui.meter.hidden, false); assert.equal(ui.meter.max, 1024); assert.equal(ui.meter.value, 224);
  assert.equal(ui.panel.dataset.low, 'false');
  showStorage(null);
  assert.equal(ui.meter.hidden, true); assert.equal(ui.summary.textContent, 'Storage availability unavailable');
});
