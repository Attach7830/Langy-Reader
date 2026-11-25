import test from 'node:test';
import assert from 'node:assert/strict';
import { readingUnits, countReadingUnits, mergeReadingRanges, bookCountSignature } from '../server/reading-counts.js';

test('OCR source revisions invalidate cached reading counts while legacy book signatures remain stable', () => {
  const book = { id: 'same-book', language: 'es', languages: ['es'] };
  assert.equal(bookCountSignature(book), bookCountSignature({ ...book, contentRevision: '' }));
  assert.notEqual(bookCountSignature(book), bookCountSignature({ ...book, contentRevision: 'ocr-1' }));
  assert.notEqual(bookCountSignature({ ...book, contentRevision: 'ocr-1' }), bookCountSignature({ ...book, contentRevision: 'ocr-2' }));
});

test('word totals include repeated forms, names and numbers while Mandarin Han positions stay separate', () => {
  const section = { text: 'María leyó libros libros 2026. 中文𠀀。', tokens: '[]', languages: '[]' };
  const units = readingUnits(section, 'es');
  assert.deepEqual(countReadingUnits(units), { words: 5, characters: 3 });
  for (const unit of units) assert.ok(section.text.slice(unit.from, unit.to).trim());
  const last = units.at(-1); assert.equal(section.text.slice(last.from, last.to), '𠀀'); assert.equal(last.to - last.from, 2);
  const ranges = mergeReadingRanges([{ from: 0, to: 8 }, { from: 5, to: 15 }, { from: 0, to: 5 }]);
  assert.deepEqual(ranges, [{ from: 0, to: 15 }]);
  assert.deepEqual(countReadingUnits(units, ranges), { words: 2, characters: 0 }, 'partially displayed words are excluded');
});

test('surface word totals do not expand clitics or contractions and honor Japanese language spans', () => {
  const text = 'aproximársele al del adulto adulta';
  assert.deepEqual(countReadingUnits(readingUnits({ text }, 'es')), { words: 5, characters: 0 });
  const japanese = { text: '日本語を読む。', languages: [{ from: 0, to: 7, language: 'ja' }] };
  const counts = countReadingUnits(readingUnits(japanese, 'ja'));
  assert.ok(counts.words > 0); assert.equal(counts.characters, 0);
});
