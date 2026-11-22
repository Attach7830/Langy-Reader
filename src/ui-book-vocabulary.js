import { $, api, element, message } from './ui.js';
import { languageName } from './settings.js';

const languageNameFor = (code) => code === 'zh' ? 'Mandarin' : languageName(code);

export function bookVocabulary({ request = api } = {}) {
  const dialog = $('#book-vocabulary-dialog'), language = $('#book-vocabulary-language'), search = $('#book-vocabulary-search');
  const meanings = $('#book-vocabulary-meaning'), cache = new Map();
  let book, offset = 0, epoch = 0, timer, controller, pageSize = 10;

  function current(version) { return version === epoch && dialog.open; }
  async function meaning(item, cell, result, version, signal) {
    const mode = meanings.value, id = book.id;
    const key = JSON.stringify([id, result.revision, mode, item.language, item.unit, item.term, item.example]);
    cell.textContent = 'Loading meaning…';
    try {
      const answer = cache.get(key) || await request(`/api/books/${encodeURIComponent(id)}/vocabulary/meaning`, {
        method: 'POST', signal, body: { mode, language: item.language, unit: item.unit, term: item.term },
      });
      if (!current(version)) return;
      cache.set(key, answer); if (cache.size > 500) cache.delete(cache.keys().next().value);
      const text = element('span', 'vocabulary-meaning', answer.text); text.lang = answer.language; text.dir = 'auto';
      cell.replaceChildren(text, element('small', 'field-note', answer.source));
    } catch (error) {
      if (!current(version) || signal.aborted) return;
      const retry = element('button', 'button quiet small', 'Retry meaning'); retry.type = 'button';
      retry.addEventListener('click', () => void meaning(item, cell, result, version, signal));
      cell.replaceChildren(element('span', 'field-note', error.message), retry);
    }
  }

  async function load() {
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal, version = ++epoch;
    $('#book-vocabulary-entries').replaceChildren();
    $('#book-vocabulary-page').textContent = 'Loading vocabulary…';
    $('#book-vocabulary-previous').disabled = true; $('#book-vocabulary-next').disabled = true;
    message('#book-vocabulary-error');
    try {
      const query = new URLSearchParams({ language: language.value, search: search.value, offset: String(offset) });
      const result = await request(`/api/books/${encodeURIComponent(book.id)}/vocabulary/below-threshold?${query}`, { signal });
      if (!current(version)) return;
      pageSize = result.pageSize; offset = result.offset;
      const selected = language.value;
      language.replaceChildren(new Option('All languages', ''), ...result.byLanguage.map((row) => new Option(languageNameFor(row.language), row.language)));
      language.value = selected;
      $('#book-vocabulary-summary').textContent = `Threshold: ${result.threshold} exposures. ` + result.byLanguage.map((row) => `${row.count.toLocaleString()} ${languageNameFor(row.language)} ${row.unit} below threshold`).join(' · ');
      $('#book-vocabulary-page').textContent = result.total ? `${offset + 1}–${offset + result.entries.length} of ${result.total.toLocaleString()} entries` : 'No matching vocabulary below your threshold.';
      $('#book-vocabulary-previous').disabled = offset === 0; $('#book-vocabulary-next').disabled = !result.more;
      const jobs = result.entries.map((item) => {
        const row = element('tr'), word = element('td');
        const term = element('strong', '', item.term); term.lang = item.language; term.dir = 'auto';
        word.append(term, element('small', 'field-note', item.unit));
        if (item.example?.text) {
          const example = element('details', 'vocabulary-example');
          const passage = element('p', '', item.example.text); passage.dir = 'auto';
          example.append(element('summary', '', 'Example from book'), passage); word.append(example);
        }
        const cell = element('td', 'book-vocabulary-meaning-cell', 'Waiting for meaning…');
        row.append(word, element('td', '', languageNameFor(item.language)), element('td', '', `${item.exposures.toLocaleString()} / ${result.threshold.toLocaleString()}`), element('td', '', item.occurrences.toLocaleString()), cell);
        $('#book-vocabulary-entries').append(row);
        return { item, cell };
      });
      // Fill a bounded page progressively, without starting an AI request for every book word.
      const workers = Array.from({ length: Math.min(2, jobs.length) }, async () => {
        while (jobs.length && current(version)) {
          const { item, cell } = jobs.shift();
          await meaning(item, cell, result, version, signal);
        }
      });
      await Promise.all(workers);
    } catch (error) {
      if (current(version) && !signal.aborted) {
        $('#book-vocabulary-page').textContent = 'Vocabulary could not be loaded.';
        message('#book-vocabulary-error', error.message);
      }
    }
  }
  dialog.addEventListener('close', () => { epoch++; controller?.abort(); clearTimeout(timer); });
  language.addEventListener('change', () => { offset = 0; void load(); });
  meanings.addEventListener('change', () => { void load(); });
  search.addEventListener('input', () => { clearTimeout(timer); offset = 0; timer = setTimeout(() => void load(), 200); });
  $('#book-vocabulary-previous').addEventListener('click', () => { offset = Math.max(0, offset - pageSize); void load(); });
  $('#book-vocabulary-next').addEventListener('click', () => { offset += pageSize; void load(); });
  return {
    open(selected) {
      controller?.abort(); clearTimeout(timer); cache.clear();
      book = selected; offset = 0; language.replaceChildren(new Option('All languages', '')); search.value = '';
      $('#book-vocabulary-title').textContent = `${book.title} · Words below threshold`;
      $('#book-vocabulary-summary').textContent = '';
      dialog.showModal(); void load();
    },
  };
}
