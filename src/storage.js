import { $, api } from './ui.js';

function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit > 0 ? 1 : 0 })} ${units[unit]}`;
}

export function showStorage(storage) {
  const panel = $('#library-storage');
  panel.hidden = false;
  const meter = $('#storage-meter');
  if (!storage?.available) {
    $('#storage-summary').textContent = 'Storage availability unavailable';
    $('#storage-detail').textContent = 'The server could not report free space.';
    meter.hidden = true;
    return;
  }
  const demo = storage.scope === 'demo', account = storage.scope === 'account';
  $('#storage-summary').textContent = `${demo ? 'Demo allowance' : account ? 'Your library' : 'Library drive'} · ${bytes(storage.availableBytes)} available`;
  $('#storage-detail').textContent = demo
    ? `${bytes(storage.usedBytes)} of ${bytes(storage.totalBytes)} used · up to 4 books, 20 MiB each`
    : account ? `${bytes(storage.usedBytes)} saved${storage.unlimited ? ' · no account limit' : ` of ${bytes(storage.totalBytes)}`}${storage.overLimit ? ' · storage limit reached' : ''}`
    : `${bytes(storage.totalBytes)} total · shared with other files on this drive`;
  meter.hidden = Boolean(account && storage.unlimited);
  meter.max = Math.max(1, storage.totalBytes);
  meter.value = Math.max(0, account ? storage.usedBytes : storage.totalBytes - storage.availableBytes);
  meter.setAttribute('aria-label', demo ? 'Demo storage allowance used' : account ? 'Your saved library allowance used' : 'Library drive space used or reserved');
  meter.title = `${bytes(storage.availableBytes)} available of ${bytes(storage.totalBytes)}`;
  panel.dataset.low = String(storage.availableBytes / storage.totalBytes < .1);
}

export async function refreshStorage() {
  try { showStorage(await api('/api/storage')); }
  catch { showStorage(null); }
}
