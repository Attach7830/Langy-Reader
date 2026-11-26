import { $, api, element, message, toast } from './ui.js';
import { bookLanguages } from '../shared/language.js';
import { selectedOCRLanguages, preferredOCRLanguages } from '../shared/ocr-languages.js';
import { defaults } from './settings.js';
import { androidApp } from './platform.js';

function name(code) {
  if (code === 'chi_sim') return 'Mandarin · simplified';
  if (code === 'chi_tra') return 'Mandarin · traditional';
  if (code === 'chi_sim_vert') return 'Mandarin · simplified, vertical text';
  if (code === 'chi_tra_vert') return 'Mandarin · traditional, vertical text';
  try { return new Intl.DisplayNames('en', { type: 'language' }).of(code.replace('_', '-')); } catch { return code; }
}
export function pdfOCR({ changed, readingLanguages = () => defaults.readingLanguages }) {
  const dialog = $('#ocr-dialog'), form = $('#ocr-form'), languages = $('#ocr-languages'), submit = $('#ocr-submit');
  let book, epoch = 0, poll, loaded = false, current;
  const active = (job) => ['queued', 'running', 'importing'].includes(job?.state);
  function render(job) {
    current = job;
    submit.disabled = !loaded || active(job);
    $('#ocr-result').hidden = job?.state !== 'ready';
    if (job?.state === 'ready') $('#ocr-result').href = `#read/${encodeURIComponent(job.book.id)}`;
    const recognized = job?.recognizedCharacters == null ? '' : ` · ${job.recognizedCharacters.toLocaleString()} new characters recognized`;
    const scanned = job?.scannedPages == null ? '' : ` · ${job.scannedPages.toLocaleString()} pages scanned`;
    const skipped = job?.skippedPages > 0 ? ` · ${job.skippedPages.toLocaleString()} pages retained without scanning` : '';
    message('#ocr-progress', job?.state === 'ready' ? `${job.inPlace ? 'PDF updated in this book' : 'Previous searchable copy available'}${job.pages ? ` · ${job.textPages}/${job.pages} pages have text` : ''}${recognized}${scanned}${skipped}.${androidApp() ? ' Save the book offline again to update any downloaded copy.' : ''}`
      : ({ queued: job?.notice || 'PDF queued for local OCR…', running: 'Scanning PDF pages. You can close this dialog; processing continues on your server.', importing: 'Updating this book’s PDF…', error: job?.error })[job?.state]);
  }
  async function load(version, initial = false) {
    if (version !== epoch) return;
    clearTimeout(poll);
    try {
      const result = await api(`/api/books/${encodeURIComponent(book.id)}/ocr`);
      if (version !== epoch) return;
      if (initial) {
        const choices = selectedOCRLanguages(result.languages, readingLanguages() || defaults.readingLanguages);
        const preferred = new Set(preferredOCRLanguages(choices, bookLanguages(book)));
        languages.replaceChildren(...choices.map((code) => { const option = new Option(`${name(code)} (${code})`, code); option.selected = preferred.has(code); return option; }));
        if (!languages.selectedOptions.length && languages.options.length) languages.options[0].selected = true;
        loaded = result.available && choices.length > 0;
      }
      message('#ocr-error', result.error || (!loaded ? 'No installed OCR models match your reading languages. Update My reading languages in Settings, or rebuild the language service to install its language packs.' : '')); const before = current?.state; render(result.job);
      if (result.job?.state === 'ready' && before !== 'ready') await changed();
      if (active(result.job)) poll = setTimeout(() => { void load(version); }, 2000);
    } catch (error) { if (version === epoch) { message('#ocr-error', error.message); if (active(current)) poll = setTimeout(() => { void load(version); }, 5000); } }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!loaded || active(current) || !form.reportValidity()) return;
    const version = epoch;
    submit.disabled = true; message('#ocr-error');
    try {
      const job = await api(`/api/books/${encodeURIComponent(book.id)}/ocr`, { method: 'POST', body: { languages: [...languages.selectedOptions].map((option) => option.value), rotate: form.elements.rotate.checked, mode: form.elements.mode.value } });
      if (version !== epoch) return;
      render(job);
      if (active(job) || job.state === 'ready') {
        dialog.close(); toast(job.state === 'ready' ? 'PDF updated' : 'PDF queued for OCR. Follow its progress in Process queue.');
      } else void load(version);
    } catch (error) { if (version === epoch) { message('#ocr-error', error.message); submit.disabled = false; } }
  });
  const stop = () => { epoch++; clearTimeout(poll); };
  dialog.addEventListener('close', stop);
  $('#ocr-result').addEventListener('click', () => dialog.close());
  return { dispose() { stop(); dialog.removeEventListener('close', stop); }, show(value) { book = value; epoch++; clearTimeout(poll); current = null; loaded = false;
    $('#ocr-book-title').textContent = `Scan ${book.title}`; languages.replaceChildren(); form.elements.rotate.checked = true; form.elements.mode.value = 'redo';
    message('#ocr-error'); render(null); dialog.showModal(); void load(epoch, true); } };
}
