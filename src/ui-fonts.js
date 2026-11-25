import { $, api, element, message } from './ui.js';
import { fonts } from './settings.js';
import { userFonts } from './user-fonts.js';

export function fontSettings(form) {
  const select = form.elements.font; let loading;
  async function preview() {
    try { await userFonts.ensure(select.value); $('#font-preview').style.fontFamily = (fonts[select.value] || fonts.spectral).stack; }
    catch (error) { message('#font-import-status', error.message); }
  }
  select.addEventListener('change', preview);
  async function load(preferred) {
    if (loading) return loading;
    loading = (async () => {
      try {
        const available = await userFonts.list(true), current = select.value || preferred || 'spectral';
        for (const option of [...select.options]) if (userFonts.custom(option.value)) option.remove();
        for (const font of available) select.append(new Option(font.name + ' · imported', font.id));
        select.value = [...select.options].some((option) => option.value === current) ? current : 'spectral';
        $('#imported-font-list').replaceChildren(...available.map((font) => {
          const row = element('div', 'button-row'), name = element('span', 'field-note', font.name), remove = element('button', 'button quiet small', 'Remove');
          remove.type = 'button'; remove.setAttribute('aria-label', 'Remove font ' + font.name);
          remove.addEventListener('click', async () => { remove.disabled = true;
            try { await api('/api/fonts/' + font.id.slice(7), { method: 'DELETE' }); await userFonts.forget(font.id); if (select.value === font.id) select.value = 'spectral'; loading = undefined; await load(select.value); message('#font-import-status', 'Font removed. Save settings to keep your new font choice.'); }
            catch (error) { message('#font-import-status', error.message); remove.disabled = false; }
          }); row.append(name, remove); return row;
        }));
        await preview();
      } catch (error) { message('#font-import-status', 'Imported fonts could not be loaded. ' + error.message); }
    })().finally(() => { loading = undefined; }); return loading;
  }
  $('#import-font').addEventListener('click', async (event) => {
    const file = $('#font-file').files[0]; if (!file) return message('#font-import-status', 'Choose a font file first.');
    if (file.size > 32 * 1024 ** 2) return message('#font-import-status', 'Font files must be at most 32 MiB.');
    event.target.disabled = true; message('#font-import-status', 'Importing font…');
    try {
      if (typeof FontFace !== 'undefined') await new FontFace('LangyUploadValidation', await file.arrayBuffer()).load();
      const data = new FormData(); data.append('file', file); data.append('name', $('#font-import-name').value);
      const font = await api('/api/fonts', { method: 'POST', body: data }); await loading; await load(font.id); select.value = font.id; await preview();
      $('#font-file').value = ''; $('#font-import-name').value = ''; message('#font-import-status', 'Font imported and selected. Save settings to use it.');
    } catch (error) { message('#font-import-status', error.message || 'This font could not be loaded.'); }
    finally { event.target.disabled = false; }
  });
  return { load, select(id) {
    if (userFonts.custom(id) && ![...select.options].some((option) => option.value === id)) select.append(new Option('Imported font', id));
    select.value = id;
  } };
}
