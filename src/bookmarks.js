import { $, element, message, toast } from './ui.js';

export function readingBookmarks({ book, position, go, request }) {
  const dialog = $('#bookmarks-dialog'), form = $('#bookmark-form'), list = $('#bookmark-list'), save = $('#bookmark-save');
  let version = 0, target, currentBook, dirty = false;
  form.addEventListener('input', () => { dirty = true; });
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
    const existing = entries.find((entry) => entry.target === target);
    if (existing && !dirty) { form.elements.label.value = existing.label; form.elements.note.value = existing.note; }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (save.disabled || target == null) return;
    const epoch = version; save.disabled = true; message('#bookmark-error');
    try {
      const result = await request(`/api/books/${currentBook}/bookmarks`, { method: 'POST', body: { target, label: form.elements.label.value, note: form.elements.note.value } });
      if (epoch === version) { render(result.bookmarks); toast(result.queued ? 'Bookmark saved offline; sync pending.' : 'Bookmark saved'); }
    } catch (error) { if (epoch === version) message('#bookmark-error', error.message); }
    finally { if (epoch === version) save.disabled = false; }
  });
  return {
    async open() {
      const active = book(), location = position(); if (!active || location?.target == null || dialog.open) return;
      const epoch = ++version; currentBook = active.id; target = location.target; dirty = false;
      form.elements.label.value = location.label || 'Bookmark'; form.elements.note.value = ''; save.disabled = false; message('#bookmark-error');
      list.replaceChildren(element('p', 'field-note', 'Loading bookmarks…')); dialog.showModal();
      try { const result = await request(`/api/books/${currentBook}/bookmarks`); if (epoch === version) render(result.bookmarks); }
      catch (error) { if (epoch === version) message('#bookmark-error', error.message); }
    },
    reset() { version++; currentBook = null; target = null; if (dialog.open) dialog.close(); },
  };
}
