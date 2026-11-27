import { $, element, message, toast } from './ui.js';
import { bookmarkTargetKey } from '../shared/bookmark-targets.js';

const freshFor = 15_000;

export function readingBookmarks({ book, position, go, request }) {
  const dialog = $('#bookmarks-dialog'), form = $('#bookmark-form'), list = $('#bookmark-list'), save = $('#bookmark-save');
  const { label, note } = form.elements;
  const excerpt = $('#bookmark-excerpt');
  let collection, version = 0, target, dirty = false, selection = false;
  form.addEventListener('input', () => { dirty = true; });
  note.addEventListener('keydown', (event) => {
    if (!selection || event.key !== 'Enter' || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (!event.repeat) form.requestSubmit(save);
  });
  function remember(data, entries) {
    data.entries = entries;
    data.updated = Date.now();
  }
  function load() {
    const id = book()?.id;
    if (!id) return Promise.resolve([]);
    collection ||= { path: `/api/books/${id}/bookmarks` };
    const data = collection;
    if (data.pending) return data.pending.promise;
    if (data.entries && Date.now() - data.updated < freshFor) return Promise.resolve(data.entries);
    const controller = new AbortController(), pending = { controller };
    data.pending = pending;
    pending.promise = request(data.path, { signal: controller.signal }).then((result) => {
      if (data.pending === pending) remember(data, result.bookmarks);
      return data.entries;
    }).catch((error) => {
      if (controller.signal.aborted) return data.entries ?? [];
      throw error;
    }).finally(() => { if (data.pending === pending) data.pending = null; });
    return pending.promise;
  }
  async function change(data, path, body) {
    data.saving = true;
    try {
      const result = await request(data.path + path, { method: 'POST', body });
      data.pending?.controller.abort();
      data.pending = null;
      remember(data, result.bookmarks);
      if (collection === data && dialog.open && !selection) render(data.entries);
      return result;
    } finally { data.saving = false; }
  }
  function render(entries) {
    list.replaceChildren(...entries.map((entry) => {
      const row = element('div', 'bookmark-entry'), open = element('button', 'button quiet bookmark-open', entry.label); open.type = 'button';
      open.dir = 'auto';
      open.setAttribute('data-user-content', '');
      open.addEventListener('click', () => { dialog.close(); void go(entry.target); });
      const remove = element('button', 'button quiet small', 'Remove'); remove.type = 'button';
      remove.addEventListener('click', async () => {
        const data = collection;
        if (!data || data.saving) return;
        const epoch = version; remove.disabled = true;
        message('#bookmark-error');
        try { await change(data, '/remove', { target: entry.target }); }
        catch (error) { if (epoch === version && dialog.open) message('#bookmark-error', error.message); }
        finally { remove.disabled = false; }
      });
      row.append(open, remove);
      if (entry.note) {
        const note = element('p', 'field-note', entry.note);
        note.dir = 'auto'; note.setAttribute('data-user-content', ''); row.append(note);
      }
      return row;
    }));
    if (!entries.length) list.append(element('p', 'field-note', 'No bookmarks for this book yet.'));
    const key = bookmarkTargetKey(target);
    const existing = entries.find((entry) => bookmarkTargetKey(entry.target) === key);
    if (existing && !dirty) { label.value = existing.label; note.value = existing.note; }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = collection;
    if (!dialog.open || save.disabled || !data || data.saving || target == null) return;
    const epoch = version; save.disabled = true; message('#bookmark-error');
    const body = { target, label: label.value };
    if (!selection || note.value.trim()) body.note = note.value;
    try {
      const result = await change(data, '', body);
      if (epoch !== version || !dialog.open) return;
      if (selection) dialog.close();
      toast(result.queued ? 'Bookmark saved offline; sync pending.' : 'Bookmark saved');
    } catch (error) { if (epoch === version && dialog.open) message('#bookmark-error', error.message); }
    finally { if (epoch === version) save.disabled = false; }
  });

  function show(location, fromSelection) {
    const active = book();
    if (!active || location?.target == null || document.querySelector('dialog[open]')) return false;
    collection ||= { path: `/api/books/${active.id}/bookmarks` };
    version++; target = location.target; dirty = false; selection = fromSelection;
    $('#bookmarks-title').textContent = selection ? 'Bookmark selection' : 'Bookmarks';
    label.closest('label').hidden = list.hidden = selection;
    label.value = location.label || 'Bookmark'; note.value = '';
    excerpt.hidden = !selection; excerpt.textContent = selection ? label.value : '';
    save.textContent = selection ? 'Save bookmark' : 'Save this reading position';
    save.disabled = false; message('#bookmark-error');
    list.replaceChildren();
    dialog.showModal();
    if (selection) note.focus();
    return true;
  }

  return {
    cached: () => collection?.entries,
    load,
    async open() {
      if (!show(position(), false)) return;
      const epoch = version, cached = collection.entries;
      if (cached) render(cached);
      else list.append(element('p', 'field-note', 'Loading bookmarks…'));
      try { const entries = await load(); if (epoch === version && dialog.open && entries !== cached) render(entries); }
      catch (error) {
        if (epoch !== version || !dialog.open) return;
        if (!collection.entries) list.replaceChildren();
        message('#bookmark-error', error.message);
      }
    },
    openSelection(target, text) {
      const label = text.replace(/\s+/gu, ' ').trim();
      return show({ target, label: label.length > 200 ? `${label.slice(0, 199).replace(/[\uD800-\uDBFF]$/u, '').trimEnd()}…` : label }, true);
    },
    reset() { version++; collection?.pending?.controller.abort(); collection = undefined; target = null; if (dialog.open) dialog.close(); },
  };
}
