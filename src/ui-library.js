import { $, api, drawIcons, element, icon, message, toast } from './ui.js';
import { languageName } from './settings.js';
import { parseLanguage } from './languages.js';

export function libraryScreen({ progress, onRemove }) {
  const search = $('#search');
  const books = $('#books');
  const bookDialog = $('#book-dialog');
  const bookForm = $('#book-form');
  const categoryDialog = $('#category-dialog');
  const categoryForm = $('#category-form');
  let snapshot = { categories: [], books: [], maxUpload: 120 * 1024 ** 2, demo: false };
  let category = 'all', editingBook, editingCategory, selectedFile;
  let bookPending = false, categoryPending = false;

  function categoryButton(id, name, count, iconName) {
    const button = element('button', 'rail-item');
    button.type = 'button';
    button.setAttribute('aria-current', String(category === id));
    button.append(icon(iconName), element('span', '', name), element('span', 'count', String(count)));
    button.addEventListener('click', () => chooseCategory(id));
    return button;
  }

  function editButton(title, action, className = '') {
    const button = element('button', `icon-button small ${className}`);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.append(icon('pencil'));
    button.addEventListener('click', action);
    return button;
  }

  function bookCard(book) {
    const card = element('article', 'book-card');
    const link = element('a');
    link.href = `#read/${encodeURIComponent(book.id)}`;
    link.setAttribute('aria-label', `${progress[book.id] ? 'Resume' : 'Read'} ${book.title}`);
    const cover = element('div', `book-cover${book.id === 'sample' ? ' cover-sample' : ''}`);
    cover.setAttribute('aria-hidden', 'true');
    cover.dataset.palette = book.id === 'sample' ? '0' : String(book.title.codePointAt(0) % 4);
    cover.append(element('span', 'cover-format', book.format.toUpperCase()),
      element('span', 'cover-title', book.title.length > 50 ? `${book.title.slice(0, 48)}…` : book.title));
    if (book.id === 'sample') cover.append(icon('coffee'));
    else cover.append(element('span', 'cover-author', book.author), element('span', 'cover-decoration'));
    if (book.thumbnailType) {
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.src = `/api/books/${book.id}/cover`;
      image.addEventListener('error', () => image.remove(), { once: true });
      cover.append(image);
    }
    const info = element('div', 'book-info');
    const meta = [book.author, languageName(book.language)].filter(Boolean).join(' · ');
    info.append(element('span', 'book-title', book.title), element('span', 'book-meta', meta));
    link.append(cover, info);
    const saved = progress[book.id];
    if (saved) {
      const track = element('span', 'progress-track');
      const fill = element('span');
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, saved.percent || 0)) * 100)}%`;
      track.append(fill);
      track.setAttribute('aria-hidden', 'true');
      info.append(track);
    }
    card.append(link);
    if (!snapshot.demo || book.id !== 'sample') card.append(editButton(`Edit ${book.title}`, () => showBook(book), 'book-edit'));
    return card;
  }

  function render() {
    const current = snapshot.categories.find(({ id }) => id === category);
    if (!current && !['all', 'uncategorized'].includes(category)) category = 'all';
    $('#all-books').setAttribute('aria-current', String(category === 'all'));
    $('#all-count').textContent = String(snapshot.books.length);
    $('#library-title').textContent = current?.name || (category === 'uncategorized' ? 'Uncategorized' : 'Your library');
    $('#library-description').textContent = category === 'all'
      ? 'Read your EPUBs and PDFs with language help on hand.'
      : current ? 'Books in this category.' : 'Books without a category.';
    $('#demo-note').hidden = !snapshot.demo;
    const categoryRows = snapshot.categories.map((entry) => {
      const row = element('div', 'category-row');
      row.append(categoryButton(entry.id, entry.name, snapshot.books.filter((book) => book.categoryId === entry.id).length, 'folder'));
      if (!snapshot.demo || entry.id !== 'spanish') row.append(editButton(`Edit category ${entry.name}`, () => showCategory(entry)));
      return row;
    });
    const uncategorized = snapshot.books.filter((book) => !book.categoryId).length;
    $('#categories').replaceChildren(...categoryRows, categoryButton('uncategorized', 'Uncategorized', uncategorized, 'folder'));
    const filter = search.value.trim().toLocaleLowerCase();
    const visible = snapshot.books.filter((book) =>
      (category === 'all' || (book.categoryId ?? 'uncategorized') === category) &&
      (!filter || `${book.title} ${book.author}`.toLocaleLowerCase().includes(filter)));
    $('#book-count').textContent = `${visible.length} ${visible.length === 1 ? 'book' : 'books'}`;
    books.replaceChildren(...visible.map(bookCard));
    $('#empty-library').hidden = visible.length > 0;
    $('#empty-title').textContent = filter ? 'No matching books' : 'No books here yet';
    $('#empty-detail').textContent = filter ? 'Try a different title or author.' : 'Import an EPUB or PDF to get started.';
    drawIcons();
  }

  async function refresh() {
    snapshot = await api('/api/library');
    message('#library-error');
    render();
    return snapshot;
  }

  function chooseCategory(id) {
    category = id;
    search.value = '';
    render();
  }

  function stageFile(file) {
    selectedFile = file;
    $('#file-label').textContent = selectedFile?.name || 'Choose an EPUB or PDF';
    if (!file) return message('#book-error');
    if (!/\.(epub|pdf)$/iu.test(file.name)) {
      selectedFile = undefined;
      return message('#book-error', 'Choose an EPUB or PDF.');
    }
    if (file.size > snapshot.maxUpload) {
      selectedFile = undefined;
      return message('#book-error', `Books must be ${snapshot.maxUpload / 1024 ** 2} MiB or smaller.`);
    }
    message('#book-error');
  }

  function showBook(book) {
    editingBook = book;
    bookForm.reset();
    stageFile();
    const isEdit = Boolean(book);
    $('#book-dialog-title').textContent = isEdit ? 'Book details' : 'Import book';
    $('#book-submit').textContent = isEdit ? 'Save book' : 'Import book';
    $('#remove-book').hidden = !isEdit;
    $('#file-field').hidden = isEdit;
    $('#file-limit').textContent = `Maximum ${snapshot.maxUpload / 1024 ** 2} MiB`;
    const choices = [new Option('Uncategorized', ''), ...snapshot.categories.map(({ id, name }) => new Option(name, id))];
    $('#book-categories').replaceChildren(...choices);
    const fields = bookForm.elements;
    fields.title.value = book?.title ?? '';
    fields.title.required = isEdit;
    fields.author.value = book?.author ?? '';
    fields.language.value = book?.language ?? '';
    fields.language.required = isEdit;
    $('#book-language-note').hidden = isEdit;
    fields.categoryId.value = book?.categoryId ?? (['all', 'uncategorized'].includes(category) ? '' : category);
    bookDialog.showModal();
  }

  function showCategory(existing) {
    editingCategory = existing;
    $('#category-dialog-title').textContent = existing ? 'Edit category' : 'New category';
    $('#remove-category').hidden = !existing;
    categoryForm.elements.name.value = existing?.name ?? '';
    message('#category-error');
    categoryDialog.showModal();
    categoryForm.elements.name.focus();
  }

  $('#add-category').addEventListener('click', () => showCategory());
  $('#all-books').addEventListener('click', () => chooseCategory('all'));
  $('#import-book').addEventListener('click', () => showBook());
  search.addEventListener('input', render);
  $('#book-file').addEventListener('change', (event) => stageFile(event.target.files[0]));
  $('#file-field').addEventListener('dragover', (event) => {
    event.preventDefault();
    event.currentTarget.classList.add('dragging');
  });
  $('#file-field').addEventListener('dragleave', (event) => event.currentTarget.classList.remove('dragging'));
  $('#file-field').addEventListener('drop', (event) => {
    event.preventDefault();
    event.currentTarget.classList.remove('dragging');
    if (event.dataTransfer.files.length !== 1) return message('#book-error', 'Drop one book at a time.');
    stageFile(event.dataTransfer.files[0]);
  });

  bookForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (bookPending) return;
    const data = new FormData(bookForm);
    const rawLanguage = String(data.get('language') ?? '').trim();
    const language = parseLanguage(rawLanguage);
    if (rawLanguage && !language) return message('#book-error', 'Choose a language or enter a valid language code.');
    data.set('language', language);
    if (!editingBook && !selectedFile) return message('#book-error', 'Choose an EPUB or PDF within the upload limit.');
    bookPending = true;
    $('#book-submit').disabled = true;
    $('#book-submit').textContent = editingBook ? 'Saving…' : 'Importing…';
    message('#book-error');
    try {
      if (editingBook) {
        data.delete('file');
        await api(`/api/books/${editingBook.id}`, { method: 'PATCH', body: Object.fromEntries(data) });
      } else {
        data.set('file', selectedFile);
        await api('/api/books', { method: 'POST', body: data });
      }
      bookDialog.close();
      toast(editingBook ? 'Book updated' : 'Book imported');
      await refresh();
    } catch (error) {
      message(bookDialog.open ? '#book-error' : '#library-error', error.message);
    } finally {
      bookPending = false;
      $('#book-submit').disabled = false;
      $('#book-submit').textContent = editingBook ? 'Save book' : 'Import book';
    }
  });

  $('#remove-book').addEventListener('click', async () => {
    if (bookPending || !editingBook || !window.confirm(`Remove “${editingBook.title}” from this library?`)) return;
    bookPending = true;
    try {
      await api(`/api/books/${editingBook.id}`, { method: 'DELETE' });
      onRemove(editingBook.id);
      bookDialog.close();
      await refresh();
      toast('Book removed');
    } catch (error) { message(bookDialog.open ? '#book-error' : '#library-error', error.message); }
    finally { bookPending = false; }
  });

  categoryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (categoryPending) return;
    categoryPending = true;
    try {
      const path = editingCategory ? `/api/categories/${editingCategory.id}` : '/api/categories';
      const saved = await api(path, { method: editingCategory ? 'PATCH' : 'POST', body: { name: categoryForm.elements.name.value } });
      categoryDialog.close();
      category = saved.id;
      search.value = '';
      await refresh();
      toast('Category saved');
    } catch (error) { message(categoryDialog.open ? '#category-error' : '#library-error', error.message); }
    finally { categoryPending = false; }
  });

  $('#remove-category').addEventListener('click', async () => {
    if (categoryPending || !editingCategory || !window.confirm(`Remove “${editingCategory.name}”? Its books will move to Uncategorized.`)) return;
    categoryPending = true;
    try {
      await api(`/api/categories/${editingCategory.id}`, { method: 'DELETE' });
      categoryDialog.close();
      await refresh();
      toast('Category removed');
    } catch (error) { message(categoryDialog.open ? '#category-error' : '#library-error', error.message); }
    finally { categoryPending = false; }
  });

  bookDialog.addEventListener('cancel', (event) => { if (bookPending) event.preventDefault(); });
  categoryDialog.addEventListener('cancel', (event) => { if (categoryPending) event.preventDefault(); });

  return { refresh, render, get state() { return snapshot; } };
}
