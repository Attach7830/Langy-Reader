import { $, element, api } from './ui.js';

export function bookContents({ renderer, book, go, focus = () => {} }) {
  const dialog = $('#contents-dialog'), body = $('#contents-body');
  return { open() {
    const current = renderer(); if (!current || dialog.open) return;
    const entries = current.contents || [], isPdf = book().format === 'pdf';
    $('#contents-title').textContent = 'Book sections'; body.replaceChildren();
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Find a chapter or section'; search.setAttribute('aria-label', 'Find a chapter or section');
    const field = element('label', 'field', 'Chapters and sections'); field.append(search); body.append(field);
    const lists = [], empty = element('p', 'field-note', 'No matching sections.'); empty.hidden = true;
    function jump(target) { dialog.close(); focus(); void Promise.resolve(go(target)).catch(() => {}); }
    function filter() {
      const query = search.value.trim().toLocaleLowerCase(); let visible = 0;
      for (const list of lists) for (const item of list.children) {
        item.hidden = Boolean(query && !item.textContent.toLocaleLowerCase().includes(query));
        if (!item.hidden && item.tagName === 'BUTTON') visible++;
      }
      empty.hidden = !query || visible > 0;
    }
    function tocList(items, name) {
      const list = element('nav', 'toc-list'); list.setAttribute('aria-label', name);
      for (const { label, target, depth = 0, marker } of items) {
        const item = element(target == null ? 'div' : 'button', target == null ? 'toc-group' : 'toc-item', label);
        item.setAttribute('data-user-content', ''); item.style.paddingInlineStart = `${10 + 14 * Math.min(depth, 5)}px`;
        if (marker) item.append(element('span', 'toc-marker', 'Reading marker'));
        if (target != null) {
          item.type = 'button'; item.addEventListener('click', () => jump(target));
          if (target?.index === current.sectionIndex || isPdf && Number.isInteger(target) && target === current.pageNumber) item.setAttribute('aria-current', 'location');
        }
        list.append(item);
      }
      lists.push(list); return list;
    }
    if (isPdf) {
      const form = element('form', 'pdf-jump'), field = element('label', 'field', `Page number (1–${current.pageCount})`);
      const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.max = String(current.pageCount); input.value = String(current.pageNumber); input.required = true;
      const submit = element('button', 'button primary', 'Go'); submit.type = 'submit'; field.append(input); form.append(field, submit);
      form.addEventListener('submit', (event) => { event.preventDefault(); if (input.checkValidity()) jump(input.valueAsNumber); else input.reportValidity(); });
      body.append(form);
    }
    if (entries.length) body.append(tocList(entries, 'Book contents'));
    const saved = element('details', 'toc-bookmarks'), savedList = element('div', 'form-stack');
    saved.append(element('summary', '', 'Bookmarks'), savedList); body.append(saved); let bookmarksStarted = false;
    saved.addEventListener('toggle', async () => {
      if (!saved.open || bookmarksStarted) return; bookmarksStarted = true;
      savedList.replaceChildren(element('p', 'field-note', 'Loading bookmarks…'));
      try {
        const result = await api(`/api/books/${book().id}/bookmarks`); if (renderer() !== current || !savedList.isConnected) return;
        savedList.replaceChildren(...(result.bookmarks?.length ? result.bookmarks.map((mark) => {
          const button = element('button', 'toc-item', mark.label || mark.note || 'Bookmark'); button.type = 'button'; button.setAttribute('data-user-content', '');
          button.addEventListener('click', () => jump(mark.target)); return button;
        }) : [element('p', 'field-note', 'No bookmarks yet.')]));
      } catch { savedList.replaceChildren(element('p', 'field-note', 'Could not load bookmarks.')); bookmarksStarted = false; }
    });
    if (current.readingOutline) {
      const detail = element('details', 'toc-outline'), output = element('div', 'toc-outline-body');
      detail.append(element('summary', '', 'Reading outline'), output); body.append(detail);
      let started = false;
      async function showOutline() {
        if (!detail.open || started) return; started = true;
        const status = element('p', 'field-note', 'Finding headings and breaks…'); status.setAttribute('role', 'status'); output.replaceChildren(status);
        try {
          const inferred = await current.readingOutline(); if (renderer() !== current || !output.isConnected) return;
          output.replaceChildren(element('p', 'field-note', inferred.some((item) => item.marker)
            ? 'Jump by heading or opening words. Reading markers are approximate stops.' : 'Jump by heading or opening words.'),
          inferred.length ? tocList(inferred, 'Reading outline') : element('p', 'field-note', 'No passages found.'));
          filter();
        } catch { status.textContent = 'Could not read sections from this book.'; }
      }
      detail.addEventListener('toggle', showOutline);
      detail.open = entries.filter((item) => item.target != null).length < 2;
      if (detail.open) void showOutline();
      search.addEventListener('input', () => { if (search.value.trim()) { detail.open = true; void showOutline(); } });
    } else if (!entries.length) body.append(element('p', 'field-note', isPdf ? 'This PDF has no chapter bookmarks. Use a page number to navigate.' : 'This book has no table of contents.'));
    body.append(empty); search.addEventListener('input', filter); dialog.showModal(); body.querySelector('.toc-item')?.focus();
  } };
}
