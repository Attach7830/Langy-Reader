const blockTags = new Set(['p', 'div', 'section', 'article', 'blockquote', 'pre', 'li', 'dt', 'dd', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br']);
const excludedTags = new Set(['script', 'style', 'template', 'nav', 'noscript', 'form', 'iframe', 'svg', 'rt', 'rp']);

export function readingText(root) {
  let text = '';
  let boundary = false;
  const runs = [];
  function visit(node) {
    if (node.nodeType === 3) {
      for (const part of node.data.matchAll(/\s+|\S+/gu)) {
        if (/^\s/u.test(part[0])) { boundary = Boolean(text); continue; }
        if (boundary && text && !text.endsWith(' ')) text += ' ';
        boundary = false;
        runs.push({ start: text.length, end: text.length + part[0].length, node, offset: part.index });
        text += part[0];
      }
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    const name = node.localName?.toLowerCase();
    if (excludedTags.has(name) || node.hasAttribute?.('hidden') || node.getAttribute?.('aria-hidden') === 'true') return;
    if (blockTags.has(name)) boundary = Boolean(text);
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
    if (blockTags.has(name)) boundary = Boolean(text);
  }
  if (root) visit(root);
  return { text, runs };
}

// Structural metadata shares the canonical text's UTF-16 offsets. Never add
// narration punctuation or labels to the text used by reading/progress sync.
export function readingBlocks({ runs }) {
  const blocks = [];
  let previous;
  for (const run of runs) {
    let node = run.node?.parentNode;
    while (node?.parentNode && !blockTags.has(node.localName?.toLowerCase())) node = node.parentNode;
    const last = blocks.at(-1);
    if (last && previous === node) last.to = run.end;
    else blocks.push({ from: run.start, to: run.end, kind: /^h[1-6]$/u.test(node?.localName || '') ? 'heading' : 'paragraph' });
    previous = node;
  }
  return blocks;
}

export function textWords(text, language = 'en') {
  const segmenter = new Intl.Segmenter(language, { granularity: 'word' });
  return Array.from(segmenter.segment(text)).filter((part) => part.isWordLike && /[\p{L}\p{N}]/u.test(part.segment))
    .map(({ segment, index }) => ({ word: segment, from: index, to: index + segment.length }));
}

export const normalizedWord = (word) => word.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
