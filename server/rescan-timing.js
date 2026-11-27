const usable = (stamp, duration) => stamp && !stamp.estimated && !stamp.review && Number.isFinite(stamp.start) && Number.isFinite(stamp.end)
  && stamp.start >= 0 && stamp.end > stamp.start && stamp.end <= duration + .01;
export const confirmed = (timings, duration) => timings.map((stamp) => usable(stamp, duration) ? { ...stamp } : null);

// Bound recognition by unchanged neighbouring matches. Long gaps are broken into
// short clips so memory use and background work stay bounded on a home server.
export function rescanWindows(words, timings, duration) {
  const anchors = confirmed(timings, duration);
  const windows = [];
  for (let from = 0; from < words.length;) {
    if (anchors[from]) { from++; continue; }
    let to = from + 1;
    while (to < words.length && !anchors[to]) to++;
    const left = from ? anchors[from - 1].end : 0;
    const right = to < words.length ? anchors[to].start : duration;
    if (right - left > .02) {
      const count = Math.max(1, Math.ceil((right - left) / 45), Math.ceil((to - from) / 140));
      for (let part = 0; part < count; part++) {
        const first = Math.min(to - 1, from + Math.floor((to - from) * part / count));
        const last = Math.max(first + 1, from + Math.floor((to - from) * (part + 1) / count));
        const start = left + (right - left) * part / count;
        const end = left + (right - left) * (part + 1) / count;
        windows.push({ from: first, to: last, left, right,
          start: Math.max(0, start - 2), end: Math.min(duration, end + 2),
          contextFrom: Math.max(0, first - 6), contextTo: Math.min(words.length, last + 6) });
      }
    }
    from = to;
  }
  return coalesceRescanWindows(windows);
}

// Nearby gaps share a recognition pass, including the reliable words between
// them as context. Keep the existing clip and source-word limits.
export function coalesceRescanWindows(windows) {
  const result = [];
  for (const window of windows) {
    const previous = result.at(-1);
    if (previous && window.from >= previous.from && window.start >= previous.start
      && window.start <= previous.end + 8 && Math.max(previous.end, window.end) - previous.start <= 49
      && Math.max(previous.to, window.to) - previous.from <= 140) {
      previous.to = Math.max(previous.to, window.to); previous.right = Math.max(previous.right, window.right);
      previous.end = Math.max(previous.end, window.end); previous.contextTo = Math.max(previous.contextTo, window.contextTo);
    } else result.push({ ...window });
  }
  return result;
}

export function mergeRescan(timings, window, candidates, duration, permitted = () => true, inPlace = false) {
  const result = inPlace ? timings : timings.map((stamp) => stamp && { ...stamp });
  const next = new Float64Array(Math.max(0, Math.min(result.length, window.to) - window.from));
  let boundary = window.right;
  for (let index = Math.min(result.length, window.to) - 1; index >= window.from; index--) {
    next[index - window.from] = boundary;
    if (usable(result[index], duration)) boundary = Math.min(boundary, result[index].start);
  }
  let end = window.left, added = 0;
  for (let index = window.from; index < window.to; index++) {
    if (usable(result[index], duration)) { end = result[index].end; continue; }
    const candidate = candidates?.[index - window.contextFrom];
    if (!candidate || candidate.estimated || candidate.review || !Number.isFinite(candidate.start) || !Number.isFinite(candidate.end)) continue;
    const start = candidate.start + window.start, finish = candidate.end + window.start;
    if (start < Math.max(window.left, end) - .001 || finish > next[index - window.from] + .001 || finish <= start
      || candidate.start < 0 || candidate.end > window.end - window.start + .01 || !permitted(index, start, finish)) continue;
    const a = Math.max(start, end, window.left), b = Math.min(finish, window.right, next[index - window.from], duration);
    if (b <= a) continue;
    result[index] = { start: a, end: b, review: false };
    end = result[index].end; added++;
  }
  return { timings: result, added };
}
