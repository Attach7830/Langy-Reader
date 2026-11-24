export function searchBook(sections, query, limit = 100) {
  if (typeof query !== 'string' || !query.trim() || query.length > 120) return [];
  const normalize = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/\s/gu, ' ');
  const needle = normalize(query.trim()), results = [];
  for (const section of sections) {
    let text = '', offset = 0; const from = [], to = [];
    for (const point of section.text) {
      const normalized = normalize(point);
      for (let n = 0; n < normalized.length; n++) { from.push(offset); to.push(offset + point.length); }
      text += normalized; offset += point.length;
    }
    for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + Math.max(1, needle.length))) {
      const first = from[start], last = to[start + needle.length - 1];
      results.push({ key: section.key, title: section.title, from: first, to: last,
        before: section.text.slice(Math.max(0, first - 70), first), match: section.text.slice(first, last), after: section.text.slice(last, last + 90) });
      if (results.length >= limit) return results;
    }
  }
  return results;
}
