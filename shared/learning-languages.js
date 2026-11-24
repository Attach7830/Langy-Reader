import { baseLanguage } from './language.js';

export function learningLanguages(analysis, nativeLanguage) {
  const native = baseLanguage(nativeLanguage, '');
  if (!native || !analysis?.vocabulary) return analysis;
  const original = analysis.vocabulary, byLanguage = original.byLanguage.filter((item) => item.language !== native), main = byLanguage[0];
  const vocabulary = { ...original, byLanguage, languages: byLanguage.map((item) => item.language),
    lemmaCount: byLanguage.filter((item) => item.unit !== 'characters').reduce((sum, item) => sum + item.count, 0),
    characterCount: native === 'zh' ? 0 : original.characterCount,
    characters: native === 'zh' ? { total: 0, unique: 0, inventory: '' } : original.characters,
    unit: main?.unit || 'lemmas', count: main?.count || 0 };
  return { ...analysis, vocabulary, lemmaCount: vocabulary.lemmaCount, nativeExcluded: !byLanguage.length,
    reading: byLanguage.length ? analysis.reading : null };
}
