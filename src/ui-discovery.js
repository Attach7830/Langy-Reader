import { $, element, message } from './ui.js';
import { parseLanguage } from './languages.js';
import { languageName } from './settings.js';

const stages = { queued: 'Waiting for book discovery…', scanning: 'Looking for connections in your library…', searching: 'Searching the web and verifying book records…', ranking: 'Your AI is choosing related books…', cancelled: 'Book discovery cancelled.' };
function sourceLink(source) {
  try {
    const url = new URL(source.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const link = element('a', '', source.title); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  } catch { return null; }
}

export function discoveryScreen({ request, pollMs = 1800 }) {
  const form = $('#discovery-form'), button = $('#generate-discovery'), cancel = $('#cancel-discovery');
  let visible = false, timer, epoch = 0, pending = false, rendered, current, dirty = false;
  form.addEventListener('input', () => { dirty = true; });
  function render(state) {
    current = state;
    const busy = state.busy || pending;
    button.disabled = busy || !state.libraryCount;
    button.textContent = state.result || state.state === 'error' ? 'Refresh recommendations' : 'Find recommendations';
    cancel.hidden = !state.busy; cancel.disabled = false;
    form.setAttribute('aria-busy', String(busy));
    $('#discovery-connection').textContent = `${state.libraryCount.toLocaleString()} ${state.libraryCount === 1 ? 'book' : 'books'} in your library · Model: ${state.model} (${state.provider})`;
    $('#discovery-status').textContent = !state.libraryCount ? 'Import a book to get started.' : state.stale && !state.busy ? 'Your library or model has changed, or these results are over a day old. Refresh for current recommendations.'
      : stages[state.state] || (state.state === 'ready' ? `Recommendations ready · ${new Date(state.result.generatedAt).toLocaleString()}` : 'Ready to find books connected to your library.');
    message('#discovery-error', state.error || '');
    $('#discovery-warnings').replaceChildren(...(state.result?.warnings || []).map((text) => element('p', '', text)));
    const result = state.result;
    $('#discovery-results').hidden = !result;
    const revision = result && JSON.stringify([result.generatedAt, result.books.map((book) => book.id || book.title)]);
    if (!result || rendered === revision) return;
    rendered = revision;
    $('#discovery-summary').textContent = result.text;
    $('#discovery-interests').textContent = `${result.interests} Scanned ${result.scannedBooks} books${result.sampledBooks < result.scannedBooks ? `; used ${result.sampledBooks} representative titles for AI context` : ''}. Requested language: ${languageName(result.language)}.`;
    $('#discovery-queries').replaceChildren(...result.queries.map((query) => element('li', '', query)));
    $('#discovery-books').replaceChildren(...result.books.map((book) => {
      const card = element('article', 'discovery-card'), heading = element('h2', '', book.title);
      card.append(heading, element('p', 'book-meta', book.authors.join(', ') + (book.year != null ? ` · First published ${book.year}` : '')),
        element('p', '', book.reason), element('p', 'field-note', 'Connected to: ' + book.basedOn.map((item) => item.title).join(' · ')));
      const sources = element('div', 'discovery-sources');
      for (const source of book.sources) { const link = sourceLink(source); if (link) sources.append(link); }
      card.append(sources); return card;
    }));
  }
  function schedule() { clearTimeout(timer); if (visible && current?.busy) timer = setTimeout(() => void refresh(), pollMs); }
  async function refresh() {
    const version = epoch;
    try {
      const state = await request('/api/discovery');
      if (!visible || version !== epoch) return;
      render(state); schedule();
    } catch (error) { if (visible && version === epoch) { message('#discovery-error', error.message); clearTimeout(timer); timer = setTimeout(() => void refresh(), 7000); } }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (pending || current?.busy || !current?.libraryCount) return;
    const raw = $('#discovery-language').value.trim(), language = parseLanguage(raw);
    if (raw && !language) return message('#discovery-error', 'Choose a language or enter a valid language code.');
    pending = true; const version = epoch; render({ ...current, error: null });
    try {
      const state = await request('/api/discovery', { method: 'POST', body: { language, focus: $('#discovery-focus').value.trim(), refresh: Boolean(current?.result || current?.state === 'error') } });
      if (!visible || version !== epoch) return;
      pending = false; render(state); schedule();
    } catch (error) { if (visible && version === epoch) { pending = false; render({ ...current, error: error.message }); } }
    finally { pending = false; if (visible && current) { render(current); schedule(); } }
  });
  cancel.addEventListener('click', async () => {
    cancel.disabled = true; const version = epoch;
    try { const state = await request('/api/discovery', { method: 'DELETE' }); if (visible && version === epoch) { render(state); schedule(); } }
    catch (error) { if (visible && version === epoch) { message('#discovery-error', error.message); cancel.disabled = false; } }
  });
  return {
    async open() {
      visible = true; epoch++; clearTimeout(timer);
      await refresh();
      if (visible && current && !dirty) { $('#discovery-focus').value = current.focus || ''; if (current.id) $('#discovery-language').value = current.language; }
    },
    leave() { visible = false; epoch++; clearTimeout(timer); },
  };
}
