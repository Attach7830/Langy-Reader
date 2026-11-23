import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { narration } from '../src/narration.js';

async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await delay(10); } throw new Error('Narration UI timed out'); }

async function fixture(t) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), { url: 'https://langy.test' });
  const values = { window: dom.window, document: dom.window.document, Option: dom.window.Option, navigator: dom.window.navigator,
    requestAnimationFrame: () => 0, cancelAnimationFrame() {} };
  const originals = new Map(Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const previousFetch = globalThis.fetch, positions = [], navigations = [];
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: {
    setActionHandler() {}, setPositionState(value) { if (value) positions.push(value); },
  } });
  const audio = document.querySelector('#narration-audio'), root = document.querySelector('#viewer');
  Object.defineProperty(audio, 'duration', { configurable: true, get: () => 3600 });
  audio.pause = () => {}; audio.load = () => { audio.currentTime = 0; }; audio.play = async () => {};
  const recording = { id: 'recording', state: 'ready', url: '/book.mp3', duration: 3600,
    markers: [{ time: 0, title: 'First chapter' }, { time: 1800, title: 'Second chapter' }],
    segments: [{ key: 'epub:0', start: 0, end: 1800, scale: 1 }, { key: 'epub:1', start: 1800, end: 3600, scale: 1 }] };
  let key = 'epub:0';
  const local = { root, annotate() {}, match: () => new Map(), rangeFor: () => null, visible: () => true };
  const view = { audioUnit: () => ({ key, root, track: () => local }), audioTarget: (target) => ({ key: target }) };
  globalThis.fetch = async (path) => {
    if (path === '/api/books/book/narration') return Response.json({ audio: recording, connected: true, recordings: [] });
    const match = path.match(/\/chapters\/([^?]+)/u);
    assert.ok(match, 'Unexpected request: ' + path);
    return Response.json({ key: decodeURIComponent(match[1]), tokens: [], audio: { timings: [] } });
  };
  const prefs = { audioEnabled: true, audioRate: 1, audioHighlight: false, audioToolbarHidden: false, podcastMode: true };
  let player;
  t.after(() => {
    player?.stop(); globalThis.fetch = previousFetch; dom.window.close();
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  player = narration({ preferences: () => prefs, renderer: () => view, book: () => ({ id: 'book', title: 'Test audiobook' }),
    async navigate(target) { navigations.push(target); key = target.key; return true; },
    changePreferences(values) { Object.assign(prefs, values); player.apply(); } });
  player.apply(); await player.refresh();
  const clock = document.querySelector('#narration-time'), seek = document.querySelector('#narration-seek'), rate = document.querySelector('#narration-rate');
  return { dom, player, audio, clock, seek, prefs, positions, navigations,
    speed(value) { rate.value = String(value); rate.dispatchEvent(new dom.window.Event('change')); },
    tick(time) { audio.currentTime = time; audio.dispatchEvent(new dom.window.Event('timeupdate')); } };
}

test('audio times update immediately with player or settings speed while media position and seeking stay in recording seconds', async (t) => {
  const f = await fixture(t);
  f.tick(900); assert.equal(f.clock.textContent, '15:00 / 1:00:00');
  f.speed(2);
  assert.equal(f.clock.textContent, '7:30 / 30:00'); assert.match(f.clock.title, /22:30 remaining at 2×/);
  assert.match(f.clock.title, /Recording position: 15:00 \/ 1:00:00/);
  assert.match(f.clock.getAttribute('aria-label'), /Listening time at 2×/);
  assert.equal(f.audio.currentTime, 900); assert.equal(f.seek.max, '3600'); assert.equal(f.seek.value, '900');
  assert.match(f.seek.getAttribute('aria-valuetext'), /7:30 of 30:00 at 2×/);
  const marker = () => document.querySelectorAll('.narration-marker')[1];
  assert.equal(marker().title, 'Second chapter · 15:00 at 2×'); assert.equal(marker().style.left, '50%');
  assert.deepEqual(f.positions.at(-1), { duration: 3600, position: 900, playbackRate: 2 });

  f.prefs.audioRate = .5; f.player.apply();
  assert.equal(f.clock.textContent, '30:00 / 2:00:00'); assert.match(f.clock.title, /1:30:00 remaining at 0.5×/);
  assert.equal(marker().title, 'Second chapter · 1:00:00 at 0.5×'); assert.equal(f.audio.currentTime, 900);
  f.prefs.audioRate = 1.6; f.player.apply();
  assert.equal(f.clock.textContent, '9:22 / 37:30'); assert.equal(document.querySelector('#narration-rate').value, '1.6');
  f.speed(1.5); assert.equal(f.clock.textContent, '10:00 / 40:00');
  assert.equal(f.navigations.length, 0, 'changing speed must not move to a different book page');
  f.seek.value = '1800'; f.seek.dispatchEvent(new f.dom.window.Event('input'));
  assert.equal(f.audio.currentTime, 1800); assert.equal(f.clock.textContent, '20:00 / 40:00');
  await until(() => f.navigations.some((target) => target.key === 'epub:1'));
  assert.equal(document.querySelector('#narration-chapter').value, '1');
});

test('speed-adjusted chapter markers and chapter buttons keep their original seek targets and reset cleanly', async (t) => {
  const f = await fixture(t); f.speed(2);
  document.querySelectorAll('.narration-marker')[1].click();
  assert.equal(f.audio.currentTime, 1800); assert.equal(f.clock.textContent, '15:00 / 30:00');
  await until(() => f.navigations.some((target) => target.key === 'epub:1'));
  document.querySelector('#narration-previous-chapter').click();
  assert.equal(f.audio.currentTime, 0); assert.equal(f.clock.textContent, '0:00 / 30:00');
  await until(() => f.navigations.some((target) => target.key === 'epub:0'));
  document.querySelector('#narration-next-chapter').click(); assert.equal(f.audio.currentTime, 1800);
  f.tick(3600); assert.equal(f.clock.textContent, '30:00 / 30:00'); assert.match(f.clock.title, /^0:00 remaining/);
  assert.equal(document.querySelector('#narration-forward').disabled, true);
  f.player.stop(); assert.equal(f.clock.textContent, '0:00 / 0:00'); assert.equal(f.seek.disabled, true);
});
