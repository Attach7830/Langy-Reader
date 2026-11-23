import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-600.css';
import '@fontsource/dm-sans/latin-700.css';
import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource/spectral/latin-400.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-tc/400.css';
import './styles.css';
import { readerDocks } from './reader-docks.js';
import { $, $$, api, drawIcons, element, message, toast } from './ui.js';
import { libraryScreen } from './ui-library.js';
import { settingsDialog } from './ui-settings.js';
import { wordHelp } from './words.js';
import { earlierPageContext } from './reading-context.js';
import { narration } from './narration.js';
import { readingProgressSync } from './reading-sync.js';
import { pinyinOverlay } from './pinyin.js';
import { readingVocabulary } from './reading-vocabulary.js';
import { renderSummaryDetail } from './summary-detail.js';
import { eventKey, getProgress, getSettings, keyLabel, languageName, modes, saveProgress, saveSettings, syncDeviceId, updateAppearance } from './settings.js';

const viewer = $('#viewer');
const stage = $('#stage');
const readerScreen = $('#reader-screen');
const setDockAutoHide = readerDocks(readerScreen);
const summaryPanel = $('#summary-panel');
const summaryBody = $('#summary-body');
const summaryButton = $('#generate-summary');
const summaryActions = $('#summary-actions');
const summaryDetail = $('#summary-detail');
const summaryDetailBody = $('#summary-detail-body');
const progress = getProgress();
const summaries = new Map();
let settings = getSettings();
let activeBook, renderer, loadController, activePosition, summaryController, activeSummary;
let moving = false, summaryQueued = false, fallbackFullscreen = false;
let zoom = 1;
let statusCheck = 0;
const pinyin = pinyinOverlay({ host: viewer, preferences: () => settings, renderer: () => renderer, book: () => activeBook, request: api });
const vocabulary = readingVocabulary({ book: () => activeBook, renderer: () => renderer, request: api });
viewer.addEventListener('scroll', () => vocabulary.refresh(), { passive: true });

const words = wordHelp({
  preferences: () => settings, request: api,
  languages: () => activeBook?.languages || [],
  lemmaAt: (node, offset) => audio.lemmaAt(node, offset),
  seekWord: (node, offset) => audio.seekWord(node, offset),
});
const audio = narration({
  preferences: () => settings, renderer: () => renderer, book: () => activeBook,
  navigate: (target) => move(0, target),
  changePreferences: (values) => {
    settings = { ...settings, ...values };
    saveSettings(settings);
    audio.apply();
  },
});
const library = libraryScreen({
  progress,
  onRemove(id) { delete progress[id]; saveProgress(progress); },
});
const settingsUI = settingsDialog({ preferences: () => settings, apply: applySettings });
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
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('#word-help')) words.clear(); }, true);
viewer.addEventListener('scroll', () => words.clear(), { passive: true });

function applyAppearance() {
  updateAppearance(settings);
  $('#word-mode-label').textContent = settings.mode === 'translation'
    ? `${languageName(settings.translationLanguage)} translation` : modes[settings.mode];
  if (settings.mode === 'off') $('#word-mode-label').textContent = 'Word help off';
  $('.word-settings').setAttribute('aria-label', `Word help: ${$('#word-mode-label').textContent}`);
  $('#summarize').title = settings.keys.summary ? `Summarize page (${keyLabel(settings.keys.summary)})` : 'Summarize page';
  $('#previous').title = settings.keys.previous ? `Previous page (${keyLabel(settings.keys.previous)})` : 'Previous page';
  $('#next').title = settings.keys.next ? `Next page (${keyLabel(settings.keys.next)})` : 'Next page';
}

function applySettings(updated, aiChanged) {
  const relayout = ['size', 'font', 'line', 'width', 'summaryLanguage', 'showPinyin'].some((key) => settings[key] !== updated[key]);
  const syncChanged = settings.progressSyncEnabled !== updated.progressSyncEnabled;
  settings = updated;
  saveSettings(settings);
  words.clear();
  applyAppearance();
  syncFullscreen();
  audio.apply();
  if (aiChanged) {
    summaries.clear();
    words.reset();
    void checkAI();
  }
  if (relayout || aiChanged) resetSummary();
  Promise.resolve(renderer?.apply?.(settings)).then(() => {
    pinyin.refresh();
    vocabulary.refresh();
    if (syncChanged && activeBook && renderer) void readingSync.start(activeBook, renderer);
  }).catch(reportError);
  if (activeBook) viewer.focus({ preventScroll: true });
}

async function checkAI() {
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
  readerScreen.hidden = screen !== 'reader';
  $('#library-screen').hidden = screen !== 'library';
  $('#about-screen').hidden = screen !== 'about';
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
  const changed = position.target !== activePosition?.target;
  activePosition = position;
  const saved = { target: position.target, percent: position.percent };
  if (progress[activeBook.id]?.target !== saved.target || progress[activeBook.id]?.percent !== saved.percent) {
    progress[activeBook.id] = { ...progress[activeBook.id], ...saved };
    saveProgress(progress);
  }
  if (changed && !position.reflowed) readingSync.changed();
  $('#page-label').textContent = position.label;
  $('#position-detail').textContent = position.detail;
  $('#previous').disabled = !position.previous;
  $('#next').disabled = !position.next;
  $('#progress-fill').style.width = `${Math.round((position.percent || 0) * 100)}%`;
  if (changed || position.reflowed) {
    words.clear();
    resetSummary();
    if (!summaryPanel.hidden) void generateSummary();
  }
  void audio.refresh({ seekToPage: changed && !position.reflowed });
  pinyin.refresh();
  vocabulary.refresh();
}

function showSummary(visible) {
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
  summaryBody.lang = settings.summaryLanguage;
  summaryBody.textContent = text;
  summaryButton.disabled = state === 'loading';
  summaryButton.hidden = state === 'complete';
  $('span', summaryButton).textContent = state === 'loading' ? 'Summarizing…' : state === 'error' ? 'Try again' : 'Summarize page';
}

function resetSummary() {
  summaryController?.abort();
  summaryController = undefined;
  activeSummary = undefined;
  summaryActions.hidden = true;
  summaryActions.replaceChildren();
  summaryDetail.hidden = true;
  summaryDetailBody.textContent = '';
  summaryPanel.scrollTop = 0;
  $('#summary-location').textContent = [activePosition?.label, languageName(settings.summaryLanguage)].filter(Boolean).join(' · ');
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
  if (entry.details.has(key)) {
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
    entry.details.set(key, result);
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
  if (!renderer || summaryController) return;
  if (moving) {
    summaryQueued = true;
    return;
  }
  showSummary(true);
  void generateSummary();
}

async function generateSummary() {
  if (!renderer || summaryPanel.hidden || summaryController) return;
  words.clear();
  $('#summary-location').textContent = [activePosition?.label, languageName(settings.summaryLanguage)].filter(Boolean).join(' · ');
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
  const outputLanguage = settings.summaryLanguage;
  const key = JSON.stringify([id, activePosition?.target, outputLanguage, title, author, text]);
  if (summaries.has(key)) return showSummaryResult(summaries.get(key));
  const controller = new AbortController();
  summaryController = controller;
  summaryState('loading', 'Generating a summary…');
  try {
    const earlier = await earlierPageContext(page.earlier, text, language, controller.signal);
    const body = { text, language: outputLanguage, earlier, book: { title, author, publicationDate: page.publicationDate } };
    const { text: answer, suggestions = [] } = await api('/api/ai/summary', { method: 'POST', signal: controller.signal, body });
    if (summaryController !== controller) return;
    const entry = { text: answer, suggestions, body, details: new Map() };
    summaries.set(key, entry);
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
  setDockAutoHide(Boolean(activeBook && fullscreen && settings.autoHideDocks && $('#sync-notice').hidden));
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

function closeReader() {
  vocabulary.stop();
  pinyin.clear();
  readingSync.stop();
  audio.stop();
  loadController?.abort();
  loadController = undefined;
  renderer?.destroy();
  renderer = undefined;
  activeBook = undefined;
  activePosition = undefined;
  moving = false;
  words.clear();
  showSummary(false);
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  fallbackFullscreen = false;
  syncFullscreen();
  viewer.replaceChildren();
  viewer.classList.remove('pdf-viewer');
  readerMessage();
}

async function openBook(book) {
  closeReader();
  activeBook = book;
  loadController = new AbortController();
  const { signal } = loadController;
  showScreen('reader');
  audio.apply();
  document.title = `${book.title} · Langy Reader`;
  $('#reading-title').textContent = book.title;
  $('#reading-subtitle').textContent = [book.format.toUpperCase(), languageName(book.language)].join(' · ');
  $('#pdf-zoom').hidden = book.format !== 'pdf';
  const contentsButton = $('#contents-button');
  contentsButton.disabled = true;
  contentsButton.title = book.format === 'pdf' ? 'Go to page' : 'Contents';
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
  viewer.classList.toggle('pdf-viewer', book.format === 'pdf');
  readerMessage('Opening book…');
  try {
    const open = book.format === 'pdf' ? (await import('./pdf.js')).openPdf : (await import('./epub.js')).openEpub;
    signal.throwIfAborted();
    const opened = await open({
      host: viewer, url: `/api/books/${book.id}/file`, position: progress[book.id]?.target,
      language: book.language, settings, signal,
      hooks: {
        keydown, bindWords: words.bind,
        layout: () => { pinyin.refresh(); vocabulary.refresh(); },
        position: (position) => { if (!signal.aborted) positionChanged(position); },
        error: (error) => { if (!signal.aborted) reportError(error); },
      },
    });
    if (signal.aborted) return opened.destroy();
    renderer = opened;
    pinyin.refresh();
    vocabulary.refresh();
    if (book.format === 'pdf' && opened.contents.length) {
      contentsButton.title = 'Contents';
      contentsButton.setAttribute('aria-label', contentsButton.title);
    }
    if (!$('#settings').open) await renderer.apply?.(settings);
    if (signal.aborted) return;
    contentsButton.disabled = false;
    audio.apply();
    void audio.refresh();
    void readingSync.start(book, opened);
    readerMessage();
    if (!document.querySelector('dialog[open]')) viewer.focus({ preventScroll: true });
  } catch (error) {
    if (!signal.aborted) reportError(error);
  }
}

async function route() {
  if (location.hash === '#about' && library.state.demo) {
    if (activeBook) closeReader();
    showScreen('about');
    document.title = 'About · Langy Reader';
    $('#about-title').focus({ preventScroll: true });
    return;
  }
  const match = /^#read\/([a-z0-9-]+)$/i.exec(location.hash);
  if (!match) {
    const returning = Boolean(activeBook);
    if (activeBook) closeReader();
    showScreen('library');
    document.title = 'Langy Reader';
    library.render();
    if (returning) {
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
  if (activeBook?.id !== book.id) await openBook(book);
}

async function move(direction, target) {
  if (!renderer || moving) return false;
  if (target == null && (direction > 0 ? !activePosition?.next : !activePosition?.previous)) return false;
  moving = true;
  words.clear();
  resetSummary();
  const signal = loadController.signal;
  try {
    if (target == null) await renderer.move(direction);
    else await renderer.go(target);
    await new Promise(requestAnimationFrame);
    if (!signal.aborted) readerMessage();
    return !signal.aborted;
  } catch (error) {
    if (!signal.aborted) reportError(error);
  } finally {
    if (!signal.aborted) {
      moving = false;
      if (summaryQueued) {
        summaryQueued = false;
        summarize();
      }
    }
  }
}

async function zoomPDF(factor) {
  if (!renderer?.setZoom || moving) return;
  zoom = Math.max(1, Math.min(3, factor));
  $('#zoom-out').disabled = zoom <= 1;
  $('#zoom-in').disabled = zoom >= 3;
  $('#zoom-reset').textContent = zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`;
  words.clear();
  try {
    await renderer.setZoom(zoom);
    readerMessage();
  } catch (error) { reportError(error); }
}

function contents() {
  if (!renderer) return;
  const dialog = $('#contents-dialog');
  if (dialog.open) return;
  const body = $('#contents-body');
  words.clear();
  const isPdf = activeBook.format === 'pdf';
  const entries = renderer.contents;
  $('#contents-title').textContent = isPdf && !entries.length ? 'Go to page' : 'Contents';
  body.replaceChildren();
  const current = renderer;

  function jump(target) {
    dialog.close();
    viewer.focus({ preventScroll: true });
    void move(0, target);
  }

  function tocList(items, name) {
    const list = element('nav', 'toc-list');
    list.setAttribute('aria-label', name);
    for (const { label, target, depth, marker } of items) {
      const item = target == null ? element('div', 'toc-group', label) : element('button', 'toc-item', label);
      item.style.paddingInlineStart = `${10 + 14 * Math.min(depth, 5)}px`;
      if (marker) item.append(element('span', 'toc-marker', 'Reading marker'));
      if (target != null) {
        item.type = 'button';
        item.addEventListener('click', () => jump(target));
      }
      list.append(item);
    }
    return list;
  }

  let pageInput;
  if (isPdf) {
    const form = element('form', 'pdf-jump');
    const field = element('label', 'field', `Page number (1–${renderer.pageCount})`);
    pageInput = document.createElement('input');
    pageInput.type = 'number';
    pageInput.min = '1';
    pageInput.max = String(renderer.pageCount);
    pageInput.value = String(renderer.pageNumber);
    pageInput.required = true;
    const submit = element('button', 'button primary', 'Go');
    field.append(pageInput);
    form.append(field, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      jump(pageInput.valueAsNumber);
    });
    body.append(form);
  }
  if (entries.length) body.append(tocList(entries, 'Book contents'));
  if (current.readingOutline) {
    const detail = element('details', 'toc-outline');
    const output = element('div', 'toc-outline-body');
    detail.append(element('summary', '', 'Reading outline'), output);
    body.append(detail);
    let started = false;
    async function showOutline() {
      if (!detail.open || started) return;
      started = true;
      const status = element('p', 'muted toc-note', 'Finding headings and breaks…');
      status.setAttribute('role', 'status');
      output.replaceChildren(status);
      try {
        const inferred = await current.readingOutline();
        if (renderer !== current || !output.isConnected) return;
        const description = inferred.some((item) => item.marker)
          ? 'Jump by heading or opening words. Reading markers are approximate stops.'
          : 'Jump by heading or opening words.';
        const note = element('p', 'muted toc-note', description);
        output.replaceChildren(...(inferred.length
          ? [note, tocList(inferred, 'Reading outline')]
          : [element('p', 'muted toc-note', 'No passages found.')]));
      } catch {
        if (renderer === current && output.isConnected) status.textContent = 'Could not read passages from this book.';
      }
    }
    detail.addEventListener('toggle', showOutline);
    detail.open = entries.filter((item) => item.target != null).length < 2;
    if (detail.open) void showOutline();
  }
  if (!body.children.length) body.append(element('p', 'muted', 'This book has no table of contents.'));
  dialog.showModal();
  if (!entries.length) pageInput?.select();
}

function keydown(event) {
  if (!activeBook || !renderer || document.querySelector('dialog[open]') || event.defaultPrevented
    || event.target?.closest?.('input, textarea, select, [contenteditable]')) return;
  if (event.key === 'Escape') {
    if (fallbackFullscreen) { fallbackFullscreen = false; syncFullscreen(); }
    else if (!summaryPanel.hidden) closeSummary();
    return;
  }
  const key = eventKey(event);
  if (!key || (key === 'Space' && event.target?.closest?.('button, a'))) return;
  if (key === 'Space' && settings.audioEnabled) {
    event.preventDefault();
    if (!event.repeat) audio.toggle();
    return;
  }
  if (event.repeat) return;
  const { previous, next, alternate, fullscreen, summary, playback, audioToolbar } = settings.keys;
  if (![previous, next, alternate, fullscreen, summary, playback, audioToolbar].includes(key)) return;
  event.preventDefault();
  if (key === previous) void move(-1);
  else if (key === next || key === alternate) void move(1);
  else if (key === fullscreen) void toggleFullscreen();
  else if (key === playback) audio.toggle();
  else if (key === audioToolbar) toggleAudioToolbar();
  else if (key === summary) {
    if (summaryPanel.hidden) summarize();
    else closeSummary();
  }
}

$('#previous').addEventListener('click', () => { viewer.focus({ preventScroll: true }); void move(-1); });
$('#next').addEventListener('click', () => { viewer.focus({ preventScroll: true }); void move(1); });
$('#contents-button').addEventListener('click', contents);
$('#sync-progress').addEventListener('click', () => void readingSync.check());
$('#sync-resume').addEventListener('click', () => void readingSync.resume());
$('#sync-keep').addEventListener('click', () => void readingSync.keepLocal());
$('#fullscreen').addEventListener('click', toggleFullscreen);
function toggleAudioToolbar() {
  const visible = settings.audioEnabled && !settings.audioToolbarHidden;
  settings = { ...settings, audioEnabled: true, audioToolbarHidden: visible };
  saveSettings(settings);
  audio.apply();
  void audio.refresh();
  viewer.focus({ preventScroll: true });
  toast(visible ? 'Audio toolbar hidden' : 'Audio toolbar shown');
}
$('#audio-toggle').addEventListener('click', toggleAudioToolbar);
$('#summarize').addEventListener('click', summarize);
$('#generate-summary').addEventListener('click', summarize);
$('#close-summary').addEventListener('click', closeSummary);
$('#zoom-out').addEventListener('click', () => zoomPDF(zoom / 1.25));
$('#zoom-in').addEventListener('click', () => zoomPDF(zoom * 1.25));
$('#zoom-reset').addEventListener('click', () => zoomPDF(1));
$('#ai-status').addEventListener('click', checkAI);
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('keydown', keydown);
window.addEventListener('resize', words.clear);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) void readingSync.flush();
  else void readingSync.check();
});
window.addEventListener('pagehide', () => void readingSync.flush());

drawIcons();
applyAppearance();
void checkAI();
setInterval(checkAI, 30_000);
try {
  const snapshot = await library.refresh();
  settingsUI.setDemo(snapshot.demo);
  $('#about-link').hidden = !snapshot.demo;
  window.addEventListener('hashchange', route);
  await route();
} catch (error) {
  message('#library-error', error.message);
}
