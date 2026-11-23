import { textWords } from '../shared/reading-text.js';
import { baseLanguage, hanPattern } from '../shared/language.js';

const parsed = (value) => Array.isArray(value) ? value : JSON.parse(value || '[]');

// Count surface words, including names and numbers, independently of lemmas.
// Mandarin uses individual Han positions; Japanese/Korean keep word segmentation.
export function readingUnits(section, fallback) {
  const spans = parsed(section.languages), tokens = parsed(section.tokens), units = [];
  const language = fallback || spans[0]?.language || tokens[0]?.language || 'en';
  let spanIndex = 0, tokenIndex = 0;
  for (const word of textWords(section.text, language)) {
    while (spanIndex + 1 < spans.length && spans[spanIndex].to <= word.from) spanIndex++;
    while (tokenIndex + 1 < tokens.length && tokens[tokenIndex].to <= word.from) tokenIndex++;
    const span = spans[spanIndex], token = tokens[tokenIndex];
    const locale = baseLanguage((span?.from <= word.from && span.to > word.from ? span.language : null)
      || (token?.from <= word.from && token.to > word.from ? token.language : null) || language);
    const characters = !['ja', 'ko'].includes(locale) ? [...word.word.matchAll(new RegExp(hanPattern, 'gu'))] : [];
    if (!characters.length) { units.push({ from: word.from, to: word.to, unit: 'words' }); continue; }
    for (const match of characters) units.push({ from: word.from + match.index, to: word.from + match.index + match[0].length, unit: 'characters' });
    const rest = word.word.replace(new RegExp(hanPattern, 'gu'), (match) => ' '.repeat(match.length));
    for (const part of textWords(rest, language)) units.push({ from: word.from + part.from, to: word.from + part.to, unit: 'words' });
  }
  return units.sort((a, b) => a.from - b.from);
}

export function mergeReadingRanges(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ from: range.from, to: range.to });
  }
  return merged;
}

export function countReadingUnits(units, ranges = null) {
  const counts = { words: 0, characters: 0 }; let index = 0;
  for (const word of units) {
    if (ranges) {
      while (index < ranges.length && ranges[index].to <= word.from) index++;
      if (!ranges[index] || ranges[index].from > word.from || ranges[index].to < word.to) continue;
    }
    counts[word.unit]++;
  }
  return counts;
}
