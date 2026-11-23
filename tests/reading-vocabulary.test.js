import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { bookLanguagePicker } from '../src/book-languages.js';
import { readingVocabulary } from '../src/reading-vocabulary.js';
import { trackText } from '../src/text-tracking.js';
import { vocabularyLibrary, recommendationRows } from '../src/ui-vocabulary.js';

function globals(t, dom) {
  const names = ['window', 'document', 'localStorage', 'NodeFilter', 'Option'];
  const original = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
  t.after(() => { dom.window.close(); for (const [name, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
}
async function until(check) { for (let n = 0; n < 150; n++) { if (check()) return; await delay(10); } throw new Error('Reader exposure timed out'); }

test('the book language picker adds named languages, persists variants, removes selections and restores automatic mode', async (t) => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://langy.test' }); globals(t, dom);
  const form = document.querySelector('#book-form'), picker = bookLanguagePicker(form);
  picker.set(); assert.deepEqual(picker.value(), []);
  const limit = form.querySelector('#book-language-limit'), input = form.querySelector('#book-language-choice');
  limit.checked = true; limit.dispatchEvent(new dom.window.Event('change'));
  assert.equal(form.querySelector('#book-language-selection').hidden, false);
  input.value = 'Mandarin'; form.querySelector('#book-language-add').click();
  input.value = 'English'; input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  assert.deepEqual(picker.value(), ['zh', 'en']);
  input.value = 'Chinese'; form.querySelector('#book-language-add').click(); assert.deepEqual(picker.value(), ['zh', 'en']);
  form.querySelector('[aria-label="Remove English"]').click(); assert.deepEqual(picker.value(), ['zh']);
  picker.set(['zh-Hant', 'en']); assert.deepEqual(picker.value(), ['zh-Hant', 'en']);
  limit.checked = false; limit.dispatchEvent(new dom.window.Event('change')); assert.deepEqual(picker.value(), []);
  picker.set([]); limit.checked = true; assert.throws(() => picker.value(), /at least one/u);
});

test('reading records only visible source ranges with audio disabled, queues failed saves, and ignores a late page response', async (t) => {
  const dom = new JSDOM('<div id="viewer"><p>Hablo hablaron libros 中文书</p></div>', { url: 'https://langy.test', pretendToBeVisual: true }); globals(t, dom);
  const root = document.querySelector('#viewer'), text = root.textContent;
  root.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 100 });
  dom.window.Range.prototype.getClientRects = function () { return [{ left: 5, top: this.startOffset === 0 ? 20 : 1000, width: 30, height: 20 }]; };
  let active = { id: 'book', language: 'es', languages: ['es', 'zh'] }, online = false, posts = [], delayed;
  const renderer = { audioUnit: () => ({ key: 'epub:0', track: () => trackText(root, 'es') }) };
  const vocabulary = readingVocabulary({ book: () => active, renderer: () => renderer, dwell: 20, async request(path, options) {
    if (options?.method === 'POST') { if (!online) throw new Error('offline'); posts.push(options.body); return { saved: true }; }
    if (delayed) await delayed;
    return { text, textHash: 'source-digest', analysisState: 'ready' };
  } });
  t.after(() => vocabulary.destroy());
  vocabulary.refresh(); await until(() => JSON.parse(localStorage.getItem('langy-reading-exposures-v1') || '[]').length === 1);
  assert.equal(posts.length, 0);
  online = true; await vocabulary.flush();
  assert.deepEqual(posts[0].ranges, [{ from: 0, to: 5 }]);
  assert.equal(posts[0].digest, 'source-digest');
  assert.deepEqual(JSON.parse(localStorage.getItem('langy-reading-exposures-v1')), []);
  vocabulary.refresh(); await delay(60); assert.equal(posts.length, 1, 'redisplaying a page does not send repeated exposure requests');
  const session = posts[0].session;
  vocabulary.stop(); vocabulary.refresh(); await until(() => posts.length === 2);
  assert.notEqual(posts[1].session, session, 'reopening the same book starts a new reading session');
  let release; delayed = new Promise((resolve) => { release = resolve; });
  active = { ...active, id: 'other-book' }; vocabulary.refresh(); await delay(30); vocabulary.stop(); active = undefined; release();
  await delay(30); assert.equal(posts.length, 2, 'leaving the book cancels a late capture');
});

test('returning to the library can await an existing reading save before refreshing totals', async (t) => {
  const dom = new JSDOM('<div></div>', { url: 'https://langy.test' }); globals(t, dom);
  localStorage.setItem('langy-reading-exposures-v1', JSON.stringify([{ id: 'book', body: { key: 'epub:0', digest: 'text', ranges: [{ from: 0, to: 4 }], session: 'one' } }]));
  let release, calls = 0, finished = false;
  const held = new Promise((resolve) => { release = resolve; });
  const vocabulary = readingVocabulary({ book: () => null, renderer: () => null, async request() { calls++; await held; return { saved: true }; } });
  t.after(() => vocabulary.destroy());
  await until(() => calls === 1);
  const saving = vocabulary.flush(); saving.then(() => { finished = true; });
  assert.equal(saving, vocabulary.flush()); await delay(10); assert.equal(finished, false);
  release(); await saving;
  assert.deepEqual(JSON.parse(localStorage.getItem('langy-reading-exposures-v1')), []); assert.equal(calls, 1);
});

test('the vocabulary view keeps language totals separate, filters and paginates entries, and renders book text safely', async (t) => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://langy.test' }); globals(t, dom);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  const previous = globalThis.fetch, queries = [];
  let threshold = 20, saves = 0;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (path, options) => {
    if (path === '/api/vocabulary/settings') {
      assert.equal(options.method, 'PUT'); threshold = JSON.parse(options.body).threshold; saves++;
      return Response.json({ threshold });
    }
    const query = new URL(path, 'https://langy.test').searchParams; queries.push(Object.fromEntries(query));
    return Response.json({ threshold, likelyKnown: [{ language: 'es', unit: 'lemmas', count: threshold <= 3 ? 1 : 0 }],
      entries: [{ term: '<img src=x>', language: 'es', unit: 'lemmas', exposures: 3, likelyKnown: threshold <= 3, lastSeen: 1000 }], total: 101, offset: Number(query.get('offset')), more: query.get('offset') === '0' });
  };
  const ui = vocabularyLibrary();
  ui.update({ byLanguage: [{ language: 'es', unit: 'lemmas', count: 2 }, { language: 'zh', unit: 'characters', count: 3 }] });
  const summary = document.querySelector('#vocabulary-summary').textContent;
  assert.ok(summary.includes('2 Spanish lemmas') && summary.includes('3 Mandarin characters'));
  document.querySelector('#open-vocabulary').click(); await until(() => document.querySelectorAll('#vocabulary-entries tr').length === 1);
  assert.equal(document.querySelector('#vocabulary-entries img'), null);
  assert.equal(document.querySelector('#vocabulary-entries td').textContent, '<img src=x>');
  document.querySelector('#vocabulary-next').click(); await until(() => queries.length === 2);
  assert.equal(queries[1].offset, '100');
  const language = document.querySelector('#vocabulary-language'); language.value = 'es'; language.dispatchEvent(new dom.window.Event('change'));
  await until(() => queries.length === 3); assert.equal(queries[2].language, 'es'); assert.equal(queries[2].offset, '0');
  const input = document.querySelector('#vocabulary-threshold'); input.value = '3'; input.dispatchEvent(new dom.window.Event('input'));
  document.querySelector('#vocabulary-threshold-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.querySelector('#vocabulary-entries').textContent.includes('Likely known'));
  assert.equal(saves, 1); assert.ok(document.querySelector('#vocabulary-known-detail').textContent.includes('1 Spanish lemmas'));
  let closed = false;
  const [row] = recommendationRows([{ id: 'book-id', title: 'A <book>', byLanguage: [{ language: 'es', unit: 'lemmas', shared: 20 }], familiarity: { byLanguage: [{ language: 'es', unit: 'lemmas', unfamiliar: 5 }] } }], () => { closed = true; });
  assert.ok(row.textContent.includes('20 shared Spanish lemmas') && row.textContent.includes('5 Spanish lemmas'));
  row.querySelector('a').click(); assert.equal(closed, true);
});
