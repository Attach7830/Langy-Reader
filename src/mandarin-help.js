import { element } from './ui.js';
import { meaningChoices } from './meaning-choices.js';

export function mandarinHelp(entry, choose = (values, label, key, render) => meaningChoices(values, { label, render }).root, select = () => {}, extra = '') {
  const box = element('div', 'mandarin-help');
  box.lang = 'en';
  const cards = [{ word: entry.word, pinyin: entry.pinyin, whole: true,
    meanings: entry.senses.flatMap((sense) => sense.meanings) },
  ...(entry.characters || []).filter(() => [...entry.word].length > 1).map((item) => ({ ...item, word: item.character }))];
  box.append(choose(cards.map((card) => `${card.word} · ${card.pinyin || ''}`), 'word or character', 'mandarin-stack', (index) => {
    const card = cards[index], row = element('div', 'mandarin-card');
    select(card.word);
    const pronunciation = element('div', 'mandarin-pronunciation', card.pinyin || 'Pronunciation unavailable');
    pronunciation.lang = 'zh-Latn';
    row.append(pronunciation, element('div', 'word-sense-source', card.whole ? 'Whole word · English meaning (CC-CEDICT)' : 'Character · English meaning'));
    row.append(element('div', 'mandarin-definition', card.meanings[0] || 'Meaning unavailable in the bundled dictionaries.'));
    if (card.meanings.length > 1) {
      const alternatives = element('details', 'mandarin-alternatives');
      alternatives.append(element('summary', '', 'More meanings'), element('div', '', card.meanings.slice(1).join('; ')));
      row.append(alternatives);
    }
    const other = (card.readings || []).filter((reading) => reading !== card.pinyin);
    if (other.length) row.append(element('div', 'word-sense-source', `Other readings: ${other.join(', ')}`));
    if (card.whole && extra) row.append(element('div', 'word-sense', extra));
    return row;
  }));
  return box;
}
