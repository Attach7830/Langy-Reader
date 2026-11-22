import { baseLanguage } from '../shared/language.js';

const presets = { en: 'af_heart', es: 'ef_dora', pt: 'pf_dora', zh: 'zf_xiaobei', ja: 'jf_alpha', fr: 'ff_siwis', it: 'if_sara', hi: 'hf_alpha' };
const voiceLanguages = { a: 'en', b: 'en', e: 'es', p: 'pt', z: 'zh', j: 'ja', f: 'fr', i: 'it', h: 'hi' };
export function voiceFor(config, language) {
  const code = baseLanguage(language);
  if (config.voicesByLanguage?.[code]) return config.voicesByLanguage[code];
  const voiceLanguage = /^[abepzjfih][fm]_/u.test(config.voice) ? voiceLanguages[config.voice[0]] : null;
  if (config.autoLanguageVoices === false || !voiceLanguage || voiceLanguage === code) return config.voice;
  return presets[code] || config.voice;
}
export function narrationOptions(config, languages) {
  const options = { voice: config.voice, model: config.model, speed: config.speed, baseUrl: config.baseUrl };
  const voiceMap = Object.fromEntries([...new Set(languages.map((language) => baseLanguage(language)))].map((language) => [language, voiceFor(config, language)])
    .filter(([, voice]) => voice !== config.voice));
  if (Object.keys(voiceMap).length) options.voiceMap = voiceMap;
  return options;
}
export function sectionLanguages(sections, fallback) {
  const languages = sections.flatMap((section) => (Array.isArray(section.languages) ? section.languages : JSON.parse(section.languages || '[]')).map((part) => part.language));
  return languages.length ? languages : [baseLanguage(fallback)];
}
