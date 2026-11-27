import { $, element, message, toast } from './ui.js';
import { bookmarkTargetKey } from '../shared/bookmark-targets.js';

export function readingBookmarks({ book, position, go, request }) {
  const dialog = $('#bookmarks-dialog'), form = $('#bookmark-form'), list = $('#bookmark-list'), save = $('#bookmark-save');
  const { label, note } = form.elements;
  const excerpt = $('#bookmark-excerpt');
  let version = 0, target, currentBook, dirty = false, selection = false;
  form.addEventListener('input', () => { dirty = true; });
  note.addEventListener('keydown', (event) => {
    if (!selection || event.key !== 'Enter' || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (!event.repeat) form.requestSubmit(save);
  });
  function render(entries) {
    list.replaceChildren(...entries.map((entry) => {
      const row = element('div', 'bookmark-entry'), open = element('button', 'button quiet', entry.label); open.type = 'button';
      open.setAttribute('data-user-content', '');
      open.addEventListener('click', () => { dialog.close(); void go(entry.target); });
      const remove = element('button', 'button quiet small', 'Remove'); remove.type = 'button';
      remove.addEventListener('click', async () => {
        const epoch = version; remove.disabled = true;
        try { const result = await request(`/api/books/${currentBook}/bookmarks/${entry.id}`, { method: 'DELETE' }); if (epoch === version) render(result.bookmarks); }
        catch (error) { if (epoch === version) { message('#bookmark-error', error.message); remove.disabled = false; } }
      });
      row.append(open, remove); if (entry.note) { const note = element('p', 'field-note', entry.note); note.setAttribute('data-user-content', ''); row.append(note); } return row;
    }));
    if (!entries.length) list.append(element('p', 'field-note', 'No bookmarks for this book yet.'));
    const key = bookmarkTargetKey(target);
    const existing = entries.find((entry) => bookmarkTargetKey(entry.target) === key);
    if (existing && !dirty) { label.value = existing.label; note.value = existing.note; }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!dialog.open || save.disabled || target == null) return;
    const epoch = version; save.disabled = true; message('#bookmark-error');
    const body = { target, label: label.value };
    if (!selection || note.value.trim()) body.note = note.value;
    try {
      const result = await request(`/api/books/${currentBook}/bookmarks`, { method: 'POST', body });
      if (epoch !== version || !dialog.open) return;
      if (selection) dialog.close(); else render(result.bookmarks);
      toast(result.queued ? 'Bookmark saved offline; sync pending.' : 'Bookmark saved');
    } catch (error) { if (epoch === version && dialog.open) message('#bookmark-error', error.message); }
    finally { if (epoch === version) save.disabled = false; }
  });

  function show(location, fromSelection) {
    const active = book();
    if (!active || location?.target == null || document.querySelector('dialog[open]')) return false;
    version++; currentBook = active.id; target = location.target; dirty = false; selection = fromSelection;
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
    async open() {
      if (!show(position(), false)) return;
      const epoch = version;
      list.append(element('p', 'field-note', 'Loading bookmarks…'));
      try { const result = await request(`/api/books/${currentBook}/bookmarks`); if (epoch === version && dialog.open) render(result.bookmarks); }
      catch (error) { if (epoch === version && dialog.open) message('#bookmark-error', error.message); }
    },
    openSelection(target, text) {
      const label = text.replace(/\s+/gu, ' ').trim();
      return show({ target, label: label.length > 200 ? `${label.slice(0, 199).replace(/[\uD800-\uDBFF]$/u, '').trimEnd()}…` : label }, true);
    },
    reset() { version++; currentBook = null; target = null; if (dialog.open) dialog.close(); },
  };
}
