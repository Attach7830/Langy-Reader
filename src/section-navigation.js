// Entries are in reading order. Previous means the preceding section, even
// when the reader is partway through the current section.
export function adjacentSection(entries, current, direction, compare = (a, b) => a - b) {
  if (!entries.length) return null;
  let at = -1;
  for (let index = 0; index < entries.length; index++) if (compare(entries[index].position, current) <= 0) at = index;
  const next = direction > 0 ? at + 1 : at - 1;
  return entries[next]?.target ?? null;
}
