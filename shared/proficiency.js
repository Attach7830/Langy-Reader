export const comprehensionLevels = [
  { value: 0, label: 'Not estimated yet' },
  { value: 1, label: 'Familiar words and short phrases', range: 'Novice', description: 'I understand familiar words and brief phrases in everyday contexts.' },
  { value: 2, label: 'Straightforward everyday messages', range: 'Novice–Intermediate', description: 'I understand the main message of straightforward material on familiar topics.' },
  { value: 3, label: 'Connected stories and factual accounts', range: 'Intermediate–Advanced', description: 'I follow connected accounts across time, including relevant details.' },
  { value: 4, label: 'Complex arguments and implied meaning', range: 'Advanced–Superior', description: 'I follow extended arguments and often understand implication or an unfamiliar perspective.' },
];

export function proficiencyEstimate(check, evidence) {
  const level = comprehensionLevels[check || 0];
  const hours = evidence.trackedHours + evidence.outsideHours;
  return { range: level.range || null, basis: level.range ? 'Comprehension self-check' : 'Add a comprehension self-check for a tentative range',
    evidence: hours > 0 && evidence.seen > 0 ? 'Self-check supported by an exposure record' : hours > 0 || evidence.seen > 0 ? 'Partial exposure record' : 'Self-report only',
    inputHours: hours, seen: evidence.seen, likelyKnown: evidence.likelyKnown };
}

// Preserve real observations, without inventing intermediate growth points.
export function compactHistory(points, limit = 180) {
  if (points.length <= limit) return points;
  return Array.from({ length: limit }, (_, index) => points[Math.round(index * (points.length - 1) / (limit - 1))]);
}
