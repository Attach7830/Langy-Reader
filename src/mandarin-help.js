import { element } from './ui.js';

export function mandarinHelp(entry) {
  const box = element('div', 'mandarin-help');
  box.lang = 'en';
  const pronunciation = element('div', 'mandarin-pronunciation', entry.pinyin || 'Pronunciation unavailable');
  pronunciation.lang = 'zh-Latn'; box.append(pronunciation);
  box.append(element('div', 'word-sense-source', 'Whole word · English meaning (CC-CEDICT)'));
  const senses = entry.senses.length ? entry.senses.slice(0, 4) : [{ meanings: ['No dictionary entry for this word.'] }];
  for (const sense of senses) {
    const row = element('div', 'word-gloss');
    if (sense.pinyin) row.append(element('span', 'mandarin-reading', `${sense.pinyin} · `));
    row.append(document.createTextNode(sense.meanings.slice(0, 5).join('; '))); box.append(row);
  }
  box.append(element('div', 'word-sense-source mandarin-character-heading', 'Individual characters · English meanings'));
  for (const character of entry.characters) {
    const row = element('div', 'mandarin-character');
    const head = element('div', 'mandarin-character-name');
    const glyph = element('strong', '', character.character); glyph.lang = 'zh';
    head.append(glyph, element('span', 'mandarin-reading', character.pinyin || 'Pronunciation unavailable'));
    row.append(head, element('div', 'word-gloss', character.meanings.length ? character.meanings.slice(0, 5).join('; ') : 'Meaning unavailable in the bundled dictionaries.'));
    const other = character.readings.filter((reading) => reading !== character.pinyin);
    if (other.length) row.append(element('div', 'word-sense-source', `Other readings: ${other.join(', ')}`));
    box.append(row);
  }
  box.append(element('div', 'word-sense-source', entry.note));
  return box;
}
