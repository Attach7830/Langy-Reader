import { modes, languageName } from './settings.js';

function caretAt(doc, x, y) {
  if (doc.caretPositionFromPoint) {
    const caret = doc.caretPositionFromPoint(x, y);
    return caret && { node: caret.offsetNode, offset: caret.offset };
  }
  const caret = doc.caretRangeFromPoint?.(x, y);
  return caret && { node: caret.startContainer, offset: caret.startOffset };
}

function wordAt(root, event, segmenter) {
  const { clientX: x, clientY: y } = event;
  const doc = root.ownerDocument;
  if (!root.contains(event.target) || event.target.closest?.('a, button, input, textarea, select')) return null;
  const caret = caretAt(doc, x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !root.contains(caret.node)) return null;
  const { node, offset } = caret;
  const segments = segmenter?.segment(node.data);
  const candidates = segments
    ? [...new Set([segments.containing(offset), segments.containing(offset - 1)])].filter((item) => item?.isWordLike)
    : Array.from(node.data.matchAll(/[\p{L}\p{M}\p{N}]+/gu), (match) => ({ index: match.index, segment: match[0] }))
      .filter((item) => item.index <= offset && offset <= item.index + item.segment.length);

  const range = doc.createRange();
  for (const { index, segment } of candidates) {
    if (!/\p{L}/u.test(segment)) continue;
    range.setStart(node, index);
    range.setEnd(node, index + segment.length);
    const rect = [...range.getClientRects()].find((box) => x >= box.left - 1 && x <= box.right + 1 && y >= box.top && y <= box.bottom);
    if (!rect) continue;
    const frame = doc.defaultView.frameElement?.getBoundingClientRect();
    return {
      node, index, word: segment,
      rect: { left: rect.left + (frame?.left || 0), right: rect.right + (frame?.left || 0),
        top: rect.top + (frame?.top || 0), bottom: rect.bottom + (frame?.top || 0) },
    };
  }
  return null;
}

export function wordHelp({ preferences, request }) {
  const bubble = document.querySelector('#word-help');
  const hint = bubble.querySelector('[data-word-mode]');
  const heading = bubble.querySelector('[data-word]');
  const answer = bubble.querySelector('[data-word-answer]');
  const cache = new Map();
  let active, controller, timer;

  function clear() {
    clearTimeout(timer);
    controller?.abort();
    controller = undefined;
    active = undefined;
    bubble.hidden = true;
  }

  function place(rect) {
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    const left = Math.min(window.innerWidth - width - 10, Math.max(10, (rect.left + rect.right - width) / 2));
    const top = rect.top - height - 11 > 8 ? rect.top - height - 11 : rect.bottom + 9;
    bubble.style.left = `${Math.max(8, left)}px`;
    bubble.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, top))}px`;
  }

  async function show(item, mode, language, getContext) {
    if (active !== item) return;
    const { translationLanguage } = preferences();
    const context = getContext(item);
    const target = mode === 'translation' ? translationLanguage : language;
    const key = JSON.stringify([mode, language, target, item.word, context]);
    answer.lang = target;
    hint.textContent = mode === 'translation' ? `${languageName(target)} translation` : modes[mode];
    heading.textContent = item.word;
    answer.textContent = cache.get(key) || 'Looking up word…';
    bubble.hidden = false;
    place(item.rect);
    if (cache.has(key)) return;

    controller = new AbortController();
    try {
      const { text } = await request('/api/ai/word', {
        method: 'POST', signal: controller.signal,
        body: { mode, language, translationLanguage, word: item.word, context },
      });
      cache.set(key, text);
      if (cache.size > 220) cache.delete(cache.keys().next().value);
      if (active === item) answer.textContent = text;
    } catch (error) {
      if (active === item && error.name !== 'AbortError') answer.textContent = error.message;
    }
    if (active === item) place(item.rect);
  }

  function bind(root, language, getContext) {
    if (!root) return;
    const listeners = new AbortController();
    let segmenter;
    try { segmenter = new Intl.Segmenter(language, { granularity: 'word' }); }
    catch { /* Use the Unicode word pattern if segmentation is unavailable. */ }

    function inspect(event, tap = false) {
      if (event.pointerType === 'touch' && !tap) return;
      const { mode } = preferences();
      if (mode === 'off' || event.buttons || !root.ownerDocument.getSelection()?.isCollapsed) return clear();
      const item = wordAt(root, event, segmenter);
      if (!item) return clear();
      if (active?.node === item.node && active.index === item.index) {
        if (tap) clear();
        return;
      }
      clear();
      active = item;
      timer = setTimeout(() => show(item, mode, language, getContext), tap ? 0 : 400);
    }
    const options = { signal: listeners.signal };
    root.addEventListener('pointermove', inspect, options);
    root.addEventListener('pointerleave', clear, options);
    root.addEventListener('pointerdown', (event) => { if (event.pointerType !== 'touch') clear(); }, options);
    root.addEventListener('pointerup', (event) => { if (event.pointerType === 'touch') inspect(event, true); }, options);
    return () => listeners.abort();
  }

  return { clear, bind, reset: () => { clear(); cache.clear(); } };
}
