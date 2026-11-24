const median = (values) => { const ordered = values.slice().sort((a, b) => a - b); return ordered[Math.floor(ordered.length / 2)] || 0; };

// PDF.js font sizes can be much larger than their transformed on-screen glyphs.
// Use visible geometry and one size per line; withhold ambiguous boxes rather
// than placing unreadable or overlapping pronunciation over the scan.
export function pdfPinyinLayout(items, viewport) {
  const rows = [];
  for (const item of items.slice().sort((a, b) => a.top + a.rect.height / 2 - b.top - b.rect.height / 2)) {
    const center = item.top + item.rect.height / 2;
    let row = rows.findLast((candidate) => Math.abs(candidate.center - center) < Math.min(candidate.height, item.rect.height) * .45);
    if (!row) { row = { items: [], center, height: item.rect.height }; rows.push(row); }
    row.items.push(item); row.height = median(row.items.map((value) => value.rect.height));
    row.center = median(row.items.map((value) => value.top + value.rect.height / 2));
  }
  const labels = [];
  for (const row of rows) {
    const height = row.height;
    const glyphs = row.items.filter((item) => item.rect.width >= height * .25 && item.rect.width <= height * 2.5
      && item.rect.height >= height * .5 && item.rect.height <= height * 2).sort((a, b) => a.left - b.left);
    const cell = median(glyphs.map((item) => item.rect.width)), ambiguous = new Set();
    for (let i = 1; i < glyphs.length; i++) if (glyphs[i].left + glyphs[i].rect.width / 2 - glyphs[i - 1].left - glyphs[i - 1].rect.width / 2 < cell * .3) {
      ambiguous.add(glyphs[i]); ambiguous.add(glyphs[i - 1]);
    }
    const slots = glyphs.map((item, index) => {
      const center = item.left + item.rect.width / 2;
      const previous = glyphs[index - 1], next = glyphs[index + 1];
      const left = Math.max(viewport.left, center - item.rect.width * .75, previous ? (previous.left + previous.rect.width / 2 + center) / 2 + 2 : -Infinity);
      const right = Math.min(viewport.right, center + item.rect.width * .75, next ? (next.left + next.rect.width / 2 + center) / 2 - 2 : Infinity);
      return { item, left, width: right - left, fit: (right - left) / Math.max(1, [...item.pinyin].length * .58) };
    }).filter((slot) => !ambiguous.has(slot.item) && slot.fit >= 7);
    if (!slots.length) continue;
    const size = Math.min(24, height * .34, ...slots.map((slot) => slot.fit));
    if (size < 7) continue;
    const top = Math.min(...slots.map((slot) => slot.item.top)) - size - 3;
    if (top < viewport.top) continue;
    for (const slot of slots) {
      // A tightly spaced previous line may leave no safe place for ruby text.
      if (rows.some((other) => other !== row && other.items.some((glyph) => glyph.left < slot.left + slot.width && glyph.left + glyph.rect.width > slot.left
        && glyph.top < top + size && glyph.top + glyph.rect.height > top))) continue;
      labels.push({ text: slot.item.pinyin, left: slot.left, top, width: slot.width, size });
    }
  }
  return labels;
}
