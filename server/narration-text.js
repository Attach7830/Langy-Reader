import { textWords } from '../shared/reading-text.js';
import { languageChunks } from './book-text.js';

export const speechVersion = 2;
const array = (value) => Array.isArray(value) ? value : JSON.parse(value || '[]');
const counter = /^(?:[1-9]\d{0,2}|[IVXLCDM]{1,10}|[一二三四五六七八九十百零〇两]{1,8})$/u;
function chapterLabel(text, language) {
  return language === 'zh' ? `第${text}章。` : ({ en: `Chapter ${text}.`, es: `Capítulo ${text}.`, pt: `Capítulo ${text}.`,
    fr: `Chapitre ${text}.`, it: `Capitolo ${text}.`, de: `Kapitel ${text}.`, ja: `第${text}章。` })[language] || `${text}.`;
}
function punctuate(text, language) {
  return /[。！？.!?;；:：…][”’"'」』）》)]*$/u.test(text.trim()) ? text.trim() : `${text.trim()}${language === 'zh' || language === 'ja' ? '。' : '.'}`;
}
function split(text, from, to, limit, language) {
  const chunks = [];
  while (from < to) {
    while (/\s/u.test(text[from] || '') && from < to) from++;
    if (from >= to) break;
    let end = Math.min(to, from + limit);
    if (end < to) {
      const part = text.slice(from, end), breaks = [...part.matchAll(/[。！？.!?;；，,、]\s*|\s+/gu)];
      const boundary = breaks.filter((match) => match.index + match[0].length >= limit * .5).at(-1);
      if (boundary) end = from + boundary.index + boundary[0].length;
      // ICU boundaries keep compound words intact, including punctuation-free Han.
      const words = textWords(text.slice(from, Math.min(to, end + 40)), language);
      const crossing = words.find((word) => word.from < end - from && word.to > end - from);
      if (crossing && crossing.from > 0) end = from + crossing.from;
      if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    }
    if (end <= from) end = Math.min(to, from + limit);
    chunks.push({ from, to: end, text: text.slice(from, end).trim() }); from = end;
  }
  return chunks;
}

export function narrationChunks(section, fallback, ranges = null) {
  if (ranges) return ranges.flatMap(([start, end]) => {
    const clip = (value) => array(value).filter(({ from, to }) => from < end && to > start)
      .map((part) => ({ ...part, from: Math.max(part.from, start) - start, to: Math.min(part.to, end) - start }));
    const excerpt = { text: section.text.slice(start, end), languages: clip(section.languages), speechBlocks: clip(section.speechBlocks) };
    return narrationChunks(excerpt, fallback).map((part) => ({ ...part, from: part.from + start, to: part.to + start }));
  });
  const text = section.text, blocks = array(section.speechBlocks);
  const structure = blocks.length ? blocks : [{ from: 0, to: text.length, kind: 'paragraph' }];
  const languages = languageChunks(section, Math.max(1, text.length), fallback), parts = [];
  let previousCounter = false;
  for (const [index, block] of structure.entries()) {
    const content = text.slice(block.from, block.to).trim();
    const label = counter.test(content) && (block.kind === 'heading' || index === 0);
    const heading = block.kind === 'heading' || previousCounter && content.length <= 120;
    previousCounter = label;
    for (const span of languages) {
      const from = Math.max(block.from, span.from), to = Math.min(block.to, span.to);
      if (to <= from || !text.slice(from, to).trim()) continue;
      const limit = span.language === 'zh' ? 180 : 1600;
      for (const chunk of split(text, from, to, limit, span.language)) {
        const kind = label ? 'label' : heading ? 'heading' : 'body';
        const input = label ? chapterLabel(chunk.text, span.language) : punctuate(chunk.text, span.language);
        const part = { ...chunk, input, language: span.language, kind, pauseAfter: label ? .8 : heading ? .9 : 0 };
        const previous = parts.at(-1);
        if (kind === 'body' && previous?.kind === 'body' && previous.language === part.language && previous.input.length + input.length + 1 <= limit) {
          previous.to = part.to; previous.input += `\n${input}`; previous.text = text.slice(previous.from, previous.to);
        } else parts.push(part);
      }
    }
  }
  if (parts.length) parts.at(-1).pauseAfter = Math.max(parts.at(-1).pauseAfter, .35);
  return parts;
}
