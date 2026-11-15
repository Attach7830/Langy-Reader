import ePub from 'epubjs';
import spectral from '@fontsource/spectral/files/spectral-latin-400-normal.woff2?url';
import spectralItalic from '@fontsource/spectral/files/spectral-latin-400-italic.woff2?url';
import dmSans from '@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2?url';
import { fonts, themes } from './settings.js';

const blocks = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, div, pre, td, dd, dt, figcaption';

function visibleText(contents, viewport, language) {
  const doc = contents.document;
  const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
  const body = contents.content;
  if (!frame || !body) return '';
  const left = Math.max(frame.left, viewport.left) - frame.left;
  const right = Math.min(frame.right, viewport.right) - frame.left;
  const top = Math.max(frame.top, viewport.top) - frame.top;
  const bottom = Math.min(frame.bottom, viewport.bottom) - frame.top;
  if (left >= right || top >= bottom) return '';

  function isVisible(rect) {
    return rect.width > 0 && rect.height > 0
      && Math.min(rect.right, right) - Math.max(rect.left, left) > rect.width / 2
      && (rect.top + rect.bottom) / 2 > top && (rect.top + rect.bottom) / 2 < bottom;
  }

  let segmenter;
  try { segmenter = new Intl.Segmenter(language, { granularity: 'word' }); } catch { /* Fall back to whitespace. */ }
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  let result = '';
  let previousBlock;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement || node.parentElement.closest('script, style, [hidden], [aria-hidden="true"]')) continue;
    const style = doc.defaultView.getComputedStyle(node.parentElement);
    if (style.visibility !== 'visible' || style.opacity === '0') continue;
    const block = node.parentElement.closest(blocks) || body;
    if (!node.data.trim()) {
      if (block === previousBlock && result && !/\s$/u.test(result)) result += ' ';
      continue;
    }
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects());
    if (!rects.some(isVisible)) continue;
    let text = node.data;
    if (!rects.every(isVisible)) {
      const segments = segmenter?.segment(text) ?? Array.from(text.matchAll(/\s+|\S+/gu),
        (match) => ({ index: match.index, segment: match[0] }));
      text = '';
      for (const { index, segment } of segments) {
        range.setStart(node, index);
        range.setEnd(node, index + segment.length);
        if ([...range.getClientRects()].some(isVisible)) text += segment;
      }
    }
    if (!text.trim()) continue;
    if (block !== previousBlock && result) result += '\n';
    result += text;
    previousBlock = block;
  }
  return result.split('\n').map((line) => line.replace(/\s+/gu, ' ').trim()).filter(Boolean).join('\n');
}

function unscript(doc) {
  for (const element of doc.querySelectorAll('script, iframe, object, embed, form, meta[http-equiv], foreignObject')) element.remove();
  for (const element of doc.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name) || /^javascript:/i.test(attribute.value.trim())) element.removeAttributeNode(attribute);
    }
  }
}

function stylesheet(settings, fixed) {
  if (fixed) return 'html { color-scheme: light; }';
  const { ink } = themes[settings.theme];
  const face = (family, url, style) => `@font-face{font-family:"${family}";src:url("${new URL(url, location.href)}") format("woff2");font-style:${style};font-weight:400;font-display:swap;}`;
  return `
    ${face('Spectral', spectral, 'normal')}
    ${face('Spectral', spectralItalic, 'italic')}
    ${face('DM Sans', dmSans, 'normal')}
    html { background: transparent !important; color-scheme: ${['dark', 'dusk'].includes(settings.theme) ? 'dark' : 'light'}; }
    body { color: ${ink} !important; background: transparent !important; }
    body, body :is(p, li, blockquote, div, dd, td) {
      font-family: ${fonts[settings.font].stack} !important;
      font-size: ${settings.size}px !important;
      line-height: ${settings.line} !important;
    }
    body :is(h1, h2, h3, h4, h5, h6) { font-family: ${fonts[settings.font].stack} !important; line-height: 1.2 !important; }
    body :is(p, span, a, li, blockquote, div, h1, h2, h3, h4, h5, h6, dd, td) { color: inherit !important; }
    body :is(main, article, section, div, p, span, li, blockquote) { background-color: transparent !important; }
    body :is(p, li, blockquote, dd, td) :is(span, a, strong, em) { font-family: inherit !important; font-size: inherit !important; }
    a { text-decoration-thickness: from-font; text-underline-offset: .15em; }
    body p { overflow-wrap: break-word; }
    body p.sample-chapter { margin: 1em 0 .62em; font: 400 .75em/1.4 "DM Sans", sans-serif !important; text-transform: uppercase; letter-spacing: .14em; opacity: .72; }
    .sample-chapter + h1 { margin: 0 0 .7em; }
  `;
}

function normalizeToc(items, depth = 0) {
  return items.flatMap((item) => [
    { label: item.label.trim(), target: item.href, depth },
    ...normalizeToc(item.subitems || [], depth + 1),
  ]);
}

export async function openEpub({ host, url, position, language, settings, hooks, signal }) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Could not retrieve this EPUB.');
  const buffer = await response.arrayBuffer();
  signal.throwIfAborted();
  const book = ePub(undefined, { replacements: 'blobUrl' });
  let rendition, observer, renderError;
  let preferences = settings;
  let disposed = false;
  const size = () => [host.clientWidth, host.clientHeight];
  function destroy() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    book.destroy();
  }

  async function display(target) {
    const controller = new AbortController();
    const stop = AbortSignal.any([controller.signal, signal, AbortSignal.timeout(15_000)]);
    const failed = new Promise((_, reject) => {
      renderError = reject;
      stop.addEventListener('abort', () => reject(stop.reason), { once: true });
      if (stop.aborted) reject(stop.reason);
    });
    try { await Promise.race([rendition.display(target), failed]); }
    finally { renderError = undefined; controller.abort(); }
  }

  try {
    await book.open(buffer, 'binary');
    signal.throwIfAborted();
    const fixed = book.packaging.metadata.layout === 'pre-paginated';
    book.spine.hooks.content.register((doc) => {
      unscript(doc);
      const rules = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
      rules.id = 'langy-reader-styles';
      rules.textContent = stylesheet(preferences, fixed);
      doc.querySelector('head')?.append(rules);
    });
    const [width, height] = size();
    rendition = book.renderTo(host, {
      width, height, flow: 'paginated', spread: 'none', manager: 'default',
      gap: width < 500 ? 32 : 100, allowScriptedContent: false, allowPopups: false,
    });
    rendition.on('displayError', (error) => renderError?.(error));
    rendition.hooks.content.register((contents) => {
      const doc = contents.document;
      doc.defaultView.frameElement?.setAttribute('title', 'EPUB page');
      doc.addEventListener('keydown', hooks.keydown);
      doc.addEventListener('click', (event) => {
        const href = event.target.closest?.('a[href]')?.getAttribute('href');
        if (/^(?:[a-z]+:|\/\/)/i.test(href || '')) event.preventDefault();
      }, true);
      hooks.bindWords(contents.content, language, ({ node, word }) => {
        const paragraph = node.parentElement?.closest(blocks)?.textContent || node.data;
        const offset = Math.max(0, paragraph.toLocaleLowerCase().indexOf(word.toLocaleLowerCase()) - 400);
        return paragraph.slice(offset, offset + 1100);
      });
    });
    function report(location = rendition.location) {
      if (!location?.start || disposed) return;
      const { start } = location;
      const { page, total } = start.displayed;
      const count = book.spine.length;
      const percent = (start.index + page / total) / count;
      hooks.position({
        target: start.cfi, label: `Page ${page} of ${total}`,
        detail: `Section ${start.index + 1} of ${count}`,
        percent: Math.min(1, percent), previous: !location.atStart, next: !location.atEnd,
      });
    }
    rendition.on('relocated', report);
    if (typeof position === 'string' && position.startsWith('epubcfi(')) {
      try { await display(position); }
      catch { await display(); }
    } else await display();
    await new Promise(requestAnimationFrame);
    report(rendition.currentLocation());

    let dimensions = size();
    function resize() {
      const next = size();
      if (disposed || !next[0] || !next[1] || next.every((value, i) => value === dimensions[i])) return;
      dimensions = next;
      rendition.resize(...next);
    }
    observer = new ResizeObserver(resize);
    observer.observe(host);

    return {
      destroy,
      get contents() { return normalizeToc(book.navigation?.toc ?? []); },
      move: (direction) => direction > 0 ? rendition.next() : rendition.prev(),
      go: (target) => display(target),
      excerpt: () => rendition.getContents().map((contents) => visibleText(contents, host.getBoundingClientRect(), language)).filter(Boolean).join('\n'),
      async apply(next) {
        const changed = ['size', 'font', 'line'].some((key) => next[key] !== preferences[key]);
        const target = rendition.currentLocation()?.start?.cfi || rendition.location?.start?.cfi;
        preferences = next;
        for (const contents of rendition.getContents()) {
          const rules = contents.document.getElementById('langy-reader-styles');
          if (rules) rules.textContent = stylesheet(preferences, fixed);
        }
        resize();
        if (changed && target && !fixed) {
          rendition.clear();
          await display(target);
        }
      },
    };
  } catch (error) {
    destroy();
    throw error;
  }
}
