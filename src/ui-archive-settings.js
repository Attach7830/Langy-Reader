import { $, api, message } from './ui.js';
import { credentialRemoval } from './credential-removal.js';

export function archiveSettings() {
  const fields = $('#settings-form').elements;
  let config, loading = false, epoch = 0;
  const removeKey = credentialRemoval({ button: $('#aa-remove-key'), input: fields.aa_apiKey, endpoint: '/api/settings/archive/key',
    status: '#archive-result', revision: () => epoch, membership: true,
    changed(next) { config = next; fields.aa_apiKey.placeholder = 'Membership key'; } });
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
      if (config.managed) $('#archive-demo-note').textContent = 'Your administrator manages the shared book-source connection. Imports go into your own private library.';
      fields.aa_baseUrl.replaceChildren(...(config.mirrors || []).map((url) => new Option(new URL(url).hostname, url)));
      fields.aa_baseUrl.value = config.baseUrl || '';
      fields.aa_apiKey.value = '';
      fields.aa_baseUrl.disabled = fields.aa_slowFallback.disabled = fields.aa_retryUnavailable.disabled = Boolean(config.personal);
      $('#aa-shared-row').hidden = !config.personal || !config.sharedAllowed;
      fields.aa_useShared.checked = Boolean(config.useShared && config.sharedAllowed);
      message('#aa-personal-note', config.personal ? config.sharedAllowed ? 'You may use the shared membership or save your own private key. Your key is never shown to other readers.' : 'Save your own private membership key, or use free slow downloads. Shared membership access has not been granted for your account.' : '');
      removeKey.refresh(config.personal ? { ...config, hasKey: config.hasPersonalKey } : config);
      fields.aa_slowFallback.checked = config.slowFallback !== false;
      fields.aa_retryUnavailable.checked = config.retryUnavailable !== false;
      fields.aa_apiKey.placeholder = (config.personal ? config.hasPersonalKey : config.hasKey) ? 'Saved key · leave blank to keep' : 'Membership key';
      message('#archive-result', config.configurable && config.hasKey ? 'Key saved. Membership and download allowance are checked when importing.' : '');
    } catch (error) { if (current === epoch) message('#archive-result', error.message); }
    finally { if (current === epoch) loading = false; }
  }
  async function save() {
    if (!config?.configurable) return;
    const body = { baseUrl: fields.aa_baseUrl.value, apiKey: fields.aa_apiKey.value, slowFallback: fields.aa_slowFallback.checked, retryUnavailable: fields.aa_retryUnavailable.checked, ...(config.personal ? { useShared: fields.aa_useShared.checked } : {}) };
    if (body.baseUrl !== config.baseUrl || body.apiKey || body.slowFallback !== config.slowFallback || body.retryUnavailable !== config.retryUnavailable || config.personal && body.useShared !== config.useShared) {
      config = await api('/api/settings/archive', { method: 'PUT', body });
      fields.aa_apiKey.value = '';
      fields.aa_baseUrl.disabled = fields.aa_slowFallback.disabled = fields.aa_retryUnavailable.disabled = Boolean(config.personal);
      $('#aa-shared-row').hidden = !config.personal || !config.sharedAllowed;
      fields.aa_useShared.checked = Boolean(config.useShared && config.sharedAllowed);
      message('#aa-personal-note', config.personal ? config.sharedAllowed ? 'You may use the shared membership or save your own private key. Your key is never shown to other readers.' : 'Save your own private membership key, or use free slow downloads. Shared membership access has not been granted for your account.' : '');
      removeKey.refresh(config.personal ? { ...config, hasKey: config.hasPersonalKey } : config);
    }
  }
  return { load, save, reset() { epoch++; config = undefined; loading = false; fields.aa_apiKey.value = ''; removeKey.refresh(null); } };
}
