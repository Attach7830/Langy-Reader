import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { trackText } from '../src/text-tracking.js';
import { searchBook } from '../shared/book-search.js';

test('whole-book search can locate text ranges in an EPUB chapter before it has a browser frame', (t) => {
  const dom = new JSDOM(''); t.after(() => dom.window.close());
  const chapter = new dom.window.DOMParser().parseFromString('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second chapter</title></head><body><h1>Segunda parte</h1><p>En el puerto, el <em>faro</em> violeta ilumina la costa.</p></body></html>', 'application/xhtml+xml');
  assert.equal(chapter.defaultView, null);
  const track = trackText(chapter.querySelector('body'), 'es');
  const [hit] = searchBook([{ key: 'epub:1', text: track.text }], 'faro violeta');
  assert.ok(hit); assert.equal(hit.key, 'epub:1');
  const word = track.words.find((item) => item.to > hit.from), range = track.rangeFor(word);
  assert.equal(range.toString(), 'faro');
  assert.equal(range.startContainer.ownerDocument, chapter);
  assert.equal(track.text.slice(hit.from, hit.to), 'faro violeta');
});
