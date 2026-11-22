import { baseLanguage, characterProfile } from '../shared/language.js';

export function addVocabulary(groups, language, result) {
  if (language === 'zh' || !result.tokens.length && !result.lemmas.length) return;
  if (!groups.has(language)) groups.set(language, { lemmas: new Set(), total: 0, method: result.method });
  const group = groups.get(language);
  for (const lemma of result.lemmas) group.lemmas.add(lemma);
  group.total += result.tokens.length;
  if (result.method === 'word forms') group.method = result.method;
}
export function vocabularySummary(chineseText, groups, primary) {
  const characters = characterProfile(chineseText);
  const byLanguage = [...groups].map(([language, group]) => ({ language,
    unit: group.method === 'word forms' ? 'word forms' : 'lemmas', count: group.lemmas.size, total: group.total }));
  if (characters.total) byLanguage.push({ language: 'zh', unit: 'characters', count: characters.unique, total: characters.total });
  byLanguage.sort((a, b) => Number(b.language === baseLanguage(primary)) - Number(a.language === baseLanguage(primary)) || a.language.localeCompare(b.language));
  const lemmaCount = [...groups.values()].reduce((sum, group) => sum + group.lemmas.size, 0);
  const main = byLanguage.find((item) => item.language === baseLanguage(primary)) || byLanguage[0];
  return { unit: main?.unit || 'lemmas', count: main?.count ?? 0, lemmaCount,
    characterCount: characters.unique, characters, byLanguage, languages: byLanguage.map((item) => item.language) };
}
