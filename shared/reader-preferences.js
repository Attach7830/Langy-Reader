export const defaults = {
  mode: 'translation', synonymContextHelp: false, showPinyin: false, translationLanguage: 'en', summaryLanguage: 'en', theme: 'paper', background: 'grain',
  font: 'spectral', size: 20, line: 1.65, width: 'balanced', pdfNight: true,
  touchSize: null,
  audioEnabled: false, audioToolbarHidden: false, podcastMode: false, audioHighlight: true, audioRate: 1, audioRecordings: {},
  readingLanguages: ['es', 'en', 'pt', 'zh'],
  uiLanguage: 'en', nativeLanguage: '', cacheAI: true,
  progressSyncEnabled: true, syncDeviceName: 'Langy browser',
  keys: { previous: 'ArrowLeft', next: 'ArrowRight', alternate: 'Space', fullscreen: 'f', summary: 's', playback: 'p', audioToolbar: 'a', pinyin: 'y', returnLocation: 'b', rewindAudio: '[', forwardAudio: ']', bookmarks: 'm' },
  autoHideDocks: false,
  tapToTurn: false, swipeToTurn: true, tapCenterFullscreen: true,
  doubleTapToTurn: true,
  immersionMode: false, quietLibrary: true,
};

export const accountFields = Object.keys(defaults).filter((key) => !['progressSyncEnabled', 'syncDeviceName'].includes(key));
export const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const maps = new Set(['keys', 'audioRecordings']);
export const accountPreferences = (value) => Object.fromEntries(accountFields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
export function mergePreferences(base, changes) {
  const result = { ...base, ...changes };
  for (const key of maps) if (Object.hasOwn(changes, key)) result[key] = { ...base[key], ...changes[key] };
  return result;
}
export function preferenceChanges(before, after) {
  const changes = {};
  for (const key of accountFields) {
    if (!Object.hasOwn(after, key) || same(before[key], after[key])) continue;
    changes[key] = maps.has(key) ? Object.fromEntries(Object.entries(after[key] || {}).filter(([name, value]) => !same(before[key]?.[name], value))) : after[key];
  }
  return changes;
}

// Only reader preferences may cross browsers. Credentials, device IDs, positions
// and server connection settings have their own storage and APIs.
export function validatePreferences(value) {
  if (!isObject(value) || Object.keys(value).some((key) => !accountFields.includes(key))) throw new Error('Unknown reader preference.');
  const enums = { mode: ['translation', 'definition', 'synonyms', 'off'], theme: ['paper', 'sepia', 'dark', 'dusk', 'midnight'],
    background: ['grain', 'plain', 'linen', 'grid'], font: ['spectral', 'georgia', 'sans', 'mono', 'chinese'], width: ['narrow', 'balanced', 'wide'], uiLanguage: ['en', 'es', 'pt', 'zh'] };
  for (const [key, setting] of Object.entries(value)) {
    let valid = true;
    if (enums[key]) valid = enums[key].includes(setting);
    else if (typeof defaults[key] === 'boolean') valid = typeof setting === 'boolean';
    else if (key === 'size') valid = Number.isInteger(setting) && setting >= 13 && setting <= 40;
    else if (key === 'touchSize') valid = setting === null || Number.isInteger(setting) && setting >= 13 && setting <= 40;
    else if (key === 'line') valid = Number.isFinite(setting) && setting >= 1.2 && setting <= 2.4;
    else if (key === 'audioRate') valid = Number.isFinite(setting) && setting >= .5 && setting <= 2;
    else if (key === 'readingLanguages') {
      try { valid = Array.isArray(setting) && setting.length >= 1 && setting.length <= 20 && setting.every((code) => typeof code === 'string' && code.length <= 35 && Intl.getCanonicalLocales(code).length === 1); } catch { valid = false; }
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
