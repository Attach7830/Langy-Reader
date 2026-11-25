import { RequestError } from './books.js';

export function vocabularyMeanings({ vocabulary, ai, lookupSynonyms }) {
  return async (book, body, signal) => {
    if (!['translation', 'synonyms', 'definition'].includes(body.mode)) throw new RequestError(422, 'Choose English translation, Spanish synonyms or Spanish definition.');
    const entry = vocabulary.term(book, body);
    let result;
    if (body.mode === 'synonyms' && entry.language === 'es') {
      const dictionary = lookupSynonyms({ word: entry.example.word, lemma: entry.term, language: 'es' });
      const senses = (dictionary.senses || []).filter((sense) => sense.terms?.length).slice(0, 3);
      if (senses.length) result = { text: senses.map((sense) => `${sense.labelLanguage === 'es' && sense.label ? sense.label + ': ' : ''}${sense.terms.join(', ')}`).join('\n'),
        source: 'Dictionary synonyms · possible senses', language: 'es' };
    }
    if (!result) {
      // Missing dictionary synonyms receive a labelled definition, rather than guessed synonyms.
      const mode = body.mode === 'synonyms' && entry.language === 'es' ? 'definition' : body.mode;
      const text = await ai.vocabularyMeaning(entry, mode, signal);
      result = { text, language: body.mode === 'translation' ? 'en' : 'es',
        source: body.mode === 'translation' ? 'AI translation' : mode === 'definition' ? body.mode === 'synonyms' ? 'AI definition · no dictionary synonyms' : 'AI definition' : 'AI Spanish equivalents' };
    }
    return result;
  };
}
