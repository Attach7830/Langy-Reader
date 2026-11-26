import { $, api, element, message, toast } from './ui.js';
import { getSettings } from './settings.js';
import { languageLabel } from './languages.js';

export function kavitaConnection() {
  let epoch = 0, config, busy = false, current, history = [], controller;
  const dialog = $('#kavita-dialog'), query = $('#kavita-query');
  const show = (value) => {
    config = value;
    $('#kavita-controls').hidden = !value.available;
    $('#kavita-managed').hidden = value.available;
    $('#kavita-remove').hidden = !value.connected;
    $('#kavita-browse').disabled = !value.connected;
    $('#kavita-import-source').disabled = !value.connected;
    $('#kavita-url').placeholder = value.connected ? 'Saved connection · ' + value.origin : 'http://YOUR-KAVITA-SERVER:5000/api/Opds/…';
    message('#kavita-status', value.connected ? 'Personal connection saved · ' + value.origin : '');
  };
  async function load() { const visit = epoch; try { const value = await api('/api/settings/kavita'); if (visit === epoch) show(value); } catch (error) { if (visit === epoch) message('#kavita-status', error.message); } }
  $('#kavita-save').addEventListener('click', async () => {
    if (busy) return; busy = true; const visit = epoch; $('#kavita-save').disabled = true;
    try {
      const value = await api('/api/settings/kavita', { method: 'PUT', body: { url: $('#kavita-url').value, username: $('#kavita-username').value, password: $('#kavita-password').value } });
      if (visit !== epoch) return; show(value); for (const id of ['url','username','password']) $('#kavita-' + id).value = ''; toast('Kavita connection saved.');
    } catch (error) { if (visit === epoch) message('#kavita-status', error.message); }
    finally { busy = false; $('#kavita-save').disabled = false; }
  });
  $('#kavita-remove').addEventListener('click', async () => {
    if (busy || !window.confirm('Are you sure you want to remove your Kavita connection? Queued imports from this connection will need to be added again.')) return;
    busy = true; const visit = epoch;
    try { const value = await api('/api/settings/kavita', { method: 'DELETE' }); if (visit === epoch) { show(value); current = null; history = []; toast('Kavita connection removed.'); } }
    catch (error) { if (visit === epoch) message('#kavita-status', error.message); }
    finally { busy = false; }
  });
  function render(result) {
    current = result; $('#kavita-catalogue-title').textContent = result.title;
    query.disabled = $('#kavita-search').disabled = !result.searchable;
    $('#kavita-back').disabled = !history.length;
    $('#kavita-entries').replaceChildren(...result.entries.map((item) => {
      const card = element('article', 'kavita-entry');
      if (item.cover) { const image = document.createElement('img'); image.src = '/api/kavita/covers/' + encodeURIComponent(item.cover); image.alt = ''; image.loading = 'lazy'; card.append(image); }
      const body = element('div', 'kavita-entry-copy'); body.append(element('h3', '', item.title));
      if (item.author) body.append(element('p', 'field-note', item.author));
      if (item.summary) { const details = document.createElement('details'); details.append(element('summary', '', 'Description'), element('p', 'field-note', item.summary)); body.append(details); }
      const actions = element('div', 'download-actions');
      if (item.node) { const open = element('button', 'button secondary small', 'Browse'); open.type = 'button'; open.addEventListener('click', () => void browse(item.node, true)); actions.append(open); }
      for (const book of item.acquisitions) {
        const add = element('button', 'button primary small', 'Import ' + book.format.toUpperCase()); add.type = 'button';
        add.addEventListener('click', async () => {
          add.disabled = true; const visit = epoch;
          try { await api('/api/imports/kavita', { method: 'POST', body: { item: book.id, categoryId: $('#kavita-folder').value, language: $('#kavita-language').value } }); if (visit !== epoch) return; add.textContent = 'Queued'; toast('Book import queued.'); window.dispatchEvent(new CustomEvent('langy-processes-changed')); }
          catch (error) { if (visit === epoch) { add.disabled = false; message('#kavita-error', error.message); } }
        }); actions.append(add);
      }
      if (!item.node && !item.acquisitions.length) body.append(element('p', 'field-note', 'No EPUB or PDF download available.'));
      body.append(actions); card.append(body); return card;
    }));
    $('#kavita-navigation').replaceChildren(...result.navigation.map((item) => { const button = element('button', 'button quiet small', item.label); button.type = 'button'; button.addEventListener('click', () => void browse(item.node, true)); return button; }));
    if (!result.entries.length) message('#kavita-result', 'No books or collections found.'); else message('#kavita-result');
  }
  async function browse(node, push = false, q = '') {
    controller?.abort(); const task = controller = new AbortController(), visit = epoch;
    message('#kavita-error'); message('#kavita-result', 'Loading Kavita catalogue…');
    try { const result = await api('/api/kavita/catalogue?' + new URLSearchParams({ ...(node ? { node } : {}), ...(q ? { q } : {}) }), { signal: task.signal }); if (visit !== epoch || task.signal.aborted) return; if (push && current) history.push(current); render(result); }
    catch (error) { if (visit === epoch && !task.signal.aborted) { message('#kavita-result'); message('#kavita-error', error.message); } }
  }
  async function open() {
    history = []; current = null; query.value = ''; $('#kavita-entries').replaceChildren();
    if ($('#book-dialog').open) $('#book-dialog').close();
    if (!dialog.open) dialog.showModal();
    const visit = epoch;
    try { const library = await api('/api/library'); if (visit !== epoch || !dialog.open) return; $('#kavita-folder').replaceChildren(new Option('Uncategorized', ''), ...library.categories.map((item) => new Option(item.name, item.id))); $('#kavita-language').replaceChildren(new Option('Detect automatically', ''), ...getSettings().readingLanguages.map((code) => new Option(languageLabel(code), code))); await browse(); }
    catch (error) { if (visit === epoch) message('#kavita-error', error.message); }
  }
  $('#kavita-browse').addEventListener('click', () => void open());
  $('#kavita-import-source').addEventListener('click', () => void open());
  $('#kavita-home').addEventListener('click', () => { history = []; current = null; query.value = ''; void browse(); });
  $('#kavita-back').addEventListener('click', () => { const previous = history.pop(); if (previous) { query.value = ''; render(previous); } });
  $('#kavita-search').addEventListener('click', () => void browse(current?.node, true, query.value.trim()));
  query.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); if (!query.disabled) void browse(current?.node, true, query.value.trim()); } });
  dialog.addEventListener('close', () => { controller?.abort(); });
  $('#import-book').addEventListener('click', () => void load());
  return { load, reset() { epoch++; controller?.abort(); current = null; history = []; config = null; for (const id of ['url','username','password']) $('#kavita-' + id).value = ''; } };
}
