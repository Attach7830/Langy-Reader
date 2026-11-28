import { $, $$, api, message } from './ui.js';
import { audioSyncTime as clock } from './audio-sync-time.js';

export function adjustPdfTiming({ saved }) {
  const dialog = $('#pdf-timing-dialog'), form = $('#pdf-timing-form'), select = form.elements.page;
  const audio = $('#pdf-timing-audio'), save = $('#pdf-timing-save'), mark = $('#pdf-timing-mark');
  const fields = $('#pdf-timing-controls');
  const jump = $('#pdf-timing-jump'), reset = $('#pdf-timing-reset'), nudges = $$('[data-pdf-nudge]', form);
  let editor;

  const selected = () => editor?.pages?.[Number(select.value)];
  function controls() {
    const page = selected(), ready = Boolean(page && Number.isFinite(audio.duration) && !editor.saving);
    fields.hidden = save.hidden = !page;
    select.disabled = !page || editor.saving;
    jump.disabled = !ready;
    mark.disabled = !ready || select.selectedIndex === 0;
    reset.disabled = !page || editor.saving || !editor.pages.some((item) => item.start !== item.original);
    save.disabled = !page || editor.saving || !editor.dirty;
    for (const button of nudges) button.disabled = !ready;
    $('#pdf-timing-opening').textContent = page?.opening || '';
    if (page) message('#pdf-timing-status', `Page ${page.number} starts at ${clock(page.start)}${select.selectedIndex === 0 ? ' · Start of the recording' : ''}`);
  }

  function showPages() {
    const selectedIndex = Math.max(0, select.selectedIndex);
    select.replaceChildren(...editor.pages.map((page, index) => new Option(`Page ${page.number} · ${clock(page.start)}`, index)));
    select.selectedIndex = selectedIndex;
    controls();
  }

  function seek(time) {
    if (Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(audio.duration, time));
  }

  select.addEventListener('change', () => { controls(); seek(selected().start); message('#pdf-timing-error'); });
  audio.addEventListener('loadedmetadata', () => { const page = selected(); controls(); if (page) seek(page.start); });
  audio.addEventListener('error', () => { if (dialog.open) message('#pdf-timing-error', 'The audiobook preview could not be loaded.'); });
  jump.addEventListener('click', () => seek(selected().start));
  for (const button of nudges) button.addEventListener('click', () => seek(audio.currentTime + Number(button.dataset.pdfNudge)));
  mark.addEventListener('click', () => {
    const index = select.selectedIndex, page = selected(), start = Math.round(audio.currentTime * 1000) / 1000;
    const previous = editor.pages[index - 1], next = editor.pages[index + 1];
    if (start <= previous.start || start >= (next?.start ?? editor.duration)) {
      return message('#pdf-timing-error', `Choose a time after ${clock(previous.start)} and before ${clock(next?.start ?? editor.duration)}.`);
    }
    page.start = start; editor.dirty = true; showPages(); message('#pdf-timing-error');
  });
  reset.addEventListener('click', () => {
    for (const page of editor.pages) page.start = page.original;
    editor.dirty = true; showPages(); seek(selected().start); message('#pdf-timing-error');
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = editor;
    if (save.disabled) return;
    session.saving = true; controls(); message('#pdf-timing-error');
    try {
      const starts = Object.fromEntries(session.pages.filter((page) => page.start !== page.original).map(({ key, start }) => [key, start]));
      await api(session.path, { method: 'PUT', body: { revision: session.revision, starts } });
      if (editor === session && dialog.open) { dialog.close(); saved(session.book); }
    } catch (error) { if (editor === session) message('#pdf-timing-error', error.message); }
    finally { if (editor === session) { session.saving = false; controls(); } }
  });
  function clearEditor() {
    editor?.controller.abort(); editor = undefined;
    if (audio.hasAttribute('src')) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  }
  dialog.addEventListener('close', () => { if (!dialog.open) clearEditor(); });
  return { async open(book, recording, { pageKey } = {}) {
    if (dialog.open) return;
    clearEditor();
    select.replaceChildren(); controls();
    message('#pdf-timing-error'); message('#pdf-timing-status');
    dialog.showModal();
    if (!recording?.pdfTimingAvailable) {
      const explanations = {
        loading: 'Wait for the audiobook details to load, then reopen this tool.',
        ready: 'This recording needs at least two synced PDF pages to adjust its page turns.',
        queued: 'Wait for the audiobook to finish, then reopen this tool.',
        assembling: 'Wait for the audiobook to finish, then reopen this tool.',
      };
      message('#pdf-timing-status', explanations[recording?.state ?? 'loading']
        || 'Generate this PDF’s audiobook or sync a recording in Analysis & audio to adjust page turns.');
      return;
    }
    const path = `/api/books/${encodeURIComponent(book.id)}/pdf-timing/${encodeURIComponent(recording.id)}`;
    const session = editor = { book, path, controller: new AbortController() };
    message('#pdf-timing-status', 'Loading page timings…');
    try {
      const data = await api(path, { signal: session.controller.signal });
      if (editor !== session) return;
      Object.assign(session, data); showPages();
      const pageIndex = session.pages.findIndex(({ key }) => key === pageKey);
      select.selectedIndex = pageIndex >= 0 ? pageIndex : 1;
      controls(); audio.src = data.url;
    } catch (error) {
      if (editor === session) { message('#pdf-timing-status'); message('#pdf-timing-error', error.message); }
    }
  } };
}
