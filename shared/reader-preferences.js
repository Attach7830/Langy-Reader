export const defaults = {
  mode: 'translation', synonymContextHelp: false, showPinyin: false, translationLanguage: 'en', summaryLanguage: 'en', theme: 'paper', background: 'grain',
  font: 'spectral', size: 20, line: 1.65, width: 'balanced', pdfNight: true,
  touchSize: null,
  audioEnabled: false, audioToolbarHidden: false, podcastMode: false, audioHighlight: true, audioRate: 1, audioRecordings: {},
  readingLanguages: ['es', 'en', 'pt', 'zh'],
  languageDefaultsMode: 'shared', languageDefaults: {},
  uiLanguage: 'en', nativeLanguage: '', cacheAI: true, cacheCovers: true,
  progressSyncEnabled: true, syncDeviceName: 'Langy browser',
  keys: { previous: 'ArrowLeft', next: 'ArrowRight', alternate: 'Space', fullscreen: 'f', summary: 's', playback: 'p', audioToolbar: 'a', pinyin: 'y', returnLocation: 'b', rewindAudio: '[', forwardAudio: ']', bookmarks: 'm', bookmarkSelection: 'k', explainSelection: 'e' },
  autoHideDocks: false,
  tapToTurn: false, swipeToTurn: true, tapCenterFullscreen: true,
  doubleTapToTurn: true,
  immersionMode: false, quietLibrary: true, showSharedBooks: true, libraryLayout: 'auto', libraryFormat: '', coversOnly: false, processDismissMinutes: 0,
};

export const accountFields = Object.keys(defaults).filter((key) => !['progressSyncEnabled', 'syncDeviceName'].includes(key));
export const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function shortcutDefaults(saved) {
  const assigned = isObject(saved) ? saved : {};
  const keys = { ...defaults.keys, ...assigned };
  // An existing assignment takes precedence over a newly introduced default.
  for (const [action, key] of Object.entries(defaults.keys)) {
    if (!Object.hasOwn(assigned, action) && Object.values(assigned).includes(key)) keys[action] = '';
  }
  return keys;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const maps = new Set(['keys', 'audioRecordings', 'languageDefaults']);
export const accountPreferences = (value) => Object.fromEntries(accountFields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
export function mergePreferences(base, changes) {
  const result = { ...base, ...changes };
  for (const key of maps) if (Object.hasOwn(changes, key)) result[key] = { ...base[key], ...changes[key] };
  if (changes.languageDefaults) for (const [language, values] of Object.entries(changes.languageDefaults)) {
    result.languageDefaults[language] = values === null ? null : { ...base.languageDefaults?.[language], ...values };
  }
  return result;
}
export function preferenceChanges(before, after) {
  const changes = {};
  for (const key of accountFields) {
    if (!Object.hasOwn(after, key) || same(before[key], after[key])) continue;
    changes[key] = maps.has(key) ? Object.fromEntries(Object.entries(after[key] || {}).filter(([name, value]) => !same(before[key]?.[name], value))
      .map(([name, value]) => [name, key === 'languageDefaults' && value !== null ? Object.fromEntries(Object.entries(value).filter(([field, setting]) => !same(before[key]?.[name]?.[field], setting))) : value])) : after[key];
  }
  return changes;
}

// Only reader preferences may cross browsers. Credentials, device IDs, positions
// and server connection settings have their own storage and APIs.
export function validatePreferences(value) {
  if (!isObject(value) || Object.keys(value).some((key) => !accountFields.includes(key))) throw new Error('Unknown reader preference.');
  const enums = { mode: ['translation', 'definition', 'synonyms', 'off'], theme: ['paper', 'sepia', 'dark', 'dusk', 'midnight'],
    background: ['grain', 'plain', 'linen', 'grid'], font: ['spectral', 'georgia', 'sans', 'mono', 'chinese'], width: ['narrow', 'balanced', 'wide'], uiLanguage: ['en', 'es', 'pt', 'zh'], libraryLayout: ['auto','1','2','3','4','list'], libraryFormat: ['', 'epub', 'pdf'], languageDefaultsMode: ['shared', 'per-language'] };
  for (const [key, setting] of Object.entries(value)) {
    let valid = true;
    if (enums[key]) valid = enums[key].includes(setting) || key === 'font' && typeof setting === 'string' && /^custom-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(setting);
    else if (typeof defaults[key] === 'boolean') valid = typeof setting === 'boolean';
    else if (key === 'size') valid = Number.isInteger(setting) && setting >= 13 && setting <= 40;
    else if (key === 'touchSize') valid = setting === null || Number.isInteger(setting) && setting >= 13 && setting <= 40;
    else if (key === 'processDismissMinutes') valid = Number.isFinite(setting) && setting >= 0 && setting <= 10080;
    else if (key === 'line') valid = Number.isFinite(setting) && setting >= 1.2 && setting <= 2.4;
    else if (key === 'audioRate') valid = Number.isFinite(setting) && setting >= .5 && setting <= 2;
    else if (key === 'readingLanguages') {
      try { valid = Array.isArray(setting) && setting.length >= 1 && setting.length <= 20 && setting.every((code) => typeof code === 'string' && code.length <= 35 && Intl.getCanonicalLocales(code).length === 1); } catch { valid = false; }
    }
    else if (key === 'languageDefaults') {
      try { valid = isObject(setting) && Object.keys(setting).length <= 100 && Object.entries(setting).every(([language, values]) =>
        language.length <= 35 && Intl.getCanonicalLocales(language).length === 1 && (values === null || isObject(values) && Object.entries(values).every(([field, target]) =>
          ['translationLanguage', 'summaryLanguage'].includes(field) && (target === null || typeof target === 'string' && target.length <= 35 && Intl.getCanonicalLocales(target).length === 1)))); }
      catch { valid = false; }
    }
    else if (key === 'nativeLanguage' && setting === '') valid = true;
    else if (key.endsWith('Language')) {
      try { valid = typeof setting === 'string' && setting.length <= 35 && Boolean(Intl.getCanonicalLocales(setting)[0]); } catch { valid = false; }
    } else if (key === 'keys') valid = isObject(setting) && Object.entries(setting).every(([action, shortcut]) => Object.hasOwn(defaults.keys, action)
      && typeof shortcut === 'string' && (shortcut === '' || shortcut === 'Space' || /^(Arrow(Left|Right|Up|Down)|PageUp|PageDown|Home|End)$/u.test(shortcut) || /^[\p{L}\p{N}\[\],./;'-]$/u.test(shortcut)));
    else if (key === 'audioRecordings') valid = isObject(setting) && Object.keys(setting).length <= 5000 && Object.entries(setting).every(([id, recording]) => /^[\w:-]{1,160}$/u.test(id)
      && typeof recording === 'string' && /^(?:[\w:-]{1,160})?$/u.test(recording));
    if (!valid) throw new Error(`Invalid reader preference: ${key}.`);
  }
  return value;
}
