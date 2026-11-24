import { $, api, element, message, toast } from './ui.js';

export function audiobookshelfSettings() {
  let config, libraries = [];
  const url = $('#abs-url'), key = $('#abs-key'), library = $('#abs-library'), folder = $('#abs-folder');
  function folders(selected) {
    const current = libraries.find((item) => item.id === library.value);
    folder.replaceChildren(...(current?.folders || []).map((item) => new Option(item.fullPath || item.path || item.id, item.id)));
    if ([...folder.options].some((option) => option.value === selected)) folder.value = selected;
  }
  async function loadLibraries() {
    const result = await api('/api/audiobookshelf/libraries'); libraries = result.libraries;
    library.replaceChildren(...libraries.map((item) => new Option(item.name, item.id)));
    if (libraries.some((item) => item.id === config.libraryId)) library.value = config.libraryId;
    folders(config.folderId);
  }
  async function load() {
    try {
      config = await api('/api/settings/audiobookshelf'); $('#abs-connection').hidden = !config.configurable;
      $('#abs-demo-note').hidden = config.configurable; url.value = config.baseUrl; key.value = ''; key.placeholder = config.hasKey ? 'Saved key' : 'Audiobookshelf API key';
      if (config.connected) await loadLibraries(); message('#abs-settings-status');
    } catch (error) { message('#abs-settings-status', error.message); }
  }
  library.addEventListener('change', () => folders());
  $('#abs-save').addEventListener('click', async (event) => {
    event.target.disabled = true; message('#abs-settings-status', 'Connecting to Audiobookshelf…');
    try {
      config = await api('/api/settings/audiobookshelf', { method: 'PUT', body: { baseUrl: url.value.trim(), apiKey: key.value,
        libraryId: library.value || config?.libraryId || '', folderId: folder.value || config?.folderId || '', clearKey: $('#abs-clear-key').checked } });
      key.value = ''; $('#abs-clear-key').checked = false;
      if (config.connected) await loadLibraries();
      message('#abs-settings-status', config.connected ? 'Connected. Choose the destination library and folder, then save again to use them for exports.' : 'Connection key removed.');
    } catch (error) { message('#abs-settings-status', error.message); }
    finally { event.target.disabled = false; }
  });
  return { load };
}

export function audiobookshelfBook({ book, changed }) {
  let epoch = 0, timer, current, page = 0;
  const library = $('#abs-book-library'), items = $('#abs-book-item'), recording = $('#abs-book-recording');
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
      if (job) error(job.error || job.notice || ({ queued: 'Transfer queued…', running: 'Transferring files between your servers…', syncing: 'Preparing and aligning the imported audio…' })[job.state] || job.state);
      if (job && ['queued', 'running', 'syncing'].includes(job.state)) timer = setTimeout(() => void status(version), 2500);
      if (job?.state === 'ready' && current !== job.id) { current = job.id; await changed(); window.dispatchEvent(new CustomEvent('langy-audio-updated', { detail: { book: book().id } })); }
    } catch (cause) { if (version === epoch) error(cause.message); }
  }
  async function show() {
    const version = ++epoch; clearTimeout(timer); current = null; $('#abs-book-tools').hidden = true; error('');
    if (!book()) return;
    try {
      const config = await api('/api/settings/audiobookshelf');
      if (version !== epoch || !config.connected) return;
      const [choices, audio] = await Promise.all([api('/api/audiobookshelf/libraries'), api(`/api/books/${book().id}/narration`)]);
      if (version !== epoch) return;
      library.replaceChildren(...choices.libraries.map((item) => new Option(item.name, item.id)));
      if (choices.libraries.some((item) => item.id === config.libraryId)) library.value = config.libraryId;
      const recordings = [...(audio.audio.state === 'ready' ? [{ id: audio.audio.id, name: audio.audio.name || 'Generated narration' }] : []), ...(audio.recordings || [])];
      recording.replaceChildren(...recordings.filter((item, index) => recordings.findIndex((other) => other.id === item.id) === index).map((item) => new Option(item.name, item.id)));
      $('#abs-export').disabled = $('#abs-link').disabled = !recordings.length;
      $('#abs-book-tools').hidden = false; if (library.value) await loadItems(); await status(version);
    } catch (cause) { if (version === epoch) error(cause.message); }
  }
  library.addEventListener('change', () => void loadItems().catch((cause) => error(cause.message)));
  $('#abs-more-items').addEventListener('click', () => { page++; void loadItems(true).catch((cause) => error(cause.message)); });
  for (const action of ['export', 'import', 'link']) $('#abs-' + action).addEventListener('click', async (event) => {
    if (!book()) return; const version = epoch; event.target.disabled = true;
    try {
      await api(`/api/books/${book().id}/audiobookshelf/${action}`, { method: 'POST', body: { recording: recording.value, item: items.value, sameRecording: $('#abs-same-recording').checked } });
      if (version !== epoch) return;
      if (action === 'link') { toast('Recording linked to Audiobookshelf'); error('Listening positions will sync when you use this recording in Langy.'); }
      else await status(version);
    } catch (cause) { if (version === epoch) error(cause.message); }
    finally { if (version === epoch) event.target.disabled = false; }
  });
  $('#learning-dialog').addEventListener('close', () => { epoch++; clearTimeout(timer); });
  return { show };
}
