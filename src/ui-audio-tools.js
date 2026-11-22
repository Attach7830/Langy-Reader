import { $, api, element, message } from './ui.js';
const pending = (value) => ['queued', 'running'].includes(value?.state);
export const audioChanged = (book) => window.dispatchEvent(new CustomEvent('langy-audio-updated', { detail: { book } }));
export function audioTools({ book, refresh }) {
  let files = [], busy = false;
  const states = new Map();
  const upload = $('#upload-audio-form'), importer = $('#ivoox-audio-form');
  function order() {
    $('#audio-file-order').replaceChildren(...files.map((file, index) => {
      const row = element('div', 'audio-file-row');
      row.append(element('span', '', `${index + 1}. ${file.name}`));
      for (const [label, delta] of [['Move up', -1], ['Move down', 1]]) {
        const button = element('button', 'button quiet small', label);
        button.type = 'button'; button.disabled = busy || !files[index + delta];
        button.setAttribute('aria-label', `${label}: ${file.name}`);
        button.addEventListener('click', () => { [files[index], files[index + delta]] = [files[index + delta], files[index]]; order(); });
        row.append(button);
      }
      return row;
    }));
  }
  upload.elements.file.addEventListener('change', () => {
    files = Array.from(upload.elements.file.files).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); order();
  });
  importer.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!book()) return;
    $('#import-ivoox').disabled = true; message('#recording-error');
    try {
      await api(`/api/books/${book().id}/ivoox`, { method: 'POST', body: { name: importer.elements.name.value, links: importer.elements.links.value } });
      await refresh();
    } catch (error) { message('#recording-error', error.message); $('#import-ivoox').disabled = false; }
  });
  $('#cancel-ivoox').addEventListener('click', async () => {
    if (!book()) return;
    try { await api(`/api/books/${book().id}/ivoox`, { method: 'DELETE' }); await refresh(); }
    catch (error) { message('#recording-error', error.message); }
  });
  function controls(recording, available) {
    if (!available || !recording?.id || recording.state !== 'ready') return [];
    const state = recording.rescan;
    const button = element('button', 'button secondary small', pending(state) ? 'Cancel rescan' : state?.state === 'error' ? 'Retry missed-word rescan' : 'Rescan missed words');
    button.type = 'button';
    button.addEventListener('click', async () => {
      if (!book()) return;
      button.disabled = true;
      try {
        await api(`/api/books/${book().id}/audio/${recording.id}/rescan`, { method: pending(state) ? 'DELETE' : 'POST', body: pending(state) ? undefined : {} });
        audioChanged(book().id); await refresh();
      } catch (error) { message('#recording-error', error.message); button.disabled = false; }
    });
    const text = pending(state) ? `Rescanning missed words · ${state.completed} / ${state.windows} passages · ${state.added} additional matches found`
      : state?.state === 'ready' ? `Rescan complete · ${state.added} additional words matched. ${state.totalWords - state.matchedBefore - state.added} words remain unconfirmed.`
        : state?.state === 'error' ? state.error : state?.state === 'cancelled' ? 'Rescan cancelled. Existing alignment retained.'
          : 'Listen again around gaps while preserving recognized word positions. Unmatched speech is not forced onto the text.';
    return [button, element('p', 'field-note', text)];
  }
  function update(result, uploaded, imported) {
    for (const item of uploaded.recordings) {
      const key = `${book()?.id}:${item.id}`, state = `${item.state}:${item.rescan?.state || ''}`;
      if (states.has(key) && states.get(key) !== state && item.state === 'ready') audioChanged(book().id);
      states.set(key, state);
    }
    importer.hidden = !uploaded.available;
    $('#generated-rescan').replaceChildren(...controls(result.narration.audio, result.rescanAvailable));
    const job = imported?.job;
    const working = ['downloading', 'importing'].includes(job?.state);
    $('#import-ivoox').disabled = working;
    $('#cancel-ivoox').hidden = !working;
    message('#ivoox-audio-status', !job ? '' : job.state === 'ready' ? 'iVoox files imported. Chapter preparation runs below; choose Sync with book when ready.'
      : job.state === 'error' ? job.error : job.state === 'cancelled' ? 'iVoox import cancelled.'
        : `Importing iVoox audio · ${job.completed} / ${job.total} episodes · ${(job.bytes / 1024 ** 2).toFixed(1)} MiB`);
    return working || pending(result.narration.audio.rescan) || uploaded.recordings.some((item) => pending(item.rescan));
  }
  return { controls, update, files: () => files,
    clearUpload() { files = []; upload.reset(); order(); },
    setBusy(value) { busy = value; upload.elements.file.disabled = value; order(); },
    reset() { if (!busy) { files = []; upload.reset(); order(); } importer.reset(); message('#ivoox-audio-status'); $('#generated-rescan').replaceChildren(); },
  };
}
