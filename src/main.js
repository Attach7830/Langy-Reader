import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-600.css';
import '@fontsource/dm-sans/latin-700.css';
import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource/spectral/latin-400.css';
import './styles.css';
import { readerDocks } from './reader-docks.js';
import { $, $$, api, drawIcons, element, message } from './ui.js';
import { libraryScreen } from './ui-library.js';
import { settingsDialog } from './ui-settings.js';
import { wordHelp } from './words.js';
import { eventKey, getProgress, getSettings, keyLabel, languageName, modes, saveProgress, saveSettings, updateAppearance } from './settings.js';

const viewer = $('#viewer');
const stage = $('#stage');
const readerScreen = $('#reader-screen');
const setDockAutoHide = readerDocks(readerScreen);
const summaryPanel = $('#summary-panel');
const summaryBody = $('#summary-body');
const summaryButton = $('#generate-summary');
const progress = getProgress();
const summaries = new Map();
let settings = getSettings();
let activeBook, renderer, loadController, activePosition, summaryController;
let moving = false, summaryQueued = false, fallbackFullscreen = false;
let zoom = 1;
let statusCheck = 0;

const words = wordHelp({ preferences: () => settings, request: api });
const library = libraryScreen({
  progress,
  onRemove(id) { delete progress[id]; saveProgress(progress); },
});
const settingsUI = settingsDialog({ preferences: () => settings, apply: applySettings });

for (const close of $$('[data-close]')) {
  close.addEventListener('click', () => {
    const dialog = close.closest('dialog');
    if (dialog) dialog.dispatchEvent(new Event('cancel', { cancelable: true })) && dialog.close();
    if (activeBook && !dialog?.open) viewer.focus({ preventScroll: true });
  });
}
document.addEventListener('pointerdown', () => words.clear(), true);
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
  const relayout = ['size', 'font', 'line', 'width', 'summaryLanguage'].some((key) => settings[key] !== updated[key]);
  settings = updated;
  saveSettings(settings);
  words.clear();
  applyAppearance();
  syncFullscreen();
  if (aiChanged) {
    summaries.clear();
    words.reset();
    void checkAI();
  }
  if (relayout || aiChanged) resetSummary();
  Promise.resolve(renderer?.apply?.(settings)).catch(reportError);
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

function showReader(visible) {
  readerScreen.hidden = !visible;
  $('#library-screen').hidden = visible;
  $('#library-header').hidden = visible;
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
    progress[activeBook.id] = saved;
    saveProgress(progress);
  }
  $('#page-label').textContent = position.label;
  $('#position-detail').textContent = position.detail;
  $('#previous').disabled = !position.previous;
  $('#next').disabled = !position.next;
  $('#progress-fill').style.width = `${Math.round((position.percent || 0) * 100)}%`;
  if (changed) {
    words.clear();
    resetSummary();
  }
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
  $('#summary-location').textContent = [activePosition?.label, languageName(settings.summaryLanguage)].filter(Boolean).join(' · ');
  summaryState('idle', 'Generate a summary of the current page.');
}

async function summarize() {
  if (!renderer || summaryController) return;
  if (moving) {
    summaryQueued = true;
    return;
  }
  words.clear();
  showSummary(true);
  $('#summary-location').textContent = [activePosition?.label, languageName(settings.summaryLanguage)].filter(Boolean).join(' · ');
  const page = renderer.excerpt().trim();
  if (!page) {
    summaryState('error', activeBook.format === 'pdf'
      ? 'This page has no selectable text. Scanned pages remain readable. They need a text layer for language help.'
      : 'This page has no text to summarize.');
    return;
  }
  const key = JSON.stringify([activeBook.id, settings.summaryLanguage, page]);
  if (summaries.has(key)) return summaryState('complete', summaries.get(key));
  const controller = new AbortController();
  summaryController = controller;
  summaryState('loading', 'Generating a summary…');
  try {
    const { text } = await api('/api/ai/summary', {
      method: 'POST', signal: controller.signal, body: { text: page, language: settings.summaryLanguage },
    });
    if (summaryController !== controller) return;
    summaries.set(key, text);
    if (summaries.size > 90) summaries.delete(summaries.keys().next().value);
    summaryState('complete', text);
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
  setDockAutoHide(Boolean(activeBook && fullscreen && settings.autoHideDocks));
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
  showReader(true);
  document.title = `${book.title} · Langy Reader`;
  $('#reading-title').textContent = book.title;
  $('#reading-subtitle').textContent = [book.format.toUpperCase(), languageName(book.language)].join(' · ');
  $('#pdf-zoom').hidden = book.format !== 'pdf';
  $('#contents-button').setAttribute('aria-label', book.format === 'pdf' ? 'Go to page' : 'Contents');
  $('#contents-button').title = book.format === 'pdf' ? 'Go to page' : 'Contents';
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
        position: (position) => { if (!signal.aborted) positionChanged(position); },
        error: (error) => { if (!signal.aborted) reportError(error); },
      },
    });
    if (signal.aborted) return opened.destroy();
    renderer = opened;
    if (!$('#settings').open) await renderer.apply?.(settings);
    if (signal.aborted) return;
    readerMessage();
    if (!document.querySelector('dialog[open]')) viewer.focus({ preventScroll: true });
  } catch (error) {
    if (!signal.aborted) reportError(error);
  }
}

async function route() {
  const match = /^#read\/([a-z0-9-]+)$/i.exec(location.hash);
  if (!match) {
    if (activeBook) closeReader();
    showReader(false);
    document.title = 'Langy Reader';
    library.render();
    return;
  }
  const book = library.state.books.find(({ id }) => id === match[1]);
  if (!book) {
    closeReader();
    history.replaceState(null, '', '#library');
    showReader(false);
    return message('#library-error', 'This book could not be found. Demo uploads expire after 24 hours.');
  }
  if (activeBook?.id !== book.id) await openBook(book);
}

async function move(direction, target) {
  if (!renderer || moving) return;
  if (target == null && (direction > 0 ? !activePosition?.next : !activePosition?.previous)) return;
  moving = true;
  words.clear();
  resetSummary();
  const signal = loadController.signal;
  try {
    if (target == null) await renderer.move(direction);
    else await renderer.go(target);
    await new Promise(requestAnimationFrame);
    if (!signal.aborted) readerMessage();
  } catch (error) {
    if (!signal.aborted) reportError(error);
  } finally {
    if (!signal.aborted) {
      moving = false;
      if (summaryQueued) {
        summaryQueued = false;
        void summarize();
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
  const body = $('#contents-body');
  words.clear();
  if (activeBook.format === 'pdf') {
    $('#contents-title').textContent = 'Go to page';
    const form = element('form', 'pdf-jump');
    const field = element('label', 'field', `Page number (1–${renderer.pageCount})`);
    const number = document.createElement('input');
    number.type = 'number';
    number.min = '1';
    number.max = String(renderer.pageCount);
    number.value = String(renderer.pageNumber);
    number.required = true;
    const submit = element('button', 'button primary', 'Go');
    field.append(number);
    form.append(field, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      dialog.close();
      viewer.focus({ preventScroll: true });
      void move(0, number.valueAsNumber);
    });
    body.replaceChildren(form);
    dialog.showModal();
    number.select();
  } else {
    $('#contents-title').textContent = 'Contents';
    const items = renderer.contents.map(({ label, target, depth }) => {
      const button = element('button', 'toc-item', label);
      button.type = 'button';
      button.style.paddingInlineStart = `${10 + 14 * depth}px`;
      button.addEventListener('click', () => {
        dialog.close();
        viewer.focus({ preventScroll: true });
        void move(0, target);
      });
      return button;
    });
    body.replaceChildren(...(items.length ? items : [element('p', 'muted', 'This book has no table of contents.')]));
    dialog.showModal();
  }
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
  if (!key || event.repeat || (key === 'Space' && event.target?.closest?.('button, a'))) return;
  const { previous, next, alternate, fullscreen, summary } = settings.keys;
  if (![previous, next, alternate, fullscreen, summary].includes(key)) return;
  event.preventDefault();
  if (key === previous) void move(-1);
  else if (key === next || key === alternate) void move(1);
  else if (key === fullscreen) void toggleFullscreen();
  else if (key === summary) {
    if (summaryPanel.hidden) void summarize();
    else closeSummary();
  }
}

$('#previous').addEventListener('click', () => { viewer.focus({ preventScroll: true }); void move(-1); });
$('#next').addEventListener('click', () => { viewer.focus({ preventScroll: true }); void move(1); });
$('#contents-button').addEventListener('click', contents);
$('#fullscreen').addEventListener('click', toggleFullscreen);
$('#summarize').addEventListener('click', summarize);
$('#generate-summary').addEventListener('click', summarize);
$('#close-summary').addEventListener('click', closeSummary);
$('#zoom-out').addEventListener('click', () => zoomPDF(zoom / 1.25));
$('#zoom-in').addEventListener('click', () => zoomPDF(zoom * 1.25));
$('#zoom-reset').addEventListener('click', () => zoomPDF(1));
$('#ai-status').addEventListener('click', checkAI);
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('keydown', keydown);
window.addEventListener('resize', () => { words.clear(); resetSummary(); });

drawIcons();
applyAppearance();
void checkAI();
setInterval(checkAI, 30_000);
try {
  const snapshot = await library.refresh();
  settingsUI.setDemo(snapshot.demo);
  window.addEventListener('hashchange', route);
  await route();
} catch (error) {
  message('#library-error', error.message);
}
