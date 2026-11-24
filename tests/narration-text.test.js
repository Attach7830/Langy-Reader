import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { readingBlocks, readingText, textWords } from '../shared/reading-text.js';
import { narrationChunks } from '../server/narration-text.js';

function section(html) {
  const doc = new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'application/xhtml+xml');
  const content = readingText(doc.getElementsByTagName('body')[0]);
  return { text: content.text, speechBlocks: readingBlocks(content) };
}

test('Mandarin chapter number, title and body are spoken separately with pauses and original offsets', () => {
  const s = section('<h1>1</h1><hr/><h2>有意思的案子</h2><p>今天，小明走进了图书馆。</p><p>他看见一本书。</p>');
  const original = s.text, chunks = narrationChunks(s, 'zh');
  assert.equal(chunks.length, 3); assert.equal(chunks[0].input, '第1章。');
  assert.equal(chunks[1].input, '有意思的案子。'); assert.equal(chunks[2].input, '今天，小明走进了图书馆。\n他看见一本书。');
  assert.ok(chunks[0].pauseAfter >= .7); assert.ok(chunks[1].pauseAfter >= .7);
  assert.equal(s.text, original);
  for (const word of textWords(s.text, 'zh')) assert.equal(chunks.filter((chunk) => word.from >= chunk.from && word.from < chunk.to).length, 1, word.word);
});

test('unstyled leading chapter counters are labelled, while years and body numbers retain their meaning', () => {
  const s = section('<p>一</p><p>有意思的案子</p><p>他有1本书，去年是2026年。</p>');
  const chunks = narrationChunks(s, 'zh'); assert.equal(chunks[0].input, '第一章。');
  assert.equal(chunks[1].kind, 'heading'); assert.ok(chunks[2].input.includes('1本书'));
  assert.equal(narrationChunks(section('<p>2026</p><p>That year was different.</p>'), 'en')[0].kind, 'body');
});

test('long Mandarin passages use bounded sentence-aware chunks without breaking compound words or astral characters', () => {
  const s = section(`<p>${'小明走进安静的图书馆，寻找古老的地图。'.repeat(80)}𠮷祥。</p>`);
  const chunks = narrationChunks(s, 'zh'); assert.ok(chunks.length > 8);
  for (const chunk of chunks) { assert.ok(chunk.text.length <= 180); assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk.text)); }
  for (const word of textWords(s.text, 'zh')) assert.equal(chunks.filter((chunk) => word.from >= chunk.from && word.to <= chunk.to).length, 1, word.word);
  assert.equal(chunks.map((chunk) => chunk.text).join(''), s.text);
});

test('mixed-language narration retains passage languages, headings and canonical positions', () => {
  const s = section('<h1>1</h1><h2>第一章</h2><p>Hello, friend.</p><p>你好，朋友。</p>');
  const english = s.text.indexOf('Hello'), chinese = s.text.indexOf('你好');
  s.languages = [{ from: 0, to: english, language: 'zh' }, { from: english, to: chinese, language: 'en' }, { from: chinese, to: s.text.length, language: 'zh' }];
  const chunks = narrationChunks(s, 'zh'); assert.deepEqual(chunks.map((chunk) => chunk.language), ['zh', 'zh', 'en', 'zh']);
  assert.equal(chunks[2].input, 'Hello, friend.'); assert.equal(chunks[3].input, '你好，朋友。');
});

test('old structure-free sections remain narratable without adding headings to body numbers', () => {
  const s = { text: 'Tengo 42 libros. Todos son interesantes.', speechBlocks: '[]', languages: '[]' };
  assert.equal(narrationChunks(s, 'es')[0].input, s.text);
});
