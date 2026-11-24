import { element } from './ui.js';
import { parseLanguage } from './languages.js';
import { defaults, languageName } from './settings.js';

export function readingLanguagesPicker({ host, input, add, error }) {
  let selected = [];
  function render() {
    host.replaceChildren(...selected.map((code) => {
      const chip = element('button', 'button quiet small', `${languageName(code)} ×`); chip.type = 'button';
      chip.setAttribute('aria-label', `Remove ${languageName(code)}`);
      chip.addEventListener('click', () => { selected = selected.filter((item) => item !== code); render(); }); return chip;
    }));
  }
  function addLanguage() {
    if (!input.value.trim()) return;
    const code = parseLanguage(input.value);
    if (!code) throw new Error('Choose a reading language or enter a valid language code.');
    if (!selected.includes(code)) { if (selected.length >= 20) throw new Error('Choose up to 20 reading languages.'); selected.push(code); }
    input.value = ''; render();
  }
  add.addEventListener('click', () => { try { addLanguage(); error(''); } catch (failure) { error(failure.message); } });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && input.value.trim()) { event.preventDefault(); add.click(); } });
  return { set(values) { selected = [...(Array.isArray(values) && values.length ? values : defaults.readingLanguages)]; input.value = ''; render(); },
    value() { addLanguage(); if (!selected.length) throw new Error('Choose at least one reading language.'); return [...selected]; } };
}

export function bookLanguageSuggestions(values, host = document.querySelector('#book-languages')) {
  const languages = Array.isArray(values) && values.length ? values : defaults.readingLanguages;
  host.replaceChildren(...languages.map((code) => new Option(languageName(code), code)));
}
