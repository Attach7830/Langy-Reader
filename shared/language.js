import { francAll } from 'franc-min';

export const hanPattern = '[\\p{Script=Han}\\u3007\\u{20000}-\\u{3FFFF}]';
export const hasHan = (text) => new RegExp(hanPattern, 'u').test(text);
export function baseLanguage(value, fallback = 'en') {
  try { const language = new Intl.Locale(value).language; return language === 'cmn' ? 'zh' : language; }
  catch { return fallback; }
}
export const selectedLanguages = (value) => [...new Set((Array.isArray(value) ? value : []).map((code) => baseLanguage(code, '')).filter(Boolean))];
// Passage detection is opt-in for books. An empty selection means one language.
export function bookLanguages(book) {
  const selection = selectedLanguages(book?.languages);
  return selection.length ? selection : [baseLanguage(book?.language)];
}
const scripts = new Map();
function scriptMatches(text, code) {
  if (!scripts.has(code)) {
    const script = new Intl.Locale(code).maximize().script;
    const pattern = { Hans: hanPattern, Hant: hanPattern, Jpan: '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]', Kore: '[\\p{Script=Han}\\p{Script=Hangul}]' }[script];
    try { scripts.set(code, new RegExp(pattern || `\\p{Script=${script}}`, 'u')); }
    catch { scripts.set(code, null); }
  }
  return scripts.get(code)?.test(text) ?? true;
}
export function detectLanguage(text, fallback = 'en', explicit = false, selection = []) {
  const base = baseLanguage(fallback);
  const allowed = selectedLanguages(selection);
  if (allowed.length) {
    const matching = allowed.filter((code) => scriptMatches(text, code));
    const choices = matching.length ? matching : allowed;
    const safe = choices.includes(base) ? base : choices[0];
    if (choices.length === 1 || explicit && choices.includes(base)) return safe;
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) && choices.includes('ja')) return 'ja';
    if (/\p{Script=Hangul}/u.test(text) && choices.includes('ko')) return 'ko';
    if (hasHan(text)) return choices.includes(base) ? base : choices.includes('zh') ? 'zh' : safe;
    const letters = text.replace(/[^\p{L}\s]/gu, ' ').trim();
    if (letters.length >= 40) {
      const ranked = francAll(letters, { minLength: 30 }).filter(([code]) => choices.includes(baseLanguage(code, '')));
      if (ranked.length && (letters.length >= 60 || ranked.length === 1 || ranked[0][1] - ranked[1][1] >= .01)) return baseLanguage(ranked[0][0]);
    }
    return safe;
  }
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
export function nodeLanguage(node, fallback, text = node?.data || '', selection = []) {
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
    if (['zh', 'ja', 'ko'].includes(code)) return detectLanguage(text, code, true, selection);
    const context = node?.data || paragraph?.textContent || text;
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(context)) return detectLanguage(text, 'ja', true, selection);
    if (/\p{Script=Hangul}/u.test(context)) return detectLanguage(text, 'ko', true, selection);
    return detectLanguage(text, 'zh', true, selection);
  }
  return detectLanguage((paragraph?.textContent || text).replace(new RegExp(hanPattern, 'gu'), ' '), base, explicit, selection);
}
export function languageSpans(content, fallback, selection = []) {
  const spans = [], cached = new Map();
  for (const run of content.runs) {
    const text = content.text.slice(run.start, run.end);
    for (const part of text.matchAll(new RegExp(`${hanPattern}+|[^${hanPattern.slice(1, -1)}]+`, 'gu'))) {
      const key = run.node;
      if (!cached.has(key)) cached.set(key, nodeLanguage(run.node, fallback, text.replace(new RegExp(hanPattern, 'gu'), ''), selection));
      const language = hasHan(part[0]) ? nodeLanguage(run.node, fallback, part[0], selection) : cached.get(key);
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
