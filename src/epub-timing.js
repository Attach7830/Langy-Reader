import { $, $$, api, element, message } from './ui.js';
import { audioSyncTime as clock } from './audio-sync-time.js';

export function adjustEpubTiming({ saved }) {
  const dialog = $('#epub-timing-dialog'), form = $('#epub-timing-form');
  const { section, text } = form.elements;
  const fields = $('#epub-timing-controls'), audio = $('#epub-timing-audio');
  const jump = $('#epub-timing-jump'), save = $('#epub-timing-save'), reset = $('#epub-timing-reset');
  const nudges = $$('[data-epub-nudge]', form), points = $('#epub-timing-points');
  let editor;

  function selectedWord() {
    const from = text.selectionStart, to = Math.max(from + 1, text.selectionEnd);
    return editor?.section?.words.find(([start, end]) => start < to && end > from);
  }
  function previewReady() {
    return Boolean(editor?.section && audio.readyState > 0 && audio.getAttribute('src') === editor.url);
  }
  function controls() {
    const word = selectedWord(), pending = editor?.pending, hasSection = Boolean(editor?.section);
    const ready = previewReady() && !pending;
    fields.hidden = save.hidden = !hasSection;
    section.disabled = text.disabled = !hasSection || pending;
    jump.disabled = save.disabled = !ready || !word;
    reset.disabled = !hasSection || pending || !editor.section.points.length;
    for (const button of nudges) button.disabled = !ready;
    for (const button of points.querySelectorAll('button')) button.disabled = Boolean(pending);
    const selected = word ? `${text.value.slice(word[0], word[1])} · ${clock(word[2])}`
      : hasSection && text.selectionStart !== text.selectionEnd ? 'Select a word with a time in this recording.' : '';
    message('#epub-timing-word', selected);
  }
  function seek(time) {
    if (previewReady()) audio.currentTime = Math.max(0, Math.min(audio.duration, time));
  }
  function updatePlayhead() {
    message('#epub-timing-playhead', previewReady() ? `Playhead · ${clock(audio.currentTime)}` : '');
  }
  function renderPoints() {
    const { text: source, points: values, needsReview } = editor.section;
    const words = new Map(editor.section.words.map(([from, to]) => [from, to]));
    points.replaceChildren(...values.map(({ from, time }) => {
      const row = element('li', 'epub-narration-range');
      const excerpt = element('div', '', `${source.slice(from, words.get(from) ?? from + 20)} · ${clock(time)}`);
      excerpt.setAttribute('data-user-content', ''); excerpt.dir = 'auto';
      const remove = element('button', 'button quiet small', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove sync point at ${clock(time)}`);
      remove.addEventListener('click', () => void savePoints(values.filter((point) => point.from !== from)));
      row.append(excerpt, remove);
      return row;
    }));
    points.hidden = !values.length;
    message('#epub-timing-review', needsReview ? 'The section was synced again. Review its saved points or restore automatic timing.' : '');
    controls();
  }

  async function load(key, position = {}) {
    const current = editor;
    if (!current || current.pending) return;
    current.pending = true; controls();
    message('#epub-timing-error'); message('#epub-timing-status', 'Loading section timing…');
    try {
      const query = key ? '?' + new URLSearchParams({ key }) : '';
      const data = await api(current.path + query, { signal: current.controller.signal });
      if (current !== editor) return;
      Object.assign(current, data);
      section.replaceChildren(...data.sections.map(({ key: value, title }) => new Option(title, value)));
      section.value = data.section.key;
      text.value = data.section.text;
      const word = data.section.words.find(([from, to]) => from <= position.from && position.from < to);
      text.setSelectionRange(word?.[0] ?? 0, word?.[1] ?? 0);
      if (!word) text.scrollTop = 0;
      const time = position.time >= data.section.start && position.time < data.section.end
        ? position.time : word?.[2] ?? data.section.start;
      if (audio.getAttribute('src') !== data.url) {
        current.previewTime = time;
        audio.src = data.url;
      } else seek(time);
      message('#epub-timing-range', `Section audio · ${clock(data.section.start)} to ${clock(data.section.end)}`);
      message('#epub-timing-status');
      renderPoints();
    } catch (error) {
      if (current !== editor) return;
      section.value = current.section?.key ?? '';
      message('#epub-timing-status'); message('#epub-timing-error', error.message);
    } finally { if (current === editor) { current.pending = false; controls(); } }
  }

  async function savePoints(values) {
    const current = editor;
    if (!current?.section || current.pending) return;
    current.pending = true; controls();
    message('#epub-timing-error'); message('#epub-timing-status', 'Saving audio sync…');
    try {
      const data = await api(current.path, { method: 'PUT', body: {
        revision: current.revision, key: current.section.key, points: values,
      } });
      if (current === editor) {
        Object.assign(current, data); renderPoints();
        message('#epub-timing-status', values.length ? 'Audio sync saved.' : 'Automatic timing restored for this section.');
      }
      saved(current.book);
    } catch (error) {
      if (current === editor) { message('#epub-timing-status'); message('#epub-timing-error', error.message); }
    } finally { if (current === editor) { current.pending = false; controls(); } }
  }

  section.addEventListener('change', () => { audio.pause(); void load(section.value); });
  for (const type of ['select', 'keyup', 'pointerup']) text.addEventListener(type, controls);
  audio.addEventListener('loadedmetadata', () => {
    if (!previewReady()) return;
    seek(editor.previewTime ?? editor.section.start);
    editor.previewTime = undefined;
    controls(); updatePlayhead();
  });
  audio.addEventListener('timeupdate', updatePlayhead);
  audio.addEventListener('error', () => { if (dialog.open) message('#epub-timing-error', 'The audiobook preview could not be loaded.'); });
  jump.addEventListener('click', () => seek(selectedWord()?.[2]));
  for (const button of nudges) button.addEventListener('click', () => seek(audio.currentTime + Number(button.dataset.epubNudge)));
  reset.addEventListener('click', () => void savePoints([]));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const word = selectedWord();
    if (!word || save.disabled) return;
    const { start, end, points: values } = editor.section, time = audio.currentTime;
    if (time < start || time >= end) return message('#epub-timing-error', 'Move the playhead to a time within this section’s audio.');
    audio.pause();
    void savePoints([...values.filter(({ from }) => from !== word[0]), { from: word[0], time }]);
  });
  function clearEditor() {
    editor?.controller.abort(); editor = undefined;
    if (audio.hasAttribute('src')) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  }
  dialog.addEventListener('close', () => { if (!dialog.open) clearEditor(); });
  return { open(book, recording, position = {}) {
    if (dialog.open) return;
    clearEditor(); controls();
    message('#epub-timing-error'); message('#epub-timing-status'); updatePlayhead();
    dialog.showModal();
    if (recording?.state !== 'ready' || !recording.segments?.length) {
      const waiting = !recording || ['queued', 'assembling'].includes(recording.state);
      return message('#epub-timing-status', waiting ? 'Open this tool when the audiobook is ready.'
        : 'Generate this EPUB’s audiobook or sync a recording in Analysis & audio.');
    }
    const path = `/api/books/${encodeURIComponent(book.id)}/epub-timing/${encodeURIComponent(recording.id)}`;
    editor = { book, path, controller: new AbortController() };
    const key = recording.segments.some(({ key }) => key === position.key) ? position.key : undefined;
    void load(key, key ? position : {});
  } };
}
