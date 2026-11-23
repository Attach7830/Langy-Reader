// Keep unmeasured books after valid rates, including a genuine zero.
export function compareVocabularyDensity(left, right, belowThreshold = false) {
  const key = belowThreshold ? 'belowThresholdDensity' : 'unfamiliarDensity';
  const rate = (value) => Number.isFinite(value?.[key]) && value[key] >= 0 ? value[key] : Infinity;
  const a = rate(left), b = rate(right);
  return a === b ? 0 : a < b ? -1 : 1;
}
