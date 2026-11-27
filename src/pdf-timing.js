import { $, $$, api, message } from './ui.js';

const clock = (time) => {
  const centiseconds = Math.round(time * 100);
  const minutes = Math.floor(centiseconds / 6000);
  return `${minutes}:${(centiseconds % 6000 / 100).toFixed(2).padStart(5, '0')}`;
};

export function adjustPdfTiming({ saved }) {
  const dialog = $('#pdf-timing-dialog'), form = $('#pdf-timing-form'), select = form.elements.page;
  const audio = $('#pdf-timing-audio'), save = $('#pdf-timing-save'), mark = $('#pdf-timing-mark');
  const jump = $('#pdf-timing-jump'), reset = $('#pdf-timing-reset'), nudges = $$('[data-pdf-nudge]', form);
  let editor;

  const selected = () => editor?.pages?.[Number(select.value)];
  function controls() {
    const page = selected(), ready = Boolean(page && Number.isFinite(audio.duration) && !editor.saving);
    select.disabled = !page || editor.saving;
    jump.disabled = !ready;
    mark.disabled = !ready || select.selectedIndex === 0;
    reset.disabled = !page || editor.saving || !editor.pages.some((item) => item.start !== item.original);
    save.disabled = !page || editor.saving || !editor.dirty;
    for (const button of nudges) button.disabled = !ready;
    $('#pdf-timing-opening').textContent = page?.opening || '';
    message('#pdf-timing-status', page ? `Page ${page.number} starts at ${clock(page.start)}${select.selectedIndex === 0 ? ' · Start of the recording' : ''}` : '');
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
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    editor?.controller.abort(); editor = undefined; audio.pause(); audio.removeAttribute('src'); audio.load();
  });
  return { async open(book, recording) {
    if (dialog.open) return;
    const path = `/api/books/${encodeURIComponent(book.id)}/pdf-timing/${encodeURIComponent(recording)}`;
    const session = editor = { book, path, controller: new AbortController() };
    select.replaceChildren(); controls(); message('#pdf-timing-error');
    message('#pdf-timing-status', 'Loading page timings…'); dialog.showModal();
    try {
      const data = await api(path, { signal: session.controller.signal });
      if (editor !== session) return;
      Object.assign(session, data); showPages();
      if (session.pages.length > 1) select.selectedIndex = 1;
      controls(); audio.src = data.url;
    } catch (error) {
      if (editor === session) { message('#pdf-timing-status'); message('#pdf-timing-error', error.message); }
    }
  } };
}
