import { RequestError } from './books.js';

export function validatePageStarts(segments, duration, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(422, 'Provide PDF page start times.');
  const keys = new Set(segments.map((segment) => segment.key));
  if (Object.keys(value).some((key) => !keys.has(key))) throw new RequestError(422, 'Choose pages included in this recording.');
  let previous = -Infinity;
  const changes = {};
  for (const [index, segment] of segments.entries()) {
    const time = Object.hasOwn(value, segment.key) ? value[segment.key] : segment.start;
    if (!Number.isFinite(time) || time < 0 || time >= duration || time <= previous || (!index && time !== segment.start)) {
      throw new RequestError(422, 'Page starts must be in order and inside the recording. The first page keeps its start.');
    }
    if (time !== segment.start) changes[segment.key] = time;
    previous = time;
  }
  return changes;
}

export function applyPageStarts(segments, markers, starts) {
  if (!Object.keys(starts).length) return { segments, markers };
  const shifts = new Map();
  const adjusted = segments.map((part, index) => {
    const next = segments[index + 1];
    const start = starts[part.key] ?? part.start;
    const end = next ? starts[next.key] ?? part.end : part.end;
    if (start === part.start && end === part.end) return part;
    const ratio = (end - start) / (part.end - part.start);
    shifts.set(part.key, { from: part.start, start, ratio });
    return { ...part, start, end, scale: part.scale * ratio, approximate: true, pageOnly: true };
  });
  return { segments: adjusted, markers: markers.map((marker) => {
    const shift = shifts.get(marker.key);
    return shift ? { ...marker, time: shift.start + (marker.time - shift.from) * shift.ratio } : marker;
  }) };
}
