// Missing alignment on a page must not seek to the beginning of its chapter.
// Prefer an aligned visible word, then interpolate between source-text anchors.
export function visibleAudioPosition(local, timed, mapped, segment) {
  if (segment?.pageOnly) return { time: segment.start, from: 0 };
  const visible = local?.words?.find((word) => local.visible(word));
  const anchors = timed.flatMap((stamp) => { const word = mapped.get(stamp.index); return word ? [{ word, time: stamp.start }] : []; });
  const aligned = anchors.find(({ word }) => local.visible(word));
  if (aligned) return { time: aligned.time, from: visible?.from ?? aligned.word.from };
  if (!segment) return null;
  if (!visible) return { time: segment.start, from: 0 };
  const length = Math.max(visible.to, local.text?.length || local.words.at(-1)?.to || 1);
  const before = anchors.findLast(({ word }) => word.from <= visible.from);
  const after = anchors.find(({ word }) => word.from > visible.from);
  const left = before ? { from: before.word.from, time: before.time } : { from: 0, time: segment.start };
  const right = after ? { from: after.word.from, time: after.time } : { from: length, time: segment.end };
  const fraction = Math.max(0, Math.min(1, (visible.from - left.from) / Math.max(1, right.from - left.from)));
  return { time: left.time + fraction * Math.max(0, right.time - left.time), from: visible.from };
}
