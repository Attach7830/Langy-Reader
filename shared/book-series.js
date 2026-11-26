export const seriesKey = (name) => typeof name === 'string' ? name.trim().normalize('NFKC').toLocaleLowerCase() : '';
export const seriesLabel = (book) => book.series ? book.series + (book.seriesIndex == null ? '' : ` · Book ${book.seriesIndex}`) : '';

export function compareSeries(a, b) {
  const left = seriesKey(a.series), right = seriesKey(b.series);
  if (Boolean(left) !== Boolean(right)) return left ? -1 : 1;
  const name = left.localeCompare(right, undefined, { numeric: true });
  if (name) return name;
  const index = (book) => book.seriesIndex != null && Number.isFinite(book.seriesIndex) ? book.seriesIndex : Infinity;
  if (index(a) !== index(b)) return index(a) < index(b) ? -1 : 1;
  return (a.title || '').localeCompare(b.title || '', undefined, { numeric: true });
}
