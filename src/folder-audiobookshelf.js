import { $, api, message } from './ui.js';

export function folderAudiobookshelf() {
  const panel = $('#category-abs'), library = $('#category-abs-library'), folder = $('#category-abs-folder');
  let epoch = 0, choices = [], dirty = false, connected = false;
  function folders(selected = '') {
    const available = choices.find((item) => item.id === library.value)?.folders || [];
    folder.replaceChildren(new Option('Choose a folder', ''), ...available.map((item) => new Option(item.fullPath || item.path || item.id, item.id)));
    if (selected && !available.some((item) => item.id === selected)) folder.append(new Option('Unavailable saved folder', selected));
    folder.value = selected; folder.disabled = !library.value;
  }
  library.addEventListener('change', () => { dirty = true; const available = choices.find((item) => item.id === library.value)?.folders || []; folders(available.length === 1 ? available[0].id : ''); });
  folder.addEventListener('change', () => { dirty = true; });
  return {
    async load(category) {
      const version = ++epoch; dirty = connected = false; choices = []; panel.hidden = true; library.disabled = folder.disabled = true;
      message('#category-abs-status');
      try {
        const config = await api('/api/settings/audiobookshelf'); if (version !== epoch || !config.configurable) return;
        panel.hidden = false;
        if (!config.connected) { message('#category-abs-status', 'Connect Audiobookshelf in Settings → Devices to link this folder.'); return; }
        const result = await api('/api/audiobookshelf/libraries'); if (version !== epoch) return;
        choices = result.libraries; connected = true;
        const selected = config.categoryDestinations?.[category?.id];
        library.replaceChildren(new Option('Not linked · automatic exports wait', ''), ...choices.map((item) => new Option(item.name, item.id)));
        if (selected?.libraryId && !choices.some((item) => item.id === selected.libraryId)) library.append(new Option('Unavailable saved library', selected.libraryId));
        library.value = selected?.libraryId || ''; library.disabled = false; folders(selected?.folderId || '');
      } catch { if (version === epoch) { panel.hidden = false; message('#category-abs-status', 'Could not load Audiobookshelf folders. Your existing link will be kept.'); } }
    },
    validate() { if (dirty && library.value && !folder.value) throw new Error('Choose an Audiobookshelf folder for the selected library.'); },
    async save(id) {
      if (!dirty || !connected) return;
      this.validate();
      try { await api(`/api/settings/audiobookshelf/categories/${encodeURIComponent(id)}`, { method: 'PATCH', body: { destination: library.value ? { libraryId: library.value, folderId: folder.value } : null } }); dirty = false; }
      catch (error) { throw new Error(`Folder saved, but its Audiobookshelf link could not be saved: ${error.message}`); }
    },
    cancel() { epoch++; },
  };
}
