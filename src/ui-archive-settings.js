import { $, api, message } from './ui.js';

export function archiveSettings() {
  const fields = $('#settings-form').elements;
  let config, loading = false, epoch = 0;
  async function load() {
    if (config || loading) return;
    const current = epoch;
    loading = true;
    $('#archive-settings').hidden = true;
    try {
      const next = await api('/api/settings/archive');
      if (current !== epoch) return;
      config = next;
      $('#archive-settings').hidden = !config.configurable;
      $('#archive-demo-note').hidden = config.configurable;
      fields.aa_baseUrl.replaceChildren(...(config.mirrors || []).map((url) => new Option(new URL(url).hostname, url)));
      fields.aa_baseUrl.value = config.baseUrl || '';
      fields.aa_apiKey.value = '';
      fields.aa_clearKey.checked = false;
      fields.aa_slowFallback.checked = config.slowFallback !== false;
      fields.aa_retryUnavailable.checked = config.retryUnavailable !== false;
      fields.aa_apiKey.placeholder = config.hasKey ? 'Saved key · leave blank to keep' : 'Membership key';
      message('#archive-result', config.configurable && config.hasKey ? 'Key saved. Membership and download allowance are checked when importing.' : '');
    } catch (error) { if (current === epoch) message('#archive-result', error.message); }
    finally { if (current === epoch) loading = false; }
  }
  async function save() {
    if (!config?.configurable) return;
    const body = { baseUrl: fields.aa_baseUrl.value, apiKey: fields.aa_apiKey.value, clearKey: fields.aa_clearKey.checked, slowFallback: fields.aa_slowFallback.checked, retryUnavailable: fields.aa_retryUnavailable.checked };
    if (body.baseUrl !== config.baseUrl || body.apiKey || body.clearKey || body.slowFallback !== config.slowFallback || body.retryUnavailable !== config.retryUnavailable) {
      config = await api('/api/settings/archive', { method: 'PUT', body });
      fields.aa_apiKey.value = '';
      fields.aa_clearKey.checked = false;
    }
  }
  return { load, save, reset() { epoch++; config = undefined; loading = false; fields.aa_apiKey.value = ''; } };
}
