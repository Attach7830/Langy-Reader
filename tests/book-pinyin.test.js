import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openBookPinyin } from '../server/book-pinyin.js';

test('book pronunciation survives reopening and changes with text and pronunciation revision', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-pinyin-cache-')); let calls = 0, store;
  const mandarin = { revision: 'v1', annotation({ text }) { calls++; return { characters: [{ character: text[0], from: 0, to: 1, pinyin: 'yǒu' }] }; } };
  t.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });
  const book = { id: 'one' }, body = { text: '有意思' };
  store = openBookPinyin(dir, mandarin); const first = store.annotation(book, body); first.characters[0].pinyin = 'mutation';
  store.close(); store = openBookPinyin(dir, mandarin);
  assert.equal(store.annotation(book, body).characters[0].pinyin, 'yǒu'); assert.equal(calls, 1);
  store.annotation({ id: 'two' }, body); assert.equal(calls, 2, 'separate books own their pronunciation data');
  store.annotation(book, { text: '有意义' }); assert.equal(calls, 3);
  store.forget(book.id); store.annotation(book, body); assert.equal(calls, 4);
  store.close(); mandarin.revision = 'v2'; store = openBookPinyin(dir, mandarin); store.annotation(book, body); assert.equal(calls, 5);
  assert.throws(() => store.annotation(book, { text: '字'.repeat(30001) }), /30,000/u);
  assert.throws(() => store.annotation(book, {}), /Pinyin/u);
});
