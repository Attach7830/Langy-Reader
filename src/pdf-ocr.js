import { $, api, element, message } from './ui.js';
import { bookLanguages, baseLanguage } from '../shared/language.js';

const codes = { en: 'eng', es: 'spa', pt: 'por', zh: 'chi_sim', fr: 'fra', de: 'deu', it: 'ita', ja: 'jpn', ko: 'kor', ru: 'rus', ar: 'ara', hi: 'hin', nl: 'nld' };
function name(code) {
  if (code === 'chi_sim') return 'Mandarin · simplified';
  if (code === 'chi_tra') return 'Mandarin · traditional';
  try { return new Intl.DisplayNames('en', { type: 'language' }).of(code.replace('_', '-')); } catch { return code; }
}
export function pdfOCR({ changed }) {
  const dialog = $('#ocr-dialog'), form = $('#ocr-form'), languages = $('#ocr-languages'), submit = $('#ocr-submit');
  let book, epoch = 0, poll, loaded = false, current;
  const active = (job) => ['queued', 'running', 'importing'].includes(job?.state);
  function render(job) {
    current = job;
    submit.disabled = !loaded || active(job);
    $('#ocr-result').hidden = job?.state !== 'ready';
    if (job?.state === 'ready') $('#ocr-result').href = `#read/${encodeURIComponent(job.book.id)}`;
    message('#ocr-progress', job?.state === 'ready' ? `Searchable copy created${job.pages ? ` · ${job.textPages}/${job.pages} pages have text` : ''}.`
      : ({ queued: 'PDF queued for local OCR…', running: 'Scanning PDF pages. You can close this dialog; processing continues on your server.', importing: 'Adding the searchable copy…', error: job?.error })[job?.state]);
  }
  async function load(version, initial = false) {
    clearTimeout(poll);
    try {
      const result = await api(`/api/books/${encodeURIComponent(book.id)}/ocr`);
      if (version !== epoch) return;
      if (initial) {
        const preferred = new Set(bookLanguages(book).map((language) => codes[baseLanguage(language)]).filter(Boolean));
        languages.replaceChildren(...result.languages.map((code) => { const option = new Option(`${name(code)} (${code})`, code); option.selected = preferred.has(code); return option; }));
        if (!languages.selectedOptions.length && languages.options.length) languages.options[0].selected = true;
        loaded = result.available && result.languages.length > 0;
      }
      message('#ocr-error', result.error || ''); const before = current?.state; render(result.job);
      if (result.job?.state === 'ready' && before !== 'ready') await changed();
      if (active(result.job)) poll = setTimeout(() => { void load(version); }, 2000);
    } catch (error) { if (version === epoch) { message('#ocr-error', error.message); if (active(current)) poll = setTimeout(() => { void load(version); }, 5000); } }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!loaded || active(current) || !form.reportValidity()) return;
    submit.disabled = true; message('#ocr-error');
    try {
      render(await api(`/api/books/${encodeURIComponent(book.id)}/ocr`, { method: 'POST', body: { languages: [...languages.selectedOptions].map((option) => option.value), rotate: form.elements.rotate.checked } }));
      void load(epoch);
    } catch (error) { message('#ocr-error', error.message); submit.disabled = false; }
  });
  $('#ocr-result').addEventListener('click', () => dialog.close());
  return { show(value) { book = value; epoch++; clearTimeout(poll); current = null; loaded = false;
    $('#ocr-book-title').textContent = `Scan ${book.title}`; languages.replaceChildren(); form.elements.rotate.checked = true;
    message('#ocr-error'); render(null); dialog.showModal(); void load(epoch, true); } };
}
