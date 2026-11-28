import { nodeLanguage, bookLanguages } from '../shared/language.js';
import { languageHelpPreferences } from '../shared/language-defaults.js';
import { readingText } from '../shared/reading-text.js';
import { translateUI } from './i18n.js';
import { touchSelection } from './touch-selection.js';

function phraseContext({ root, range, phrase }) {
  const ancestor = range.commonAncestorContainer;
  const parent = ancestor.nodeType === 1 ? ancestor : ancestor.parentElement;
  const block = parent.closest('p,li,blockquote,h1,h2,h3,div') || parent;
  let context = [block.previousElementSibling?.textContent || '', block.textContent || '', block.nextElementSibling?.textContent || ''].join('\n').trim();
  let at = context.indexOf(phrase);
  if (at < 0) {
    const before = range.cloneRange(), after = range.cloneRange();
    before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
    after.selectNodeContents(root); after.setStart(range.endContainer, range.endOffset);
    const prefix = before.toString().slice(-1200);
    context = prefix + phrase + after.toString().slice(0, 2100); at = prefix.length;
  }
  const start = Math.max(0, at - 1200);
  return context.slice(start, start + 4000);
}

export function phraseHelp({ book, preferences, request, explanations = true, roots = () => [], onBookmark = () => false, onSelection = () => {} }) {
  const panel = document.querySelector('#phrase-help');
  const viewer = document.querySelector('#viewer');
  const response = panel.querySelector('.phrase-response'), answer = panel.querySelector('[data-phrase-answer]');
  const webStatus = panel.querySelector('[data-phrase-web-status]'), sources = panel.querySelector('[data-phrase-sources]');
  const bookmarkButton = panel.querySelector('[data-bookmark-selection]'), explainButton = panel.querySelector('[data-explain-phrase]');
  const searchButton = panel.querySelector('[data-search-phrase]');
  const viewport = window.visualViewport;
  let selected, controller, scheduled, adjusting = false;
  const touch = touchSelection({ roots, changed(dragging) {
    adjusting = dragging;
    if (dragging) { clearPanel(); onSelection(); }
    else for (const root of roots()) inspect(root);
  } });

  function clearPanel() {
    controller?.abort(); controller = undefined;
    clearTimeout(scheduled); selected = null;
    panel.hidden = response.hidden = searchButton.hidden = true; answer.textContent = '';
    setWebStatus(); showSources();
    explainButton.disabled = false; explainButton.setAttribute('aria-expanded', 'false');
  }
  function clear() {
    touch.clear(); adjusting = false;
    clearPanel();
  }

  function setWebStatus(text = '') {
    webStatus.textContent = translateUI(text); webStatus.hidden = !text;
  }

  function showSources(items = []) {
    sources.replaceChildren(...items.flatMap(({ id, title, url }) => {
      let link;
      try { link = new URL(url); } catch { return []; }
      if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password) return [];
      const entry = document.createElement('li'), anchor = document.createElement('a');
      entry.value = id; anchor.textContent = title; anchor.href = link.href;
      anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; entry.append(anchor);
      return [entry];
    }));
    sources.hidden = !sources.childElementCount;
  }

  function dismiss() {
    selected?.root.ownerDocument.getSelection()?.removeAllRanges();
    clear();
  }

  function place() {
    touch.place();
    if (panel.hidden || !selected?.root.isConnected) return;
    const margin = 8, gap = 8;
    const left = (viewport?.offsetLeft ?? 0) + margin, top = (viewport?.offsetTop ?? 0) + margin;
    const width = Math.max(0, (viewport?.width ?? window.innerWidth) - margin * 2);
    const height = Math.max(0, (viewport?.height ?? window.innerHeight) - margin * 2);
    panel.style.maxWidth = `${width}px`; panel.style.maxHeight = `${height}px`;
    const { width: panelWidth, height: panelHeight } = panel.getBoundingClientRect();
    const range = selected.range.getBoundingClientRect();
    const frame = selected.root.ownerDocument.defaultView?.frameElement?.getBoundingClientRect();
    if (touch.active) {
      const reading = viewer.getBoundingClientRect();
      const header = Math.max(top, reading.top + gap), footer = Math.max(header, Math.min(top + height, reading.bottom) - panelHeight - gap);
      const roomAbove = range.top + (frame?.top ?? 0) - header;
      const roomBelow = footer + panelHeight - range.bottom - (frame?.top ?? 0);
      panel.style.left = `${left + Math.max(0, width - panelWidth) / 2}px`;
      panel.style.top = `${Math.min(top + height - panelHeight, roomAbove > roomBelow ? header : footer)}px`;
      return;
    }
    const x = Math.max(left, Math.min(range.left + (frame?.left ?? 0), left + width - panelWidth));
    const below = range.bottom + (frame?.top ?? 0) + gap;
    const above = range.top + (frame?.top ?? 0) - gap - panelHeight;
    const maxTop = top + height - panelHeight;
    const y = Math.max(top, Math.min(below <= maxTop ? below : above, maxTop));
    panel.style.left = `${x}px`; panel.style.top = `${y}px`;
  }

  function read(root, active) {
    const selection = root?.isConnected && root.ownerDocument.getSelection();
    const managed = root?.isConnected && touch.range(root);
    if (!managed && (!selection?.rangeCount || selection.isCollapsed)) return null;
    const range = managed || selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const phrase = (managed ? readingText(range.cloneContents()).text
      : selection.rangeCount === 1 ? selection.toString() : range.toString()).trim();
    if (!phrase) return null;
    return { root, range: range.cloneRange(), phrase, book: active.id, canExplain: explanations && !active.l1Folder && phrase.length <= 700 };
  }

  function show(value) {
    const { range } = value;
    if (selected?.book === value.book && selected.root === value.root && selected.phrase === value.phrase && selected.canExplain === value.canExplain
      && range.compareBoundaryPoints(range.START_TO_START, selected.range) === 0
      && range.compareBoundaryPoints(range.END_TO_END, selected.range) === 0) return selected;
    clearPanel(); selected = value;
    explainButton.hidden = !value.canExplain;
    const keys = preferences().keys;
    for (const [button, key] of [[bookmarkButton, keys?.bookmarkSelection], [explainButton, keys?.explainSelection]]) {
      if (key) button.setAttribute('aria-keyshortcuts', key.length === 1 ? key.toUpperCase() : key);
      else button.removeAttribute('aria-keyshortcuts');
    }
    onSelection(); panel.hidden = false; place();
    return value;
  }

  function inspect(root) {
    if (adjusting || panel.contains(document.activeElement) || panel.contains(document.getSelection()?.anchorNode)) return;
    const active = book();
    const value = active && !document.querySelector('dialog[open]') && read(root, active);
    if (value) show(value);
    else if (selected?.root === root) clear();
  }

  function current() {
    const active = book();
    if (!active || document.querySelector('dialog[open]')) return null;
    if (selected?.book === active.id && selected.root.isConnected && panel.contains(document.activeElement)) return selected;
    for (const root of new Set([selected?.root, ...roots()])) {
      const value = read(root, active);
      if (value) return show(value);
    }
    return null;
  }

  function bookmark() {
    const value = current();
    if (value && onBookmark(value.range, value.phrase)) dismiss();
  }

  async function explain(useWeb = false) {
    const active = book();
    const value = useWeb && selected?.book === active?.id && !response.hidden ? selected : current();
    if (!value?.canExplain || active?.l1Folder || explainButton.disabled) return;
    const language = nodeLanguage(value.range.startContainer, active.language, value.phrase, bookLanguages(active));
    const context = phraseContext(value);
    const previous = controller = new AbortController();
    explainButton.disabled = searchButton.disabled = true; explainButton.setAttribute('aria-expanded', 'true');
    if (useWeb) setWebStatus('Searching the web…');
    else { setWebStatus(); showSources(); answer.textContent = translateUI('Explaining phrase…'); }
    response.hidden = false; response.scrollTop = 0; place();
    try {
      const result = await request('/api/ai/phrase', { method: 'POST', signal: previous.signal,
        body: { phrase: value.phrase, context, language, translationLanguage: languageHelpPreferences(preferences(), language).translationLanguage || 'en', ...(useWeb ? { web: true } : {}) } });
      if (controller !== previous || book()?.id !== value.book) return;
      if (result.webStatus === 'unavailable') {
        const reasons = {
          configuration: 'Web search needs a SearXNG connection on this server.',
          connection: 'Could not reach the search service. Check that it is running.',
          access: 'The search service denied access. Check that SearXNG allows JSON search.',
          timeout: 'The search service timed out. Try again.',
          busy: 'The search service is busy. Try again shortly.',
          service: 'The search service returned an error. Try again.',
        };
        setWebStatus(reasons[result.webReason] || 'Web search is unavailable.');
      } else if (result.webStatus) setWebStatus('No web sources helped explain this selection.');
      else { setWebStatus(); answer.textContent = result.text; showSources(result.sources); }
    } catch (error) {
      if (controller === previous && error.name !== 'AbortError') {
        if (useWeb) setWebStatus(error.message); else answer.textContent = error.message;
      }
    } finally {
      if (controller === previous) {
        controller = undefined; explainButton.disabled = searchButton.disabled = searchButton.hidden = false; place();
      }
    }
  }

  function bind(root) {
    const doc = root.ownerDocument;
    const update = () => { clearTimeout(scheduled); scheduled = setTimeout(() => inspect(root), 160); };
    const dismissTouch = () => { if (touch.active) dismiss(); };
    doc.addEventListener('selectionchange', update); root.addEventListener('pointerup', update); root.addEventListener('keyup', update);
    root.addEventListener('pointerdown', dismissTouch);
    return () => {
      doc.removeEventListener('selectionchange', update); root.removeEventListener('pointerup', update); root.removeEventListener('keyup', update);
      root.removeEventListener('pointerdown', dismissTouch);
      if (selected?.root === root || touch.range(root)) clear();
    };
  }

  panel.addEventListener('pointerdown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
  document.addEventListener('pointerdown', (event) => {
    if (event.target.closest?.('#selection-handles') || panel.contains(event.target)) return;
    if (touch.active || selected && !selected.root.contains(event.target)) dismiss();
  });
  bookmarkButton.addEventListener('click', bookmark);
  explainButton.addEventListener('click', () => void explain());
  searchButton.addEventListener('click', () => void explain(true));
  window.addEventListener('resize', place);
  viewport?.addEventListener('resize', place);
  viewport?.addEventListener('scroll', place);
  viewer.addEventListener('scroll', place, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(panel);

  return { bind, clear, bookmark, explain, selectPassage: touch.start,
    get touchSelected() { return touch.active; },
    keydown(event) {
      if (event.key !== 'Escape' || panel.hidden) return false;
      event.preventDefault(); dismiss(); return true;
    },
  };
}
