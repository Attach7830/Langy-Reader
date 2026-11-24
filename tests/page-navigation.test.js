import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';
import { pageNavigation } from '../src/page-navigation.js';
import { wordHelp } from '../src/words.js';
import { defaults } from '../src/settings.js';

const rect = { left: 100, right: 500, top: 50, bottom: 650, width: 400, height: 600 };
function pointer(type, target, x, y = 200, options = {}) {
  const doc = target.nodeType === 9 ? target : target.ownerDocument;
  const event = new doc.defaultView.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...options });
  for (const [name, value] of Object.entries({ pointerId: 1, pointerType: 'touch', isPrimary: true, ...options })) {
    if (['pointerId', 'pointerType', 'isPrimary'].includes(name)) Object.defineProperty(event, name, { value });
  }
  target.dispatchEvent(event); return event;
}
const click = (target, x, y = 200, options = {}) => pointer('click', target, x, y, { detail: 1, ...options });
function fixture(t, options = {}) {
  const dom = new JSDOM('<main id="reading"><div id="viewer"><p id="words">hello reader</p><a href="#note">Note</a><button>Control</button><input><div contenteditable="true">Editable</div></div></main><aside id="summary">Summary</aside>', { url: 'https://langy.test' });
  const host = dom.window.document.querySelector('#reading'), target = host.querySelector('#words'), turns = [];
  host.getBoundingClientRect = () => rect;
  const viewport = new dom.window.EventTarget(); viewport.scale = 1;
  Object.defineProperty(dom.window, 'visualViewport', { configurable: true, value: viewport });
  let clock = 1000, active = true, allowSwipe = true;
  const nav = pageNavigation({ host, turn: (direction) => turns.push(direction), enabled: () => active, canSwipe: () => allowSwipe, now: () => clock, ...options });
  t.after(() => { nav.destroy(); dom.window.close(); });
  return { dom, host, target, turns, nav, viewport, tick(ms = 100) { clock += ms; },
    active(value) { active = value; }, allowSwipe(value) { allowSwipe = value; },
    gesture(from, to, { startY = 200, endY = 200, duration = 100, type = 'touch', root = target } = {}) {
      pointer('pointerdown', root, from, startY, { pointerType: type }); clock += duration;
      pointer('pointermove', root, to, endY, { pointerType: type });
      return pointer('pointerup', root, to, endY, { pointerType: type });
    },
  };
}

test('left/right edge clicks and touch taps turn exactly once while center taps remain available', (t) => {
  const f = fixture(t);
  click(f.target, 105); click(f.target, 495); click(f.target, 300);
  assert.deepEqual(f.turns, [-1, 1]);
  for (const type of ['mouse', 'touch']) {
    const up = f.gesture(495, 494, { type }); assert.equal(up.defaultPrevented, true);
    const compatibility = click(f.target, 494); assert.equal(compatibility.defaultPrevented, true);
  }
  assert.deepEqual(f.turns, [-1, 1, 1, 1]);
  f.gesture(300, 300); assert.equal(click(f.target, 300).defaultPrevented, false);
  assert.equal(f.turns.length, 4);
});

test('new readers get swipe and center-fullscreen by default, with edge taps controlled independently', (t) => {
  assert.equal(defaults.swipeToTurn, true); assert.equal(defaults.tapToTurn, false); assert.equal(defaults.tapCenterFullscreen, true);
  let edgeTaps = defaults.tapToTurn, fullscreens = 0;
  const f = fixture(t, { canTap: () => edgeTaps, canCenterTap: () => defaults.tapCenterFullscreen, centerTap: () => fullscreens++ });
  f.gesture(495, 495); click(f.target, 495); assert.deepEqual(f.turns, []);
  f.gesture(400, 200); click(f.target, 200); assert.deepEqual(f.turns, [1]); assert.equal(fullscreens, 0);
  const tap = f.gesture(300, 300); const duplicate = click(f.target, 300);
  assert.equal(tap.defaultPrevented, true); assert.equal(duplicate.defaultPrevented, true); assert.equal(fullscreens, 1);
  f.gesture(300, 300); click(f.target, 300); assert.equal(fullscreens, 2, 'a second real center tap exits fullscreen');
  f.gesture(300, 300, { duration: 800 }); click(f.target, 300);
  f.gesture(300, 300, { type: 'mouse' }); click(f.target, 300);
  f.gesture(300, 300, { root: f.host.querySelector('a') }); click(f.host.querySelector('a'), 300);
  assert.equal(fullscreens, 2, 'long presses, mouse selection and hyperlinks never toggle fullscreen');
  edgeTaps = true; f.gesture(495, 495); click(f.target, 495); assert.deepEqual(f.turns, [1, 1]);
  f.allowSwipe(false); f.gesture(400, 200); click(f.target, 200); assert.deepEqual(f.turns, [1, 1]);
});

test('center taps in EPUB frames use the visible reader coordinates and never also turn pages', (t) => {
  let fullscreens = 0;
  const f = fixture(t, { canTap: () => false, canCenterTap: () => true, centerTap: () => fullscreens++ });
  const frame = f.dom.window.document.createElement('iframe'); f.host.append(frame);
  frame.getBoundingClientRect = () => rect;
  Object.defineProperty(frame, 'offsetWidth', { value: 800 }); Object.defineProperty(frame, 'offsetHeight', { value: 1200 });
  const doc = frame.contentDocument; doc.body.textContent = 'EPUB body'; f.nav.bind(doc);
  f.gesture(400, 400, { root: doc.body, startY: 400, endY: 400 }); click(doc.body, 400, 400);
  assert.equal(fullscreens, 1); assert.deepEqual(f.turns, []);
  f.gesture(600, 200, { root: doc.body, startY: 400, endY: 400 }); click(doc.body, 200, 400);
  assert.equal(fullscreens, 1); assert.deepEqual(f.turns, [1]);
});

test('horizontal touch swipes turn in both directions and suppress the following click and word lookup', (t) => {
  const f = fixture(t); let taps = 0;
  f.target.addEventListener('pointerup', () => taps++); f.target.addEventListener('click', () => taps++);
  f.gesture(400, 200); click(f.target, 200);
  f.gesture(200, 490); click(f.target, 490);
  assert.deepEqual(f.turns, [1, -1]); assert.equal(taps, 0);
  // A new real tap is independent of the previous swipe's compatibility click.
  f.gesture(495, 495); click(f.target, 495); assert.deepEqual(f.turns, [1, -1, 1]);
});

test('short drags, vertical/diagonal scrolling, mouse drags and long presses never turn pages', (t) => {
  const f = fixture(t);
  f.gesture(300, 320); click(f.target, 320);
  f.gesture(300, 380, { endY: 350 }); click(f.target, 380, 350);
  f.gesture(300, 380, { endY: 260 }); click(f.target, 380, 260);
  f.gesture(200, 495, { type: 'mouse' }); click(f.target, 495);
  const longPress = f.gesture(495, 495, { duration: 800 }); click(f.target, 495);
  assert.equal(longPress.defaultPrevented, false, 'native long-press behavior stays available');
  pointer('pointerdown', f.target, 300); pointer('pointermove', f.target, 302, 225); pointer('pointermove', f.target, 420, 230); pointer('pointerup', f.target, 420, 230); click(f.target, 420, 230);
  assert.deepEqual(f.turns, []);
});

test('links, controls, modified clicks, text selections and dialogs keep their existing actions', (t) => {
  const f = fixture(t);
  for (const element of f.host.querySelectorAll('a,button,input,[contenteditable]')) { f.gesture(495, 495, { root: element }); click(element, 495); }
  click(f.target, 495, 200, { ctrlKey: true }); click(f.target, 495, 200, { button: 2 }); click(f.target, 495, 200, { detail: 0 });
  const selection = f.dom.window.getSelection(), range = f.dom.window.document.createRange();
  range.selectNodeContents(f.target); selection.addRange(range);
  f.gesture(400, 200); click(f.target, 495); selection.removeAllRanges();
  f.active(false); f.gesture(400, 200); click(f.target, 495);
  assert.deepEqual(f.turns, []);
  f.active(true); f.gesture(495, 495); assert.deepEqual(f.turns, [1]);
});

test('pinches and cancelled pointers cannot become page turns, and native zoom restores horizontal panning', (t) => {
  const f = fixture(t);
  pointer('pointerdown', f.target, 400);
  pointer('pointerdown', f.target, 300, 200, { pointerId: 2, isPrimary: false });
  pointer('pointermove', f.target, 150);
  pointer('pointerup', f.target, 150); pointer('pointerup', f.target, 300, 200, { pointerId: 2, isPrimary: false }); click(f.target, 150);
  pointer('pointerdown', f.target, 400); pointer('pointercancel', f.target, 300); pointer('pointerup', f.target, 200); click(f.target, 200);
  f.viewport.scale = 2; f.viewport.dispatchEvent(new f.dom.window.Event('resize'));
  assert.equal(f.host.classList.contains('reader-native-zoom'), true);
  f.gesture(400, 200); click(f.target, 200); assert.deepEqual(f.turns, []);
  f.viewport.scale = 1; f.viewport.dispatchEvent(new f.dom.window.Event('resize'));
  f.gesture(400, 200); assert.deepEqual(f.turns, [1]);
});

test('zoomed PDFs can pan without page turns and still accept explicit edge taps', (t) => {
  const f = fixture(t); f.allowSwipe(false);
  f.gesture(495, 200); click(f.target, 200); assert.deepEqual(f.turns, []);
  f.gesture(495, 495); click(f.target, 495); assert.deepEqual(f.turns, [1]);
  f.allowSwipe(true); f.gesture(400, 200); assert.deepEqual(f.turns, [1, 1]);
});

test('releasing a mouse drag outside the book does not block later touch gestures', (t) => {
  const f = fixture(t);
  pointer('pointerdown', f.target, 300, 200, { pointerType: 'mouse', pointerId: 1 });
  pointer('pointerup', f.dom.window.document.body, 600, 200, { pointerType: 'mouse', pointerId: 1 });
  pointer('pointerdown', f.target, 400, 200, { pointerId: 2 });
  pointer('pointermove', f.target, 200, 200, { pointerId: 2 });
  pointer('pointerup', f.target, 200, 200, { pointerId: 2 });
  assert.deepEqual(f.turns, [1]);
});

test('EPUB iframe coordinates account for offsets, scaling and offscreen columns; bindings reset with the book', (t) => {
  const f = fixture(t), frame = f.dom.window.document.createElement('iframe'); f.host.append(frame);
  const doc = frame.contentDocument; doc.body.innerHTML = '<p>Book page</p>';
  frame.getBoundingClientRect = () => ({ ...rect }); Object.defineProperty(frame, 'offsetWidth', { value: 800 }); Object.defineProperty(frame, 'offsetHeight', { value: 1200 });
  const remove = f.nav.bind(doc); assert.equal(f.nav.bind(doc), remove);
  click(doc.body, 780, 300); click(doc.body, 10, 300); assert.deepEqual(f.turns, [1, -1]);
  frame.getBoundingClientRect = () => ({ ...rect, left: -900, right: 1100, width: 2000 });
  // offsetWidth stays 800: the frame is also scaled by 2.5.
  f.gesture(520, 440, { root: doc.body, startY: 100, endY: 100 });
  assert.deepEqual(f.turns, [1, -1, 1]);
  f.nav.reset(); click(doc.body, 780, 300); assert.equal(f.turns.length, 3);
  click(f.target, 495); assert.equal(f.turns.length, 4, 'outer reading gutters stay bound');
  f.nav.destroy(); click(f.target, 495); assert.equal(f.turns.length, 4);
});

test('a stationary center word tap still opens help and seeks audio, while swiping does neither', async (t) => {
  const f = fixture(t), doc = f.dom.window.document;
  const names = ['window', 'document', 'Node', 'AbortController', 'AbortSignal'];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: f.dom.window[name] });
  t.after(() => { for (const [name, value] of originals) { if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; } });
  doc.body.insertAdjacentHTML('beforeend', '<div id="word-help" hidden><div data-word-mode></div><strong data-word></strong><div data-word-lemma></div><div data-word-answer></div></div>');
  doc.caretPositionFromPoint = () => ({ offsetNode: f.target.firstChild, offset: 1 });
  f.dom.window.Range.prototype.getClientRects = () => [{ left: 250, right: 340, top: 180, bottom: 220, width: 90, height: 40 }];
  let requests = 0, seeks = 0;
  const help = wordHelp({ preferences: () => ({ ...defaults, mode: 'translation' }), async request() { requests++; return { text: 'a greeting' }; }, seekWord() { seeks++; } });
  const unbind = help.bind(f.target, 'en', () => f.target.textContent); t.after(() => { help.clear(); unbind(); });
  f.gesture(300, 300); click(f.target, 300); await delay(30);
  assert.equal(requests, 1); assert.equal(seeks, 1); assert.equal(doc.querySelector('#word-help').hidden, false);
  help.clear(); f.gesture(400, 250); click(f.target, 250); await delay(30);
  assert.equal(requests, 1); assert.equal(seeks, 1); assert.deepEqual(f.turns, [1]);
});
