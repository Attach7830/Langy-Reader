import { $, api, element, message } from './ui.js';
import { languageName } from './settings.js';

const language = (code) => code === 'zh' ? 'Mandarin' : languageName(code);
export const bookCountLabel = (counts) => counts ? [counts.words || !counts.characters ? `${counts.words.toLocaleString()} words` : '',
  counts.characters ? `${counts.characters.toLocaleString()} Mandarin characters` : ''].filter(Boolean).join(' · ') : '';
export const unfamiliarLabel = (value, belowThreshold = false) => value?.byLanguage?.map((item) => {
  const count = belowThreshold ? item.belowThreshold : item.unfamiliar;
  const rate = belowThreshold ? item.belowThresholdPer1000 : item.unfamiliarPer1000;
  const density = Number.isFinite(rate) ? ` (${rate > 0 && rate < .01 ? '<0.01' : rate.toLocaleString(undefined, { maximumFractionDigits: 2 })} per 1,000 ${item.textUnit})` : '';
  return `${count.toLocaleString()} ${language(item.language)} ${item.unit}${density}`;
}).join(' · ') || '';

export function vocabularyLibrary({ changed = () => {} } = {}) {
  const dialog = $('#vocabulary-dialog');
  let offset = 0, epoch = 0, timer, thresholdEdited = false;
  const thresholdInput = $('#vocabulary-threshold');
  async function load() {
    const version = ++epoch;
    try {
      const query = new URLSearchParams({ language: $('#vocabulary-language').value, search: $('#vocabulary-search').value, offset: String(offset) });
      const result = await api('/api/vocabulary?' + query);
      if (version !== epoch || !dialog.open) return;
      if (!thresholdEdited) thresholdInput.value = result.threshold ?? 20;
      showKnown(result);
      showReading(result.reading);
      $('#vocabulary-entries').replaceChildren(...result.entries.map((item) => {
        const row = element('tr');
        const source = item.completionExposures ? `${(item.trackedExposures || 0).toLocaleString()} tracked · ${item.completionExposures.toLocaleString()} from read books` : 'Tracked reading';
        for (const text of [item.term, language(item.language), item.unit, (item.exposures ?? 1).toLocaleString(), source, item.likelyKnown ? 'Likely known' : 'Below threshold', new Date(item.lastSeen).toLocaleDateString()]) row.append(element('td', '', text));
        return row;
      }));
      $('#vocabulary-page').textContent = result.total ? `${offset + 1}–${offset + result.entries.length} of ${result.total} entries` : 'No matching vocabulary recorded yet.';
      $('#vocabulary-previous').disabled = offset === 0;
      $('#vocabulary-next').disabled = !result.more;
      message('#vocabulary-error');
    } catch (error) { if (version === epoch) message('#vocabulary-error', error.message); }
  }
  function showKnown(summary) {
    const rows = summary?.likelyKnown || [];
    const text = rows.length ? rows.map((item) => `${item.count.toLocaleString()} ${language(item.language)} ${item.unit}`).join(' · ') : 'No recorded vocabulary yet';
    $('#vocabulary-known-summary').textContent = `Likely known (${summary?.threshold ?? 20}+ exposures): ${text}`;
    $('#vocabulary-known-detail').textContent = `Likely known: ${text}`;
  }
  function showReading(reading) {
    $('#reading-summary').textContent = `Total words read: ${(reading?.words ?? 0).toLocaleString()}`
      + (reading?.characters ? ` · Mandarin characters read: ${reading.characters.toLocaleString()}` : '');
    $('#reading-summary').title = `${(reading?.trackedWords ?? 0).toLocaleString()} tracked words · ${(reading?.completedWords ?? 0).toLocaleString()} additional words from books marked read`;
    $('#reading-detail').textContent = 'Estimated from displayed passages and books marked read. Rereading in a new session counts again.'
      + (reading?.pendingBooks ? ` ${reading.pendingBooks} read ${reading.pendingBooks === 1 ? 'book awaits' : 'books await'} text counting.` : '');
  }
  $('#open-vocabulary').addEventListener('click', () => { offset = 0; thresholdEdited = false; dialog.showModal(); void load(); });
  thresholdInput.addEventListener('input', () => { thresholdEdited = true; });
  $('#vocabulary-threshold-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const threshold = Number(thresholdInput.value), button = $('#save-vocabulary-threshold');
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 10000) return message('#vocabulary-error', 'Choose an exposure threshold from 1 to 10,000.');
    button.disabled = true;
    try {
      await api('/api/vocabulary/settings', { method: 'PUT', body: { threshold } });
      thresholdEdited = false; await load(); await changed();
    } catch (error) { message('#vocabulary-error', error.message); }
    finally { button.disabled = false; }
  });
  $('#vocabulary-search').addEventListener('input', () => { clearTimeout(timer); offset = 0; timer = setTimeout(() => void load(), 200); });
  $('#vocabulary-language').addEventListener('change', () => { offset = 0; void load(); });
  $('#vocabulary-previous').addEventListener('click', () => { offset = Math.max(0, offset - 100); void load(); });
  $('#vocabulary-next').addEventListener('click', () => { offset += 100; void load(); });
  return {
    update(summary) {
      const rows = summary?.byLanguage || [];
      $('#vocabulary-summary').textContent = rows.length ? 'Seen: ' + rows.map((item) => `${item.count.toLocaleString()} ${language(item.language)} ${item.unit}`).join(' · ') : 'Your vocabulary catalogue grows from reading and books marked read.';
      showKnown(summary);
      showReading(summary?.reading);
      const select = $('#vocabulary-language'), value = select.value;
      select.replaceChildren(new Option('All languages', ''), ...[...new Set(rows.map((item) => item.language))].map((code) => new Option(language(code), code)));
      if ([...select.options].some((option) => option.value === value)) select.value = value;
    },
  };
}

export function recommendationRows(books, close) {
  return books.map((book) => {
    const row = element('div', 'recommendation-row');
    const link = element('a', 'book-title', book.title);
    link.href = `#read/${encodeURIComponent(book.id)}`; link.addEventListener('click', close);
    row.append(link, element('span', 'book-meta', book.byLanguage.map((item) => `${item.shared.toLocaleString()} shared ${language(item.language)} ${item.unit}`).join(' · ')),
      element('span', 'field-note', 'Not yet seen: ' + unfamiliarLabel(book.familiarity)));
    const archive = element('a', 'button quiet small', 'Search Anna’s Archive');
    archive.href = `/api/archive/search?${new URLSearchParams({ title: book.title, author: book.author || '' })}`; archive.target = '_blank'; archive.rel = 'noopener noreferrer'; row.append(archive);
    return row;
  });
}
