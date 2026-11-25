import { $, api, message } from './ui.js';
import { credentialRemoval } from './credential-removal.js';

export function ocrConnectionSettings() {
  const provider = $('#ocr-provider'), url = $('#ocr-service-url'), key = $('#ocr-service-key');
  let config, loading, epoch = 0;
  const remove = credentialRemoval({ button: $('#ocr-remove-key'), input: key, endpoint: '/api/settings/ocr/key', status: '#ocr-service-status', revision: () => epoch, changed(next) { config = next; key.value = ''; key.placeholder = 'Optional API key'; } });
  const update = () => { $('#ocr-external-fields').hidden = provider.value !== 'paddle'; };
  provider.addEventListener('change', update);
  async function load() {
    if (config || loading) return loading; const version = epoch;
    loading = (async () => {
      try { const result = await api('/api/settings/ocr'); if (version !== epoch) return;
        config = result; $('#ocr-service-controls').hidden = !result.configurable; $('#ocr-service-managed').hidden = result.configurable;
        if (result.configurable) { provider.value = result.provider; url.value = result.baseUrl; key.value = ''; key.placeholder = result.hasKey ? 'Saved API key' : 'Optional API key'; remove.refresh(result); update(); }
        message('#ocr-service-status');
      } catch (error) { if (version === epoch) message('#ocr-service-status', error.message); }
      finally { if (version === epoch) loading = null; }
    })(); return loading;
  }
  async function save(force = false) {
    if (loading) await loading; if (!config?.configurable) return;
    const draft = { provider: provider.value, baseUrl: url.value.trim(), apiKey: key.value };
    if (!force && draft.provider === config.provider && draft.baseUrl === config.baseUrl && !draft.apiKey) return;
    const version = ++epoch; const result = await api('/api/settings/ocr', { method: 'PUT', body: draft }); if (version !== epoch) return;
    config = result; key.value = ''; key.placeholder = result.hasKey ? 'Saved API key' : 'Optional API key'; remove.refresh(result);
    message('#ocr-service-status', result.provider === 'paddle' ? 'PaddleOCR connection tested and saved.' : 'Built-in OCR selected.');
  }
  $('#ocr-service-save').addEventListener('click', async (event) => { event.target.disabled = true; message('#ocr-service-status', 'Testing OCR connection…');
    try { await save(true); } catch (error) { message('#ocr-service-status', error.message); } finally { event.target.disabled = false; }
  });
  return { load, save: () => save(), reset() { epoch++; loading = config = undefined; } };
}
