import { $, api, drawIcons, element, icon, message, toast } from './ui.js';
import { languageName } from './settings.js';
import { parseLanguage } from './languages.js';
import { refreshStorage, showStorage } from './storage.js';

export function libraryScreen({ progress, onRemove }) {
  const search = $('#search');
  const books = $('#books');
  const bookDialog = $('#book-dialog');
  const bookForm = $('#book-form');
  const categoryDialog = $('#category-dialog');
  const categoryForm = $('#category-form');
  const learningDialog = $('#learning-dialog');
  let learningBook, learningTimer, libraryTimer;
  let snapshot = { categories: [], books: [], maxUpload: 120 * 1024 ** 2, demo: false };
  let category = 'all', editingBook, editingCategory, selectedFile;
  let bookPending = false, categoryPending = false;
  let audioUploading = false;
  $('#refresh-storage').addEventListener('click', () => void refreshStorage());
  setInterval(() => {
    if (!document.hidden && !$('#library-screen').hidden) void refreshStorage();
  }, 60_000);
  const archiveWorking = (job) => job && ['queued', 'downloading', 'importing'].includes(job.state);
  function importProgress(job) {
    if (!job) return '';
    if (job.state === 'queued') return 'Requesting an Anna’s Archive download…';
    if (job.state === 'downloading') return `Downloading book · ${(job.bytes / 1024 ** 2).toFixed(1)} MiB${job.total ? ` / ${(job.total / 1024 ** 2).toFixed(1)} MiB` : ''}`;
    return job.state === 'importing' ? 'Adding book to your library…' : job.state === 'error' ? job.error : '';
  }

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
    const analysis = book.learning;
    const detail = element('div', 'book-learning');
    const count = analysis?.lemmaCount;
    const vocabulary = count == null ? '' : `${count.toLocaleString()} ${analysis.method === 'word forms' ? 'word forms' : 'lemmas'}`;
    const estimate = analysis?.reading?.band ? `Est. ${analysis.reading.band}` : '';
    detail.append(element('span', 'book-meta', [vocabulary, estimate].filter(Boolean).join(' · ')));
    const tools = element('button', 'button quiet small', 'Analysis & audio');
    tools.type = 'button';
    tools.setAttribute('aria-label', `Analysis and audio for ${book.title}`);
    tools.addEventListener('click', () => void showLearning(book));
    detail.append(tools);
    card.append(detail);
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
      (!$('#reading-filter').value || book.learning?.reading?.band === $('#reading-filter').value) &&
      (!filter || `${book.title} ${book.author}`.toLocaleLowerCase().includes(filter)));
    $('#book-count').textContent = `${visible.length} ${visible.length === 1 ? 'book' : 'books'}`;
    books.replaceChildren(...visible.map(bookCard));
    $('#empty-library').hidden = visible.length > 0;
    $('#empty-title').textContent = filter ? 'No matching books' : 'No books here yet';
    $('#empty-detail').textContent = filter ? 'Try a different title or author.' : 'Import an EPUB or PDF to get started.';
    drawIcons();
    message('#archive-import-status', importProgress(snapshot.archive?.job));
  }

  async function refresh() {
    snapshot = await api('/api/library');
    showStorage(snapshot.storage);
    message('#library-error');
    render();
    clearTimeout(libraryTimer);
    if (snapshot.books.some((book) => ['queued', 'running'].includes(book.learning?.state)
      || ['queued', 'running'].includes(book.learning?.reading?.state)) || archiveWorking(snapshot.archive?.job)) {
      libraryTimer = setTimeout(() => { if (!document.querySelector('dialog[open]')) void refresh(); }, archiveWorking(snapshot.archive?.job) ? 1200 : 4500);
    }
    return snapshot;
  }

  async function learningStatus() {
    if (!learningDialog.open || !learningBook) return;
    clearTimeout(learningTimer);
    const id = learningBook.id;
    try {
      const [result, uploaded] = await Promise.all([api(`/api/books/${id}/learning`), api(`/api/books/${id}/recordings`)]);
      if (learningBook?.id !== id || !learningDialog.open) return;
      const analysis = result.analysis;
      $('#upload-audio-form').hidden = !uploaded.available;
      $('#audio-upload-note').textContent = uploaded.available
        ? 'Upload MP3, M4A, M4B, OGG, WAV, FLAC or AAC, up to 1 GiB per file. Sync runs in the background. Recordings of the same edition give better matches.'
        : 'Upload and sync your own audiobooks on a self-hosted installation. This demo previews the reading controls.';
      $('#recordings-list').replaceChildren(...uploaded.recordings.map((recording) => {
        const item = element('div', 'recording-item');
        item.append(element('strong', '', recording.name), element('span', 'field-note', recording.state === 'ready'
          ? `Synced · ${recording.quality.textPercent}% of book words matched. Unmatched passages may differ or be omitted.`
          : ['queued', 'syncing'].includes(recording.state) ? `Syncing with book · ${Math.round(recording.progress * 100)}%`
            : recording.error || 'Uploaded · ready to sync'));
        const actions = element('div', 'button-row');
        const sync = element('button', 'button secondary small', recording.state === 'ready' ? 'Sync again' : 'Sync with book');
        sync.type = 'button'; sync.disabled = analysis.state !== 'ready' || ['queued', 'syncing'].includes(recording.state);
        sync.addEventListener('click', async () => {
          sync.disabled = true; message('#recording-error');
          try { await api(`/api/books/${id}/recordings/${recording.id}/sync`, { method: 'POST', body: {} }); await learningStatus(); }
          catch (error) { message('#recording-error', error.message); sync.disabled = false; }
        });
        const download = element('a', 'button quiet small', 'Download original');
        download.href = recording.downloadUrl; download.download = recording.name;
        const remove = element('button', 'button quiet small', 'Remove recording'); remove.type = 'button';
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try { await api(`/api/books/${id}/recordings/${recording.id}`, { method: 'DELETE' }); await learningStatus(); }
          catch (error) { message('#recording-error', error.message); remove.disabled = false; }
        });
        actions.append(sync, download, remove); item.append(actions);
        return item;
      }));
      $('#learning-stats').textContent = analysis.lemmaCount == null ? `Analysis ${analysis.state}…`
        : `${analysis.lemmaCount.toLocaleString()} ${analysis.method === 'word forms' ? 'word forms' : 'unique lemmas'} · ${analysis.wordCount.toLocaleString()} words`;
      $('#learning-estimate').textContent = analysis.reading?.band
        ? `Estimated ACTFL reading demand · ${analysis.reading.band}`
        : analysis.reading?.state === 'error' ? 'Reading estimate unavailable.'
          : analysis.reading?.state === 'ready' ? 'Reading estimate unavailable for this text.' : 'Estimating reading demand…';
      $('#learning-reason').textContent = analysis.reading?.text || '';
      const evidence = analysis.reading?.evidence ?? [];
      $('#learning-evidence').hidden = !evidence.length;
      $('#learning-quotes').replaceChildren(
        element('p', 'field-note', `${analysis.reading?.sampledPassages || 0} excerpts across ${analysis.reading?.sampledSections || 0} of ${analysis.reading?.totalSections || 0} sections.`),
        ...evidence.map((quote) => element('blockquote', '', quote)),
      );
      $('#generate-book-audio').disabled = analysis.state !== 'ready' || !result.chapters.some((chapter) => chapter.narratable);
      const audio = result.narration.audio;
      const working = ['queued', 'assembling'].includes(audio.state);
      $('#generate-book-audio').disabled ||= working;
      $('#cancel-book-audio').hidden = !working;
      $('#book-audio-status').textContent = audio.state === 'ready' ? audio.approximateSections
        ? `Complete book recording ready. Page timing is approximate in ${audio.approximateSections} sections; estimated words are not highlighted.`
        : 'Complete book recording ready. Chapter markers are included.'
        : audio.state === 'queued' ? `Generating book audio · ${audio.complete} / ${audio.total} sections`
          : audio.state === 'assembling' ? 'Finishing the complete book recording…'
            : audio.state === 'cancelled' ? 'Generation cancelled. Completed work can be reused.' : '';
      const download = $('#book-audio-download');
      download.hidden = audio.state !== 'ready';
      if (audio.state === 'ready') { download.href = audio.url; download.download = learningBook.title + '.mp3'; }
      message('#learning-error', analysis.error || audio.error || analysis.reading?.error);
      const rows = result.chapters.map((chapter) => {
        const row = element('div', 'learning-chapter');
        const metadata = element('div');
        const availability = chapter.narratable ? '' : chapter.characters ? 'Above demo narration limit' : 'No selectable text';
        const count = chapter.lemmaCount == null ? '' : `${availability ? ' · ' : ''}${chapter.lemmaCount} lemmas`;
        metadata.append(element('strong', '', chapter.title), element('span', 'book-meta', availability + count));
        row.append(metadata);
        return row;
      });
      $('#learning-chapters').replaceChildren(...rows);
      if (['queued', 'running'].includes(analysis.state) || ['queued', 'running'].includes(analysis.reading?.state)
        || working || uploaded.recordings.some((recording) => ['queued', 'syncing'].includes(recording.state))) {
        learningTimer = setTimeout(() => void learningStatus(), 2200);
      }
    } catch (error) { message('#learning-error', error.message); }
  }

  async function showLearning(book) {
    learningBook = book;
    $('#learning-title').textContent = book.title;
    $('#learning-stats').textContent = 'Loading analysis…';
    $('#learning-estimate').textContent = '';
    $('#learning-reason').textContent = '';
    $('#learning-chapters').replaceChildren();
    $('#replace-book-audio').checked = false;
    message('#learning-error');
    learningDialog.showModal();
    await learningStatus();
  }

  $('#analyze-book').addEventListener('click', async () => {
    if (!learningBook) return;
    try {
      await api(`/api/books/${learningBook.id}/learning`, { method: 'POST', body: {} });
      void learningStatus();
    } catch (error) { message('#learning-error', error.message); }
  });
  $('#generate-book-audio').addEventListener('click', async (event) => {
    if (!learningBook) return;
    event.target.disabled = true;
    try {
      await api(`/api/books/${learningBook.id}/narration`, {
        method: 'POST', body: { replace: $('#replace-book-audio').checked },
      });
      void learningStatus();
    } catch (error) {
      message('#learning-error', error.message);
      event.target.disabled = false;
    }
  });
  learningDialog.addEventListener('close', () => {
    clearTimeout(learningTimer);
    learningBook = undefined;
    void refresh();
  });
  $('#upload-audio-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (audioUploading || !learningBook) return;
    const form = event.currentTarget, file = form.elements.file.files[0];
    if (!file || file.size > 1024 ** 3) return message('#recording-error', 'Choose an audiobook of 1 GiB or smaller.');
    const id = learningBook.id;
    audioUploading = true; $('#upload-audio').disabled = true; $('#upload-audio').textContent = 'Uploading…';
    message('#recording-error');
    try {
      await api(`/api/books/${id}/recordings`, { method: 'POST', body: new FormData(form) });
      form.reset(); toast('Recording uploaded. Choose Sync with book to align it.');
      if (learningBook?.id === id) await learningStatus();
    } catch (error) { message('#recording-error', error.message); }
    finally { audioUploading = false; $('#upload-audio').disabled = false; $('#upload-audio').textContent = 'Upload recording'; }
  });
  $('#cancel-book-audio').addEventListener('click', async () => {
    if (!learningBook) return;
    try {
      await api(`/api/books/${learningBook.id}/narration`, { method: 'DELETE' });
      void learningStatus();
    } catch (error) { message('#learning-error', error.message); }
  });

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
    if (bookPending) { if (!bookDialog.open) bookDialog.showModal(); return; }
    editingBook = book;
    bookForm.reset();
    stageFile();
    const isEdit = Boolean(book);
    $('#book-dialog-title').textContent = isEdit ? 'Book details' : 'Import book';
    $('#book-submit').textContent = isEdit ? 'Save book' : 'Import book';
    $('#remove-book').hidden = !isEdit;
    $('#file-field').hidden = isEdit;
    $('#import-source-field').hidden = isEdit;
    $('#book-source option[value="anna"]').disabled = !snapshot.archive?.available;
    $('#book-source option[value="anna"]').textContent = snapshot.archive?.available ? 'Anna’s Archive' : 'Anna’s Archive (self-hosted)';
    $('#archive-book-fields').hidden = true;
    message('#book-import-progress');
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
  $('#book-source').addEventListener('change', () => {
    const archive = $('#book-source').value === 'anna';
    $('#file-field').hidden = archive;
    $('#archive-book-fields').hidden = !archive;
    message('#book-error');
  });
  $('#configure-archive').addEventListener('click', () => bookDialog.close());
  search.addEventListener('input', render);
  $('#reading-filter').addEventListener('change', render);
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
    const archiveImport = !editingBook && $('#book-source').value === 'anna';
    const reference = bookForm.elements.archiveReference.value.trim();
    data.delete('source');
    data.delete('archiveReference');
    if (archiveImport && !reference) return message('#book-error', 'Paste an Anna’s Archive book link or MD5.');
    if (!editingBook && !archiveImport && !selectedFile) return message('#book-error', 'Choose an EPUB or PDF within the upload limit.');
    bookPending = true;
    $('#book-submit').disabled = true;
    $('#book-submit').textContent = editingBook ? 'Saving…' : 'Importing…';
    message('#book-error');
    try {
      if (editingBook) {
        data.delete('file');
        await api(`/api/books/${editingBook.id}`, { method: 'PATCH', body: Object.fromEntries(data) });
      } else if (archiveImport) {
        data.delete('file');
        let job = await api('/api/imports/anna', { method: 'POST', body: { ...Object.fromEntries(data), reference } });
        while (archiveWorking(job)) {
          message('#book-import-progress', importProgress(job));
          message('#archive-import-status', importProgress(job));
          await new Promise((resolve) => setTimeout(resolve, 1000));
          job = await api(`/api/imports/anna/${job.id}`);
        }
        if (job.state !== 'ready') throw new Error(job.error || 'The book could not be imported.');
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
      message('#book-import-progress');
      message('#archive-import-status');
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

  bookDialog.addEventListener('cancel', (event) => { if (bookPending && $('#book-source').value !== 'anna') event.preventDefault(); });
  categoryDialog.addEventListener('cancel', (event) => { if (categoryPending) event.preventDefault(); });

  return { refresh, render, get state() { return snapshot; } };
}
