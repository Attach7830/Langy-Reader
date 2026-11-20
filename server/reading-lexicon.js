// Short reading notes and regional equivalents written for Langy from the cited sources.
const notes = [
  {
    lemma: 'tiliche',
    forms: { tiliche: ['trasto', 'cachivache'], tiliches: ['trastos', 'cachivaches'] },
    label: 'Pertenencias viejas o de poco valor.',
    source: 'Diccionario del español de México',
    url: 'https://dem.colmex.mx/ver/tiliche',
  },
  {
    lemma: 'entilichada',
    forms: { entilichada: [] },
    label: 'Llena de trastos o de muebles guardados.',
    source: 'Pedro Páramo · nota de lectura',
    url: 'https://bindani.izt.uam.mx/downloads/5t34sj77k?locale=es',
    readingNote: true,
  },
  {
    lemma: 'saponaria',
    forms: { saponaria: ['jabonera'], saponarias: ['jaboneras'] },
    label: 'Planta herbácea conocida como jabonera.',
    source: 'Diccionario de la lengua española',
    url: 'https://dle.rae.es/saponaria',
  },
];

const spanishNotes = new Map(notes.flatMap(({ lemma, forms, ...note }) => Object.entries(forms).map(([word, terms]) => [
  word, { ...note, lemma, terms, labelLanguage: 'es' },
])));

export function readingNotes(language, word) {
  const note = language === 'es' && spanishNotes.get(word);
  return note ? [note] : [];
}
