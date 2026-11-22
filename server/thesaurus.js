import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { normalizeLanguage, RequestError } from './books.js';
import { readingNotes } from './reading-lexicon.js';

export const thesaurusDir = fileURLToPath(new URL('./thesaurus-data/', import.meta.url));
export const thesaurusFile = fileURLToPath(new URL('./thesaurus-data/wordnet.sqlite', import.meta.url));
export const wiktionaryFile = fileURLToPath(new URL('./thesaurus-data/wiktionary.sqlite', import.meta.url));

export function dictionaryLanguage(language) {
  const base = new Intl.Locale(language).language;
  return base === 'no' ? 'nb' : base;
}

export const wordKey = (word, language) => word.normalize('NFC').toLocaleLowerCase(language);

const suffixes = {
  en: {
    n: [['s', ''], ['ses', 's'], ['ves', 'f'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'], ['ies', 'y']],
    v: [['s', ''], ['ies', 'y'], ['es', 'e'], ['es', ''], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', '']],
    a: [['er', ''], ['est', ''], ['er', 'e'], ['est', 'e']],
  },
  es: {
    n: [['ces', 'z'], ['es', ''], ['s', '']],
    a: [['os', 'o'], ['as', 'a'], ['as', 'o'], ['es', ''], ['a', 'o']],
  },
};

export function openThesaurus() {
  const db = existsSync(thesaurusFile) ? new DatabaseSync(thesaurusFile, { readOnly: true }) : null;
  const wiki = existsSync(wiktionaryFile) ? new DatabaseSync(wiktionaryFile, { readOnly: true }) : null;
  const languages = new Set([
    ...(db?.prepare('SELECT DISTINCT language FROM lexemes').all() ?? []),
    ...(wiki?.prepare('SELECT DISTINCT language FROM entries').all() ?? []),
  ].map((row) => row.language));
  const find = db?.prepare(`
    SELECT senses.pos, senses.label, senses.terms
      FROM lexemes JOIN senses ON lexemes.sense = senses.id
     WHERE lexemes.language = ? AND lexemes.word = ?
     ORDER BY lexemes.sense
  `);
  const exceptions = db?.prepare('SELECT lemma, pos FROM english_exceptions WHERE word = ?');
  const wikiEntries = wiki?.prepare('SELECT pos, senses FROM entries WHERE language = ? AND word = ? ORDER BY rowid');
  const wikiForms = wiki?.prepare('SELECT lemma, pos FROM forms WHERE language = ? AND word = ? ORDER BY lemma, pos LIMIT 12');
  const missing = (text) => ({ text, language: 'en', status: 'missing' });

  function sensesFor(language, lemma, pos) {
    const dictionary = (wikiEntries?.all(language, lemma) ?? [])
      .filter((row) => !pos || row.pos === pos)
      .flatMap((row) => JSON.parse(row.senses).map((sense) => ({
        ...sense, lemma, labelLanguage: 'es', source: 'Wikcionario',
      })));
    const wordNet = (find?.all(language, lemma) ?? [])
      .filter((row) => !pos || row.pos === pos)
      .map((row) => ({ label: row.label, terms: JSON.parse(row.terms), lemma, labelLanguage: 'en', source: 'WordNet' }));
    return [...readingNotes(language, lemma), ...dictionary, ...wordNet];
  }

  return (body) => {
    const language = normalizeLanguage(body.language);
    const word = typeof body.word === 'string' ? body.word.trim() : '';
    if (!language || !word || word.length > 100) throw new RequestError(422, 'Choose a word and a book language.');
    const code = dictionaryLanguage(language);
    const key = wordKey(word, code);
    let rows = sensesFor(code, key);
    const contextualLemma = typeof body.lemma === 'string' ? body.lemma.trim().slice(0, 100) : '';
    if (contextualLemma && wordKey(contextualLemma, code) !== key) {
      const contextualRows = sensesFor(code, wordKey(contextualLemma, code));
      if (contextualRows.length) rows = contextualRows;
    }
    if (!rows.length && !db && !wiki) return missing('The local synonym dictionaries are unavailable.');
    if (!rows.length && !languages.has(code)) return missing('No local dictionary entries for this language.');
    if (!rows.length) {
      const detected = typeof body.lemma === 'string' ? body.lemma.trim().slice(0, 100) : '';
      if (detected && wordKey(detected, code) !== key) rows = sensesFor(code, wordKey(detected, code));
    }
    if (!rows.length) {
      const forms = wikiForms?.all(code, key) ?? [];
      rows = forms.flatMap(({ lemma, pos }) => sensesFor(code, lemma, pos));
    }
    if (!rows.length) {
      const candidates = new Map();
      function addCandidate(form, pos) {
        const matches = sensesFor(code, form, pos);
        if (matches.length) candidates.set(form, [...(candidates.get(form) ?? []), ...matches]);
      }
      for (const { lemma, pos } of code === 'en' ? exceptions?.all(key) ?? [] : []) addCandidate(lemma, pos);
      if (!candidates.size) {
        for (const [pos, rules] of Object.entries(suffixes[code] ?? {})) {
          for (const [from, to] of rules) {
            if (key.length > from.length + 1 && key.endsWith(from)) {
              addCandidate(key.slice(0, -from.length) + to, pos);
            }
          }
        }
      }
      if (candidates.size === 1) rows = candidates.values().next().value;
    }

    const groups = new Map();
    for (const row of rows) {
      const terms = row.terms.filter((term) => {
        const termKey = wordKey(term, code);
        return termKey !== row.lemma && termKey !== key;
      }).slice(0, 4);
      const identity = JSON.stringify([row.lemma, row.label, terms]);
      if ((row.label || terms.length) && !groups.has(identity)) groups.set(identity, { ...row, terms });
    }
    if (!groups.size) return missing('No dictionary entry for this word.');
    const meanings = [...groups.values()];
    const firstByLemma = new Map();
    for (const sense of meanings) {
      if (!firstByLemma.has(sense.lemma)) firstByLemma.set(sense.lemma, sense);
    }
    const senses = [...new Set([
      ...firstByLemma.values(), ...meanings.filter((sense) => sense.terms.length), ...meanings,
    ])].slice(0, 4);
    const synonyms = senses.filter((sense) => sense.terms.length);
    const text = (synonyms.length ? synonyms.map(({ terms }) => terms.join(', ')) : senses.map(({ label }) => label)).join('\n');
    const lemma = firstByLemma.size === 1 ? firstByLemma.keys().next().value : key;
    return {
      text,
      senses,
      language,
      status: synonyms.length ? 'synonyms' : 'meaning',
      ...(lemma !== key ? { lemma } : {}),
    };
  };
}
