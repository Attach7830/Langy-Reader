const contextBudget = 4600;
const recentBudget = 1500;
const maxPassage = 500;

function contentWords(text, segmenter) {
  const words = segmenter
    ? Array.from(segmenter.segment(text), (part) => part.isWordLike ? part.segment : '')
    : (text.match(/[\p{L}\p{M}]+/gu) ?? []);
  return new Set(words
    .filter((word) => /^\p{L}/u.test(word) && (word.length >= 3 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)))
    .map((word) => word.normalize('NFC').toLowerCase()));
}

function* passages(text, segmenter) {
  for (const paragraph of text.split(/\n+/u)) {
    const pieces = segmenter
      ? Array.from(segmenter.segment(paragraph), ({ segment }) => segment)
      : (paragraph.match(/[^.!?。！？]+[.!?。！？]*/gu) ?? [paragraph]);
    for (const piece of pieces) {
      const normalized = piece.trim().replace(/\s+/gu, ' ');
      for (let offset = 0; offset < normalized.length;) {
        let end = Math.min(offset + maxPassage, normalized.length);
        if (end < normalized.length) {
          const boundary = normalized.lastIndexOf(' ', end);
          if (boundary > offset + maxPassage / 2) end = boundary;
        }
        const part = normalized.slice(offset, end).trim();
        if (part) yield part;
        offset = end;
      }
    }
  }
}

export async function earlierPageContext(earlier, currentText, language, signal) {
  const sentences = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(language, { granularity: 'sentence' }) : null;
  const words = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(language, { granularity: 'word' }) : null;
  const queries = contentWords(currentText, words);
  const occurrences = new Map();
  const entries = [];
  let totalLength = 0;
  let sections = 0;

  for await (const section of earlier(signal)) {
    signal.throwIfAborted();
    for (const text of passages(section, sentences)) {
      const related = [...contentWords(text, words)].filter((term) => queries.has(term));
      entries.push({ text, related, index: entries.length });
      totalLength += text.length + 1;
      for (const term of related) occurrences.set(term, (occurrences.get(term) ?? 0) + 1);
    }
    if (++sections % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  if (totalLength <= contextBudget + 1) return entries.map(({ text }) => text).join('\n');

  const selected = new Set();
  let length = 0;
  function add(entry, budget) {
    if (selected.has(entry) || length + entry.text.length + 1 > budget) return;
    selected.add(entry);
    length += entry.text.length + 1;
  }
  for (let i = entries.length - 1; i >= 0 && length < recentBudget - maxPassage; i--) {
    add(entries[i], recentBudget);
  }
  // Keep the opening and recent context, then look across the entire prefix for relevant passages.
  add(entries[0], contextBudget);
  const ranked = entries.filter((entry) => !selected.has(entry)).map((entry) => ({
    entry,
    score: entry.related.reduce((sum, term) => sum + Math.log1p(entries.length / occurrences.get(term)), 0)
      / Math.sqrt(1 + entry.text.length / 200),
  })).sort((a, b) => b.score - a.score || b.entry.index - a.entry.index);
  for (const { entry } of ranked) {
    add(entry, contextBudget);
    if (length >= contextBudget - 30) break;
  }
  return [...selected].sort((a, b) => a.index - b.index).map(({ text }) => text).join('\n');
}
