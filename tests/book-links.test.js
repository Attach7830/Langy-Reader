import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';
import { locationHistory } from '../src/location-history.js';
import { epubLinkTarget, bindBookLinks, pdfLinkLayer } from '../src/book-links.js';

test('EPUB footnotes resolve against their source section and returning restores the previous CFI', async (t) => {
  const dom = new JSDOM('<a href="notes.xhtml#n%C3%B1"><span>Note</span></a><a href="https://external.example/">External</a>', { url: 'https://langy.test' }); t.after(() => dom.window.close());
  const doc = dom.window.document, spine = [{ index: 0, href: 'text.xhtml', url: '/book/text.xhtml' }, { index: 1, href: 'notes.xhtml', url: '/book/notes.xhtml' }];
  assert.deepEqual(epubLinkTarget('#local', spine[0], spine), { index: 0, fragment: 'local' });
  assert.deepEqual(epubLinkTarget('notes.xhtml#n%C3%B1', spine[0], spine), { index: 1, fragment: 'nñ' });
  assert.equal(epubLinkTarget('javascript:alert(1)', spine[0], spine), null);
  const origin = 'epubcfi(/6/2!/4/2/1:50)', note = 'epubcfi(/6/4!/4/2/1:0)';
  let position = { target: origin, label: 'Section 1 · Page 7' }, state, oldHandler = 0;
  const history = locationHistory({ location: () => position, changed(value) { state = value; }, async go(target) { position = { target: typeof target === 'string' ? target : note, label: 'Note page' }; return true; } });
  doc.querySelector('a').onclick = () => oldHandler++;
  const unbind = bindBookLinks(doc, { section: spine[0], spine, follow: history.follow }); t.after(unbind);
  doc.querySelector('span').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await delay(0);
  assert.equal(position.target, note); assert.equal(oldHandler, 0, 'the EPUB library cannot make a second uncontrolled jump');
  assert.equal(state.count, 1); assert.equal(state.previous.target, origin);
  assert.equal(await history.back(), true); assert.equal(position.target, origin); assert.equal(state.count, 0);
});

test('nested link history survives ordinary page turns, keeps failed returns retryable and resets between books', async () => {
  let position = { target: 2, label: 'Page 2', scrollTop: 100 }, state, fail = false, restored;
  const history = locationHistory({ location: () => position, changed(value) { state = value; }, async go(target, saved) {
    if (fail) return false; restored = saved; position = { target, label: `Page ${target}`, scrollTop: 0 }; return true;
  } });
  await history.follow(8); await history.follow(20); position = { target: 21, label: 'Page 21' };
  assert.equal(await history.back(), true); assert.equal(position.target, 8); assert.equal(state.previous.target, 2);
  fail = true; assert.equal(await history.back(), false); assert.equal(state.count, 1);
  fail = false; await history.back(); assert.equal(position.target, 2); assert.equal(restored.scrollTop, 100);
  await history.follow(2); assert.equal(state.count, 0, 'a same-page link does not add an empty return step');
  await history.follow(8); history.reset(); assert.equal(state.previous, null); assert.equal(await history.back(), false);
});

test('navigation history never queues repeated jumps and ignores an outstanding jump after a book is closed', async () => {
  let release, position = { target: 'original' }, state;
  const held = new Promise((done) => { release = done; });
  const history = locationHistory({ location: () => position, changed(value) { state = value; }, async go(target) { await held; position = { target }; return true; } });
  const following = history.follow('note'); assert.equal(state.busy, true);
  assert.equal(await history.follow('another-note'), false); assert.equal(await history.back(), false);
  history.reset(); release(); assert.equal(await following, false); assert.equal(state.count, 0); assert.equal(state.busy, false);
});

test('PDF internal annotations follow destinations and external links open separately without executing unsafe actions', (t) => {
  const dom = new JSDOM('<main></main>', { url: 'https://langy.test' });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document'); Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  t.after(() => { dom.window.close(); if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; });
  const followed = [], destination = [{ num: 10, gen: 0 }, { name: 'Fit' }];
  const layer = pdfLinkLayer([
    { annotationType: 2, rect: [10, 20, 40, 30], dest: destination },
    { subtype: 'Link', rect: [10, 20, 40, 30], url: 'https://publisher.example/book' },
    { subtype: 'Link', rect: [10, 20, 40, 30], url: 'javascript:alert(1)' },
  ], { convertToViewportRectangle: (rect) => rect.map((value) => value * 2) }, (target) => followed.push(target));
  document.querySelector('main').append(layer);
  assert.equal(layer.children.length, 2); assert.equal(layer.firstChild.style.width, '60px');
  const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }); layer.firstChild.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true); assert.deepEqual(followed, [destination]); assert.equal(layer.lastChild.target, '_blank'); assert.equal(layer.lastChild.rel, 'noopener noreferrer');
});
