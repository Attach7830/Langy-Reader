const blockTags = new Set(['p', 'div', 'section', 'article', 'blockquote', 'pre', 'li', 'dt', 'dd', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br']);
const excludedTags = new Set(['script', 'style', 'template', 'nav', 'noscript', 'form', 'iframe', 'svg']);

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

export function textWords(text, language = 'en') {
  const segmenter = new Intl.Segmenter(language, { granularity: 'word' });
  return Array.from(segmenter.segment(text)).filter((part) => part.isWordLike && /\p{L}/u.test(part.segment))
    .map(({ segment, index }) => ({ word: segment, from: index, to: index + segment.length }));
}

export const normalizedWord = (word) => word.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
