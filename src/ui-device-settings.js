import { $, api, message, toast } from './ui.js';
import { audiobookshelfSettings } from './audiobookshelf-ui.js';
import { ocrConnectionSettings } from './ui-ocr-settings.js';

export function deviceSettings() {
  const audiobookshelf = audiobookshelfSettings();
  const ocr = ocrConnectionSettings();
  let loading = false, loaded = false, epoch = 0;
  async function load() {
    void audiobookshelf.load();
    void ocr.load();
    if (loading || loaded) return;
    const current = epoch;
    loading = true;
    $('#opds-connection').hidden = true;
    $('#sync-connection').hidden = true;
    message('#opds-result', 'Loading device connection…');
    message('#sync-result', 'Loading progress sync…');
    await Promise.allSettled([api('/api/settings/opds').then((settings) => {
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
    }).catch((error) => { if (current === epoch) message('#opds-result', error.message); }),
    api('/api/settings/sync').then((settings) => {
      if (current !== epoch) return;
      $('#sync-demo-note').hidden = settings.available;
      $('#sync-connection').hidden = !settings.available;
      if (settings.available) {
        $('#sync-url').value = new URL(settings.path, location.origin).href;
        $('#sync-auth').textContent = settings.deviceAvailable
          ? `Username: ${settings.username}. Use your Langy password, or the separate READER_SYNC_PASSWORD configured on your server. Authenticate with this account; registration is disabled.`
          : 'Browser sync is ready. To connect an e-reader, first set READER_PASSWORD or READER_SYNC_PASSWORD in your server’s .env file and restart the reader service.';
      }
      message('#sync-result');
    }).catch((error) => { if (current === epoch) message('#sync-result', error.message); })]);
    if (current === epoch) { loading = false; loaded = true; }
  }
  for (const kind of ['opds', 'sync']) $('#copy-' + kind + '-url').addEventListener('click', async () => {
    const input = $('#' + kind + '-url');
    try { await navigator.clipboard.writeText(input.value); toast('Device address copied'); }
    catch { input.focus(); input.select(); message('#' + kind + '-result', 'Select and copy the address.'); }
  });
  return { load, async save() { await audiobookshelf.save(); await ocr.save(); }, reset() { epoch++; loading = loaded = false; audiobookshelf.reset(); ocr.reset(); $('#opds-url').value = ''; $('#sync-url').value = ''; } };
}
