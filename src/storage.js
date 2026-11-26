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
  panel.dataset.low = 'false';
  const meter = $('#storage-meter');
  if (!storage?.available) {
    $('#storage-summary').textContent = 'Storage availability unavailable';
    $('#storage-detail').textContent = 'The server could not report free space.';
    meter.hidden = true;
    return;
  }
  const unlimited = storage.scope === 'account' && storage.unlimited;
  if (unlimited && !storage.drive?.available) {
    $('#storage-summary').textContent = `Your library · ${bytes(storage.usedBytes)} saved`;
    $('#storage-detail').textContent = 'No account limit · drive capacity unavailable';
    meter.hidden = true;
    return;
  }
  const capacity = unlimited ? storage.drive : storage;
  const demo = capacity.scope === 'demo', account = capacity.scope === 'account';
  $('#storage-summary').textContent = `${demo ? 'Demo allowance' : account ? 'Your library' : 'Library drive'} · ${bytes(capacity.availableBytes)} available`;
  $('#storage-detail').textContent = demo
    ? `${bytes(capacity.usedBytes)} of ${bytes(capacity.totalBytes)} used · up to 4 books, 20 MiB each`
    : account ? `${bytes(capacity.usedBytes)} saved of ${bytes(capacity.totalBytes)}${capacity.overLimit ? ' · storage limit reached' : ''}`
    : `${bytes(capacity.totalBytes)} total · shared with other files on this drive${unlimited ? ` · ${bytes(storage.usedBytes)} in your library` : ''}`;
  meter.hidden = false;
  meter.max = Math.max(1, capacity.totalBytes);
  meter.value = Math.max(0, account ? capacity.usedBytes : capacity.totalBytes - capacity.availableBytes);
  meter.setAttribute('aria-label', demo ? 'Demo storage allowance used' : account ? 'Your saved library allowance used' : 'Library drive space used or reserved');
  meter.title = `${bytes(capacity.availableBytes)} available of ${bytes(capacity.totalBytes)}`;
  panel.dataset.low = String(capacity.availableBytes / capacity.totalBytes < .1);
}

export async function refreshStorage() {
  try { showStorage(await api('/api/storage')); }
  catch { showStorage(null); }
}
