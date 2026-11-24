import { baseLanguage } from './language.js';
export function ocrLanguage(code) {
  const aliases = { chi_sim: 'zh-Hans', chi_tra: 'zh-Hant', chi_sim_vert: 'zh-Hans', chi_tra_vert: 'zh-Hant', frk: 'de', srp_latn: 'sr-Latn', uzb_cyrl: 'uz-Cyrl' };
  if (aliases[code]) return aliases[code];
  try { return Intl.getCanonicalLocales(code.replace(/_vert$/u, ''))[0]; } catch { return null; }
}
export function selectedOCRLanguages(available, selected) {
  const result = [];
  for (const language of selected || []) for (const code of available || [])
    if (baseLanguage(ocrLanguage(code), '') === baseLanguage(language, '') && !result.includes(code)) result.push(code);
  return result;
}
export function ocrBookLanguages(book, codes) {
  const detected = [];
  for (const code of codes) {
    const language = ocrLanguage(code);
    if (language && !detected.some((item) => baseLanguage(item) === baseLanguage(language))) detected.push(language);
  }
  if (!detected.length) return { language: book.language, languages: book.languages };
  const languages = detected.map((language) => book.languages?.find((item) => baseLanguage(item) === baseLanguage(language)) || language);
  return { language: languages.some((language) => baseLanguage(language) === baseLanguage(book.language)) ? book.language : languages[0],
    languages: languages.length > 1 || book.languages?.length ? languages : [] };
}
