import { $, api, message, toast } from './ui.js';

export function deviceSettings() {
  let loading = false, epoch = 0;
  async function load() {
    if (loading) return;
    const current = epoch;
    loading = true;
    $('#opds-connection').hidden = true;
    message('#opds-result', 'Loading device connection…');
    try {
      const settings = await api('/api/settings/opds');
      if (current !== epoch) return;
      $('#opds-demo-note').hidden = settings.available;
      $('#opds-connection').hidden = !settings.available;
      if (settings.available) {
        $('#opds-url').value = new URL(settings.path, location.origin).href;
        $('#opds-auth').textContent = settings.authenticated
          ? `Username: ${settings.username}. Use the password configured for this Langy installation.`
          : 'No login is configured. Devices that can reach this address can browse and download your books. Set READER_USER and READER_PASSWORD in your server’s .env file to require a login.';
      }
      message('#opds-result');
    } catch (error) { if (current === epoch) message('#opds-result', error.message); }
    finally { if (current === epoch) loading = false; }
  }
  $('#copy-opds-url').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#opds-url').value); toast('OPDS address copied'); }
    catch { $('#opds-url').focus(); $('#opds-url').select(); message('#opds-result', 'Select and copy the catalog address.'); }
  });
  return { load, reset() { epoch++; loading = false; $('#opds-url').value = ''; } };
}
