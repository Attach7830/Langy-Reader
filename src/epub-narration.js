import { $, api, element, message } from './ui.js';

const wholeBook = () => ({ start: null, end: null, exclusions: [] });
const point = (value) => value && { key: value.key, offset: value.offset };

export function epubNarrationEditor({ saved }) {
  const dialog = $('#epub-narration-dialog'), form = $('#epub-narration-form');
  const { section, text } = form.elements;
  const start = $('#epub-narration-start'), end = $('#epub-narration-end'), exclude = $('#epub-narration-exclude');
  const summary = $('#epub-narration-selection'), reset = $('#epub-narration-reset'), save = $('#epub-narration-save');
  let session, poll;

  function controls() {
    const ready = Boolean(session?.section && !session.loading && !session.saving && !session.stale);
    section.disabled = text.disabled = save.disabled = !ready;
    start.disabled = end.disabled = !ready || !text.value.trim();
    exclude.disabled = start.disabled || text.selectionStart === text.selectionEnd;
    reset.disabled = !ready || !summary.childElementCount;
    for (const button of summary.querySelectorAll('button')) button.disabled = !ready;
  }

  function render() {
    const { selection, sections } = session;
    function row(label, value, remove) {
      const heading = sections.find(({ key }) => key === value.key)?.title;
      const item = element('li', 'epub-narration-range');
      const description = element('div');
      description.append(element('strong', '', label));
      const excerpt = element('p', 'field-note', [heading, value.preview].filter(Boolean).join(' · '));
      excerpt.setAttribute('data-user-content', ''); excerpt.dir = 'auto';
      description.append(excerpt);
      const button = element('button', 'button quiet small', 'Remove');
      button.type = 'button'; button.setAttribute('aria-label', 'Remove ' + label);
      button.addEventListener('click', () => { remove(); render(); reset.focus({ preventScroll: true }); });
      item.append(description, button);
      return item;
    }
    const rows = [];
    if (selection.start) rows.push(row('Start', selection.start, () => { selection.start = null; }));
    if (selection.end) rows.push(row('End', selection.end, () => { selection.end = null; }));
    for (const [index, exclusion] of selection.exclusions.entries()) {
      rows.push(row(`Exclusion ${index + 1}`, exclusion, () => selection.exclusions.splice(index, 1)));
    }
    summary.replaceChildren(...rows);
    summary.hidden = !rows.length;
    controls();
  }

  async function load(key) {
    const editor = session;
    if (!editor || editor.loading) return;
    editor.loading = true; controls();
    message('#epub-narration-error'); message('#epub-narration-status', 'Loading EPUB text…');
    try {
      const query = key ? '?' + new URLSearchParams({ key }) : '';
      const data = await api(editor.path + query, { signal: editor.controller.signal });
      if (editor !== session) return;
      if (data.state === 'error') throw new Error(data.error);
      if (data.state !== 'ready') { poll = setTimeout(() => void load(key), 1200); return; }
      if (editor.revision && editor.revision !== data.revision) {
        editor.stale = true;
        throw new Error('The text or settings changed. Reopen the editor to work with the current version.');
      }
      if (!editor.revision) {
        editor.revision = data.revision; editor.sections = data.sections; editor.selection = data.selection;
        section.replaceChildren(...data.sections.map(({ key, title }) => new Option(title, key)));
        message('#epub-narration-note', data.outdated ? 'The EPUB text changed. Set new boundaries and exclusions before generating.' : '');
      }
      editor.section = data.section;
      section.value = data.section.key;
      text.value = data.section.text; text.setSelectionRange(0, 0); text.scrollTop = 0;
      message('#epub-narration-status');
      render();
    } catch (error) {
      if (editor === session) {
        section.value = editor.section?.key || '';
        message('#epub-narration-status'); message('#epub-narration-error', error.message);
      }
    } finally { if (editor === session) { editor.loading = false; controls(); } }
  }

  function setBoundary(which, offset) {
    const context = which === 'start' ? text.value.slice(offset, offset + 100) : text.value.slice(Math.max(0, offset - 100), offset);
    session.selection[which] = { key: session.section.key, offset, preview: context.trim() };
    render();
  }
  section.addEventListener('change', () => void load(section.value));
  text.addEventListener('select', controls);
  text.addEventListener('pointerup', controls);
  text.addEventListener('keyup', controls);
  start.addEventListener('click', () => setBoundary('start', text.selectionStart));
  end.addEventListener('click', () => setBoundary('end', text.selectionEnd));
  exclude.addEventListener('click', () => {
    const from = text.selectionStart, to = text.selectionEnd;
    if (to <= from) return;
    session.selection.exclusions.push({ key: session.section.key, from, to, preview: text.value.slice(from, Math.min(to, from + 140)).trim() });
    render();
  });
  reset.addEventListener('click', () => { session.selection = wholeBook(); render(); save.focus({ preventScroll: true }); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    const editor = session, { start, end, exclusions } = editor.selection;
    editor.saving = true; controls(); message('#epub-narration-error');
    try {
      await api(editor.path, { method: 'PUT', signal: editor.controller.signal, body: {
        revision: editor.revision, start: point(start), end: point(end),
        exclusions: exclusions.map(({ key, from, to }) => ({ key, from, to })),
      } });
      if (editor === session && dialog.open) { dialog.close(); saved(editor.book); }
    } catch (error) { if (editor === session) message('#epub-narration-error', error.message); }
    finally { if (editor === session) { editor.saving = false; controls(); } }
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    clearTimeout(poll); session?.controller.abort(); session = undefined;
  });
  return { open(book) {
    if (dialog.open) return;
    session = { book, path: `/api/books/${encodeURIComponent(book.id)}/epub-narration`, controller: new AbortController() };
    section.replaceChildren(); text.value = ''; summary.replaceChildren(); summary.hidden = true;
    message('#epub-narration-note'); controls(); dialog.showModal(); void load();
  } };
}
