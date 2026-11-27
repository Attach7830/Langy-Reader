import { $ } from './ui.js';
import { parseLanguage } from './languages.js';
import { languageName } from './settings.js';

export function languageDefaultsEditor() {
  const mode = $('#language-defaults-mode'), panel = $('#language-defaults-panel'), choice = $('#language-default-language');
  const translation = $('#language-translation-default'), summary = $('#language-summary-default');
  let drafts = {}, selected = '';
  function capture() { if (selected) drafts[selected] = { translationLanguage: translation.value.trim(), summaryLanguage: summary.value.trim() }; }
  function show() {
    selected = choice.value;
    translation.value = drafts[selected]?.translationLanguage || '';
    summary.value = drafts[selected]?.summaryLanguage || '';
    panel.hidden = mode.value !== 'per-language';
    translation.disabled = summary.disabled = !selected || panel.hidden;
  }
  mode.addEventListener('change', () => { capture(); show(); });
  choice.addEventListener('change', () => { capture(); show(); });
  return {
    languages(values) {
      capture(); const previous = choice.value;
      choice.replaceChildren(...values.map((code) => new Option(languageName(code), code)));
      choice.value = values.includes(previous) ? previous : values[0] || ''; show();
    },
    set(preferences) { drafts = structuredClone(preferences.languageDefaults || {}); mode.value = preferences.languageDefaultsMode || 'shared'; show(); },
    value() {
      capture(); const values = {};
      for (const [language, settings] of Object.entries(drafts)) {
        if (!settings) { values[language] = null; continue; }
        values[language] = {};
        for (const field of ['translationLanguage', 'summaryLanguage']) {
          const raw = settings[field]?.trim() || '', target = raw ? parseLanguage(raw) : null;
          if (raw && !target) throw new Error(`Choose a valid ${field === 'translationLanguage' ? 'translation' : 'summary'} language for ${languageName(language)}.`);
          values[language][field] = target;
        }
      }
      return { languageDefaultsMode: mode.value, languageDefaults: values };
    },
  };
}
