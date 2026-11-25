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

function doubleTap(f, x, root = f.target) { f.gesture(x, x, { root }); click(root, x); f.tick(80); f.gesture(x, x, { root }); return click(root, x); }

test('single word taps never turn pages; outer double taps turn exactly once', (t) => {
  const f = fixture(t);
  f.gesture(495, 495); click(f.target, 495); assert.deepEqual(f.turns, []);
  f.tick(400); doubleTap(f, 495); assert.deepEqual(f.turns, [1]);
  f.tick(400); doubleTap(f, 105); assert.deepEqual(f.turns, [1, -1]);
  assert.equal(defaults.doubleTapToTurn, true); assert.equal(defaults.swipeToTurn, true);
});
test('center double-tap playback cancels blank-center fullscreen; word taps get immediate priority', (t) => {
  let fullscreens = 0, playback = 0, word = false; const timers = new Map(); let timer = 0;
  const f = fixture(t, { canCenterTap: () => true, centerTap: () => fullscreens++, centerDoubleTap: () => playback++, wordAt: () => word,
    setTimer(callback) { timers.set(++timer, callback); return timer; }, clearTimer(id) { timers.delete(id); } });
  doubleTap(f, 300); assert.equal(playback, 1); assert.equal(fullscreens, 0); assert.equal(timers.size, 0);
  f.tick(400); word = true; f.gesture(300, 300); click(f.target, 300); assert.equal(timers.size, 0);
  f.tick(400); word = false; f.gesture(300, 300); click(f.target, 300); assert.equal(timers.size, 1);
  [...timers.values()][0](); assert.equal(fullscreens, 1); assert.deepEqual(f.turns, []);
});
test('horizontal swipes tolerate an initial wobble and do not open word help or count as double taps', (t) => {
  const f = fixture(t); let taps = 0; f.target.addEventListener('pointerup', () => taps++); f.target.addEventListener('click', () => taps++);
  pointer('pointerdown', f.target, 420); pointer('pointermove', f.target, 417, 218);
  pointer('pointermove', f.target, 200, 210); pointer('pointerup', f.target, 200, 210); click(f.target, 200, 210);
  f.gesture(200, 450); click(f.target, 450);
  assert.deepEqual(f.turns, [1, -1]); assert.equal(taps, 0);
});
test('consecutive double taps prevent native multi-tap selection from swallowing playback actions', (t) => {
  let playback = 0; const f = fixture(t, { centerDoubleTap: () => playback++ });
  for (let pair = 0; pair < 3; pair++) {
    f.gesture(300, 300); f.tick(50);
    const down = pointer('pointerdown', f.target, 300);
    if (!down.defaultPrevented) { const range = f.dom.window.document.createRange(); range.selectNodeContents(f.target); f.dom.window.getSelection().addRange(range); }
    pointer('pointerup', f.target, 300); assert.equal(playback, pair + 1);
    assert.equal(f.dom.window.getSelection().isCollapsed, true);
  }
});
test('vertical swipes open audio and sections independently from page-turn settings', (t) => {
  let up = 0, down = 0;
  const f = fixture(t, { canSwipe: () => false, swipeUp: () => up++, swipeDown: () => down++ });
  f.gesture(300, 300, { startY: 400, endY: 260 }); click(f.target, 300, 260);
  f.gesture(300, 300, { startY: 260, endY: 420 }); click(f.target, 300, 420);
  assert.equal(up, 1); assert.equal(down, 1); assert.deepEqual(f.turns, []);
});
test('short drags, diagonal movement, mouse drags, links and long presses preserve their normal actions', (t) => {
  const f = fixture(t);
  f.gesture(300, 320); click(f.target, 320);
  f.gesture(300, 380, { endY: 270 }); click(f.target, 380, 270);
  f.gesture(200, 495, { type: 'mouse' }); click(f.target, 495);
  f.gesture(495, 495, { duration: 800 }); click(f.target, 495);
  for (const node of f.host.querySelectorAll('a,button,input,[contenteditable]')) doubleTap(f, 495, node);
  assert.deepEqual(f.turns, []);
});
test('pinch changes size once after both fingers lift and cannot become a page turn', (t) => {
  const pinches = [], f = fixture(t, { pinch: (event) => pinches.push(event) });
  pointer('pointerdown', f.target, 250);
  pointer('pointerdown', f.target, 350, 200, { pointerId: 2, isPrimary: false });
  pointer('pointermove', f.target, 200); pointer('pointermove', f.target, 400, 200, { pointerId: 2, isPrimary: false });
  pointer('pointerup', f.target, 200); assert.equal(pinches.some((event) => event.phase === 'end'), false);
  pointer('pointerup', f.target, 400, 200, { pointerId: 2, isPrimary: false }); click(f.target, 400);
  assert.equal(pinches[0].phase, 'start'); assert.equal(pinches.at(-1).phase, 'end'); assert.equal(pinches.at(-1).factor, 2); assert.deepEqual(f.turns, []);
});
test('zoomed PDF panning, selections, cancellations and dialogs cannot trigger reader gestures', (t) => {
  let pan = true; const f = fixture(t, { canPan: () => pan });
  f.gesture(400, 200); click(f.target, 200); assert.deepEqual(f.turns, []);
  pan = false; pointer('pointerdown', f.target, 400); pointer('pointercancel', f.target, 200); click(f.target, 200);
  f.viewport.scale = 2; f.viewport.dispatchEvent(new f.dom.window.Event('resize'));
  f.gesture(400, 200); click(f.target, 200); assert.deepEqual(f.turns, []);
  assert.equal(f.host.classList.contains('reader-native-zoom'), true);
  f.viewport.scale = 1; f.viewport.dispatchEvent(new f.dom.window.Event('resize'));
  const selection = f.dom.window.getSelection(), range = f.dom.window.document.createRange(); range.selectNodeContents(f.target); selection.addRange(range);
  f.gesture(400, 200); selection.removeAllRanges(); f.active(false); f.gesture(400, 200); assert.deepEqual(f.turns, []);
});
test('EPUB iframe coordinates account for scaled offscreen columns, and bindings reset with the book', (t) => {
  const f = fixture(t), frame = f.dom.window.document.createElement('iframe'); f.host.append(frame);
  const doc = frame.contentDocument; doc.body.innerHTML = '<p>Book page</p>';
  frame.getBoundingClientRect = () => rect; Object.defineProperty(frame, 'offsetWidth', { value: 800 }); Object.defineProperty(frame, 'offsetHeight', { value: 1200 });
  const remove = f.nav.bind(doc); assert.equal(f.nav.bind(doc), remove);
  doubleTap(f, 780, doc.body); assert.deepEqual(f.turns, [1]);
  frame.getBoundingClientRect = () => ({ ...rect, left: -900, right: 1100, width: 2000 });
  f.gesture(520, 440, { root: doc.body, startY: 100, endY: 100 }); click(doc.body, 440, 100);
  assert.deepEqual(f.turns, [1, 1]); f.nav.reset(); doubleTap(f, 520, doc.body); assert.equal(f.turns.length, 2);
});
test('a word tap opens a definition and a double tap seeks from that word instead of toggling center playback', async (t) => {
  let help, playback = 0, fullscreens = 0;
  const f = fixture(t, { canCenterTap: () => true, centerTap: () => fullscreens++, centerDoubleTap: () => playback++, wordAt: (event) => help.at(event), wordDoubleTap: (item) => { assert.equal(item.node, f.target.firstChild); assert.equal(item.index, 0); help.clear(); seeks++; } });
  const doc = f.dom.window.document, names = ['window','document','Node','AbortController','AbortSignal'];
  const saved = new Map(names.map((name) => [name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for (const name of names) Object.defineProperty(globalThis,name,{configurable:true,value:f.dom.window[name]});
  t.after(() => { for (const [name,value] of saved) if(value) Object.defineProperty(globalThis,name,value); else delete globalThis[name]; });
  doc.body.insertAdjacentHTML('beforeend','<div id="word-help" hidden><div data-word-mode></div><strong data-word></strong><div data-word-lemma></div><div data-word-answer></div></div>');
  doc.caretPositionFromPoint=()=>({offsetNode:f.target.firstChild,offset:1});
  f.dom.window.Range.prototype.getClientRects=()=>[{left:250,right:340,top:180,bottom:220,width:90,height:40}];
  let requests=0,seeks=0; help=wordHelp({preferences:()=>({...defaults,mode:'translation'}),async request(){requests++;return{text:'a greeting'};},seekWord(){seeks++;}});
  const unbind=help.bind(f.target,'en',()=>f.target.textContent);t.after(()=>{help.clear();unbind();});
  f.gesture(300,300);click(f.target,300);await delay(20);
  assert.equal(requests,1);assert.equal(seeks,0);assert.equal(fullscreens,0);assert.equal(doc.querySelector('#word-help').hidden,false);
  f.tick(80);f.gesture(300,300);click(f.target,300);await delay(20);assert.equal(playback,0);assert.equal(seeks,1);assert.equal(doc.querySelector('#word-help').hidden,true);
});

test('word double taps take priority at both edges, work with page double taps disabled, and require the same word', (t) => {
  const seeks = [], node = {}, other = {}; let playback = 0, current = node;
  const f = fixture(t, { canDoubleTap: () => false, centerDoubleTap: () => playback++,
    wordAt: () => ({ node: current, index: 4 }), wordDoubleTap: (word) => seeks.push(word) });
  for (const x of [105, 300, 495]) { f.tick(400); doubleTap(f, x); }
  assert.equal(seeks.length, 3); assert.equal(playback, 0); assert.deepEqual(f.turns, []);
  f.tick(400); f.gesture(300,300); f.tick(80); current = other; f.gesture(300,300);
  assert.equal(seeks.length, 3, 'adjacent word taps must not play from either word'); assert.equal(playback, 0);
});
