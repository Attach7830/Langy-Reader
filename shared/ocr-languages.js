import { baseLanguage } from './language.js';
export function ocrBookLanguages(book, codes) {
  const aliases = { chi_sim: 'zh-Hans', chi_tra: 'zh-Hant', chi_sim_vert: 'zh-Hans', chi_tra_vert: 'zh-Hant', frk: 'de', srp_latn: 'sr-Latn', uzb_cyrl: 'uz-Cyrl' };
  const detected = [];
  for (const code of codes) {
    let language = aliases[code];
    try { language ||= Intl.getCanonicalLocales(code)[0]; } catch {}
    if (language && !detected.some((item) => baseLanguage(item) === baseLanguage(language))) detected.push(language);
  }
  if (!detected.length) return { language: book.language, languages: book.languages };
  const languages = detected.map((language) => book.languages?.find((item) => baseLanguage(item) === baseLanguage(language)) || language);
  return { language: languages.some((language) => baseLanguage(language) === baseLanguage(book.language)) ? book.language : languages[0],
    languages: languages.length > 1 || book.languages?.length ? languages : [] };
}
