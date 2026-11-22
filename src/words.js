import { modes, languageName } from './settings.js';
import { element } from './ui.js';
import { hasHan, nodeLanguage } from '../shared/language.js';
import { readingText } from '../shared/reading-text.js';
import { mandarinHelp } from './mandarin-help.js';

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
    ? [...new Set([segments.containing(offset), segments.containing(offset - 1)])].filter((item) => item?.isWordLike || hasHan(item?.segment || ''))
    : Array.from(node.data.matchAll(/[\p{L}\p{M}\p{N}]+/gu), (match) => ({ index: match.index, segment: match[0] }))
      .filter((item) => item.index <= offset && offset <= item.index + item.segment.length);

  const range = doc.createRange();
  for (const { index, segment } of candidates) {
    if (!/\p{L}/u.test(segment) && !hasHan(segment)) continue;
    range.setStart(node, index);
    range.setEnd(node, index + segment.length);
    const rect = [...range.getClientRects()].find((box) => x >= box.left - 1 && x <= box.right + 1 && y >= box.top && y <= box.bottom);
    if (!rect) continue;
    const frame = doc.defaultView.frameElement?.getBoundingClientRect();
    return {
      node, index, word: segment, caret: Math.max(index, Math.min(offset, index + segment.length - 1)),
      rect: { left: rect.left + (frame?.left || 0), right: rect.right + (frame?.left || 0),
        top: rect.top + (frame?.top || 0), bottom: rect.bottom + (frame?.top || 0) },
    };
  }
  return null;
}

export function wordHelp({ preferences, request, lemmaAt = () => null, seekWord = () => {}, languages = () => [] }) {
  const bubble = document.querySelector('#word-help');
  const hint = bubble.querySelector('[data-word-mode]');
  const heading = bubble.querySelector('[data-word]');
  const answer = bubble.querySelector('[data-word-answer]');
  const lemmaLabel = bubble.querySelector('[data-word-lemma]');
  const cache = new Map();
  let active, controller, timer;
  bubble.addEventListener('pointerenter', () => clearTimeout(timer));
  bubble.addEventListener('pointerleave', () => clear());

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
    language = nodeLanguage(item.node, language, item.word, languages());
    const chinese = hasHan(item.word) && language === 'zh';
    let mandarin;
    if (chinese) {
      const root = item.node.parentElement.closest('p,li,blockquote,td,h1,h2,h3,h4,h5,h6') || item.node.parentElement.closest('.textLayer') || item.node.parentElement;
      const content = readingText(root);
      const run = content.runs.find((part) => part.node === item.node && part.offset <= item.caret && part.offset + part.end - part.start > item.caret);
      const offset = run ? run.start + item.caret - run.offset : item.caret;
      let from = Math.max(0, offset - 150);
      const text = run ? content.text : item.node.data;
      if (/[\uDC00-\uDFFF]/u.test(text[from])) from--;
      mandarin = { text: text.slice(from, from + 350), offset: offset - from };
    }
    const { translationLanguage, synonymContextHelp } = preferences();
    const dictionary = mode === 'synonyms';
    const useContextHelp = dictionary && synonymContextHelp === true;
    const context = dictionary && !useContextHelp ? '' : getContext(item);
    const target = mode === 'translation' ? translationLanguage : language;
    const key = JSON.stringify([mode, language, target, item.word, context, mandarin]);
    const label = mode === 'translation' ? `${languageName(target)} translation` : modes[mode];
    const detected = lemmaAt(item.node, item.index);
    lemmaLabel.textContent = detected?.lemma ? `Lemma · ${detected.lemma}` : '';
    lemmaLabel.hidden = chinese || !detected?.lemma;
    function display(result) {
      if (result.mandarin) {
        heading.textContent = result.mandarin.word;
        hint.textContent = 'Mandarin dictionary';
        answer.replaceChildren(mandarinHelp(result.mandarin));
        if (result.text) answer.append(element('div', 'word-sense', `${result.status === 'context' ? 'AI context explanation' : label}: ${result.text}`));
        return;
      }
      answer.lang = result.language ?? target;
      answer.textContent = result.text;
      const title = result.status === 'context' ? 'AI context explanation'
        : result.senses?.every((sense) => sense.readingNote) ? 'Reading note'
        : result.status === 'meaning' ? 'Dictionary meaning' : label;
      hint.textContent = result.lemma ? `${title} · ${result.lemma}` : title;
      if (result.senses?.length) {
        answer.replaceChildren(...result.senses.map(({ label: meaning, labelLanguage, terms, source, lemma }) => {
          const sense = element('div', 'word-sense');
          if (source) {
            const headword = lemma && lemma !== result.lemma && lemma !== item.word.toLocaleLowerCase(language);
            sense.append(element('div', 'word-sense-source', headword ? `${lemma} · ${source}` : source));
          }
          if (meaning) {
            const caption = element('div', terms.length ? 'word-sense-label' : 'word-gloss', meaning);
            caption.lang = labelLanguage || 'en';
            caption.dir = 'auto';
            sense.append(caption);
          }
          if (terms.length) {
            const choices = element('div', '', terms.join(', '));
            choices.dir = 'auto';
            sense.append(choices);
          }
          return sense;
        }));
      }
    }
    heading.textContent = item.word;
    display(cache.get(key) || { text: 'Looking up word…', language: 'en' });
    bubble.hidden = false;
    place(item.rect);
    if (cache.has(key)) return;

    const lookup = new AbortController();
    controller = lookup;
    const askWord = (task, passage) => request('/api/ai/word', {
      method: 'POST', signal: lookup.signal,
      body: { mode: task, language, translationLanguage, word: item.resolvedWord || item.word, context: passage, lemma: detected?.lemma },
    });
    let checkingContext = false;
    try {
      if (chinese) {
        const local = await request('/api/mandarin/word', { method: 'POST', signal: lookup.signal, body: mandarin });
        if (active !== item) return;
        item.resolvedWord = local.word;
        const result = { mandarin: local };
        display(result); place(item.rect);
        if (!(mode === 'translation' && /^en(?:-|$)/u.test(target))) {
          try {
            const passage = getContext(item);
            let extra = await askWord(mode, passage);
            if (useContextHelp && extra.status === 'missing' && passage.trim()) extra = { ...await askWord('context', passage), status: 'context' };
            Object.assign(result, extra);
          }
          catch (error) { if (error.name === 'AbortError') throw error; result.text = error.message; }
        }
        cache.set(key, result);
        if (cache.size > 220) cache.delete(cache.keys().next().value);
        if (active === item) { display(result); place(item.rect); }
        return;
      }
      let result = await askWord(mode, dictionary ? '' : context);
      if (active !== item) return;
      if (useContextHelp && result.status === 'missing' && context.trim()) {
        checkingContext = true;
        display({ text: 'Reading the surrounding text…', language: 'en', status: 'context' });
        place(item.rect);
        result = { ...await askWord('context', context), status: 'context' };
      }
      cache.set(key, result);
      if (cache.size > 220) cache.delete(cache.keys().next().value);
      if (active === item) display(result);
    } catch (error) {
      if (active === item && error.name !== 'AbortError') {
        display({
          text: checkingContext ? 'No dictionary entry. AI explanation unavailable.' : error.message,
          language: 'en',
        });
      }
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
    root.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'touch') { clearTimeout(timer); timer = setTimeout(clear, 180); }
    }, options);
    root.addEventListener('pointerdown', (event) => { if (event.pointerType !== 'touch') clear(); }, options);
    root.addEventListener('pointerup', (event) => { if (event.pointerType === 'touch') inspect(event, true); }, options);
    root.addEventListener('click', (event) => {
      const item = wordAt(root, event, segmenter);
      if (item) seekWord(item.node, item.index);
    }, options);
    return () => listeners.abort();
  }

  return { clear, bind, reset: () => { clear(); cache.clear(); } };
}
