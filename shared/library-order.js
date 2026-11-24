import { compareVocabularyDensity } from './vocabulary-ranking.js';

export function compareLibraryBooks(a, b, sort = 'recent') {
  const pinned = Number(Boolean(b.starredAt)) - Number(Boolean(a.starredAt));
  if (pinned) return pinned;
  if (['familiar', 'known'].includes(sort)) {
    const demand = compareVocabularyDensity(a.familiarity, b.familiarity, sort === 'known');
    if (demand) return demand;
  }
  return (b.starredAt || b.addedAt) - (a.starredAt || a.addedAt) || a.id.localeCompare(b.id);
}
