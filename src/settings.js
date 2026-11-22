export const modes = {
  translation: 'English translation',
  definition: 'Definition',
  synonyms: 'Dictionary synonyms',
  off: 'Off',
};

export const themes = {
  paper: { name: 'Paper', ink: '#2d2e28', background: '#fffdf8' },
  sepia: { name: 'Sepia', ink: '#3c2f22', background: '#f7ead1' },
  dark: { name: 'Dark', ink: '#eee9dd', background: '#262a28' },
  dusk: { name: 'Dusk', ink: '#e7e8f4', background: '#24283b' },
  midnight: { name: 'Midnight', ink: '#dedfe2', background: '#08090b' },
};

export const fonts = {
  spectral: { name: 'Spectral', stack: "'Spectral', Georgia, serif" },
  georgia: { name: 'Georgia', stack: 'Georgia, serif' },
  sans: { name: 'DM Sans', stack: "'DM Sans', Arial, sans-serif" },
  mono: { name: 'Monospace', stack: "'Courier New', monospace" },
};

export const shortcuts = {
  previous: 'Previous page',
  next: 'Next page',
  alternate: 'Next page (alternate)',
  fullscreen: 'Full screen',
  summary: 'Toggle page summary',
  playback: 'Play or pause narration',
  audioToolbar: 'Show or hide audio toolbar',
};

export const defaults = {
  mode: 'translation', synonymContextHelp: false, translationLanguage: 'en', summaryLanguage: 'en', theme: 'paper', background: 'grain',
  font: 'spectral', size: 20, line: 1.65, width: 'balanced', pdfNight: true,
  audioEnabled: false, audioToolbarHidden: false, podcastMode: false, audioHighlight: true, audioRate: 1,
  audioRecordings: {},
  progressSyncEnabled: true, syncDeviceName: 'Langy browser',
  keys: { previous: 'ArrowLeft', next: 'ArrowRight', alternate: 'Space', fullscreen: 'f', summary: 's', playback: 'p', audioToolbar: 'a' },
  autoHideDocks: false,
};

function read(key, defaultValue) {
  try { return JSON.parse(localStorage.getItem(key)) ?? defaultValue; }
  catch { return defaultValue; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* Reading still works in browsers that disable local storage. */ }
}

export function getSettings() {
  const saved = read('langy-settings-v1', {});
  const keys = { ...defaults.keys, ...saved.keys };
  // Preserve an existing custom assignment to A when introducing this shortcut.
  if (!Object.hasOwn(saved.keys || {}, 'audioToolbar') && Object.values(saved.keys || {}).includes(defaults.keys.audioToolbar)) {
    keys.audioToolbar = '';
  }
  return { ...defaults, ...saved, keys };
}

export const saveSettings = (settings) => write('langy-settings-v1', settings);
export const getProgress = () => read('langy-progress-v1', {});
export const saveProgress = (progress) => write('langy-progress-v1', progress);

export function syncDeviceId() {
  const saved = read('langy-sync-device-v1', null);
  if (typeof saved === 'string' && saved.length > 0 && saved.length <= 160) return saved;
  const id = crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16)).join('-');
  write('langy-sync-device-v1', id);
  return id;
}

const labels = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
export function keyLabel(key) { return labels[key] || (key ? key.length === 1 ? key.toUpperCase() : key : 'Unassigned'); }

export function eventKey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return '';
  if (event.key === ' ') return 'Space';
  if (/^[\p{L}\p{N}\[\],./;'-]$/u.test(event.key)) return event.key.toLowerCase();
  if (/^(Arrow(Left|Right|Up|Down)|PageUp|PageDown|Home|End)$/.test(event.key)) return event.key;
  return '';
}

export function languageName(language) {
  try { return new Intl.DisplayNames('en', { type: 'language' }).of(language); }
  catch { return language; }
}

export function updateAppearance(settings) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.background = settings.background;
  root.dataset.readingWidth = settings.width;
  root.dataset.pdfNight = String(settings.pdfNight);
}
