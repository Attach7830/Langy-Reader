const headingSelector = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const passages = `p, div, section, article, blockquote, pre, hr, ${headingSelector}`;
const skipped = 'nav, aside, script, style, template, [hidden], [aria-hidden="true"]';
const separatorClass = /(?:^|[\s_-])(?:scene[-_]?break|section[-_]?break|dinkus|ornament|separator|separador|salto)(?=$|[\s_-])/iu;
const ornament = /^(?:[⁂❦❧✦✧*]|[*⁎•·×◆◇—–_=~]{2,})+$/u;
const checkpointLength = 5400;

const clean = (text) => (text || '').replace(/\s+/gu, ' ').trim();

function openingWords(text, heading) {
  const preview = heading ? text : text.split(' ').slice(0, 12).join(' ');
  const short = preview.length > 90 ? preview.slice(0, 90).replace(/\s+\S*$/u, '') : preview;
  return short.length < text.length ? `${short}…` : short;
}

function lengthInPixels(value) {
  const match = /^(\d*\.?\d+)(px|pt|em|rem)$/u.exec(value.trim());
  if (!match) return 0;
  return Number(match[1]) * ({ px: 1, pt: 4 / 3, em: 16, rem: 16 }[match[2]]);
}

function spacing(style, side) {
  if (!style) return 0;
  const edge = side === 'start' ? 'top' : 'bottom';
  return Math.max(lengthInPixels(style.getPropertyValue(`margin-${edge}`)), lengthInPixels(style.getPropertyValue(`margin-block-${side}`)))
    + Math.max(lengthInPixels(style.getPropertyValue(`padding-${edge}`)), lengthInPixels(style.getPropertyValue(`padding-block-${side}`)));
}

export function spacingRules(css) {
  if (!css || typeof CSSStyleSheet === 'undefined') return [];
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css.replace(/@import[^;]*;/giu, ''));
    return Array.from(sheet.cssRules).flatMap((rule) => {
      if (!rule.selectorText || rule.selectorText.includes('|') || !rule.style) return [];
      const before = spacing(rule.style, 'start');
      const after = spacing(rule.style, 'end');
      return before || after ? [{ selector: rule.selectorText, before, after }] : [];
    });
  } catch {
    return [];
  }
}

function blockSpacing(block, rules) {
  let before = spacing(block.style, 'start');
  let after = spacing(block.style, 'end');
  for (const rule of rules) {
    try {
      if (block.matches(rule.selector)) {
        before = Math.max(before, rule.before);
        after = Math.max(after, rule.after);
      }
    } catch { /* Ignore selectors that require a stylesheet namespace or context. */ }
  }
  return { before, after };
}

function splitLines(block) {
  if (!block.querySelector('br')) return [{ anchor: block, text: clean(block.textContent) }];
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const pieces = [];
  let anchor = block;
  let text = '';
  let breaks = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE && node.localName === 'br' && !node.closest(skipped)) {
      text += ' ';
      breaks++;
    }
    if (node.nodeType !== Node.TEXT_NODE || node.parentElement?.closest(skipped)) continue;
    if (node.data.trim() && breaks > 1 && text.trim()) {
      pieces.push({ anchor, text: clean(text) });
      anchor = node;
      text = '';
    }
    if (node.data.trim()) breaks = 0;
    text += node.data;
  }
  if (text.trim()) pieces.push({ anchor, text: clean(text) });
  return pieces;
}

export function outlineDocument(doc, rules = []) {
  const body = doc.querySelector('body');
  if (!body) return [];
  const blocks = Array.from(body.querySelectorAll(passages));
  if (!blocks.length) blocks.push(body);
  const prose = [];
  let separator = false;
  let blank = false;
  let previousEnd = 0;
  let wrapperGap = 0;
  for (const block of blocks) {
    if (block.closest(skipped)) continue;
    const heading = block.matches(headingSelector);
    const marked = block.matches('section, [role="doc-chapter"], [role="doc-part"]')
      || separatorClass.test(block.getAttribute('class') || '');
    if (!heading && block.querySelector(passages)) {
      if (marked) separator = true;
      wrapperGap = Math.max(wrapperGap, blockSpacing(block, rules).before);
      continue;
    }
    const text = clean(block.textContent);
    if (block.localName === 'hr' || ornament.test(text.replace(/\s/gu, ''))) {
      separator = true;
      continue;
    }
    if (!text || /^[\p{Z}\u200b\ufeff]*$/u.test(text)) {
      if (marked) separator = true;
      else if (block.localName === 'p' && !block.querySelector('img, svg, audio, video')) blank = true;
      continue;
    }
    const { before, after } = blockSpacing(block, rules);
    const pieces = heading ? [{ anchor: block, text }] : splitLines(block);
    for (const [index, piece] of pieces.entries()) {
      prose.push({
        ...piece, heading, boundary: separator || marked || index > 0, blank,
        gap: index === 0 ? Math.max(before, previousEnd, wrapperGap) : 0,
      });
      separator = false;
      blank = false;
    }
    previousEnd = after;
    wrapperGap = 0;
  }
  if (!prose.length) return [];
  const gaps = prose.filter((row) => !row.heading).map((row) => row.gap).sort((a, b) => a - b);
  const typicalGap = gaps[Math.floor(gaps.length / 2)] ?? 0;
  // Blank paragraphs are useful signals only if the edition does not use them between nearly all paragraphs.
  const occasionalBlanks = prose.filter((row) => row.blank).length * 3 < prose.length * 2;
  const gapThreshold = Math.max(16, typicalGap + 12, typicalGap * 1.6);
  const entries = [];
  let distance = 0;
  for (const [index, row] of prose.entries()) {
    const start = index === 0 || row.heading || row.boundary || (row.blank && occasionalBlanks) || row.gap >= gapThreshold;
    if (start || distance >= checkpointLength) {
      entries.push({ label: openingWords(row.text, row.heading), anchor: row.anchor, marker: !start });
      distance = 0;
    }
    distance += row.text.length;
  }
  return entries;
}
