import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderSummaryDetail } from '../src/summary-detail.js';

test('page explanations render as separate headed sections, safely handle quotes and support cached responses', () => {
  const dom = new JSDOM('<div id="detail"></div>'), original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  try {
    const target = document.querySelector('#detail');
    const answer = { text: 'Fallback answer', sections: [
      { heading: 'Esta página', text: 'La niña ve que su hermano esconde la carta.' },
      { heading: 'Qué significa', text: 'Sus acciones hacen dudar de sus palabras. <img src=x onerror="alert(1)">' },
      { heading: 'Contexto útil', text: 'La conversación anterior explica por qué ella sospecha.' },
    ] };
    renderSummaryDetail(target, 'complete', answer);
    assert.equal(target.querySelectorAll('section').length, 3);
    assert.deepEqual([...target.querySelectorAll('h4')].map((node) => node.textContent), ['Esta página', 'Qué significa', 'Contexto útil']);
    assert.equal(target.querySelectorAll('p').length, 3); assert.equal(target.querySelector('img'), null);
    assert.ok(target.textContent.includes('<img src=x')); assert.equal(target.dataset.state, 'complete');
    renderSummaryDetail(target, 'loading', 'Generating an explanation…');
    assert.equal(target.querySelector('section'), null); assert.equal(target.textContent, 'Generating an explanation…');
    renderSummaryDetail(target, 'complete', answer); assert.equal(target.querySelectorAll('section').length, 3);
    renderSummaryDetail(target, 'error', 'Try again.'); assert.equal(target.dataset.state, 'error'); assert.equal(target.textContent, 'Try again.');
    renderSummaryDetail(target, 'complete', { text: 'An answer to the selected question.' });
    assert.equal(target.textContent, 'An answer to the selected question.');
  } finally {
    dom.window.close(); if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document;
  }
});
