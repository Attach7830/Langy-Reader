// Resolve a reading language without changing the account's shared defaults.
// Exact regional/script settings take precedence, then the base language.
export function languageHelpPreferences(preferences, language) {
  if (preferences.languageDefaultsMode !== 'per-language') return preferences;
  let canonical;
  try { canonical = new Intl.Locale(language).toString(); } catch { return preferences; }
  const choices = preferences.languageDefaults || {};
  const base = new Intl.Locale(canonical).language;
  const values = { ...(choices[base] || (base === 'cmn' ? choices.zh : null)), ...choices[canonical] };
  if (!Object.keys(values).length) return preferences;
  return { ...preferences, translationLanguage: values.translationLanguage || preferences.translationLanguage,
    summaryLanguage: values.summaryLanguage || preferences.summaryLanguage };
}
