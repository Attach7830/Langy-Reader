import { searchBook } from '../shared/book-search.js';
import { pinyinCharacters } from '../shared/mandarin-pinyin.js';
import { baseLanguage } from '../shared/language.js';

export function offlineLookup(pack, path, body) {
  if (path.startsWith(`/api/books/${pack.book.id}/search?`)) return { results: searchBook(pack.sections, new URL(path, 'https://local.test').searchParams.get('q'), 100) };
  if (path === '/api/mandarin/pinyin') return { characters: pinyinCharacters(body.text) };
  if (path === '/api/mandarin/readings') return { characters: [...body.characters].map((character) => ({ character, pinyin: pack.dictionary.chinese[character]?.pinyin || '' })) };
  if (path === '/api/mandarin/word') {
    const points = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(body.text)];
    const hit = points.find((part) => part.index <= body.offset && part.index + part.segment.length > body.offset);
    if (!hit) throw new Error('Choose a Chinese character.');
    let from = hit.index, word = hit.segment, entry = pack.dictionary.chinese[word];
    if (!entry) {
      const candidates = [];
      for (let start = Math.max(0, body.offset - 7); start <= body.offset; start++) for (let end = body.offset + 1; end <= Math.min(body.text.length, start + 8); end++) {
        const candidate = body.text.slice(start, end);
        if (pack.dictionary.chinese[candidate]) candidates.push({ from: start, word: candidate, entry: pack.dictionary.chinese[candidate] });
      }
      candidates.sort((a, b) => b.word.length - a.word.length);
      if (candidates.length) ({ from, word, entry } = candidates[0]);
    }
    if (!entry) throw new Error('This word has no saved offline dictionary entry.');
    return { ...entry, from, to: from + word.length };
  }
  if (path === '/api/ai/word') {
    const language = baseLanguage(body.language), key = JSON.stringify([language, String(body.word).toLocaleLowerCase(language)]);
    const found = pack.dictionary.lexical[key] || pack.dictionary.lexical[JSON.stringify([language, String(body.lemma || '').toLocaleLowerCase(language)])];
    if (!found) throw new Error('This word has no saved offline dictionary entry.');
    if (body.mode === 'synonyms') return found;
    const target = body.mode === 'translation' ? baseLanguage(body.targetLanguage || 'en') : language;
    const senses = (found.senses || []).filter((sense) => baseLanguage(sense.labelLanguage) === target && sense.label);
    return senses.length ? { text: senses.map((sense) => sense.label).join('\n'), language: target, source: 'Offline dictionary' }
      : { text: 'No saved dictionary meaning in this language. Synonym mode may have local dictionary entries.', language: 'en', status: 'missing' };
  }
  throw new Error('This feature needs a connection to your Langy server.');
}
