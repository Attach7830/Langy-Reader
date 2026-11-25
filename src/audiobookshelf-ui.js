import { $, api, element, message, toast } from './ui.js';
import { credentialRemoval } from './credential-removal.js';

export function audiobookshelfSettings() {
  let config, libraries = [], categories = [], loading, choicesLoaded = false, epoch = 0;
  const url = $('#abs-url'), key = $('#abs-key'), library = $('#abs-library'), folder = $('#abs-folder');
  const mappings = $('#abs-category-destinations'), mappingRows = $('#abs-category-rows');
  const removeKey = credentialRemoval({ button: $('#abs-clear-key'), input: key, endpoint: '/api/settings/audiobookshelf/key',
    status: '#abs-settings-status', revision: () => epoch, changed(next) {
      config = next; key.placeholder = 'Audiobookshelf API key'; choicesLoaded = false;
      mappings.hidden = true; library.disabled = folder.disabled = true;
    } });
  function libraryOptions(select, selected, defaultOption = 'Choose a library') {
    select.disabled = false;
    select.replaceChildren(new Option(defaultOption, ''), ...libraries.map((item) => new Option(item.name, item.id)));
    if (selected && !libraries.some((item) => item.id === selected)) select.append(new Option('Unavailable saved library', selected));
    select.value = selected || '';
  }
  function folders(select, libraryId, selected, isMapping = false) {
    const available = libraries.find((item) => item.id === libraryId)?.folders || [];
    select.replaceChildren(new Option(isMapping && !libraryId ? 'Use default folder' : 'Choose a folder', ''),
      ...available.map((item) => new Option(item.fullPath || item.path || item.id, item.id)));
    if (selected && !available.some((item) => item.id === selected)) select.append(new Option('Unavailable saved folder', selected));
    select.value = selected || ''; select.disabled = !libraryId;
  }
  function renderMappings() {
    mappingRows.replaceChildren();
    for (const category of [{ id: 'uncategorized', name: 'Uncategorized' }, ...categories]) {
      const selected = config.categoryDestinations?.[category.id];
      const row = element('fieldset', 'abs-category-row'); row.dataset.absCategory = category.id;
      const group = element('div', 'form-grid'), libLabel = element('label', 'field', 'Audiobookshelf library'), folderLabel = element('label', 'field', 'Folder');
      const lib = document.createElement('select'), target = document.createElement('select');
      lib.setAttribute('aria-label', `${category.name} export library`); target.setAttribute('aria-label', `${category.name} export folder`);
      lib.dataset.absLibrary = ''; target.dataset.absFolder = '';
      libraryOptions(lib, selected?.libraryId, 'Not mapped · automatic exports wait'); folders(target, lib.value, selected?.folderId, true);
      lib.addEventListener('change', () => folders(target, lib.value, '', true));
      libLabel.append(lib); folderLabel.append(target); group.append(libLabel, folderLabel);
      row.append(element('legend', '', category.name), group); mappingRows.append(row);
    }
    mappings.hidden = false;
  }
  async function loadLibraries(version = epoch) {
    const [choices, catalog] = await Promise.all([api('/api/audiobookshelf/libraries'), api('/api/categories')]);
    if (version !== epoch) return;
    libraries = choices.libraries; categories = catalog.categories || []; choicesLoaded = true;
    libraryOptions(library, config.libraryId); folders(folder, library.value, config.folderId); renderMappings();
  }
  function load() {
    if (config || loading) return loading;
    const version = epoch;
    $('#abs-connection').hidden = true; mappings.hidden = true; choicesLoaded = false;
    loading = (async () => {
      try {
        const next = await api('/api/settings/audiobookshelf'); if (version !== epoch) return;
        config = next; $('#abs-connection').hidden = !config.configurable; $('#abs-demo-note').hidden = config.configurable;
        if (config.managed) $('#abs-demo-note').textContent = 'The administrator manages their Audiobookshelf connection. Your private books and listening progress are not exported through their account.';
        url.value = config.baseUrl; key.value = ''; removeKey.refresh(config); $('#abs-auto-export').checked = config.autoExport !== false;
        key.placeholder = config.hasKey ? 'Saved key' : 'Audiobookshelf API key';
        if (config.connected) void loadLibraries(version).catch((error) => { if (version === epoch) message('#abs-settings-status', error.message); });
        else { library.replaceChildren(); folder.replaceChildren(); library.disabled = folder.disabled = true; }
        message('#abs-settings-status');
      } catch (error) { if (version === epoch) message('#abs-settings-status', error.message); }
      finally { if (version === epoch) loading = null; }
    })(); return loading;
  }
  function draft() {
    const baseUrl = url.value.trim().replace(/\/+$/u, ''), changedServer = baseUrl !== config.baseUrl;
    const categoryDestinations = choicesLoaded ? Object.fromEntries([...mappingRows.children].flatMap((row) => {
      const lib = row.querySelector('[data-abs-library]'), target = row.querySelector('[data-abs-folder]');
      return lib.value ? [[row.dataset.absCategory, { libraryId: lib.value, folderId: target.value }]] : [];
    })) : config.categoryDestinations || {};
    return { baseUrl, apiKey: key.value, autoExport: $('#abs-auto-export').checked,
      libraryId: changedServer ? '' : choicesLoaded ? library.value : config.libraryId || '',
      folderId: changedServer ? '' : choicesLoaded ? folder.value : config.folderId || '',
      categoryDestinations: changedServer ? {} : categoryDestinations };
  }
  library.addEventListener('change', () => folders(folder, library.value));
  async function save({ force = false } = {}) {
    if (loading) await loading;
    if (!config?.configurable) return;
    const body = draft();
    const ordered = (value) => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
    const changed = body.baseUrl !== config.baseUrl || body.apiKey || body.libraryId !== config.libraryId
      || body.folderId !== config.folderId || body.autoExport !== (config.autoExport !== false) || ordered(body.categoryDestinations) !== ordered(config.categoryDestinations);
    if (!changed && !force) return;
    const version = ++epoch;
    const next = await api('/api/settings/audiobookshelf', { method: 'PUT', body });
    if (version !== epoch) return;
    config = next;
    key.value = ''; removeKey.refresh(config);
    if (config.connected) await loadLibraries(version);
    else { mappings.hidden = true; library.disabled = folder.disabled = true; }
    message('#abs-settings-status', config.connected ? 'Audiobookshelf connection and export destinations saved.' : 'Connection key removed.');
  }
  $('#abs-save').addEventListener('click', async (event) => {
    event.target.disabled = true; $('#abs-connection').inert = true; message('#abs-settings-status', 'Saving Audiobookshelf…');
    try { await save({ force: true }); }
    catch (error) { message('#abs-settings-status', error.message); }
    finally { event.target.disabled = false; $('#abs-connection').inert = false; }
  });
  return { load, save, reset() { epoch++; loading = null; config = undefined; choicesLoaded = false; libraries = []; categories = []; mappingRows.replaceChildren(); mappings.hidden = true; removeKey.refresh(null); } };
}

export function audiobookshelfBook({ book, changed }) {
  let epoch = 0, timer, current, page = 0;
  const library = $('#abs-book-library'), items = $('#abs-book-item'), recording = $('#abs-book-recording');
  const exportLibrary = $('#abs-export-library'), exportFolder = $('#abs-export-folder');
  let exportChoices = [];
  function updateExport() {
    const lib = exportChoices.find((item) => item.id === exportLibrary.value), folder = lib?.folders?.find((item) => item.id === exportFolder.value);
    $('#abs-export').disabled = !recording.options.length || !folder;
    $('#abs-export-destination').textContent = folder ? `Export destination: ${lib.name} · ${folder.fullPath || folder.path || folder.id}`
      : 'Choose a valid export library and folder. Configure category destinations in Settings → Devices → Audiobookshelf.';
  }
  function exportFolders(selected = '', chooseSingle = false) {
    const folders = exportChoices.find((item) => item.id === exportLibrary.value)?.folders || [];
    exportFolder.replaceChildren(new Option('Choose an export folder', ''), ...folders.map((item) => new Option(item.fullPath || item.path || item.id, item.id)));
    exportFolder.value = folders.some((item) => item.id === selected) ? selected : chooseSingle && folders.length === 1 ? folders[0].id : '';
    exportFolder.disabled = !exportLibrary.value; updateExport();
  }
  exportLibrary.addEventListener('change', () => exportFolders('', true));
  exportFolder.addEventListener('change', updateExport);
  function error(text) { message('#abs-book-status', text); }
  async function loadItems(append = false) {
    const version = epoch; if (!append) page = 0;
    const result = await api(`/api/audiobookshelf/libraries/${encodeURIComponent(library.value)}/items?page=${page}`);
    if (version !== epoch) return;
    if (!append) items.replaceChildren();
    items.append(...result.results.map((item) => new Option(`${item.title}${item.author ? ' · ' + item.author : ''}`, item.id)));
    $('#abs-more-items').hidden = (page + 1) * 100 >= result.total;
  }
  async function status(version = epoch) {
    clearTimeout(timer); if (!book() || !$('#learning-dialog').open) return;
    try {
      const result = await api(`/api/books/${book().id}/audiobookshelf`); if (version !== epoch) return;
      const job = result.jobs.at(-1);
      if (result.automaticExportNotice && (!job || !['queued', 'running', 'syncing', 'linking', 'awaiting_confirmation'].includes(job.state))) error(result.automaticExportNotice);
      else if (job) error(job.error || job.notice || ({ queued: 'Transfer queued…', running: 'Transferring files between your servers…', syncing: 'Preparing and aligning the imported audio…', linking: 'Waiting for Audiobookshelf to index and link the export…', awaiting_confirmation: 'Open Processes to approve replacing the current Langy audio.' })[job.state] || job.state);
      if (job && ['queued', 'running', 'syncing', 'linking'].includes(job.state)) timer = setTimeout(() => void status(version), 2500);
      if (job?.state === 'ready' && current !== job.id) { current = job.id; await changed(); window.dispatchEvent(new CustomEvent('langy-audio-updated', { detail: { book: book().id } })); }
    } catch (cause) { if (version === epoch) error(cause.message); }
  }
  async function show() {
    const version = ++epoch; clearTimeout(timer); current = null; $('#abs-book-tools').hidden = true; error('');
    if (!book()) return;
    try {
      const config = await api('/api/settings/audiobookshelf');
      if (version !== epoch || !config.connected) return;
      $('#abs-book-tools').hidden = false;
      library.disabled = recording.disabled = exportLibrary.disabled = exportFolder.disabled = true;
      $('#abs-link').disabled = $('#abs-import').disabled = $('#abs-export').disabled = true;
      error('Loading Audiobookshelf choices…');
      const [choices, audio, state] = await Promise.all([api('/api/audiobookshelf/libraries'), api(`/api/books/${book().id}/narration`), api(`/api/books/${book().id}/audiobookshelf`)]);
      if (version !== epoch) return;
      library.disabled = recording.disabled = exportLibrary.disabled = false; $('#abs-import').disabled = false;
      library.replaceChildren(...choices.libraries.map((item) => new Option(item.name, item.id)));
      const mappings = config.categoryDestinations || {}, category = book().categoryId || 'uncategorized';
      const destination = state.destination || (Object.hasOwn(mappings, category) ? mappings[category] : config);
      const targetLibrary = choices.libraries.find((item) => item.id === destination.libraryId);
      if (targetLibrary) library.value = targetLibrary.id;
      exportChoices = choices.libraries;
      exportLibrary.replaceChildren(new Option('Choose an export library', ''), ...exportChoices.map((item) => new Option(item.name, item.id)));
      exportLibrary.value = targetLibrary?.id || '';
      const recordings = [...(audio.audio.state === 'ready' ? [{ id: audio.audio.id, name: audio.audio.name || 'Generated narration' }] : []), ...(audio.recordings || [])];
      recording.replaceChildren(...recordings.filter((item, index) => recordings.findIndex((other) => other.id === item.id) === index).map((item) => new Option(item.name, item.id)));
      $('#abs-link').disabled = !recordings.length;
      exportFolders(destination.folderId);
      $('#abs-book-tools').hidden = false;
      await Promise.allSettled([status(version), library.value ? loadItems().catch((cause) => { if (version === epoch) error(cause.message); }) : Promise.resolve()]);
    } catch (cause) { if (version === epoch) error(cause.message); }
  }
  library.addEventListener('change', () => void loadItems().catch((cause) => error(cause.message)));
  $('#abs-more-items').addEventListener('click', () => { page++; void loadItems(true).catch((cause) => error(cause.message)); });
  for (const action of ['export', 'import', 'link']) $('#abs-' + action).addEventListener('click', async (event) => {
    if (!book()) return; const version = epoch; event.target.disabled = true;
    try {
      await api(`/api/books/${book().id}/audiobookshelf/${action}`, { method: 'POST', body: { recording: recording.value, item: items.value, sameRecording: $('#abs-same-recording').checked,
        ...(action === 'export' ? { destination: { libraryId: exportLibrary.value, folderId: exportFolder.value } } : {}) } });
      if (version !== epoch) return;
      if (action === 'link') { toast('Recording linked to Audiobookshelf'); error('Listening positions will sync when you use this recording in Langy.'); }
      else await status(version);
    } catch (cause) { if (version === epoch) error(cause.message); }
    finally { if (version === epoch) { event.target.disabled = false; if (action === 'export') updateExport(); } }
  });
  $('#learning-dialog').addEventListener('close', () => { epoch++; clearTimeout(timer); });
  return { show };
}
