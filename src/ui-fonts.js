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
  let choices = [], searchEpoch = 0;
  const family = $('#free-font-family'), variant = $('#free-font-variant');
  $('#free-font-search').addEventListener('click', async (event) => {
    event.target.disabled = true; const epoch = ++searchEpoch; message('#font-import-status', 'Searching free fonts…');
    try { const result = await api('/api/fonts/catalogue?q='+encodeURIComponent($('#free-font-query').value)); if (epoch !== searchEpoch) return;
      family.replaceChildren(new Option('Choose a font',''),...result.fonts.map((font) => new Option(font.family,font.id)));
      variant.replaceChildren(new Option('Choose a variant','')); choices=[]; message('#font-import-status',result.fonts.length ? 'Choose a family, then a language subset and style.' : 'No matching font families found.');
    } catch (error) { message('#font-import-status',error.message); } finally {event.target.disabled=false;}
  });
  family.addEventListener('change', async () => {
    const epoch = ++searchEpoch; choices=[]; variant.replaceChildren(new Option('Choose a variant','')); if (!family.value) return;
    try { const result = await api('/api/fonts/catalogue/'+encodeURIComponent(family.value)); if (epoch !== searchEpoch) return; choices=result.choices;
      variant.append(...choices.map((choice,index) => new Option(`${choice.subset} · ${choice.weight} · ${choice.style}`,String(index))));
      if (!choices.length) message('#font-import-status','This font uses segmented files. Download a complete font from its official source and import it instead.');
    } catch (error) {message('#font-import-status',error.message);}
  });
  async function downloadFont(body, button) {
    button.disabled=true; message('#font-import-status','Downloading font…');
    try { const font=await api('/api/fonts/download',{method:'POST',body}); await loading; await load(font.id); select.value=font.id; await preview(); message('#font-import-status','Font downloaded and selected. Save settings to use it.'); }
    catch(error){message('#font-import-status',error.message);} finally {button.disabled=false;}
  }
  $('#free-font-download').addEventListener('click',(event) => {
    const choice=variant.value === '' ? null : choices[Number(variant.value)];
    if (!choice) return message('#font-import-status','Choose a font family and variant first.');
    void downloadFont({id:family.value,subset:choice.subset,weight:choice.weight,style:choice.style},event.target);
  });
  $('#download-font-url').addEventListener('click',(event) => {
    const url=$('#font-download-url'); if (!url.value.trim() || !url.reportValidity()) return message('#font-import-status','Paste a direct font file URL first.');
    void downloadFont({url:url.value.trim(),name:$('#font-import-name').value},event.target);
  });
  return { load, select(id) {
    if (userFonts.custom(id) && ![...select.options].some((option) => option.value === id)) select.append(new Option('Imported font', id));
    select.value = id;
  } };
}
