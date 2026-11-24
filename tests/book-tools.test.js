import test from 'node:test';
import assert from 'node:assert/strict';
import { searchBook } from '../shared/book-search.js';
import { bookTools } from '../server/book-tools.js';

test('whole-book search preserves exact original spans across accent/case folding, Mandarin and supplementary characters', () => {
  const sections = [{ key: 'epub:0', title: 'Opening', text: '𠮷 ÁRBOL árvore 中文 árbol' }];
  const hits = searchBook(sections, 'arbol'); assert.equal(hits.length, 2);
  for (const hit of hits) assert.equal(sections[0].text.slice(hit.from, hit.to), hit.match);
  assert.equal(searchBook(sections, 'arvore')[0].match, 'árvore'); assert.equal(searchBook(sections, '中文')[0].match, '中文');
  assert.equal(searchBook(sections, '𠮷')[0].to, 2); assert.equal(searchBook(sections, 'arbol', 1).length, 1);
});
test('character guides and page/book questions never receive later pages, even from the same source section', async () => {
  const reached = 'Ana llega y conoce a Luis.', future = ' SECRETO: Luis muere.', sections = [{ key: 'epub:0', title: 'Earlier', text: 'Ana vive en Madrid.' },
    { key: 'epub:1', title: 'Now', text: reached + future }, { key: 'epub:2', title: 'Later', text: 'FUTURO inaccesible.' }], calls = [];
  const tools = bookTools({ learning: { textSections: () => sections }, ai: { characterGuide(source) { calls.push(source); return 'Guide'; }, bookQuestion(source) { calls.push(source); return 'Answer'; } } });
  const body = { key: 'epub:1', from: 0, through: reached.length, language: 'es', query: 'Luis', question: '¿Quién es Luis?' };
  assert.equal((await tools.guide({}, body)).text, 'Guide'); assert.equal((await tools.question({}, { ...body, scope: 'book' })).text, 'Answer');
  assert.equal((await tools.question({}, { ...body, scope: 'page' })).text, 'Answer');
  for (const call of calls) { assert.equal(/SECRETO|FUTURO/u.test(JSON.stringify(call)), false); }
  assert.deepEqual(calls[2].earlier, []); assert.equal(calls[2].page, reached);
  await assert.rejects(tools.guide({}, { ...body, through: 100000 }), { status: 422 });
});
