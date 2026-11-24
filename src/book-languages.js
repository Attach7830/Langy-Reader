import { parseLanguage } from './languages.js';
import { languageName } from './settings.js';
import { baseLanguage } from '../shared/language.js';

export function bookLanguagePicker(form) {
  const limit = form.querySelector('#book-language-limit'), panel = form.querySelector('#book-language-selection');
  const input = form.querySelector('#book-language-choice'), list = form.querySelector('#book-language-list');
  let selected = [];
  function render() {
    panel.hidden = !limit.checked;
    input.disabled = !limit.checked;
    list.replaceChildren(...selected.map((code) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'button quiet small';
      button.textContent = `${languageName(code)} ×`; button.setAttribute('aria-label', `Remove ${languageName(code)}`);
      button.addEventListener('click', () => { selected = selected.filter((value) => value !== code); render(); });
      return button;
    }));
  }
  function add() {
    input.setCustomValidity('');
    if (!input.value.trim()) return;
    const code = parseLanguage(input.value);
    if (!code) throw new Error('Choose a language or enter a valid language code.');
    if (!selected.some((value) => baseLanguage(value) === baseLanguage(code))) {
      if (selected.length >= 20) throw new Error('Choose up to 20 book languages.');
      selected.push(code);
    }
    input.value = ''; input.setCustomValidity(''); render();
  }
  const attempt = () => { try { add(); } catch (error) { input.setCustomValidity(error.message); input.reportValidity(); } };
  form.querySelector('#book-language-add').addEventListener('click', attempt);
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('blur', () => { if (!input.value.trim()) input.setCustomValidity(''); });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (input.value.trim()) { event.preventDefault(); attempt(); }
    else input.setCustomValidity(''); // An empty optional field lets Enter save the book.
  });
  limit.addEventListener('change', () => { input.setCustomValidity(''); render(); });
  return {
    set(languages = []) { selected = [...languages]; limit.checked = selected.length > 1; input.value = ''; input.setCustomValidity(''); render(); },
    value() {
      if (!limit.checked) return [];
      input.setCustomValidity('');
      if (input.value.trim()) add();
      return [...selected];
    },
  };
}
