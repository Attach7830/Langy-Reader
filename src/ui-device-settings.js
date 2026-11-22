import { $, api, message, toast } from './ui.js';

export function deviceSettings() {
  let loading = false, epoch = 0;
  async function load() {
    if (loading) return;
    const current = epoch;
    loading = true;
    $('#opds-connection').hidden = true;
    $('#sync-connection').hidden = true;
    message('#opds-result', 'Loading device connection…');
    message('#sync-result', 'Loading progress sync…');
    const results = await Promise.allSettled([api('/api/settings/opds'), api('/api/settings/sync')]);
    if (current !== epoch) return;
    const [opds, sync] = results;
    if (opds.status === 'fulfilled') {
      const settings = opds.value;
      $('#opds-demo-note').hidden = settings.available;
      $('#opds-connection').hidden = !settings.available;
      if (settings.available) {
        $('#opds-url').value = new URL(settings.path, location.origin).href;
        $('#opds-auth').textContent = settings.authenticated
          ? `Username: ${settings.username}. Use the password configured for this Langy installation.`
          : 'No login is configured. Devices that can reach this address can browse and download your books. Set READER_USER and READER_PASSWORD in your server’s .env file to require a login.';
      }
      message('#opds-result');
    } else message('#opds-result', opds.reason.message);
    if (sync.status === 'fulfilled') {
      const settings = sync.value;
      $('#sync-demo-note').hidden = settings.available;
      $('#sync-connection').hidden = !settings.available;
      if (settings.available) {
        $('#sync-url').value = new URL(settings.path, location.origin).href;
        $('#sync-auth').textContent = settings.deviceAvailable
          ? `Username: ${settings.username}. Use your Langy password, or the separate READER_SYNC_PASSWORD configured on your server. Authenticate with this account; registration is disabled.`
          : 'Browser sync is ready. To connect an e-reader, first set READER_PASSWORD or READER_SYNC_PASSWORD in your server’s .env file and restart the reader service.';
      }
      message('#sync-result');
    } else message('#sync-result', sync.reason.message);
    loading = false;
  }
  for (const kind of ['opds', 'sync']) $('#copy-' + kind + '-url').addEventListener('click', async () => {
    const input = $('#' + kind + '-url');
    try { await navigator.clipboard.writeText(input.value); toast('Device address copied'); }
    catch { input.focus(); input.select(); message('#' + kind + '-result', 'Select and copy the address.'); }
  });
  return { load, reset() { epoch++; loading = false; $('#opds-url').value = ''; $('#sync-url').value = ''; } };
}
