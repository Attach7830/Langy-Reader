import { francAll } from 'franc-min';

export const hanPattern = '[\\p{Script=Han}\\u3007\\u{20000}-\\u{3FFFF}]';
export const hasHan = (text) => new RegExp(hanPattern, 'u').test(text);
export function baseLanguage(value, fallback = 'en') {
  try { const language = new Intl.Locale(value).language; return language === 'cmn' ? 'zh' : language; }
  catch { return fallback; }
}
export function detectLanguage(text, fallback = 'en', explicit = false) {
  const base = baseLanguage(fallback);
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  if (hasHan(text) && !['ja', 'ko'].includes(base)) return 'zh';
  if (explicit) return base;
  const letters = text.replace(/[^\p{L}\s]/gu, ' ').trim();
  if (letters.length >= 40) {
    const [first, second] = francAll(letters, { minLength: 30 });
    if (first?.[0] !== 'und' && (letters.length >= 60 || !second || first[1] - second[1] >= .01)) return baseLanguage(first[0], base);
  }
  return base === 'zh' && /\p{Script=Latin}/u.test(text) ? 'en' : base;
}
export function nodeLanguage(node, fallback, text = node?.data || '') {
  let scope = node?.nodeType === 1 ? node : node?.parentNode, paragraph, declared, explicit = false;
  while (scope?.nodeType === 1) {
    const tag = (scope.localName || scope.nodeName).toLowerCase();
    if (!paragraph && /^(?:p|li|blockquote|td|dd|h[1-6])$/u.test(tag)) paragraph = scope;
    const language = scope.getAttribute('lang') || scope.getAttribute('xml:lang');
    if (!declared && language) { declared = language; explicit = !['html', 'body'].includes(tag); }
    scope = scope.parentNode;
  }
  const base = declared || fallback;
  if (hasHan(text)) {
    const code = baseLanguage(base);
    if (['zh', 'ja', 'ko'].includes(code)) return code;
    const context = node?.data || paragraph?.textContent || text;
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(context)) return 'ja';
    if (/\p{Script=Hangul}/u.test(context)) return 'ko';
    return 'zh';
  }
  return detectLanguage((paragraph?.textContent || text).replace(new RegExp(hanPattern, 'gu'), ' '), base, explicit);
}
export function languageSpans(content, fallback) {
  const spans = [], cached = new Map();
  for (const run of content.runs) {
    const text = content.text.slice(run.start, run.end);
    for (const part of text.matchAll(new RegExp(`${hanPattern}+|[^${hanPattern.slice(1, -1)}]+`, 'gu'))) {
      const key = run.node;
      if (!cached.has(key)) cached.set(key, nodeLanguage(run.node, fallback, text.replace(new RegExp(hanPattern, 'gu'), '')));
      const language = hasHan(part[0]) ? nodeLanguage(run.node, fallback, part[0]) : cached.get(key);
      const from = run.start + part.index, to = from + part[0].length, previous = spans.at(-1);
      if (previous?.language === language) previous.to = to;
      else { if (previous) previous.to = from; spans.push({ from, to, language }); }
    }
  }
  if (spans.length) { spans[0].from = 0; spans.at(-1).to = content.text.length; }
  return spans;
}
export function characterProfile(text) {
  const counts = new Map();
  for (const match of text.matchAll(new RegExp(hanPattern, 'gu'))) counts.set(match[0], (counts.get(match[0]) || 0) + 1);
  const frequencies = [...counts].sort((a, b) => b[1] - a[1]);
  const total = frequencies.reduce((sum, [, count]) => sum + count, 0);
  return { unit: 'characters', unique: counts.size, total,
    top100Coverage: total ? Math.round(frequencies.slice(0, 100).reduce((sum, [, count]) => sum + count, 0) / total * 1000) / 10 : 0,
    frequentCharacters: frequencies.slice(0, 80), inventory: [...counts.keys()].join('') };
}
