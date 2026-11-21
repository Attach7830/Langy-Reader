const valid = (stamp, duration) => stamp && Number.isFinite(stamp.start) && Number.isFinite(stamp.end)
  && stamp.start >= 0 && stamp.start < duration && stamp.end > stamp.start && stamp.end <= duration + .2;

export function hasUsableTimings(value, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return false;
  try {
    const timings = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(timings) && timings.some((stamp) => valid(stamp, duration));
  } catch { return false; }
}

// Estimates support page following, but must never be presented as matched word highlights.
export function synchronizeChunk(words, aligned, duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new TypeError('Invalid audio duration.');
  const timings = words.map((word) => ({ ...word, start: null, end: null }));
  const anchors = [{ index: -1, end: 0 }];
  for (const [index, stamp] of (Array.isArray(aligned) ? aligned : []).entries()) {
    if (!timings[index] || !valid(stamp, duration) || stamp.start < anchors.at(-1).end) continue;
    Object.assign(timings[index], { start: stamp.start, end: Math.min(duration, stamp.end),
      review: Boolean(stamp.review), ...(stamp.estimated ? { estimated: true } : {}) });
    anchors.push({ index, ...timings[index] });
  }
  anchors.push({ index: words.length, start: duration });
  for (let index = 1; index < anchors.length; index++) {
    const left = anchors[index - 1], right = anchors[index];
    const missing = timings.slice(left.index + 1, right.index);
    const span = right.start - left.end;
    if (!missing.length || span <= 0) continue;
    const weights = missing.map(({ word }) => Math.max(1, [...word].length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let elapsed = 0;
    for (const [position, stamp] of missing.entries()) {
      stamp.start = left.end + span * elapsed / total;
      elapsed += weights[position];
      stamp.end = position === missing.length - 1 ? right.start : left.end + span * elapsed / total;
      stamp.estimated = stamp.review = true;
    }
  }
  return timings;
}
