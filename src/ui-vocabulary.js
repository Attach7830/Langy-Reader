import { $, api, element, message } from './ui.js';
import { languageName } from './settings.js';

const language = (code) => code === 'zh' ? 'Mandarin' : languageName(code);
export const unfamiliarLabel = (value) => value?.byLanguage?.map((item) => `${item.unfamiliar.toLocaleString()} ${language(item.language)} ${item.unit}`).join(' · ') || '';

export function vocabularyLibrary() {
  const dialog = $('#vocabulary-dialog');
  let offset = 0, epoch = 0, timer;
  async function load() {
    const version = ++epoch;
    try {
      const query = new URLSearchParams({ language: $('#vocabulary-language').value, search: $('#vocabulary-search').value, offset: String(offset) });
      const result = await api('/api/vocabulary?' + query);
      if (version !== epoch || !dialog.open) return;
      $('#vocabulary-entries').replaceChildren(...result.entries.map((item) => {
        const row = element('tr');
        for (const text of [item.term, language(item.language), item.unit, new Date(item.lastSeen).toLocaleDateString()]) row.append(element('td', '', text));
        return row;
      }));
      $('#vocabulary-page').textContent = result.total ? `${offset + 1}–${offset + result.entries.length} of ${result.total} entries` : 'No matching vocabulary recorded yet.';
      $('#vocabulary-previous').disabled = offset === 0;
      $('#vocabulary-next').disabled = !result.more;
      message('#vocabulary-error');
    } catch (error) { if (version === epoch) message('#vocabulary-error', error.message); }
  }
  $('#open-vocabulary').addEventListener('click', () => { offset = 0; dialog.showModal(); void load(); });
  $('#vocabulary-search').addEventListener('input', () => { clearTimeout(timer); offset = 0; timer = setTimeout(() => void load(), 200); });
  $('#vocabulary-language').addEventListener('change', () => { offset = 0; void load(); });
  $('#vocabulary-previous').addEventListener('click', () => { offset = Math.max(0, offset - 100); void load(); });
  $('#vocabulary-next').addEventListener('click', () => { offset += 100; void load(); });
  return {
    update(summary) {
      const rows = summary?.byLanguage || [];
      $('#vocabulary-summary').textContent = rows.length ? 'Seen: ' + rows.map((item) => `${item.count.toLocaleString()} ${language(item.language)} ${item.unit}`).join(' · ') : 'Your vocabulary catalogue grows from the pages you read.';
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
    return row;
  });
}
