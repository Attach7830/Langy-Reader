import { readingText, textWords, normalizedWord } from '../shared/reading-text.js';

export function trackText(root, language, pdf = false) {
  let content = readingText(root);
  if (pdf) {
    let text = '';
    const runs = [];
    for (const span of root.querySelectorAll('span:not(:has(span))')) {
      const part = readingText(span);
      if (!part.text) continue;
      if (text && !text.endsWith(' ') && !/^[,.;:!?]/u.test(part.text)) text += ' ';
      runs.push(...part.runs.map((run) => ({ ...run, start: run.start + text.length, end: run.end + text.length })));
      text += part.text;
    }
    content = { text, runs };
  }
  const words = textWords(content.text, language);
  const frame = root.ownerDocument.defaultView.frameElement;
  const annotations = new Map();
  let runIndex = 0;
  const wordRuns = new Map(words.map((word) => {
    while (runIndex < content.runs.length && content.runs[runIndex].end <= word.from) runIndex++;
    const first = content.runs[runIndex];
    let end = runIndex;
    while (end < content.runs.length && content.runs[end].end < word.to) end++;
    return [word, { first, last: content.runs[end] }];
  }));

  function rangeFor(word) {
    const { first, last } = wordRuns.get(word) ?? {};
    if (!first || !last || !first.node.isConnected || !last.node.isConnected) return null;
    const range = root.ownerDocument.createRange();
    range.setStart(first.node, first.offset + Math.max(0, word.from - first.start));
    range.setEnd(last.node, last.offset + Math.min(last.end, word.to) - last.start);
    return range;
  }

  function visible(word) {
    const range = rangeFor(word);
    if (!range) return false;
    const host = document.querySelector('#viewer').getBoundingClientRect();
    const outer = frame?.getBoundingClientRect();
    return [...range.getClientRects()].some((box) => {
      const left = box.left + (outer?.left || 0);
      const top = box.top + (outer?.top || 0);
      return box.width > 0 && left + box.width > host.left && left < host.right
        && top + box.height > host.top && top < host.bottom;
    });
  }

  function match(source) {
    const mapped = new Map();
    let local = 0;
    for (const [index, token] of source.entries()) {
      const key = normalizedWord(token.word);
      const end = Math.min(words.length, local + 12);
      let found = local;
      while (found < end && normalizedWord(words[found].word) !== key) found++;
      if (found === end) continue;
      mapped.set(index, words[found]);
      local = found + 1;
    }
    return mapped;
  }

  return {
    root, text: content.text, words, rangeFor, visible, match,
    annotate(tokens) {
      annotations.clear();
      for (const [index, word] of match(tokens)) annotations.set(word, tokens[index]);
    },
    at(node, offset) {
      const run = content.runs.find((part) => part.node === node && part.offset <= offset && offset <= part.offset + part.end - part.start);
      if (!run) return null;
      const position = run.start + offset - run.offset;
      const word = words.find((part) => part.from <= position && part.to >= position);
      return word ? { word, token: annotations.get(word) } : null;
    },
  };
}
