import { element } from './ui.js';
import { meaningChoices } from './meaning-choices.js';

export function mandarinHelp(entry, choose = (values, label) => meaningChoices(values, { label }).root) {
  const box = element('div', 'mandarin-help');
  box.lang = 'en';
  const pronunciation = element('div', 'mandarin-pronunciation', entry.pinyin || 'Pronunciation unavailable');
  pronunciation.lang = 'zh-Latn'; box.append(pronunciation);
  box.append(element('div', 'word-sense-source', 'Whole word · English meaning (CC-CEDICT)'));
  const senses = entry.senses.length ? entry.senses : [{ meanings: ['No dictionary entry for this word.'] }];
  const meanings = senses.flatMap((sense) => sense.meanings.map((meaning) => (sense.pinyin ? `${sense.pinyin} · ` : '') + meaning));
  box.append(choose(meanings, `${entry.word} meaning`, 'whole'));
  box.append(element('div', 'word-sense-source mandarin-character-heading', 'Individual characters · English meanings'));
  for (const [index, character] of entry.characters.entries()) {
    const row = element('div', 'mandarin-character');
    const head = element('div', 'mandarin-character-name');
    const glyph = element('strong', '', character.character); glyph.lang = 'zh';
    head.append(glyph, element('span', 'mandarin-reading', character.pinyin || 'Pronunciation unavailable'));
    row.append(head, choose(character.meanings.length ? character.meanings : ['Meaning unavailable in the bundled dictionaries.'], `${character.character} meaning`, `character-${index}`));
    const other = character.readings.filter((reading) => reading !== character.pinyin);
    if (other.length) row.append(element('div', 'word-sense-source', `Other readings: ${other.join(', ')}`));
    box.append(row);
  }
  box.append(element('div', 'word-sense-source', entry.note));
  return box;
}
