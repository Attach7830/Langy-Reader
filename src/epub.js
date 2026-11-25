import ePub from 'epubjs';
import spectral from '@fontsource/spectral/files/spectral-latin-400-normal.woff2?url';
import spectralItalic from '@fontsource/spectral/files/spectral-latin-400-italic.woff2?url';
import dmSans from '@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2?url';
import notoSC from '@fontsource/noto-sans-sc/400.css?inline';
import notoTC from '@fontsource/noto-sans-tc/400.css?inline';
import { fonts, themes } from './settings.js';
import { outlineDocument, spacingRules } from './epub-outline.js';
import { serializeRenderer } from './reader-navigation.js';
import { readingFile } from './book-source.js';
import { trackText } from './text-tracking.js';
import { bindBookLinks } from './book-links.js';
import { adjacentSection } from './section-navigation.js';
import { annotateSyncPaths, koReaderXPath, parseKOReaderXPath, resolveKOReaderXPath,
  positionFraction, pointAtFraction, weightedPercentage, percentagePosition } from '../shared/epub-sync-position.js';

const blocks = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, div, pre, td, dd, dt, figcaption';
const excluded = 'script, style, template, rt, rp, [hidden], [aria-hidden="true"]';

function normalizeReadingText(text) {
  return text.split('\n').map((line) => line.replace(/\s+/gu, ' ').trim()).filter(Boolean).join('\n');
}

function sectionText(root) {
  if (!root) return '';
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  let previousBlock;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(excluded)) continue;
    const block = node.parentElement?.closest(blocks) || root;
    if (text && block !== previousBlock && node.data.trim()) text += '\n';
    text += node.data;
    if (node.data.trim()) previousBlock = block;
  }
  return normalizeReadingText(text);
}

function visibleText(contents, viewport, language) {
  const doc = contents.document;
  const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
  const body = contents.content;
  if (!frame || !body) return { text: '' };
  const left = Math.max(frame.left, viewport.left) - frame.left;
  const right = Math.min(frame.right, viewport.right) - frame.left;
  const top = Math.max(frame.top, viewport.top) - frame.top;
  const bottom = Math.min(frame.bottom, viewport.bottom) - frame.top;
  if (left >= right || top >= bottom) return { text: '' };

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
  let start;
  let previousBlock;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement || node.parentElement.closest(excluded)) continue;
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
    let firstOffset;
    if (!rects.every(isVisible)) {
      const segments = segmenter?.segment(text) ?? Array.from(text.matchAll(/\s+|\S+/gu),
        (match) => ({ index: match.index, segment: match[0] }));
      text = '';
      for (const { index, segment } of segments) {
        range.setStart(node, index);
        range.setEnd(node, index + segment.length);
        if ([...range.getClientRects()].some(isVisible)) {
          if (segment.trim()) firstOffset ??= index;
          text += segment;
        }
      }
    }
    if (!text.trim()) continue;
    start ??= { node, offset: firstOffset ?? 0 };
    if (block !== previousBlock && result) result += '\n';
    result += text;
    previousBlock = block;
  }
  return { text: normalizeReadingText(result), body, start, index: contents.sectionIndex };
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
  const cjk = (notoSC + notoTC).replace(/url\(([^)]+)\)/gu, (_, value) => `url("${new URL(value.replace(/^['"]|['"]$/gu, ''), location.href)}")`);
  if (fixed) return cjk + 'html { color-scheme: light; }';
  const { ink } = themes[settings.theme];
  const font = fonts[settings.font] || fonts.spectral;
  const stack = font.stack.replace(/,\s*(?:serif|sans-serif|monospace)$/u, '');
  const face = (family, url, style) => `@font-face{font-family:"${family}";src:url("${new URL(url, location.href)}") format("woff2");font-style:${style};font-weight:400;font-display:swap;}`;
  return `
    ${cjk}
    ${font.face || ''}
    ${face('Spectral', spectral, 'normal')}
    ${face('Spectral', spectralItalic, 'italic')}
    ${face('DM Sans', dmSans, 'normal')}
    html { background: transparent !important; color-scheme: ${['dark', 'dusk', 'midnight'].includes(settings.theme) ? 'dark' : 'light'}; }
    body { color: ${ink} !important; background: transparent !important; }
    body, body :is(p, li, blockquote, div, dd, td) {
      font-family: ${stack}, 'Noto Sans SC', 'Noto Sans TC', serif !important;
      font-size: ${settings.size}px !important;
      line-height: ${settings.showPinyin ? Math.max(settings.line, 2.05) : settings.line} !important;
    }
    body :is(h1, h2, h3, h4, h5, h6) { font-family: ${stack}, 'Noto Sans SC', 'Noto Sans TC', serif !important; line-height: ${settings.showPinyin ? 2.05 : 1.2} !important; }
    body :is(p, span, a, li, blockquote, div, h1, h2, h3, h4, h5, h6, dd, td) { color: inherit !important; }
    body :is(main, article, section, div, p, span, li, blockquote) { background-color: transparent !important; }
    body :is(p, li, blockquote, dd, td) :is(span, a, strong, em) { font-family: inherit !important; font-size: inherit !important; }
    a { text-decoration-thickness: from-font; text-underline-offset: .15em; }
    ::highlight(langy-narration) { background-color: #f6ca64; color: #262c24; }
    body p { overflow-wrap: break-word; }
    body p.sample-chapter { margin: 1em 0 .62em; font: 400 .75em/1.4 "DM Sans", sans-serif !important; text-transform: uppercase; letter-spacing: .14em; opacity: .72; }
    .sample-chapter + h1 { margin: 0 0 .7em; }
  `;
}

function archiveURL(path, base = 'https://epub.invalid/') {
  try {
    const url = new URL(path, base);
    return url.origin === 'https://epub.invalid' ? url : null;
  } catch {
    return null;
  }
}

function decoded(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function epubContents(book) {
  const spine = book.spine.spineItems;
  const spinePaths = new Map(spine.map((section) => [
    decoded(archiveURL(book.resolve(section.href, false))?.pathname || ''), section,
  ]));
  const navPath = book.packaging.navPath || book.packaging.ncxPath;
  const navURL = archiveURL(navPath ? book.resolve(navPath, false) : '/');

  function flatten(items, depth = 0) {
    return items.flatMap((item) => {
      const children = flatten(item.subitems ?? [], depth + 1);
      const href = item.href && navURL ? archiveURL(item.href, navURL) : null;
      const section = href && (spinePaths.get(decoded(href.pathname)) || book.spine.get(item.href));
      const label = item.label?.replace(/\s+/gu, ' ').trim();
      if (!section) return label && children.length ? [{ label, depth }, ...children] : children;
      const target = { index: section.index, fragment: decoded(href.hash.slice(1)) };
      return [{ label: label || `Section ${section.index + 1}`, depth, target }, ...children];
    });
  }

  return flatten(book.navigation?.toc ?? []);
}

async function inferOutline(book, signal) {
  const styles = new Map();
  const entries = [];
  for (const section of book.spine.spineItems) {
    if (!section.linear) continue;
    signal.throwIfAborted();
    const start = { label: `Section ${section.index + 1}`, depth: 0, target: { index: section.index } };
    try {
      const doc = section.document || await book.load(section.url);
      signal.throwIfAborted();
      if (!section.document) unscript(doc);
      const base = archiveURL(section.url);
      const sheets = Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'), (link) => {
        const path = base && archiveURL(link.getAttribute('href'), base)?.pathname;
        if (!path) return [];
        if (!styles.has(path)) {
          styles.set(path, Promise.resolve().then(() => book.archive.getText(path)).then(spacingRules).catch(() => []));
        }
        return styles.get(path);
      });
      const rules = (await Promise.all(sheets)).flat();
      signal.throwIfAborted();
      for (const node of doc.querySelectorAll('style:not(#langy-reader-styles)')) rules.push(...spacingRules(node.textContent));
      const passages = outlineDocument(doc, rules);
      const sectionEntries = passages.map(({ label, anchor, marker }) => {
        let cfi;
        if (anchor.nodeType === Node.TEXT_NODE) {
          const range = doc.createRange();
          range.setStart(anchor, 0);
          range.collapse(true);
          cfi = section.cfiFromRange(range);
        } else {
          cfi = section.cfiFromElement(anchor);
        }
        return { label, marker, depth: 0, target: { cfi } };
      });
      entries.push(...(sectionEntries.length ? sectionEntries : [start]));
    } catch {
      signal.throwIfAborted();
      entries.push(start);
    }
  }
  return entries;
}

export async function openEpub({ host, url, position, language, settings, hooks, signal }) {
  const response = await readingFile(url, { signal });
  if (!response.ok) throw new Error('Could not retrieve this EPUB.');
  const buffer = await response.arrayBuffer();
  signal.throwIfAborted();
  const book = ePub(undefined, { replacements: 'blobUrl' });
  const earlierSections = new Map();
  let rendition, observer, renderError, outline;
  let activeSection = 0, lastTarget, sourceAnchor;
  let spineSizes = [], syncResolution;
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
    const navigation = epubContents(book), comparePosition = new ePub.CFI();
    spineSizes = book.spine.spineItems.map((section) => {
      try {
        const path = decodeURIComponent(archiveURL(section.url).pathname.slice(1));
        return book.archive.zip.file(path)?._data?.uncompressedSize || 1;
      } catch { return 1; }
    });
    const fixed = book.packaging.metadata.layout === 'pre-paginated';
    book.spine.hooks.content.register((doc, section) => {
      const body = doc.querySelector('body');
      if (body) annotateSyncPaths(body, section.index);
      unscript(doc);
      const rules = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
      rules.id = 'langy-reader-styles';
      rules.textContent = stylesheet(preferences, fixed);
      doc.querySelector('head')?.append(rules);
    });
    let dimensions = size();
    let reflowing = false;
    const [width, height] = dimensions;
    rendition = book.renderTo(host, {
      width, height, flow: 'paginated', spread: 'none', manager: 'default',
      gap: width < 500 ? 32 : 100, allowScriptedContent: false, allowPopups: false,
    });
    rendition.on('displayError', (error) => renderError?.(error));
    rendition.hooks.content.register((contents) => {
      const doc = contents.document;
      void doc.fonts?.ready.then(() => hooks.layout?.());
      doc.defaultView.frameElement?.setAttribute('title', 'EPUB page');
      hooks.bindPageNavigation?.(doc);
      doc.addEventListener('keydown', hooks.keydown);
      bindBookLinks(doc, { section: book.spine.get(contents.sectionIndex), spine: book.spine.spineItems,
        follow: (target) => hooks.followLink?.(target), error: hooks.error });
      hooks.bindWords(contents.content, language, ({ node, word }) => {
        const paragraph = node.parentElement?.closest(blocks)?.textContent || node.data;
        const offset = Math.max(0, paragraph.toLocaleLowerCase().indexOf(word.toLocaleLowerCase()) - 400);
        return paragraph.slice(offset, offset + 1100);
      });
    });
    function report(location = rendition.location) {
      if (!location?.start || disposed) return;
      const reflowed = reflowing;
      reflowing = false;
      const { start } = location;
      activeSection = Number(start.index);
      // Preserve an explicit text anchor through deferred layout reports. A
      // generated page-boundary CFI can otherwise reopen the preceding column.
      if (sourceAnchor && sourceAnchor.index !== start.index) sourceAnchor = undefined;
      lastTarget = sourceAnchor?.target || start.cfi;
      const { page, total } = start.displayed;
      const section = book.spine.get(start.index), entries = navigation.filter((entry) => entry.target?.index === start.index);
      let heading = entries[0]?.label;
      for (const entry of entries) {
        if (!entry.target.fragment) { heading = entry.label; continue; }
        const anchor = section.document?.getElementById(entry.target.fragment);
        if (anchor && comparePosition.compare(section.cfiFromElement(anchor), lastTarget) <= 0) heading = entry.label;
      }
      heading ||= section.document?.querySelector('h1,h2,h3')?.textContent?.replace(/\s+/gu, ' ').trim() || `Section ${start.index + 1}`;
      const count = book.spine.length;
      const percent = (start.index + page / total) / count;
      hooks.position({
        target: lastTarget, heading, label: `Page ${page} of ${total}`,
        detail: `Section ${start.index + 1} of ${count}`,
        percent: Math.min(1, percent), previous: !location.atStart, next: !location.atEnd, reflowed,
      });
    }
    rendition.on('relocated', report);
    let resumedTarget;
    if (typeof position === 'string' && position.startsWith('epubcfi(')) {
      try { await display(position); resumedTarget = position; }
      catch { await display(); }
    } else await display();
    await new Promise(requestAnimationFrame);
    const resumed = await rendition.currentLocation();
    if (resumedTarget && resumed?.start) sourceAnchor = { target: resumedTarget, index: resumed.start.index, page: resumed.start.displayed.page };
    // Web fonts can change column boundaries after the first display. Restore
    // the requested text point once those fonts have finished, not its old column.
    await Promise.all(rendition.getContents().map((contents) => contents.document.fonts?.ready));
    if (resumedTarget) await display(resumedTarget);
    report(resumed);

    async function resize() {
      const next = size();
      if (disposed || !next[0] || !next[1] || next.every((value, i) => value === dimensions[i])) return;
      dimensions = next;
      reflowing = true;
      const target = sourceAnchor?.target || lastTarget || (await rendition.currentLocation())?.start?.cfi;
      rendition.resize(...next, target);
      // epub.js queues a display when resized. Drain that display before the
      // next turn, or it can jump back to the location preceding the swipe.
      if (target) await display(target);
      await settle();
    }
    async function settle() {
      await new Promise(requestAnimationFrame);
      const location = await rendition.currentLocation();
      if (!location?.start) throw new Error('The EPUB page could not be laid out. Try opening the book again.');
      rendition.location = location;
      report(location);
    }
    let schedule;
    observer = new ResizeObserver(() => { void schedule(resize).catch((error) => { if (!disposed) hooks.error(error); }); });
    observer.observe(host);

    function summaryPage() {
      // Wait for the new columns before collecting the visible text.
      if (reflowing || size().some((value, i) => value !== dimensions[i])) return null;
      const viewport = host.getBoundingClientRect();
      const visible = rendition.getContents().map((contents) => visibleText(contents, viewport, language))
        .filter(({ text }) => text);
      if (!visible.length) return { text: '' };
      const first = visible[0];
      const range = first.body.ownerDocument.createRange();
      range.selectNodeContents(first.body);
      range.setEnd(first.start.node, first.start.offset);
      const sameSectionPrefix = sectionText(range.cloneContents());

      return {
        text: visible.map(({ text }) => text).join('\n'),
        publicationDate: book.packaging.metadata.pubdate,
        async *earlier(contextSignal) {
          for (const section of book.spine.spineItems) {
            if (section.index >= first.index) break;
            if (!section.linear) continue;
            contextSignal.throwIfAborted();
            if (!earlierSections.has(section.index)) {
              const doc = section.document || await book.load(section.url);
              contextSignal.throwIfAborted();
              earlierSections.set(section.index, sectionText(doc.querySelector('body')));
            }
            yield earlierSections.get(section.index);
          }
          if (sameSectionPrefix) yield sameSectionPrefix;
        },
      };
    }

    function syncPosition() {
      if (reflowing || disposed) return null;
      const current = rendition.currentLocation()?.start || rendition.location?.start;
      const contents = rendition.getContents().find((item) => item.sectionIndex === current?.index);
      if (!contents?.content || !current?.cfi) return null;
      let point;
      try {
        const range = contents.range(current.cfi);
        if (range) point = { node: range.startContainer, offset: range.startOffset };
      } catch { /* A fixed-layout image can have only an element location. */ }
      point ||= { node: contents.content, offset: 0 };
      const xpath = koReaderXPath(contents.content, point.node, point.offset, current.index);
      if (!xpath) return null;
      const fraction = positionFraction(contents.content, point.node, point.offset);
      const percentage = weightedPercentage(spineSizes, current.index, fraction);
      return { progress: xpath, percentage, target: current.cfi,
        position: { spine: current.index, page: Math.max(0, current.displayed.page - 1),
          pages: Math.max(1, current.displayed.total), pctQ: Math.round(percentage * 1000000), xpath } };
    }

    async function resumeProgress(remote) {
      if (typeof remote.langyTarget === 'string' && remote.langyTarget.startsWith('epubcfi(')) {
        try {
          await display(remote.langyTarget);
          syncResolution = { exact: true };
          report(rendition.currentLocation());
          return;
        } catch { signal.throwIfAborted(); /* Try its portable XPath next. */ }
      }
      let xpath = remote.progress, parsed = parseKOReaderXPath(xpath);
      if (!parsed && remote.position?.xpath) { xpath = remote.position.xpath; parsed = parseKOReaderXPath(xpath); }
      const fallback = percentagePosition(spineSizes, remote.percentage);
      const spine = parsed?.spine ?? remote.position?.spine ?? fallback.spine;
      const index = Number.isInteger(spine) && spine >= 0 && spine < spineSizes.length ? spine : fallback.spine;
      const section = book.spine.get(index);
      await section.load(book.load.bind(book));
      signal.throwIfAborted();
      const body = section.document.querySelector('body');
      if (!body) throw new Error('The saved reading position could not be mapped to this EPUB.');
      let point = parsed?.spine === index ? resolveKOReaderXPath(body, xpath) : null;
      if (!point) {
        const total = spineSizes.reduce((a, b) => a + b, 0);
        const before = spineSizes.slice(0, index).reduce((a, b) => a + b, 0);
        point = pointAtFraction(body, (remote.percentage * total - before) / spineSizes[index]);
      }
      const range = section.document.createRange();
      range.setStart(point.node, point.offset);
      range.collapse(true);
      await display(section.cfiFromRange(range));
      syncResolution = { exact: point.exact };
      report(rendition.currentLocation());
    }

    const opened = {
      destroy,
      syncPosition,
      get syncResolution() { return syncResolution; },
      get contents() { return epubContents(book); },
      get sectionIndex() { return activeSection; },
      async sectionTarget(direction) {
        const toc = epubContents(book).filter((entry) => entry.target);
        const targets = toc.length ? toc.map((entry) => entry.target) : book.spine.spineItems.filter((item) => item.linear).map((item) => ({ index: item.index }));
        const section = book.spine.get(activeSection);
        await section.load(book.load.bind(book)); signal.throwIfAborted();
        const cfi = new ePub.CFI(), seen = new Set(), entries = [];
        for (const target of targets) {
          const identity = `${target.index}:${target.fragment || ''}`; if (seen.has(identity)) continue; seen.add(identity);
          const anchor = target.index === activeSection && target.fragment && section.document.getElementById(target.fragment);
          entries.push({ target, position: { index: target.index, cfi: anchor ? section.cfiFromElement(anchor) : null } });
        }
        return adjacentSection(entries, { index: activeSection, cfi: rendition.currentLocation()?.start?.cfi || lastTarget }, direction,
          (a, b) => a.index - b.index || (a.cfi && b.cfi ? cfi.compare(a.cfi, b.cfi) : -1));
      },
      get pageNumber() { return rendition.location?.start?.displayed.page || 1; },
      get pageCount() { return rendition.location?.start?.displayed.total || 1; },
      get pageSections() {
        const labels = new Map();
        for (const item of epubContents(book)) if (item.target && !labels.has(item.target.index)) labels.set(item.target.index, item.label);
        return book.spine.spineItems.map(({ index }) => ({ index, label: labels.get(index) || `Section ${index + 1}` }));
      },
      readingRoots() { return rendition.getContents().map((contents) => contents.content).filter(Boolean); },
      vocabularyPages() {
        if (reflowing) return [];
        return rendition.getContents().filter((contents) => contents.content).map((contents) => ({
          key: `epub:${contents.sectionIndex}`, root: contents.content, track: () => trackText(contents.content, language),
        }));
      },
      audioUnit() {
        if (reflowing) return null;
        const index = activeSection;
        const contents = rendition.getContents().find((content) => content.sectionIndex === index);
        if (!contents?.content) return null;
        return { key: `epub:${index}`, root: contents.content, track: () => trackText(contents.content, language) };
      },
      audioTarget(key) { return { index: Number(key.split(':')[1]) }; },
      async revealWord(range, { valid = () => true } = {}) {
        if (!valid() || !range.startContainer.isConnected) return;
        const contents = rendition.getContents().find((content) => content.document === range.startContainer.ownerDocument);
        if (!contents) return;
        sourceAnchor = undefined;
        await display(contents.cfiFromRange(range));
        report(rendition.currentLocation());
      },
      readingOutline() { return outline ??= inferOutline(book, signal); },
      async move(direction) {
        sourceAnchor = undefined;
        await resize();
        await (direction > 0 ? rendition.next() : rendition.prev());
        // next/prev resolve before epub.js emits its deferred relocation event.
        // Publish the actual new position before accepting another page turn.
        await settle();
      },
      async go(target) {
        sourceAnchor = undefined;
        if (Number.isInteger(target?.page)) {
          await resize();
          const index = Number.isInteger(target.index) ? target.index : activeSection;
          const section = book.spine.get(index);
          if (!section) throw new Error('This section could not be found.');
          if (index !== activeSection) { await display(index); await settle(); }
          const location = await rendition.currentLocation();
          const total = location.start.displayed.total;
          const page = Math.max(1, Math.min(total, target.page));
          const manager = rendition.manager;
          const contents = rendition.getContents().find((content) => content.sectionIndex === index);
          const vertical = manager.settings.axis === 'vertical';
          const step = vertical ? manager.layout.height : manager.layout.pageWidth;
          const offset = !vertical && manager.settings.direction === 'rtl' ? total - page : page - 1;
          const mapped = manager.mapping.page(contents, section.cfiBase, offset * step, (offset + 1) * step);
          if (!mapped?.start) throw new Error('This page could not be located.');
          await display(mapped.start); await settle(); return;
        }
        if (target?.sync) return resumeProgress(target.sync);
        if (target?.text) {
          await resize();
          const section = book.spine.get(Number(target.key.split(':')[1]));
          await section.load(book.load.bind(book)); signal.throwIfAborted();
          const track = trackText(section.document.querySelector('body') || section.document.documentElement, language);
          const word = track.words.find((item) => item.to > target.from), range = word && track.rangeFor(word);
          if (!range) throw new Error('This text match could not be located.');
          const match = section.cfiFromRange(range);
          await display(match); await settle();
          const location = await rendition.currentLocation();
          sourceAnchor = { target: match, index: location.start.index, page: location.start.displayed.page };
          report(location); return;
        }
        let location = typeof target === 'string' ? target : target.cfi ?? target.index;
        if (target.fragment) {
          const section = book.spine.get(target.index);
          await section.load(book.load.bind(book));
          signal.throwIfAborted();
          const anchor = section.document.getElementById(target.fragment);
          if (anchor) location = section.cfiFromElement(anchor);
        }
        await resize();
        await display(location);
        await settle();
      },
      summaryPage,
      async apply(next) {
        const reflow = ['size', 'font', 'line', 'showPinyin'].some((key) => next[key] !== preferences[key]);
        const recolor = next.theme !== preferences.theme;
        const target = sourceAnchor?.target || lastTarget || rendition.currentLocation()?.start?.cfi;
        preferences = next;
        if ((reflow || recolor) && !fixed) {
          const css = stylesheet(preferences, fixed);
          // epub.js may reuse a section's source document when rebuilding its frame.
          const documents = [
            ...book.spine.spineItems.map((section) => section.document),
            ...rendition.getContents().map((contents) => contents.document),
          ];
          for (const doc of documents) {
            const rules = doc?.getElementById('langy-reader-styles');
            if (rules) rules.textContent = css;
          }
        }
        await resize();
        if (reflow && target && !fixed) {
          reflowing = true;
          rendition.clear();
          await display(target);
          await settle();
        }
      },
    };
    const serialized = serializeRenderer(opened, { signal, stalled: destroy });
    schedule = serialized.run;
    return serialized.renderer;
  } catch (error) {
    destroy();
    throw error;
  }
}
