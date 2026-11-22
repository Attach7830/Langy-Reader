import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { bookVocabulary } from '../src/ui-book-vocabulary.js';

async function until(check) { for (let n = 0; n < 150; n++) { if (check()) return; await delay(10); } throw new Error('Book vocabulary UI timed out'); }
async function fixture(t) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test' });
  const names = ['window', 'document', 'Option', 'Node', 'Element', 'HTMLElement'];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  t.after(async () => {
    document.querySelector('#book-vocabulary-dialog').close(); await delay(10); dom.window.close();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  return { change(selector, value) { const input = document.querySelector(selector); input.value = value; input.dispatchEvent(new dom.window.Event('change')); } };
}
const item = (term, language = 'es') => ({ term, language, unit: language === 'zh' ? 'characters' : 'lemmas', exposures: 0, occurrences: 4, example: { text: 'Text <script>from the book</script>', word: term } });
const page = (entries, extras = {}) => ({ entries, threshold: 3, byLanguage: [{ language: 'es', unit: 'lemmas', total: 5, count: 5 }], offset: 0, pageSize: 3, total: entries.length, more: false, revision: 'one', ...extras });

test('book vocabulary renders safe text, fills meanings progressively with two workers, switches languages and reuses page meanings', async (t) => {
  const f = await fixture(t), entries = ['<img src=x>', 'libro', 'leer', 'tener', 'ir'].map((term) => item(term));
  let release; const held = new Promise((resolve) => { release = resolve; });
  const calls = [], queries = [];
  const view = bookVocabulary({ async request(path, options) {
    if (options?.method === 'POST') {
      calls.push(options.body); if (calls.length <= 2) await held;
      return { text: options.body.mode === 'translation' ? 'English <b>meaning</b>' : 'Definición sencilla.', source: 'AI meaning', language: options.body.mode === 'translation' ? 'en' : 'es' };
    }
    const query = new URL(path, 'https://langy.test').searchParams; queries.push(Object.fromEntries(query));
    const offset = Number(query.get('offset'));
    return page(entries.slice(offset, offset + 3), { offset, total: entries.length, more: offset + 3 < entries.length });
  } });
  view.open({ id: 'book', title: '<Book>' });
  await until(() => calls.length === 2); await delay(20);
  assert.equal(calls.length, 2, 'requests are bounded while the first requests wait');
  assert.equal(document.querySelector('#book-vocabulary-entries img'), null);
  assert.equal(document.querySelector('#book-vocabulary-entries strong').textContent, '<img src=x>');
  release(); await until(() => document.querySelectorAll('.vocabulary-meaning').length === 3);
  assert.equal(document.querySelector('.vocabulary-meaning').lang, 'en');
  assert.equal(document.querySelector('#book-vocabulary-entries b'), null);
  assert.equal(document.querySelector('#book-vocabulary-entries script'), null);
  f.change('#book-vocabulary-meaning', 'definition');
  await until(() => calls.length === 6 && document.querySelectorAll('.vocabulary-meaning').length === 3);
  assert.ok(calls.slice(3).every((body) => body.mode === 'definition'));
  assert.equal(document.querySelector('.vocabulary-meaning').lang, 'es');
  document.querySelector('#book-vocabulary-next').click();
  await until(() => calls.length === 8 && document.querySelectorAll('.vocabulary-meaning').length === 2);
  assert.equal(queries.at(-1).offset, '3');
  document.querySelector('#book-vocabulary-previous').click();
  await until(() => document.querySelectorAll('.vocabulary-meaning').length === 3);
  assert.equal(calls.length, 8, 'returning to a page does not generate its meanings again');
  f.change('#book-vocabulary-language', 'es');
  await until(() => queries.at(-1).language === 'es');
  assert.equal(queries.at(-1).offset, '0');
});

test('failed meanings can be retried and old book responses cannot replace the newly selected book', async (t) => {
  await fixture(t);
  let release, fail = true, calls = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const view = bookVocabulary({ async request(path, options) {
    if (path.includes('/old/')) { await held; return page([item('obsolete')]); }
    if (options?.method === 'POST') {
      calls++; if (fail) throw new Error('AI is busy');
      return { text: 'book', source: 'AI translation', language: 'en' };
    }
    return page([item('libro')]);
  } });
  view.open({ id: 'old', title: 'Old' }); view.open({ id: 'new', title: 'New' });
  await until(() => document.querySelector('#book-vocabulary-entries button'));
  assert.match(document.querySelector('#book-vocabulary-entries').textContent, /AI is busy/);
  fail = false; document.querySelector('#book-vocabulary-entries button').click();
  await until(() => document.querySelector('.vocabulary-meaning'));
  release(); await delay(20);
  assert.equal(calls, 2); assert.equal(document.querySelector('#book-vocabulary-entries strong').textContent, 'libro');
  assert.match(document.querySelector('#book-vocabulary-title').textContent, /^New/);
});
