import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfPinyinLayout } from '../src/pinyin-layout.js';
const viewport = { left: 0, top: 0, right: 1200, bottom: 1000 };
const glyph = (pinyin, left, top = 100, width = 60, height = 65, fontSize = 200) => ({ pinyin, left, top, fontSize, rect: { width, height } });

test('PDF pronunciation uses one line size despite wildly different hidden-font metrics and stays within its cells', () => {
  const items = ['duān', 'wǔ', 'jié', 'de', 'chuán', 'shuō'].map((word, index) => glyph(word, 80 + index * 65, 100 + index % 2, 60, 65, [200, 7, 400, 20, 5, 300][index]));
  const labels = pdfPinyinLayout(items, viewport);
  assert.equal(labels.length, 6); assert.equal(new Set(labels.map((label) => label.size)).size, 1);
  for (const [index, label] of labels.entries()) {
    assert.ok(label.size >= 7 && label.size <= 24); assert.ok(label.top + label.size < items[index].top);
    if (index) assert.ok(labels[index - 1].left + labels[index - 1].width <= label.left);
  }
});
test('PDF overlay withholds microscopic, duplicate or oversized OCR boxes and never overlaps neighboring text lines', () => {
  const items = [glyph('zhōng', 50), glyph('guó', 120), glyph('de', 190, 100, 2), glyph('chuán', 260), glyph('tǒng', 260), glyph('jié', 340, 100, 500), glyph('tiān', 50, 170)];
  const labels = pdfPinyinLayout(items, viewport);
  assert.deepEqual(labels.map((label) => label.text), ['zhōng', 'guó']);
  assert.deepEqual(pdfPinyinLayout([glyph('zhōng', 10, 4)], viewport), []);
});
