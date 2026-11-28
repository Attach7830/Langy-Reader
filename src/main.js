import { proficiencyPage } from './proficiency.js';
import { startup } from './startup.js';
import { languageHelpPreferences } from '../shared/language-defaults.js';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-600.css';
import '@fontsource/dm-sans/latin-700.css';
import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource/spectral/latin-400.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-tc/400.css';
import './styles.css';
import { readerDocks } from './reader-docks.js';
import { $, $$, api, bookFormatLabel, drawIcons, element, message, toast } from './ui.js';
import { libraryScreen } from './ui-library.js';
import { settingsPage } from './ui-settings.js';
import { phraseHelp } from './phrase-help.js';
import { wordHelp } from './words.js';
import { earlierPageContext } from './reading-context.js';
import { narration } from './narration.js';
import { readingProgressSync } from './reading-sync.js';
import { pinyinOverlay, pinyinToolbar } from './pinyin.js';
import { readingVocabulary } from './reading-vocabulary.js';
import { renderSummaryDetail } from './summary-detail.js';
import { pageNavigation } from './page-navigation.js';
import { bookContents } from './book-contents.js';
import { bookPageJump } from './book-page-jump.js';
import { pageTurnQueue, readerDeadline } from './reader-navigation.js';
import { readingPreferences, readingFontSize, fontSizeChange } from './touch-preferences.js';
import { temporaryControls } from './reader-peek.js';
import { discoveryScreen } from './ui-discovery.js';
import { locationHistory } from './location-history.js';
import { readingShortcut } from './reader-shortcuts.js';
import { accountSession, beforeSignOut } from './auth.js';
import { userFonts } from './user-fonts.js';
import { accountSettings } from './account-settings.js';
import { readingBookmarks } from './bookmarks.js';
import { readingTime as readingTimeTracker } from './reading-time.js';
import { readingBookTools } from './book-tools.js';
import { setOfflineAccount, setOfflineBook, flushOfflineChanges } from './offline.js';
import { pageQuestions } from './page-question.js';
import { audiobookshelfProgress } from './audiobookshelf-progress.js';
import { setInterfaceLanguage } from './i18n.js';
import { processTasks } from './process-tasks.js';
import { processQueue } from './process-queue.js';
import { coverCache } from './cover-cache.js';
import { refreshOfflineReader } from './offline-downloads.js';
import { bookLanguages } from '../shared/language.js';
import { getProgress, getSettings, keyLabel, languageName, modes, saveProgress, saveSettings, subscribeSettings, syncDeviceId, updateAppearance } from './settings.js';

const viewer = $('#viewer');
const stage = $('#stage');
const readerScreen = $('#reader-screen');
const safeMode = accountSession()?.user?.safeMode === true;
const processLauncher = $('#open-process-queue');
const setDockAutoHide = readerDocks(readerScreen);
const summaryPanel = $('#summary-panel');
const summaryBody = $('#summary-body');
const summaryButton = $('#generate-summary');
const summaryActions = $('#summary-actions');
const summaryDetail = $('#summary-detail');
const summaryDetailBody = $('#summary-detail-body');
const progress = getProgress();
const discovery = discoveryScreen({ request: api });
const summaries = new Map();
let settings = getSettings();
let activeBook, renderer, loadController, activePosition, summaryController, activeSummary, hadSavedPosition = false;
let readingPdfEpub = false;
const readingFormat = () => readingPdfEpub ? 'epub' : activeBook?.format;
let moving = false, summaryQueued = false, fallbackFullscreen = false;
let hasReturnLocation = false, temporaryAudioVisible = false, pinchStart;
let zoom = 1;
let statusCheck = 0;
let settingsReturnHash = '#library', settingsHistoryEntry = false;
const returnHistory = locationHistory({
  location: () => activePosition && ({ target: activePosition.target, label: [activePosition.detail, activePosition.label].filter(Boolean).join(' · '), scrollTop: viewer.scrollTop, scrollLeft: viewer.scrollLeft }),
  async go(target, saved) {
    const moved = await move(0, target);
    if (moved && saved) { viewer.scrollTop = saved.scrollTop; viewer.scrollLeft = saved.scrollLeft; }
    return moved;
  },
  changed({ previous, busy }) {
    hasReturnLocation = Boolean(previous);
    const button = $('#return-location'); button.hidden = !previous; button.disabled = busy;
    button.title = previous ? `Back to ${previous.label}${settings.keys.returnLocation ? ` (${keyLabel(settings.keys.returnLocation)})` : ''}` : 'Back to previous location';
    syncFullscreen();
  },
});
const pageTurns = pageTurnQueue({ perform: performMove, busy(value) {
  moving = value;
  if (!value && activeBook && summaryQueued) { summaryQueued = false; summarize(); }
} });
const pageGestures = pageNavigation({ host: $('.reading-main'),
  enabled: () => Boolean(activeBook && renderer && !document.querySelector('dialog[open]')),
  canSwipe: () => settings.swipeToTurn !== false && !viewer.classList.contains('pdf-panning'),
  canTap: () => settings.tapToTurn === true,
  canDoubleTap: () => settings.doubleTapToTurn !== false,
  canCenterTap: () => settings.tapCenterFullscreen !== false,
  wordAt: (event) => words.at(event),
  wordDoubleTap: (word) => void playWordFromGesture(word),
  canPan: () => viewer.classList.contains('pdf-panning'),
  panBy: (x, y) => viewer.scrollBy(x, y),
  selectPassage(word) {
    const passage = phrases.selectPassage(word);
    if (passage) audio.pause();
    return passage;
  },
  passageSelected: () => phrases.hasSelection,
  dismissPassage: () => phrases.dismiss(),
  centerTap: () => { words.clear(); void toggleFullscreen(); },
  centerDoubleTap: () => void togglePlaybackFromGesture(),
  swipeUp: toggleAudioToolbar, swipeDown: swipeDownReaderPanels,
  pinch: pinchText,
  turn: (direction) => { viewer.focus({ preventScroll: true }); void move(direction); },
});
const pinyin = pinyinOverlay({ host: viewer, preferences: comprehensionPreferences, renderer: () => renderer, book: () => activeBook, request: api });
const pinyinButton = pinyinToolbar({ button: $('#pinyin-toggle'), preferences: () => settings, book: () => activeBook,
  change: (showPinyin) => { applySettings({ ...settings, showPinyin }); toast(showPinyin ? 'Pinyin shown' : 'Pinyin hidden'); } });
const bookTools = readingBookTools({ book: () => activeBook, renderer: () => renderer, preferences: outputPreferences, request: api, textEdition: () => readingPdfEpub,
  async go(target) { const moved = await returnHistory.follow(target); if (moved) await audio.seekSource(target.key, target.from); return moved; } });
const questions = pageQuestions({ book: () => activeBook, renderer: () => renderer, preferences: outputPreferences, request: api });
const readingTime = readingTimeTracker({ book: () => activeBook, renderer: () => renderer, request: api,
  eligible: () => !document.hidden && document.hasFocus() && !readerScreen.hidden && !document.querySelector('dialog[open]') });
const vocabulary = readingVocabulary({ book: () => activeBook, renderer: () => renderer, request: api, onDisplay: readingTime.evidence });
viewer.addEventListener('scroll', () => vocabulary.refresh(), { passive: true });

const words = wordHelp({
  preferences: comprehensionPreferences, request: api,
  languages: () => bookLanguages(activeBook),
  lemmaAt: (node, offset) => audio.lemmaAt(node, offset),
  seekWord: (node, offset) => audio.seekWord(node, offset),
  onWord: readingTime.activity,
});
const phrases = phraseHelp({ book: () => activeBook, preferences: () => settings, request: api, explanations: !safeMode,
  roots: () => renderer?.readingRoots() || [], onSelection: words.clear,
  onBookmark: (range, text) => bookmarks.openSelection(renderer?.bookmarkTarget?.(range) ?? activePosition?.target, text),
});
const audio = narration({
  safeMode, textEdition: () => readingPdfEpub, highlight: () => readingFormat() === 'epub',
  canFollow: () => !phrases.touchSelected,
  editableTiming: (book) => library.editableTiming(book),
  showAudioTiming: (book, recording, position) => library.showAudioTiming(book, recording, position),
  preferences: () => temporaryAudioVisible ? { ...settings, audioToolbarHidden: false } : settings, renderer: () => renderer, book: () => activeBook,
  readingPosition: () => activePosition?.target,
  navigate: (target) => move(0, target, { audio: true }),
  changePreferences: (values) => {
    settings = saveSettings({ ...settings, ...values });
    audio.apply();
  },
});
const audioPeek = temporaryControls({ changed(visible) { temporaryAudioVisible = visible; audio.apply(); syncFullscreen(); } });
const audioToolbarGestures = pageNavigation({ host: $('#narration-player'),
  enabled: () => Boolean(activeBook && renderer && !$('#narration-player').hidden && !document.querySelector('dialog[open]')),
  canSwipe: () => false, canDoubleTap: () => false, turn() {},
  swipeUp: toggleAudioToolbar, swipeDown: closeAudioToolbar,
});
for (const type of ['input', 'change', 'click', 'wheel', 'focusin']) $('#narration-player').addEventListener(type, audioPeek.activity, { passive: true });
$('#narration-player').addEventListener('pointerdown', audioPeek.hold, { passive: true });
document.addEventListener('pointerup', audioPeek.release, { passive: true });
document.addEventListener('pointercancel', audioPeek.release, { passive: true });
const absProgress = audiobookshelfProgress({ audio, request: api, reading: {
  hasSavedPosition: () => hadSavedPosition,
  playbackPosition() {
    const current = renderer?.syncPosition?.();
    return activeBook && current && audio.absConnected ? { book: activeBook.id, recording: 'reading', time: current.percentage, duration: 1, absConnected: true, readingTarget: current.target, hasSavedPosition: hadSavedPosition } : null;
  },
  async resumeAt(percentage) { if (!await move(0, { sync: { percentage } })) throw new Error('The Audiobookshelf reading position could not be opened.'); },
} });
const processes = safeMode ? null : processQueue({ changePreferences: (values) => applySettings({ ...settings, ...values }) });
const library = libraryScreen({
  safeMode,
  preferences: () => settings, changePreferences: (updated) => { applySettings({ ...settings, ...updated }); },
  progress, readingLanguages: () => settings.readingLanguages, onSnapshot: (snapshot) => { processes?.setAccount(snapshot.readingTime?.accountId); readingTime.setAccount(snapshot.readingTime?.accountId); void setOfflineAccount(snapshot.readingTime?.accountId).catch(() => {}); updateActiveBook(snapshot); },
  onRemove(id) { delete progress[id]; saveProgress(progress); },
});
const proficiency = proficiencyPage({ preferences: () => settings });
const bookmarks = readingBookmarks({ book: () => activeBook, position: () => activePosition, go: (target) => returnHistory.follow(target), request: api });
const settingsUI = settingsPage({ preferences: () => settings, apply: applySettings, navigate: openSettings, back: leaveSettings, safeMode });
const account = accountSettings({ request: api, preferences: () => settings,
  busy: () => settingsUI.active,
  apply: (updated) => applySettings(updated, false, false),
  status: (state) => { const label = $('#account-settings-status');
    if (label) label.textContent = ({ saved: 'Reader preferences saved to your account.', pending: 'Saving reader preferences…', offline: 'Preferences saved on this browser; account sync will retry.' })[state]; },
});
subscribeSettings(account.changed);
const readingSync = readingProgressSync({
  request: api, progress, persist: () => saveProgress(progress), preferences: () => settings,
  available: () => !library.state.demo, deviceId: syncDeviceId(),
  visible: () => !document.hidden,
  async applyRemote(remote) {
    const view = renderer;
    const moved = await move(0, { sync: remote });
    return moved && renderer === view ? view.syncResolution : false;
  },
  notify: syncStatus,
});

function syncStatus({ state, pending, error }) {
  const button = $('#sync-progress');
  const notice = $('#sync-notice');
  const wasHidden = notice.hidden;
  button.hidden = state === 'disabled';
  button.disabled = state === 'syncing';
  button.dataset.state = state;
  const labels = {
    syncing: 'Syncing reading progress…', waiting: 'Saving reading progress…',
    synced: 'Reading progress synced. Check for updates',
    approximate: 'Resumed near the saved position. Check for updates',
    offline: 'Progress saved on this browser. Click to retry sync',
    conflict: 'Choose which reading position to keep', remote: 'Another device saved a reading position',
    error: error || 'Could not resume the saved position. Click to retry',
  };
  button.title = labels[state] || 'Sync reading progress';
  button.setAttribute('aria-label', button.title);
  notice.hidden = !pending || state === 'disabled';
  if (!notice.hidden) {
    const saved = pending.progress;
    const date = new Date(saved.timestamp * 1000).toLocaleString();
    $('#sync-notice-text').textContent = `${saved.device || 'Another device'} saved a position at ${Math.round(saved.percentage * 100)}% (${date}).`
      + (state === 'error' ? ` ${error}` : ' Resume there or keep your current place.');
  }
  $('#sync-resume').disabled = $('#sync-keep').disabled = state === 'syncing';
  if (wasHidden !== notice.hidden) syncFullscreen();
  if (state === 'approximate') toast('Resumed near the saved position. This EPUB location could only be mapped approximately.');
}

for (const close of $$('[data-close]')) {
  close.addEventListener('click', () => {
    const dialog = close.closest('dialog');
    if (dialog) dialog.dispatchEvent(new Event('cancel', { cancelable: true })) && dialog.close();
    if (activeBook && !dialog?.open) viewer.focus({ preventScroll: true });
  });
}
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#word-help')) words.clear();
  if (!event.target.closest('#reader-more')) $('#reader-more').open = false;
}, true);
viewer.addEventListener('scroll', () => words.clear(), { passive: true });

function applyAppearance() {
  setInterfaceLanguage(settings.uiLanguage);
  document.documentElement.dataset.immersion = String(settings.immersionMode);
  $('#immersion-toggle').setAttribute('aria-pressed', String(settings.immersionMode));
  updateAppearance(settings);
  pinyinButton.refresh();
  $('#word-mode-label').textContent = settings.mode === 'translation'
    ? `${languageName(outputPreferences().translationLanguage)} translation` : modes[settings.mode];
  if (settings.mode === 'off') $('#word-mode-label').textContent = 'Word help off';
  $('.word-settings').setAttribute('aria-label', `Word help: ${$('#word-mode-label').textContent}`);
  $('#summarize').title = settings.keys.summary ? `Summarize page (${keyLabel(settings.keys.summary)})` : 'Summarize page';
  $('#previous').title = settings.keys.previous ? `Previous page (${keyLabel(settings.keys.previous)})` : 'Previous page';
  $('#next').title = settings.keys.next ? `Next page (${keyLabel(settings.keys.next)})` : 'Next page';
  $('#bookmarks-button').title = settings.keys.bookmarks ? `Bookmarks (${keyLabel(settings.keys.bookmarks)})` : 'Bookmarks';
  returnHistory.refresh();
}

function applySettings(updated, aiChanged, notify = true) {
  if (JSON.stringify(settings) === JSON.stringify(updated) && !aiChanged) return;
  const relayout = ['size', 'touchSize', 'font', 'line', 'width', 'summaryLanguage', 'showPinyin', 'languageDefaultsMode', 'languageDefaults'].some((key) => JSON.stringify(settings[key]) !== JSON.stringify(updated[key]));
  const syncChanged = settings.progressSyncEnabled !== updated.progressSyncEnabled;
  const libraryChanged = settings.nativeLanguage !== updated.nativeLanguage || settings.quietLibrary !== updated.quietLibrary || settings.showSharedBooks !== updated.showSharedBooks
    || settings.libraryLayout !== updated.libraryLayout || settings.coversOnly !== updated.coversOnly || settings.cacheCovers !== updated.cacheCovers;
  const cacheChanged = settings.cacheAI !== updated.cacheAI;
  const libraryFormatChanged = settings.libraryFormat !== updated.libraryFormat;
  settings = saveSettings(updated, { notify });
  proficiency.preferencesChanged();
  if (settings.cacheCovers === false) void coverCache.clear().catch(() => {});
  document.documentElement.dataset.immersion = String(settings.immersionMode);
  $('#immersion-toggle').setAttribute('aria-pressed', String(settings.immersionMode));
  if (libraryChanged && !activeBook) void library.refresh().catch((error) => message('#library-error', error.message));
  else if (libraryFormatChanged) library.render();
  words.clear(); phrases.clear();
  applyAppearance();
  syncFullscreen();
  audio.apply();
  if (aiChanged || cacheChanged) {
    summaries.clear();
    words.reset();
    if (aiChanged) void checkAI();
  }
  if (relayout || aiChanged || cacheChanged) resetSummary();
  Promise.resolve(userFonts.ensure(settings.font)).catch(() => {}).then(() => renderer?.apply?.(readingPreferences(comprehensionPreferences()))).then(() => {
    pageGestures.refresh();
    pinyin.refresh();
    vocabulary.refresh();
    if (syncChanged && activeBook && renderer) void readingSync.start(activeBook, renderer);
  }).catch(reportError);
  if (activeBook) viewer.focus({ preventScroll: true });
}

function comprehensionPreferences() {
  return activeBook?.l1Folder || safeMode ? { ...settings, mode: 'off', showPinyin: false } : settings;
}
function outputPreferences() { return languageHelpPreferences(comprehensionPreferences(), activeBook?.language); }
function updateComprehension() {
  applyAppearance();
  const limitedHelp = safeMode || Boolean(activeBook?.l1Folder);
  $('#summarize').hidden = limitedHelp; $('.word-settings').hidden = limitedHelp; $('#character-guide-tools').hidden = limitedHelp;
  const tools = $('#book-tools-button'), label = limitedHelp ? 'Search book' : 'Search book and character guide';
  tools.title = label; tools.setAttribute('aria-label', label);
  if (limitedHelp) { words.clear(); phrases.clear(); showSummary(false); bookTools.reset(); }
}
function updateActiveBook(snapshot) {
  const current = activeBook && snapshot.books.find((book) => book.id === activeBook.id);
  if (!current) return;
  const pdfChanged = (current.contentRevision || '') !== (activeBook.contentRevision || '');
  const editionChanged = current.epubRevision !== activeBook.epubRevision;
  if (!readerScreen.hidden && (pdfChanged || readingPdfEpub && editionChanged && current.epubRevision)) {
    const epub = readingPdfEpub && Boolean(current.epubRevision);
    if (readingPdfEpub && !epub) history.replaceState(null, '', `#read/${current.id}`);
    void openBook(current, epub); return;
  }
  const l1Changed = Boolean(current.l1Folder) !== Boolean(activeBook.l1Folder);
  if (!l1Changed && !editionChanged) return;
  activeBook = { ...activeBook, l1Folder: current.l1Folder, epubRevision: current.epubRevision };
  updateFormatLink();
  if (!l1Changed) return;
  updateComprehension(); pinyinButton.refresh(); pinyin.refresh();
  void Promise.resolve(renderer?.apply?.(readingPreferences(comprehensionPreferences()))).catch(reportError);
}

async function checkAI() {
  if (safeMode) return;
  const request = ++statusCheck;
  const button = $('#ai-status');
  const label = $('span:last-child', button);
  try {
    const { ready, model, provider } = await api('/api/ai/status');
    if (request !== statusCheck) return;
    button.dataset.ready = String(ready);
    label.textContent = ready ? provider === 'bundled' ? 'Local AI ready' : 'AI connected' : 'AI not ready';
    button.title = model;
  } catch {
    if (request !== statusCheck) return;
    button.dataset.ready = 'false';
    label.textContent = 'AI not ready';
  }
}

function showScreen(screen) {
  const launcherParent = screen === 'reader' ? readerScreen : document.body;
  if (processLauncher.parentElement !== launcherParent) launcherParent.append(processLauncher);
  $('#mobile-navigation').hidden = screen === 'reader';
  for (const link of document.querySelectorAll('.mobile-navigation a')) {
    if (link.hash === `#${screen}`) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  readerScreen.hidden = screen !== 'reader';
  $('#library-screen').hidden = screen !== 'library';
  $('#about-screen').hidden = screen !== 'about';
  $('#howto-screen').hidden = screen !== 'howto';
  $('#discovery-screen').hidden = screen !== 'discovery';
  $('#proficiency-screen').hidden = screen !== 'proficiency';
  if (screen !== 'proficiency') proficiency.leave();
  $('#settings').hidden = screen !== 'settings';
  for (const button of document.querySelectorAll('#mobile-navigation [data-settings]')) {
    if (screen === 'settings') button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  if (screen !== 'discovery') discovery.leave();
  $('#library-header').hidden = screen === 'reader';
  if (screen === 'about') $('#about-link').setAttribute('aria-current', 'page');
  else $('#about-link').removeAttribute('aria-current');
}

function readerMessage(text = '', problem = false) {
  const node = $('#reader-message');
  node.dataset.problem = String(problem);
  message('#reader-message', text);
}

function reportError(error) {
  if (!activeBook || error?.name === 'AbortError') return;
  readerMessage(error?.name === 'TimeoutError' ? 'This page took too long to open.' : error?.message || 'The page could not be opened.', true);
}

function positionChanged(position) {
  if (!activeBook) return;
  const sourceChanged = position.target !== activePosition?.target;
  const changed = sourceChanged || position.editionTarget !== activePosition?.editionTarget;
  activePosition = position;
  readingTime.refresh();
  const saved = { target: position.target, percent: position.percent };
  const previous = progress[activeBook.id];
  if (position.editionTarget) saved.epubPosition = { cfi: position.editionTarget, page: position.target, revision: activeBook.epubRevision };
  if (previous?.target !== saved.target || previous?.percent !== saved.percent
    || saved.epubPosition && (previous?.epubPosition?.cfi !== saved.epubPosition.cfi || previous?.epubPosition?.revision !== saved.epubPosition.revision)) {
    progress[activeBook.id] = { ...previous, ...saved };
    saveProgress(progress);
  }
  if (sourceChanged && !position.reflowed) readingSync.changed();
  if (sourceChanged && !position.reflowed) absProgress.changed();
  $('#page-label').textContent = position.label;
  const format = readingPdfEpub ? 'Simplified EPUB' : activeBook.format === 'pdf' && activeBook.ocrComplete ? bookFormatLabel(activeBook) : '';
  const heading = [format, position.heading || position.label].filter(Boolean).join(' · ');
  $('#reading-subtitle').textContent = heading; $('#reading-subtitle').title = heading;
  $('#position-detail').textContent = position.detail;
  $('#previous').disabled = !position.previous;
  $('#next').disabled = !position.next;
  $('#progress-fill').style.width = `${Math.round((position.percent || 0) * 100)}%`;
  if (changed || position.reflowed) {
    words.clear(); phrases.clear();
    resetSummary();
    if (!summaryPanel.hidden) void generateSummary();
  }
  void audio.refresh({ seekToPage: changed && !position.reflowed });
  pinyin.refresh();
  vocabulary.refresh();
}

function showSummary(visible) {
  visible = visible && !activeBook?.l1Folder;
  summaryPanel.hidden = !visible;
  stage.classList.toggle('summary-open', visible);
  $('#summarize').setAttribute('aria-expanded', String(visible));
  if (!visible) {
    summaryQueued = false;
    resetSummary();
  }
}

function closeSummary() {
  showSummary(false);
  viewer.focus({ preventScroll: true });
}

function summaryState(state, text) {
  summaryBody.dataset.state = state;
  summaryBody.lang = outputPreferences().summaryLanguage;
  summaryBody.textContent = text;
  summaryButton.disabled = state === 'loading';
  summaryButton.hidden = state === 'complete';
  $('span', summaryButton).textContent = state === 'loading' ? 'Summarizing…' : state === 'error' ? 'Try again' : 'Summarize page';
}

function resetSummary() {
  questions.reset();
  summaryController?.abort();
  summaryController = undefined;
  activeSummary = undefined;
  summaryActions.hidden = true;
  summaryActions.replaceChildren();
  summaryDetail.hidden = true;
  summaryDetailBody.textContent = '';
  summaryPanel.scrollTop = 0;
  $('#summary-location').textContent = [activePosition?.label, languageName(outputPreferences().summaryLanguage)].filter(Boolean).join(' · ');
  summaryState('idle', 'Generate a summary of the current page.');
}

function showSummaryResult(entry) {
  if (entry === activeSummary) return;
  activeSummary = entry;
  summaryState('complete', entry.text);
  const actions = [
    { label: 'Go deeper', mode: 'deeper' },
    ...entry.suggestions.map((label) => ({ label, mode: 'question' })),
  ];
  summaryActions.replaceChildren(...actions.map(({ label, mode }) => {
    const button = element('button', mode === 'deeper' ? 'button secondary' : 'button quiet', label);
    button.type = 'button';
    button.dir = 'auto';
    button.lang = mode === 'question' ? entry.body.language : 'en';
    button.setAttribute('aria-controls', 'summary-detail');
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => void explainSummary(mode, label, button));
    return button;
  }));
  summaryActions.hidden = false;
}

function detailState(state, text) {
  renderSummaryDetail(summaryDetailBody, state, text);
}

async function explainSummary(mode, label, selected) {
  const entry = activeSummary;
  if (!entry || summaryController) return;
  const question = mode === 'question' ? label : '';
  const key = `${mode}:${question}`;
  const buttons = $$('button', summaryActions);
  for (const button of buttons) button.setAttribute('aria-pressed', String(button === selected));
  const title = $('#summary-detail-title');
  title.textContent = label;
  title.lang = mode === 'question' ? entry.body.language : 'en';
  summaryDetailBody.lang = entry.body.language;
  summaryDetail.hidden = false;
  if (settings.cacheAI !== false && entry.details.has(key)) {
    detailState('complete', entry.details.get(key));
    summaryDetail.scrollIntoView({ block: 'nearest' });
    return;
  }

  const controller = new AbortController();
  summaryController = controller;
  for (const button of buttons) button.disabled = true;
  detailState('loading', 'Generating an explanation…');
  summaryDetail.scrollIntoView({ block: 'nearest' });
  try {
    const result = await api('/api/ai/summary', {
      method: 'POST', signal: controller.signal,
      body: { ...entry.body, mode, question, brief: entry.text },
    });
    if (summaryController !== controller) return;
    if (settings.cacheAI !== false) entry.details.set(key, result);
    detailState('complete', result);
  } catch (error) {
    if (summaryController === controller && error.name !== 'AbortError') detailState('error', error.message);
  } finally {
    if (summaryController === controller) {
      summaryController = undefined;
      for (const button of buttons) button.disabled = false;
    }
  }
}

function summarize() {
  if (safeMode) return;
  if (!renderer || summaryController || activeBook?.l1Folder) return;
  if (moving) {
    summaryQueued = true;
    return;
  }
  showSummary(true);
  void generateSummary();
}

async function generateSummary() {
  if (!renderer || summaryPanel.hidden || summaryController || activeBook?.l1Folder) return;
  words.clear(); phrases.clear();
  $('#summary-location').textContent = [activePosition?.label, languageName(outputPreferences().summaryLanguage)].filter(Boolean).join(' · ');
  const page = renderer.summaryPage();
  if (!page) {
    summaryState('loading', 'Preparing this page…');
    return;
  }
  const text = page.text.trim();
  if (!text) {
    summaryState('error', activeBook.format === 'pdf'
      ? 'This page has no selectable text. Scanned pages remain readable. They need a text layer for language help.'
      : 'This page has no text to summarize.');
    return;
  }
  const { id, title, author, language } = activeBook;
  const outputLanguage = outputPreferences().summaryLanguage;
  const key = JSON.stringify([id, activePosition?.target, outputLanguage, title, author, text]);
  if (settings.cacheAI !== false && summaries.has(key)) return showSummaryResult(summaries.get(key));
  const controller = new AbortController();
  summaryController = controller;
  summaryState('loading', 'Generating a summary…');
  try {
    const earlier = await earlierPageContext(page.earlier, text, language, controller.signal);
    const body = { text, language: outputLanguage, earlier, book: { title, author, publicationDate: page.publicationDate } };
    const { text: answer, suggestions = [] } = await api('/api/ai/summary', { method: 'POST', signal: controller.signal, body });
    if (summaryController !== controller) return;
    const entry = { text: answer, suggestions, body, details: new Map() };
    if (settings.cacheAI !== false) summaries.set(key, entry);
    if (summaries.size > 90) summaries.delete(summaries.keys().next().value);
    showSummaryResult(entry);
  } catch (error) {
    if (summaryController === controller && error.name !== 'AbortError') summaryState('error', error.message);
  } finally {
    if (summaryController === controller) summaryController = undefined;
  }
}

function syncFullscreen() {
  const fullscreen = Boolean(document.fullscreenElement) || fallbackFullscreen;
  document.documentElement.classList.toggle('focus-mode', fallbackFullscreen);
  $('#fullscreen').setAttribute('aria-pressed', String(fullscreen));
  $('#fullscreen').setAttribute('aria-label', fullscreen ? 'Exit full screen' : 'Full screen');
  $('#fullscreen').title = fullscreen ? 'Exit full screen' : 'Full screen';
  setDockAutoHide(Boolean(activeBook && fullscreen && settings.autoHideDocks && !hasReturnLocation && !temporaryAudioVisible && $('#sync-notice').hidden));
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (fallbackFullscreen) fallbackFullscreen = false;
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else fallbackFullscreen = true;
  } catch {
    fallbackFullscreen = !fallbackFullscreen;
  }
  syncFullscreen();
}

function closeReader(playbackPosition) {
  audioPeek.reset();
  pinchText({ phase: 'cancel' });
  absProgress.stop();
  readingTime.stop();
  returnHistory.reset();
  pageGestures.reset();
  audioToolbarGestures.reset();
  vocabulary.stop();
  pinyin.clear();
  readingSync.stop();
  audio.stop(playbackPosition);
  loadController?.abort();
  loadController = undefined;
  renderer?.destroy();
  renderer = undefined;
  activeBook = undefined;
  readingPdfEpub = false;
  pinyinButton.refresh();
  summaryQueued = false;
  pageTurns.reset();
  activePosition = undefined;
  bookmarks.reset();
  bookTools.reset();
  moving = false;
  words.clear(); phrases.clear();
  showSummary(false);
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  fallbackFullscreen = false;
  syncFullscreen();
  viewer.replaceChildren();
  viewer.classList.remove('pdf-viewer');
  readerMessage();
}

function updateFormatLink() {
  const link = $('#reader-format-link');
  link.hidden = !readingPdfEpub && !activeBook?.epubRevision;
  if (!link.hidden) {
    link.href = `#read/${activeBook.id}${readingPdfEpub ? '' : '/epub'}`;
    $('span', link).textContent = readingPdfEpub ? 'Read PDF' : 'Read simplified EPUB';
  }
}

async function openBook(book, textEdition = readingPdfEpub && activeBook?.id === book.id) {
  const playbackPosition = activeBook?.id === book.id && textEdition !== readingPdfEpub ? audio.playbackPosition() : null;
  closeReader(playbackPosition);
  hadSavedPosition = Boolean(progress[book.id]?.target);
  const finishOpening = processTasks.begin('Open book', { bookId: book.id, title: book.title, cancel: () => { closeReader(); location.hash = '#library'; } });
  activeBook = book;
  readingPdfEpub = textEdition;
  const isPdf = readingFormat() === 'pdf';
  updateFormatLink();
  updateComprehension();
  setOfflineBook(book.id);
  void bookmarks.load().catch(() => {});
  loadController = new AbortController();
  const { signal } = loadController;
  showScreen('reader');
  audio.apply();
  document.title = `${book.title} · Langy Reader`;
  $('#reading-title').textContent = book.title;
  $('#reading-subtitle').textContent = [textEdition ? 'Simplified EPUB' : bookFormatLabel(book), languageName(book.language)].join(' · ');
  $('#reading-subtitle').title = '';
  $('#pdf-zoom').hidden = !isPdf;
  pinyinButton.refresh();
  const contentsButton = $('#contents-button');
  contentsButton.disabled = true;
  contentsButton.title = 'Book sections';
  contentsButton.setAttribute('aria-label', contentsButton.title);
  $('#previous').disabled = true;
  $('#next').disabled = true;
  $('#page-label').textContent = '';
  $('#position-detail').textContent = '';
  $('#progress-fill').style.width = '0';
  $('#zoom-reset').textContent = 'Fit';
  $('#zoom-out').disabled = true;
  $('#zoom-in').disabled = false;
  zoom = 1;
  viewer.classList.toggle('pdf-viewer', isPdf);
  readerMessage('Opening book…');
  try {
    const open = isPdf ? (await import('./pdf.js')).openPdf : (await import('./epub.js')).openEpub;
    if (!isPdf) try { await userFonts.ensure(settings.font); } catch { toast('Imported font unavailable. Using the built-in fallback.'); }
    signal.throwIfAborted();
    let position = progress[book.id]?.target, archive, pdfSource;
    if (textEdition) {
      const edition = await api(`/api/books/${book.id}/epub-text`, { signal });
      const { pdfEpub } = await import('./pdf-epub.js');
      archive = await pdfEpub(book, edition);
      signal.throwIfAborted();
      pdfSource = { total: edition.total, pages: edition.pages.map(({ number }) => number) };
      activeBook = { ...book, epubRevision: edition.revision };
      const saved = progress[book.id]?.epubPosition;
      if (saved?.revision === edition.revision && saved.page === position) position = saved.cfi;
    }
    const opened = await open({
      host: viewer, url: `/api/books/${book.id}/file${book.contentRevision ? '?revision=' + encodeURIComponent(book.contentRevision) : ''}`, position, archive, pdfSource,
      language: book.language, settings: readingPreferences(comprehensionPreferences()), signal,
      hooks: {
        keydown, bindWords: (...args) => { const wordCleanup = words.bind(...args), phraseCleanup = phrases.bind(args[0]); return () => { wordCleanup?.(); phraseCleanup(); }; }, bindPageNavigation: pageGestures.bind,
        followLink: (target) => signal.aborted ? false : returnHistory.follow(target),
        layout: () => { pinyin.refresh(); vocabulary.refresh(); },
        position: (position) => { if (!signal.aborted) positionChanged(position); },
        error: (error) => { if (!signal.aborted) reportError(error); },
      },
    });
    if (signal.aborted) return opened.destroy();
    renderer = opened;
    pinyin.refresh();
    vocabulary.refresh();
    if (isPdf && opened.contents.length) {
      contentsButton.title = 'Book sections';
      contentsButton.setAttribute('aria-label', contentsButton.title);
    }
    await renderer.apply?.(readingPreferences(comprehensionPreferences()));
    if (signal.aborted) return;
    contentsButton.disabled = false;
    audio.apply();
    void Promise.all([audio.refresh(), readingSync.start(book, opened)]).then(() => {
      if (!signal.aborted && renderer === opened) absProgress.start();
    });
    readerMessage();
    if (!document.querySelector('dialog[open]')) viewer.focus({ preventScroll: true });
  } catch (error) {
    finishOpening(signal.aborted ? signal.reason : error);
    if (!signal.aborted) reportError(error);
  } finally { finishOpening(signal.aborted ? signal.reason : undefined); }
}

function openSettings(tab = 'reading') {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  if (!/^#settings(?:\/|$)/u.test(location.hash)) {
    settingsReturnHash = location.hash || '#library'; settingsHistoryEntry = true;
    location.hash = `#settings/${tab}`;
  } else {
    history.replaceState(null, '', `#settings/${tab}`); settingsUI.open(tab);
  }
}

function leaveSettings() {
  if (settingsHistoryEntry) { settingsHistoryEntry = false; history.back(); }
  else location.hash = settingsReturnHash;
}

async function route() {
  const settingsRoute = /^#settings(?:\/([^/]+))?$/u.exec(location.hash);
  if (settingsRoute) {
    if (activeBook) closeReader();
    showScreen('settings'); document.title = 'Settings · Langy Reader';
    const label = /^#read\//u.test(settingsReturnHash) ? 'Back to book' : 'Back to library';
    $('#settings-back span').textContent = label;
    settingsUI.open(settingsRoute[1] || 'reading'); $('#settings-title').focus({ preventScroll: true });
    window.scrollTo(0, 0); return;
  }
  if (settingsUI.active) { settingsUI.leave(); void account.resume(); }
  if (location.hash === '#proficiency') {
    if (activeBook) closeReader();
    await Promise.allSettled([readingTime.flush(),vocabulary.flush(),account.flush()]);
    showScreen('proficiency'); document.title='Reading profile · Langy Reader';
    $('#proficiency-title').focus({preventScroll:true}); await proficiency.open(); return;
  }
  if (location.hash === '#discover' && safeMode) history.replaceState(null, '', '#library');
  if (location.hash === '#discover') {
    if (activeBook) { closeReader(); await vocabulary.flush(); }
    showScreen('discovery'); document.title = 'Discover books · Langy Reader';
    $('#discovery-title').focus({ preventScroll: true });
    await discovery.open();
    return;
  }
  if (['#about', '#howto'].includes(location.hash)) {
    if (activeBook) closeReader();
    const screen = location.hash.slice(1); showScreen(screen);
    document.title = `${screen === 'about' ? 'About' : 'How to'} · Langy Reader`;
    $(`#${screen}-title`).focus({ preventScroll: true });
    return;
  }
  const match = /^#read\/([a-z0-9-]+)(?:\/(epub))?$/i.exec(location.hash);
  if (!match) {
    const returning = Boolean(activeBook);
    if (activeBook) closeReader();
    showScreen('library');
    document.title = 'Langy Reader';
    library.render();
    if (returning) {
      await readingTime.flush();
      await vocabulary.flush();
      await library.refresh().catch((error) => message('#library-error', error.message));
    }
    return;
  }
  const book = library.state.books.find(({ id }) => id === match[1]);
  if (!book) {
    closeReader();
    history.replaceState(null, '', '#library');
    showScreen('library');
    return message('#library-error', 'This book could not be found. Demo uploads expire after 24 hours.');
  }
  const textEdition = Boolean(match[2] && book.epubRevision);
  if (match[2] && !textEdition) {
    history.replaceState(null, '', `#read/${book.id}`);
    toast('The simplified EPUB needs indexed PDF text.');
  }
  if (activeBook?.id !== book.id || activeBook?.contentRevision !== book.contentRevision || readingPdfEpub !== textEdition) await openBook(book, textEdition);
}

function move(direction, target, context) { return pageTurns.request(direction, target, context); }

async function performMove(direction, target, context) {
  if (!renderer) return false;
  if (target == null && (direction > 0 ? !activePosition?.next : !activePosition?.previous)) return false;
  words.clear(); phrases.clear();
  resetSummary();
  const signal = loadController.signal;
  const current = renderer;
  const narrationNavigation = context?.audio ? null : audio.beginNavigation();
  let completed = false;
  try {
    await readerDeadline(() => target == null ? current.move(direction) : current.go(target), { signal, milliseconds: 20000 });
    await new Promise(requestAnimationFrame);
    completed = !signal.aborted;
    if (!signal.aborted) readerMessage();
    return !signal.aborted;
  } catch (error) {
    if (!signal.aborted && error?.name === 'TimeoutError' && renderer === current) {
      const book = activeBook;
      toast('Restoring the reader at your saved page…');
      await openBook(book);
    } else if (!signal.aborted) {
      reportError(error);
    }
  } finally {
    if (narrationNavigation != null && !signal.aborted) void audio.endNavigation(narrationNavigation, { seekToPage: completed });
  }
  return false;
}

async function zoomPDF(factor) {
  if (!renderer?.setZoom || moving) return;
  zoom = Math.max(1, Math.min(3, factor));
  $('#zoom-out').disabled = zoom <= 1;
  $('#zoom-in').disabled = zoom >= 3;
  $('#zoom-reset').textContent = zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`;
  words.clear(); phrases.clear();
  try {
    await renderer.setZoom(zoom);
    pageGestures.refresh();
    readerMessage();
  } catch (error) { reportError(error); }
}

const pageJump = bookPageJump({ renderer: () => renderer, book: () => ({ format: readingFormat() }),
  go: (target) => returnHistory.follow(target), focus: () => viewer.focus({ preventScroll: true }) });
const contentsUI = bookContents({ renderer: () => renderer, book: () => ({ format: readingFormat() }), bookmarks,
  go: (target) => returnHistory.follow(target), focus: () => viewer.focus({ preventScroll: true }), jumpPage: () => pageJump.open() });
function contents() { words.clear(); contentsUI.open(); }
for (const id of ['jump-page', 'page-label']) $(`#${id}`).addEventListener('click', () => { words.clear(); pageJump.open(); });

function keydown(event) {
  if (!activeBook || !renderer || document.querySelector('dialog[open]') || event.defaultPrevented
    || event.target?.closest?.('input, textarea, select, [contenteditable]')) return;
  if (phrases.keydown(event) || words.keydown?.(event)) return;
  if (event.key === 'Escape') {
    if (fallbackFullscreen) { fallbackFullscreen = false; syncFullscreen(); }
    else if (!summaryPanel.hidden) closeSummary();
    return;
  }
  const action = readingShortcut(event, settings);
  if (action === 'previous') void move(-1);
  else if (action === 'next') void move(1);
  else if (action === 'previousSection' || action === 'nextSection') void skipSection(action === 'previousSection' ? -1 : 1);
  else if (action === 'fullscreen') void toggleFullscreen();
  else if (action === 'playback') audio.toggle();
  else if (action === 'rewindAudio') audio.skipBy(-10);
  else if (action === 'forwardAudio') audio.skipBy(10);
  else if (action === 'bookmarks') void bookmarks.open();
  else if (action === 'bookmarkSelection') phrases.bookmark();
  else if (action === 'explainSelection') void phrases.explain();
  else if (action === 'audioToolbar') toggleAudioToolbar();
  else if (action === 'pinyin' && !safeMode && !activeBook?.l1Folder) { applySettings({ ...settings, showPinyin: !settings.showPinyin }); toast(settings.showPinyin ? 'Pinyin shown' : 'Pinyin hidden'); }
  else if (action === 'returnLocation') void returnHistory.back();
  else if (action === 'summary' && !safeMode) {
    if (summaryPanel.hidden) summarize();
    else closeSummary();
  }
}

async function skipSection(direction) {
  const view = renderer;
  try {
    const target = await view?.sectionTarget?.(direction);
    if (view !== renderer || target == null) return;
    await returnHistory.follow(target);
  } catch (error) { reportError(error); }
}

$('#previous').addEventListener('click', () => { viewer.focus({ preventScroll: true }); void move(-1); });
$('#reader-format-link').addEventListener('click', () => { $('#reader-more').open = false; });
$('#return-location').addEventListener('click', () => { viewer.focus({ preventScroll: true }); void returnHistory.back(); });
$('#next').addEventListener('click', () => { viewer.focus({ preventScroll: true }); void move(1); });
$('#contents-button').addEventListener('click', contents);
$('#reader-more').addEventListener('click', (event) => { if (event.target.closest('button')) $('#reader-more').open = false; });
$('#bookmarks-button').addEventListener('click', () => void bookmarks.open());
$('#sync-progress').addEventListener('click', () => void readingSync.check());
$('#sync-resume').addEventListener('click', () => void readingSync.resume());
$('#sync-keep').addEventListener('click', () => void readingSync.keepLocal());
$('#fullscreen').addEventListener('click', toggleFullscreen);
function toggleAudioToolbar() {
  const visible = temporaryAudioVisible || settings.audioEnabled && !settings.audioToolbarHidden;
  audioPeek.hide();
  settings = saveSettings({ ...settings, audioEnabled: true, audioToolbarHidden: visible });
  audio.apply();
  void audio.refresh();
  viewer.focus({ preventScroll: true });
  toast(visible ? 'Audio toolbar hidden' : 'Audio toolbar shown');
}
function swipeDownReaderPanels() {
  if ($('#narration-player').hidden) contents(); else closeAudioToolbar();
}
function closeAudioToolbar() {
  audioPeek.reset();
  settings = saveSettings({ ...settings, audioToolbarHidden: true });
  audio.apply(); syncFullscreen(); viewer.focus({ preventScroll: true });
}
$('#narration-close').addEventListener('click', closeAudioToolbar);
function showTemporaryAudio() {
  words.clear(); phrases.clear();
  if (!settings.audioEnabled) settings = saveSettings({ ...settings, audioEnabled: true, audioToolbarHidden: true });
  if (settings.audioToolbarHidden) audioPeek.show();
  audio.apply(); void audio.refresh();
}
async function togglePlaybackFromGesture() {
  words.clear(); phrases.clear();
  const book = activeBook;
  if (!settings.audioEnabled) { showTemporaryAudio(); await audio.refresh(); }
  if (book !== activeBook) return;
  if (!audio.ready) showTemporaryAudio(); else audio.toggle();
}
async function playWordFromGesture(word) {
  words.clear();
  const book = activeBook;
  if (!settings.audioEnabled) settings = saveSettings({ ...settings, audioEnabled: true, audioToolbarHidden: true });
  audio.apply();
  if (!await audio.playWord(word.node, word.index) && activeBook === book) toast('No synchronized audio is available for this word.');
}
function pinchText({ phase, factor = 1 }) {
  const feedback = $('#text-size-feedback');
  if (phase === 'start') {
    words.clear(); phrases.clear(); pinchStart = { book: activeBook, size: readingFontSize(settings), zoom, format: readingFormat() };
  }
  if (!pinchStart) return;
  if (phase === 'move') {
    // Keep the iframe coordinate space fixed throughout the gesture. Scaling
    // it under the fingers feeds its transformed coordinates into the next
    // pointer event and can cancel or reverse the size change.
    feedback.hidden = false; feedback.textContent = pinchStart.format === 'pdf' ? `${Math.round(pinchStart.zoom * factor * 100)}%` : `${Math.max(13, Math.min(40, Math.round(pinchStart.size * factor)))} px`;
  }
  if (phase === 'end' || phase === 'cancel') {
    const start = pinchStart; pinchStart = undefined; feedback.hidden = true;
    if (phase === 'end' && start.book === activeBook) {
      if (start.format === 'pdf') void zoomPDF(start.zoom * factor);
      else applySettings({ ...settings, ...fontSizeChange(start.size * factor) });
    }
  }
}
$('#audio-toggle').addEventListener('click', toggleAudioToolbar);
$('#summarize').addEventListener('click', summarize);
$('#generate-summary').addEventListener('click', summarize);
$('#immersion-toggle').addEventListener('click', () => applySettings({ ...settings, immersionMode: !settings.immersionMode }));
$('#close-summary').addEventListener('click', closeSummary);
$('#zoom-out').addEventListener('click', () => zoomPDF(zoom / 1.25));
$('#zoom-in').addEventListener('click', () => zoomPDF(zoom * 1.25));
$('#zoom-reset').addEventListener('click', () => zoomPDF(1));
$('#ai-status').addEventListener('click', checkAI);
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('keydown', keydown);
window.addEventListener('resize', words.clear);
window.addEventListener('langy-ai-cache-cleared', () => { summaries.clear(); words.reset(); resetSummary(); });
for (const button of document.querySelectorAll('[data-document-section]')) button.addEventListener('click', () => {
  const section = document.getElementById(button.dataset.documentSection); section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
if (typeof matchMedia === 'function') matchMedia('(pointer: coarse)').addEventListener('change', () => {
  words.clear(); phrases.clear(); void renderer?.apply?.(readingPreferences(comprehensionPreferences())).then(() => { pinyin.refresh(); vocabulary.refresh(); }).catch(reportError);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { void readingSync.flush(); void account.flush({ keepalive: true }); }
  else { void readingSync.check(); void account.resume(); }
});
beforeSignOut(async () => { closeReader(); await Promise.allSettled([account.flush(), readingTime.flush(), vocabulary.flush(), readingSync.flushSaved()]); });
window.addEventListener('langy-signing-out', () => { account.close(); closeReader(); proficiency.leave(); library.dispose(); processes?.dispose(); });
window.addEventListener('pagehide', () => { void readingSync.flush(); void account.flush({ keepalive: true }); });
window.addEventListener('online', () => { void account.resume(); void flushOfflineChanges(); void readingSync.flushSaved(); void refreshOfflineReader(); });
window.addEventListener('langy-offline-synced', () => { if (!$('#library-screen').hidden) void library.refresh().catch((error) => message('#library-error', error.message)); });
window.addEventListener('focus', () => void account.resume());
setInterval(() => { if (!document.hidden) { void account.resume(); void flushOfflineChanges(); void readingSync.flushSaved(); } }, 30_000);

drawIcons();
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/service-worker.js', { type: 'module' }).catch(() => {});
applyAppearance();
void checkAI();
setInterval(checkAI, 30_000);
try {
  startup.report({ label: 'Restoring your preferences…' });
  await account.start();
  startup.report({ label: 'Loading your library…' });
  const snapshot = await library.refresh({ onProgress: startup.report });
  void flushOfflineChanges();
  void readingSync.flushSaved();
  void refreshOfflineReader();
  settingsUI.setDemo(snapshot.demo);
  $('#about-link').hidden = false;
  window.addEventListener('hashchange', route);
  startup.report({ label: location.hash.startsWith('#read/') ? 'Opening your book…' : 'Preparing your library…' });
  await route();
  startup.finish();
} catch (error) {
  startup.fail(error);
  message('#library-error', error.message);
}
