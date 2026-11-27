import { RequestError } from './books.js';
import { textWords } from '../shared/reading-text.js';
import { hasHan, baseLanguage } from '../shared/language.js';
import { setImmediate as yieldLoop } from 'node:timers/promises';

export function offlinePacks({ learning, mandarin, lookupSynonyms }) {
  return async (book, selected) => {
    const sections = learning.textSections(book, { original: true }), lexical = {}, chinese = {}, candidates = new Set();
    const words = new Map(); let scanned = 0;
    for (const section of sections) {
      for (const token of section.tokens.length ? section.tokens : textWords(section.text, book.language)) {
        const language = baseLanguage(token.language || book.language);
        if (language !== 'zh') words.set(JSON.stringify([language, token.word.toLocaleLowerCase(language)]), { language, word: token.word, lemma: token.lemma });
        if (words.size > 150000) throw new RequestError(422, 'Split this book into smaller volumes before saving it offline.');
        if (++scanned % 2000 === 0) await yieldLoop();
      }
      for (const run of section.text.matchAll(/[\p{Script=Han}〇]+/gu)) {
        for (const item of new Intl.Segmenter('zh', { granularity: 'word' }).segment(run[0])) candidates.add(item.segment);
        const points = [...run[0]];
        for (let n = 0; n < points.length; n++) {
          for (let length = 1; length <= Math.min(4, points.length - n); length++) candidates.add(points.slice(n, n + length).join(''));
          if (words.size + candidates.size > 150000) throw new RequestError(422, 'Split this book into smaller volumes before saving it offline.');
          if (++scanned % 2000 === 0) await yieldLoop();
        }
      }
    }
    if (words.size + candidates.size > 150000) throw new RequestError(422, 'This book is too large for one offline dictionary pack. Split it into smaller volumes.');
    let processed = 0;
    for (const [key, value] of words) {
      lexical[key] = lookupSynonyms(value);
      if (++processed % 300 === 0) await yieldLoop();
    }
    for (const word of candidates) {
      if (!hasHan(word) || word.length > 100) continue;
      const entry = mandarin.lookup({ text: word, offset: 0 });
      if (entry.word === word) chinese[word] = entry;
      if (++processed % 300 === 0) await yieldLoop();
    }
    const narration = learning.narration(book, selected);
    if (selected && narration.audio.id !== selected) throw new RequestError(409, 'That recording changed. Choose a current recording and retry.');
    return { version: 1, book, analysis: learning.info(book), sections, dictionary: { lexical, chinese }, narration,
      units: sections.map((section) => learning.unit(book, section.key, narration.audio.state === 'ready' ? narration.audio.id : undefined)),
      created: Date.now() };
  };
}
