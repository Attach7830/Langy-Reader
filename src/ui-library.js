import { importExtensions, importAccept, fileExtension, convertsToEPUB, conversionLimit } from '../shared/import-formats.js';
import { $, api, bookFormatLabel, drawIcons, element, icon, message, toast } from './ui.js';
import { languageName } from './settings.js';
import { parseLanguage } from './languages.js';
import { refreshStorage, showStorage } from './storage.js';
import { audioTools, audioChanged } from './ui-audio-tools.js';
import { bookLanguagePicker } from './book-languages.js';
import { bookSharing } from './book-sharing.js';
import { vocabularyLibrary, unfamiliarLabel, recommendationRows, bookCountLabel } from './ui-vocabulary.js';
import { bookVocabulary } from './ui-book-vocabulary.js';
import { bookMetadataFields } from './book-metadata-fields.js';
import { compareLibraryBooks } from '../shared/library-order.js';
import { bookCover, bookCoverPicker } from './book-covers.js';
import { archiveBulk } from './archive-bulk.js';
import { archiveTitleActions } from './archive-title-controls.js';
import { pdfOCR } from './pdf-ocr.js';
import { reviewPdfText } from './pdf-review.js';
import { adjustPdfTiming } from './pdf-timing.js';
import { bookLanguageSuggestions } from './reading-languages.js';
import { showReadingTime } from './ui-reading-time.js';
import { audiobookshelfBook } from './audiobookshelf-ui.js';
import { coverSearch } from './cover-search.js';
import { folderAudiobookshelf } from './folder-audiobookshelf.js';
import { offlineDownloads } from './offline-downloads.js';
import { downloadedBooks } from './book-source.js';
import { androidApp, watchAppCapability } from './platform.js';
import { processTasks } from './process-tasks.js';
import { seriesKey, seriesLabel } from '../shared/book-series.js';

const vocabularyLabel = (vocabulary) => vocabulary?.byLanguage?.map((item) => `${item.count.toLocaleString()} ${item.language === 'zh' ? 'Mandarin Han characters' : `${languageName(item.language)} ${item.unit}`}`).join(' · ');
const wordCountLabel = (analysis) => bookCountLabel(analysis?.counts)
  || (['missing', 'error'].includes(analysis?.counting?.state) ? 'Word count unavailable' : 'Counting words…');

export function libraryScreen({ progress, onRemove, detectMetadata, safeMode = false, readingLanguages = () => null, onSnapshot = () => {}, preferences = () => ({ quietLibrary: true }), changePreferences = () => {} }) {
  const surface = window;
  const search = $('#search');
  const books = $('#books');
  const bookDialog = $('#book-dialog');
  const bookForm = $('#book-form');
  const coverSearchUI=coverSearch(bookForm);
  const coverPicker = bookCoverPicker(bookForm, $('#book-cover-options'));
  const bulkImport = archiveBulk(bookForm);
  const ocr = pdfOCR({ changed: refresh, readingLanguages });
  const languagePicker = bookLanguagePicker(bookForm);
  const sharing = bookSharing(bookForm);
  const vocabularyUI = vocabularyLibrary({ changed: refresh });
  const bookVocabularyUI = bookVocabulary();
  const categoryDialog = $('#category-dialog');
  const categoryForm = $('#category-form');
  const folderABS = folderAudiobookshelf();
  $('#category-dialog').addEventListener('close', () => folderABS.cancel());
  const learningDialog = $('#learning-dialog');
  const pdfReview = reviewPdfText({ saved(book) {
    toast('PDF review saved.');
    void showLearning(book);
  } });
  const pdfTiming = adjustPdfTiming({ saved(book) {
    audioChanged(book.id); toast('Page timing saved.');
    void showLearning(book);
  } });
  let learningBook, learningTimer, libraryTimer, learningVisit = 0, libraryVisit = 0, learningParts = {}, learningPending = {};
  let snapshot = { categories: [], books: [], maxUpload: 120 * 1024 ** 2, demo: false };
  const editablePdf = (book) => !snapshot.demo && book?.format === 'pdf' && book.canEdit !== false;
  let category = 'all', editingBook, editingCategory, selectedFile, slowImport, downloadExpiry;
  const completedImports = new Map();
  let bookPending = false, categoryPending = false, bookVisit = 0;
  const metadataFields = bookMetadataFields({ form: bookForm, status: $('#book-metadata-status'), detect: detectMetadata,
    active: () => !editingBook && bookDialog.open && $('#book-source').value === 'file' });
  const pendingReadStatus = new Set();
  const pendingStars = new Set();
  const pendingAside = new Set();
  let audioUploading = false;
  let expandedDetails = new Set();
  const audioUI = audioTools({ book: () => learningBook, refresh: learningStatus });
  const absBook = audiobookshelfBook({ book: () => learningBook, changed: learningStatus });
  const offline = offlineDownloads();
  let downloaded = new Set(), downloadScan = 0, disposed = false;
  async function refreshDownloaded() {
    const version = ++downloadScan, next = androidApp() ? await downloadedBooks() : new Set();
    if (disposed || version !== downloadScan) return;
    const changed = next.size !== downloaded.size || [...next].some((id) => !downloaded.has(id)); downloaded = next;
    if (changed) render();
  }
  const openProcess = (event) => {
    const job = event.detail, book = snapshot.books.find((item) => item.id === job?.bookId);
    if (book) { location.hash = '#library'; if (job.kind === 'ocr') void ocr.show(book); else if (job.kind === 'cover') showBook(book); else void showLearning(book); }
    else if (job?.kind === 'archive') { location.hash = '#library'; const panel = $('#archive-downloads'); panel.open = true; panel.scrollIntoView?.({ block: 'center' }); }
  };
  surface.addEventListener('langy-open-process', openProcess);
  const libraryChanged = () => { if (!disposed) void refresh().catch((error) => message('#library-error', error.message)); };
  surface.addEventListener('langy-library-changed', libraryChanged);
  surface.addEventListener('langy-audio-updated', libraryChanged);
  surface.addEventListener('langy-packs-changed', refreshDownloaded); surface.addEventListener('langy-offline-account', refreshDownloaded);
  const unwatchApp = watchAppCapability(() => { render(); void refreshDownloaded(); });
  void refreshDownloaded();
  $('#show-shared-books').addEventListener('change', (event) => { changePreferences({ showSharedBooks: event.target.checked }); render(); });
  $('#book-format-filter').addEventListener('change', (event) => { changePreferences({ libraryFormat: event.target.value }); render(); });
  $('#book-series-filter').addEventListener('change', (event) => { if (event.target.value.startsWith('series:')) $('#book-sort').value = 'series'; render(); });
  $('#refresh-storage').addEventListener('click', () => void refreshStorage());
  const storageTimer = !safeMode && setInterval(() => {
    if (!document.hidden && !$('#library-screen').hidden) void refreshStorage();
  }, 60_000);
  const archiveWorking = (job) => job && ['queued', 'downloading', 'importing'].includes(job.state);
  function importProgress(job) {
    if (!job) return '';
    if (job.state === 'retry_wait') return `${job.error || 'Download unavailable.'} Next attempt: ${new Date(job.nextAttempt).toLocaleString()}.`;
    if (job.state === 'needs_action') return job.error || job.notice || 'Continue this book’s free slow download.';
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
    card.dataset.book = book.id;
    const link = element('a');
    link.href = `#read/${encodeURIComponent(book.id)}`;
    const saved = progress[book.id]?.syncDirty || !snapshot.progress?.[book.id]
      ? progress[book.id] : { ...progress[book.id], percent: snapshot.progress[book.id].percentage };
    link.setAttribute('aria-label', `${saved ? 'Resume' : 'Read'} ${book.title}`);
    const cover = bookCover(book);
    const info = element('div', 'book-info');
    const meta = [book.author, languageName(book.language)].filter(Boolean).join(' · ');
    info.append(element('span', 'book-format', bookFormatLabel(book)), element('span', 'book-title', book.title), element('span', 'book-meta', meta));
    if (book.series) info.append(element('span', 'book-meta book-series', seriesLabel(book)));
    const actions = element('div', 'book-reading-actions');
    if (book.sharedWithMe) actions.append(element('span', 'book-read-badge shared-book-badge', 'Shared with you'));
    else if (book.shared || book.shareWith?.length) actions.append(element('span', 'book-read-badge shared-book-badge', 'Shared'));
    if (book.starredAt) actions.append(element('span', 'book-read-badge', 'Currently reading'));
    if (book.setAsideAt) actions.append(element('span', 'book-read-badge', 'Set aside'));
    if (saved && book.starredAt) actions.append(element('span', 'button secondary small book-resume-label', 'Resume'));
    if (book.readAt) {
      const badge = element('span', 'book-read-badge', 'Read');
      badge.title = `Marked as read on ${new Date(book.readAt).toLocaleDateString()}`;
      actions.append(badge);
    }
    if (actions.childElementCount) info.append(actions);
    link.append(cover, info);
    if (saved) {
      const track = element('span', 'progress-track');
      const fill = element('span');
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, saved.percent || 0)) * 100)}%`;
      track.append(fill);
      track.setAttribute('aria-hidden', 'true');
      info.append(track);
    }
    card.append(link);
    const star = element('button', 'icon-button book-star');
    star.type = 'button';
    star.title = book.starredAt ? 'Remove from Currently reading' : 'Mark as Currently reading';
    star.setAttribute('aria-label', `${star.title}: ${book.title}`);
    star.setAttribute('aria-pressed', String(Boolean(book.starredAt)));
    star.disabled = pendingStars.has(book.id);
    star.append(icon('star'));
    star.addEventListener('click', async () => {
      if (pendingStars.has(book.id) || pendingAside.has(book.id)) return;
      pendingStars.add(book.id); star.disabled = true;
      try {
        const result = await api(`/api/books/${encodeURIComponent(book.id)}/currently-reading`, { method: 'PATCH', body: { currentlyReading: !book.starredAt } });
        const current = snapshot.books.find((item) => item.id === book.id);
        if (current) Object.assign(current, { starredAt: result.starredAt, setAsideAt: result.setAsideAt });
        toast(result.starredAt ? 'Pinned to Currently reading' : 'Removed from Currently reading');
        render();
      } catch (error) { message('#library-error', error.message); }
      finally { pendingStars.delete(book.id); render(); }
    });
    card.append(star);
    if (downloaded.has(book.id)) card.append(element('span', 'book-download-badge', 'Downloaded'));
    if (book.audioSynced) {
      const badge = element('span', 'book-read-badge book-audio-badge'); badge.title = 'Audio is ready for synchronized reading.';
      badge.append(icon('headphones'), element('span', '', 'Audio synced')); card.append(badge);
    }
    const analysis = book.learning;
    const detail = element('details', 'book-learning'); detail.open = expandedDetails.has(book.id);
    detail.append(element('summary', '', 'Book options'));
    const readingDetails = element('div', 'book-reading-details'); readingDetails.hidden = preferences().quietLibrary !== false;
    const wordCount = element('span', 'book-meta book-word-count', wordCountLabel(analysis));
    wordCount.title = analysis?.counting?.error || '';
    readingDetails.append(wordCount);
    const count = analysis?.vocabulary?.count ?? analysis?.lemmaCount;
    const vocabulary = analysis?.nativeExcluded ? 'L1 vocabulary excluded' : vocabularyLabel(analysis?.vocabulary) || (count == null ? '' : `${count.toLocaleString()} ${analysis.vocabulary?.unit === 'characters' ? 'Han characters' : analysis.method === 'word forms' ? 'word forms' : 'lemmas'}`);
    const estimate = analysis?.reading?.band ? `Est. ${analysis.reading.band}` : '';
    readingDetails.append(element('span', 'book-meta', [vocabulary, estimate].filter(Boolean).join(' · ')));
    if (book.familiarity) {
      const belowThreshold = $('#book-sort').value === 'known';
      readingDetails.append(element('span', 'book-meta', (belowThreshold ? 'Below threshold: ' : 'Not yet seen: ') + unfamiliarLabel(book.familiarity, belowThreshold)));
    }
    card.append(readingDetails);
    if (book.epubRevision) {
      const openEpub = element('button', 'button quiet small', 'Read simplified EPUB');
      openEpub.type = 'button';
      openEpub.addEventListener('click', () => { location.hash = `#read/${encodeURIComponent(book.id)}/epub`; });
      detail.append(openEpub);
    }
    if (!safeMode) {
      const tools = element('button', 'button quiet small', 'Analysis & audio');
      tools.type = 'button';
      tools.setAttribute('aria-label', `Analysis and audio for ${book.title}`);
      tools.addEventListener('click', () => void showLearning(book));
      detail.append(tools);
    }
    if (!safeMode && androidApp()) {
      const download = element('button', 'button quiet small', 'Save offline'); download.type = 'button';
      download.addEventListener('click', () => void offline.open(book)); detail.append(download);
    }
    if (!safeMode && book.format === 'pdf' && !snapshot.demo) {
      const scan = element('button', 'button quiet small', 'Scan PDF with OCR'); scan.type = 'button';
      scan.setAttribute('aria-label', `Scan ${book.title} with OCR`); scan.addEventListener('click', () => ocr.show(book)); detail.append(scan);
    }
    const readToggle = element('button', 'button quiet small book-read-toggle', book.readAt ? 'Mark as unread' : 'Mark as read');
    readToggle.type = 'button';
    readToggle.setAttribute('aria-label', `Mark ${book.title} as ${book.readAt ? 'unread' : 'read'}`);
    readToggle.setAttribute('aria-pressed', String(Boolean(book.readAt)));
    readToggle.disabled = pendingReadStatus.has(book.id);
    readToggle.addEventListener('click', async () => {
      if (pendingReadStatus.has(book.id)) return;
      pendingReadStatus.add(book.id); readToggle.disabled = true;
      try {
        const result = await api(`/api/books/${encodeURIComponent(book.id)}/read-status`, { method: 'PATCH', body: { read: !book.readAt } });
        const current = snapshot.books.find((item) => item.id === book.id);
        if (current) current.readAt = result.readAt;
        toast(result.readAt ? 'Book marked as read' : 'Book marked as unread');
        await refresh();
      } catch (error) { message('#library-error', error.message); }
      finally { pendingReadStatus.delete(book.id); render(); }
    });
    detail.append(readToggle);
    const aside = element('button', 'button quiet small', book.setAsideAt ? 'Return to shelf' : 'Set aside'); aside.type = 'button'; aside.disabled = pendingAside.has(book.id);
    aside.addEventListener('click', async () => {
      if (pendingAside.has(book.id) || pendingStars.has(book.id)) return; pendingAside.add(book.id); aside.disabled = true;
      try {
        const result = await api(`/api/books/${book.id}/set-aside`, { method: 'PATCH', body: { setAside: !book.setAsideAt } });
        Object.assign(book, result); toast(result.setAsideAt ? 'Book set aside. You can find it with the Set aside filter.' : 'Book returned to shelf');
      } catch (error) { message('#library-error', error.message); }
      finally { pendingAside.delete(book.id); render(); }
    }); detail.append(aside);
    card.append(detail);
    const edit = book.canEdit !== false && (!snapshot.demo || book.id !== 'sample') ? editButton(`Edit ${book.title}`, () => showBook(book), 'book-edit') : null;
    if (edit) card.append(edit);
    const mobileActions = element('button', 'icon-button book-mobile-menu', '•••'); mobileActions.type = 'button'; mobileActions.setAttribute('aria-label', `Book options for ${book.title}`);
    mobileActions.addEventListener('click', () => {
      const dialog = $('#book-actions-dialog'), content = $('#book-actions-body'); $('#book-actions-title').textContent = book.title;
      const open = element('a', 'button primary', book.epubRevision ? 'Read PDF' : saved ? 'Resume reading' : 'Read book');
      open.href = link.href; open.addEventListener('click', () => dialog.close());
      const buttons = [...detail.querySelectorAll('button'), ...(edit ? [edit] : [])].map((source) => {
        const button = element('button', 'button secondary', source === edit ? 'Edit book details' : source.textContent); button.type = 'button'; button.disabled = source.disabled;
        button.addEventListener('click', () => { dialog.close(); source.click(); }); return button;
      }); content.replaceChildren(open, ...buttons); dialog.showModal();
    }); card.append(mobileActions);
    return card;
  }

  function render() {
    const libraryBooks = snapshot.books.filter((book) => preferences().showSharedBooks !== false || !book.sharedWithMe);
    const seriesNames = new Map();
    for (const book of libraryBooks) if (book.series) seriesNames.set(seriesKey(book.series), book.series);
    const series = [...seriesNames].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })), selectedSeries = $('#book-series-filter').value;
    $('#book-series-filter').replaceChildren(new Option('All series', ''), new Option('No series', 'none'), ...series.map(([key, name]) => new Option(name, 'series:' + key)));
    $('#book-series-filter').value = selectedSeries === 'none' || seriesNames.has(selectedSeries.slice(7)) ? selectedSeries : '';
    $('#book-series-options').replaceChildren(...series.map(([, name]) => new Option(name, name)));
    $('#shared-books-control').hidden = !snapshot.sharingAvailable;
    $('#show-shared-books').checked = preferences().showSharedBooks !== false;
    $('#book-format-filter').value = preferences().libraryFormat || '';
    const quiet = preferences().quietLibrary !== false;
    books.dataset.layout = preferences().libraryLayout || 'auto'; books.dataset.coversOnly = String(Boolean(preferences().coversOnly));
    $('#library-layout').value = books.dataset.layout; $('#library-covers-only').checked = Boolean(preferences().coversOnly);
    const uncategorized = libraryBooks.filter((book) => !book.categoryId).length;
    if (category === 'uncategorized' && !uncategorized) category = 'all';
    expandedDetails = new Set([...books.querySelectorAll('.book-card details[open]')].map((detail) => detail.closest('.book-card').dataset.book));
    books.dataset.quiet = String(quiet);
    $('#library-details-toggle').textContent = quiet ? 'Show reading details' : 'Hide reading details';
    $('#library-details-toggle').setAttribute('aria-pressed', String(!quiet));
    const current = snapshot.categories.find(({ id }) => id === category);
    if (!current && !['all', 'uncategorized'].includes(category)) category = 'all';
    $('#all-books').setAttribute('aria-current', String(category === 'all'));
    $('#all-count').textContent = String(libraryBooks.length);
    $('#library-title').textContent = current?.name || (category === 'uncategorized' ? 'Uncategorized' : 'Your library');
    $('#library-description').textContent = category === 'all'
      ? 'Choose a book to read.'
      : current?.language ? `${languageName(current.language)} folder · Books added here inherit this language.` : current ? 'Books in this category.' : 'Books without a category.';
    if (current?.l1Folder) $('#library-description').textContent += ' L1 Folder · Comprehension assistance is off.';
    $('#mobile-category').replaceChildren(new Option('All books', 'all'), ...snapshot.categories.map((entry) => new Option(entry.name, entry.id)), ...(uncategorized ? [new Option('Uncategorized', 'uncategorized')] : []));
    $('#mobile-category').value = category; $('#mobile-edit-category').disabled = !current || snapshot.demo && current.id === 'spanish';
    $('#mobile-about-link').hidden = false;
    $('#demo-note').hidden = !snapshot.demo;
    const categoryRows = snapshot.categories.map((entry) => {
      const row = element('div', 'category-row');
      const button = categoryButton(entry.id, entry.name, libraryBooks.filter((book) => book.categoryId === entry.id).length, 'folder');
      if (entry.language) button.title = `${languageName(entry.language)} language folder`;
      row.append(button);
      if (!safeMode && (!snapshot.demo || entry.id !== 'spanish')) row.append(editButton(`Edit category ${entry.name}`, () => showCategory(entry)));
      return row;
    });
    $('#categories').replaceChildren(...categoryRows, ...(uncategorized ? [categoryButton('uncategorized', 'Uncategorized', uncategorized, 'folder')] : []));
    const filter = search.value.trim().toLocaleLowerCase();
    const visible = libraryBooks.filter((book) =>
      (category === 'all' || (book.categoryId ?? 'uncategorized') === category) &&
      (!$('#book-format-filter').value || book.format === $('#book-format-filter').value) &&
      (!$('#book-series-filter').value || ($('#book-series-filter').value === 'none' ? !book.series : 'series:' + seriesKey(book.series) === $('#book-series-filter').value)) &&
      (!$('#reading-filter').value || book.learning?.reading?.band === $('#reading-filter').value) &&
      (!$('#book-status-filter').value || $('#book-status-filter').value === 'shelf' && !book.setAsideAt || $('#book-status-filter').value === 'set-aside' && book.setAsideAt
        || ['read', 'unread'].includes($('#book-status-filter').value) && Boolean(book.readAt) === ($('#book-status-filter').value === 'read')) &&
      (!filter || `${book.title} ${book.author} ${book.series || ''}`.toLocaleLowerCase().includes(filter)));
    $('#book-count').textContent = `${visible.length} ${visible.length === 1 ? 'book' : 'books'}`;
    visible.sort((a, b) => compareLibraryBooks(a, b, $('#book-sort').value));
    books.replaceChildren(...visible.map(bookCard));
    $('#empty-library').hidden = visible.length > 0;
    const filtering = filter || $('#book-format-filter').value || $('#book-series-filter').value || $('#reading-filter').value || !['', 'shelf'].includes($('#book-status-filter').value);
    $('#empty-title').textContent = filtering ? 'No matching books' : 'No books here yet';
    $('#empty-detail').textContent = filtering ? 'Try a different search or filter.' : safeMode ? 'Ask an administrator to share a book with you.' : 'Import a book or document to get started.';
    drawIcons();
    renderDownloads(snapshot.archive?.jobs || []);
  }

  async function refresh({ signal, onProgress } = {}) {
    const version = ++libraryVisit, next = await api('/api/library', { signal, onProgress }); signal?.throwIfAborted(); if (disposed || version !== libraryVisit) return snapshot;
    snapshot = next;
    onSnapshot(snapshot);
    showReadingTime(snapshot.readingTime);
    vocabularyUI.update(snapshot.vocabulary);
    if (!safeMode) showStorage(snapshot.storage);
    message('#library-error');
    onProgress?.({ label: 'Preparing your library…', complete: next.books.length, total: next.books.length });
    render();
    clearTimeout(libraryTimer);
    if (snapshot.books.some((book) => ['queued', 'running'].includes(book.learning?.state)
      || ['queued', 'running'].includes(book.learning?.counting?.state)
      || ['queued', 'running'].includes(book.learning?.reading?.state)) || archiveWorking(snapshot.archive?.job) || snapshot.archive?.jobs?.some((job) => job.titlePending) || snapshot.imports?.some((job)=>['queued','downloading','importing'].includes(job.state))) {
      libraryTimer = setTimeout(() => { if (!document.querySelector('dialog[open]')) void refresh(); }, archiveWorking(snapshot.archive?.job) || snapshot.archive?.jobs?.some((job) => job.titlePending) ? 1200 : 4500);
    } else if (snapshot.archive?.jobs?.some((job) => ['retry_wait', 'needs_action'].includes(job.state))) {
      libraryTimer = setTimeout(() => { if (!document.querySelector('dialog[open]')) void refresh(); }, 60_000);
    }
    return snapshot;
  }

  function renderLearning(id) {
    const result = learningParts.result || { analysis: { state: 'loading' }, chapters: [], narration: { audio: { state: 'loading' } } };
    const epub = $('#open-reviewed-epub');
    epub.hidden = !result.epubRevision;
    if (result.epubRevision) epub.href = `#read/${encodeURIComponent(id)}/epub`;
    const listEntry = snapshot.books.find((book) => book.id === id);
    if (listEntry && result.epubRevision !== undefined && listEntry.epubRevision !== result.epubRevision) {
      listEntry.epubRevision = result.epubRevision;
      render();
    }
    const uploaded = learningParts.uploaded || { available: false, recordings: [] }, imported = learningParts.imported || { job: null };
      const analysis = result.analysis;
      $('#find-similar-books').disabled = analysis.state !== 'ready';
      $('#open-book-vocabulary').disabled = analysis.state !== 'ready';
      $('#upload-audio-form').hidden = !uploaded.available;
      $('#audio-upload-note').textContent = uploaded.available
        ? 'Upload a complete audiobook or up to 200 chapter files, totalling 1 GiB and at most 72 hours per recording. Files are sorted by name; adjust their order below before upload. Preparation and sync run in the background.'
        : 'Upload and sync your own audiobooks on a self-hosted installation. This demo previews the reading controls.';
      $('#recordings-list').replaceChildren(...uploaded.recordings.map((recording) => {
        const item = element('div', 'recording-item');
        item.append(element('strong', '', recording.name), element('span', 'field-note', recording.state === 'ready'
          ? `Synced · ${recording.quality.textPercent}% of book words matched. Unmatched passages may differ or be omitted.`
          : recording.state === 'assembling' ? `Preparing chapter files · ${Math.round(recording.progress * 100)}%`
            : ['queued', 'syncing'].includes(recording.state) ? `Syncing with book · ${Math.round(recording.progress * 100)}%`
            : recording.error || 'Uploaded · ready to sync'));
        const actions = element('div', 'button-row');
        const sync = element('button', 'button secondary small', recording.state === 'ready' ? 'Sync again' : 'Sync with book');
        sync.type = 'button'; sync.disabled = learningBook?.canEdit === false || analysis.state !== 'ready' || ['queued', 'syncing', 'assembling'].includes(recording.state)
          || ['queued', 'running'].includes(recording.rescan?.state);
        sync.addEventListener('click', async () => {
          sync.disabled = true; message('#recording-error');
          try { await api(`/api/books/${id}/recordings/${recording.id}/sync`, { method: 'POST', body: {} }); audioChanged(id); await learningStatus(); }
          catch (error) { message('#recording-error', error.message); sync.disabled = false; }
        });
        const download = element('a', 'button quiet small', recording.sourceChapters?.length ? 'Download complete MP3' : 'Download original');
        download.href = recording.downloadUrl; download.download = recording.name;
        download.hidden = !recording.duration;
        const remove = element('button', 'button quiet small', 'Remove recording'); remove.type = 'button'; remove.hidden = learningBook?.canEdit === false;
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try { await api(`/api/books/${id}/recordings/${recording.id}`, { method: 'DELETE' }); await learningStatus(); }
          catch (error) { message('#recording-error', error.message); remove.disabled = false; }
        });
        actions.append(sync, download, remove); item.append(actions);
        item.append(...audioUI.controls(recording, result.rescanAvailable));
        if (recording.sourceChapters?.length) {
          const detail = element('details'), summary = element('summary', 'field-note', `${recording.sourceChapters.length} chapter files · download originals`);
          detail.append(summary);
          for (const chapter of recording.sourceChapters) {
            const link = element('a', 'recording-chapter-download', `${chapter.index + 1}. ${chapter.name}`);
            link.href = chapter.url; link.download = chapter.name; detail.append(link);
          }
          item.append(detail);
        }
        return item;
      }));
      const vocabulary = analysis.vocabulary;
      $('#learning-word-count').textContent = wordCountLabel(analysis);
      $('#learning-word-count').title = analysis.counting?.error || '';
      if (analysis.counting?.error) $('#learning-word-count').textContent += ` · ${analysis.counting.error}`;
      $('#learning-stats').textContent = analysis.nativeExcluded ? 'L1 vocabulary excluded' : vocabulary?.byLanguage?.length
        ? vocabularyLabel(vocabulary)
        : analysis.lemmaCount == null ? `Analysis ${analysis.state}…`
          : `${analysis.lemmaCount.toLocaleString()} ${analysis.method === 'word forms' ? 'word forms' : 'unique lemmas'} · ${analysis.wordCount.toLocaleString()} tokens${vocabulary?.characterCount ? ` · ${vocabulary.characterCount} unique Han characters` : ''}`;
      const breakdown = $('#learning-vocabulary'); breakdown.replaceChildren();
      if (vocabulary?.byLanguage?.length) {
        const table = element('table', 'vocabulary-table');
        const header = element('tr');
        for (const label of ['Language', 'Unit', 'Unique', 'Text total', 'Seen', 'Likely known', 'Not yet seen']) header.append(element('th', '', label));
        table.append(header);
        for (const item of vocabulary.byLanguage) {
          const row = element('tr');
          const familiarity = result.familiarity?.byLanguage?.find((entry) => entry.language === item.language && entry.unit === item.unit);
          for (const text of [item.language === 'zh' ? 'Mandarin' : languageName(item.language), item.unit === 'characters' ? 'Han characters' : item.unit, item.count.toLocaleString(), `${item.total.toLocaleString()} ${item.unit === 'characters' ? 'characters' : 'word tokens'}`, familiarity?.seen?.toLocaleString() ?? '—', familiarity?.likelyKnown?.toLocaleString() ?? '—', familiarity?.unfamiliar?.toLocaleString() ?? '—']) row.append(element('td', '', text));
          table.append(row);
        }
        breakdown.append(table);
        if (vocabulary.byLanguage.some((item) => item.language === 'es')) breakdown.append(element('p', 'field-note',
          'Spanish totals group inflections and verbal participles with their base word. Attached pronouns count separately.'));
      }
      $('#learning-estimate').textContent = analysis.reading?.band
        ? `Estimated ACTFL reading demand · ${analysis.reading.band}`
        : analysis.reading?.state === 'error' ? 'Reading estimate unavailable.'
          : analysis.reading?.state === 'ready' ? 'Reading estimate unavailable for this text.'
            : analysis.reading?.state === 'queued' ? 'Reading demand queued for AI…'
              : analysis.reading?.state === 'running' ? `Estimating reading demand · ${Math.max(0, Math.floor((Date.now() - (analysis.reading.startedAt || Date.now())) / 1000))}s elapsed…`
                : 'Reading estimate awaits vocabulary analysis.';
      $('#learning-reason').textContent = analysis.reading?.error || analysis.reading?.text || '';
      $('#retry-reading-estimate').disabled = learningBook?.canEdit === false || analysis.state !== 'ready';
      $('#retry-reading-estimate').textContent = ['queued', 'running'].includes(analysis.reading?.state) ? 'Restart reading estimate' : 'Retry reading estimate';
      const evidence = analysis.reading?.evidence ?? [];
      $('#learning-evidence').hidden = !evidence.length;
      $('#learning-quotes').replaceChildren(
        element('p', 'field-note', `${analysis.reading?.sampledPassages || 0} excerpts across ${analysis.reading?.sampledSections || 0} of ${analysis.reading?.totalSections || 0} sections.`),
        ...evidence.map((quote) => element('blockquote', '', quote)),
      );
      $('#generate-book-audio').disabled = analysis.state !== 'ready' || !result.chapters.some((chapter) => chapter.narratable);
      const audio = result.narration.audio;
      $('#adjust-pdf-timing').hidden = !editablePdf(learningBook) || audio.kind !== 'generated' || audio.state !== 'ready' || (audio.segments?.length || 0) < 2;
      const working = ['queued', 'assembling'].includes(audio.state);
      const scheduled = result.narration.scheduled;
      $('#generate-book-audio').disabled ||= working || learningBook?.canEdit === false;
      $('#cancel-book-audio').hidden = learningBook?.canEdit === false || !working && scheduled?.state !== 'waiting';
      $('#book-audio-status').textContent = audio.state === 'ready' ? audio.segments?.some((part) => part.pageOnly)
        ? 'Complete book recording ready. Some pages use page-level sync.' : audio.approximateSections
        ? `Complete book recording ready. Page timing is approximate in ${audio.approximateSections} sections; estimated words are not highlighted.`
        : 'Complete book recording ready. Chapter markers are included.'
        : audio.state === 'queued' ? `Generating book audio · ${audio.complete} / ${audio.total} sections`
          : audio.state === 'assembling' ? 'Finishing the complete book recording…'
            : audio.state === 'cancelled' ? 'Generation cancelled. Completed work can be reused.' : scheduled?.notice || '';
      const download = $('#book-audio-download');
      download.hidden = audio.state !== 'ready';
      if (audio.state === 'ready') { download.href = audio.url; download.download = learningBook.title + '.mp3'; }
      message('#learning-error', analysis.error || audio.error || analysis.reading?.error);
      const rows = result.chapters.map((chapter) => {
        const row = element('div', 'learning-chapter');
        const metadata = element('div');
        const availability = chapter.narratable ? '' : chapter.characters ? 'Above demo narration limit' : 'No selectable text';
        const value = chapter.nativeExcluded ? null : chapter.vocabulary?.count ?? chapter.lemmaCount;
        const count = value == null ? '' : `${availability ? ' · ' : ''}${vocabularyLabel(chapter.vocabulary) || `${value} ${chapter.vocabulary?.unit || 'lemmas'}`}`;
        metadata.append(element('strong', '', chapter.title), element('span', 'book-meta', availability + count));
        row.append(metadata);
        return row;
      });
      $('#learning-chapters').replaceChildren(...rows);
      const toolsWorking = audioUI.update(result, uploaded, imported);
      clearTimeout(learningTimer);
      if (['queued', 'running'].includes(analysis.state) || ['queued', 'running'].includes(analysis.reading?.state)
        || ['queued', 'running'].includes(analysis.counting?.state)
        || toolsWorking || working || scheduled?.state === 'waiting' || uploaded.recordings.some((recording) => ['queued', 'syncing', 'assembling'].includes(recording.state))) {
        learningTimer = setTimeout(() => void learningStatus(), 2200);
      }
    message('#learning-partial-error', Object.values(learningParts.errors || {}).join(' · '));
  }
  async function learningStatus() {
    if (!learningDialog.open || !learningBook) return;
    clearTimeout(learningTimer);
    const id = learningBook.id, visit = learningVisit;
    const requests = [['result', `/api/books/${id}/learning`], ['uploaded', `/api/books/${id}/recordings`],
      ...(!snapshot.demo ? [['imported', `/api/books/${id}/ivoox`]] : [])];
    learningParts.errors = {};
    await Promise.allSettled(requests.filter(([key]) => !learningPending[key]).map(async ([key, path]) => {
      learningPending[key] = true;
      try {
        const value = await api(path);
        if (visit !== learningVisit || learningBook?.id !== id || !learningDialog.open) return;
        learningParts[key] = value; renderLearning(id);
      } catch (error) {
        if (visit !== learningVisit || learningBook?.id !== id || !learningDialog.open) return;
        learningParts.errors[key] = error.message; renderLearning(id);
      } finally { if (visit === learningVisit) delete learningPending[key]; }
    }));
  }

  async function showLearning(book) {
    learningVisit++; learningParts = {}; learningPending = {};
    audioUI.reset();
    learningBook = book;
    $('#review-pdf-text').hidden = !editablePdf(book);
    $('#open-reviewed-epub').hidden = true;
    $('#adjust-pdf-timing').hidden = true;
    $('#edit-book-languages').hidden = book.canEdit === false || snapshot.demo && book.id === 'sample';
    $('#find-similar-books').disabled = true;
    $('#open-book-vocabulary').disabled = true;
    $('#similar-books').replaceChildren();
    $('#learning-title').textContent = book.title;
    $('#learning-stats').textContent = 'Loading analysis…';
    $('#learning-word-count').textContent = 'Counting words…';
    $('#learning-estimate').textContent = '';
    $('#retry-reading-estimate').disabled = true;
    $('#learning-reason').textContent = '';
    $('#learning-chapters').replaceChildren();
    $('#replace-book-audio').checked = false;
    message('#learning-error');
    learningDialog.showModal();
    void absBook.show();
    await learningStatus();
  }

  $('#review-pdf-text').addEventListener('click', () => {
    const book = learningBook;
    if (editablePdf(book)) { learningDialog.close(); pdfReview.open(book); }
  });
  $('#open-reviewed-epub').addEventListener('click', () => learningDialog.close());
  $('#adjust-pdf-timing').addEventListener('click', () => {
    const book = learningBook, audio = learningParts.result?.narration?.audio;
    if (editablePdf(book) && audio?.state === 'ready') { learningDialog.close(); void pdfTiming.open(book, audio.id); }
  });

  $('#analyze-book').addEventListener('click', async () => {
    if (!learningBook) return;
    try {
      await api(`/api/books/${learningBook.id}/learning`, { method: 'POST', body: {} });
      void learningStatus();
    } catch (error) { message('#learning-error', error.message); }
  });
  $('#retry-reading-estimate').addEventListener('click', async (event) => {
    if (!learningBook) return;
    event.currentTarget.disabled = true;
    try {
      await api(`/api/books/${encodeURIComponent(learningBook.id)}/reading-estimate`, { method: 'POST', body: {} });
      await learningStatus();
    } catch (error) { message('#learning-error', error.message); $('#retry-reading-estimate').disabled = false; }
  });
  $('#edit-book-languages').addEventListener('click', () => {
    const book = learningBook;
    if (!book) return;
    learningDialog.close(); showBook(book);
    $('#book-language-limit').focus();
  });
  $('#find-similar-books').addEventListener('click', async (event) => {
    if (!learningBook) return;
    const id = learningBook.id; event.currentTarget.disabled = true;
    $('#similar-books').textContent = 'Comparing vocabulary…';
    try {
      const result = await api(`/api/books/${encodeURIComponent(id)}/recommendations`);
      if (learningBook?.id !== id) return;
      $('#similar-books').replaceChildren(...(result.books.length ? recommendationRows(result.books, () => learningDialog.close()) : [element('p', 'field-note', 'No other analyzed books with shared vocabulary yet.')]));
    } catch (error) { if (learningBook?.id === id) $('#similar-books').textContent = error.message; }
    finally { $('#find-similar-books').disabled = false; }
  });
  $('#open-book-vocabulary').addEventListener('click', () => { if (learningBook) bookVocabularyUI.open(learningBook); });
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
    const form = event.currentTarget, files = audioUI.files();
    if (!files.length || files.length > 200 || files.reduce((sum, file) => sum + file.size, 0) > 1024 ** 3) return message('#recording-error', 'Choose up to 200 audio files totalling 1 GiB or less.');
    const id = learningBook.id;
    audioUploading = true; $('#upload-audio').disabled = true; $('#upload-audio').textContent = 'Uploading…';
    audioUI.setBusy(true);
    message('#recording-error');
    try {
      const body = new FormData(); body.append('name', form.elements.name.value);
      for (const file of files) body.append('files', file);
      await api(`/api/books/${id}/recordings/chapters`, { method: 'POST', body });
      audioUI.clearUpload(); audioChanged(id); toast('Recording uploaded. Sync with book when preparation finishes.');
      if (learningBook?.id === id) await learningStatus();
    } catch (error) { message('#recording-error', error.message); }
    finally { audioUploading = false; audioUI.setBusy(false); $('#upload-audio').disabled = false; $('#upload-audio').textContent = 'Upload recording'; }
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
    metadataFields.start();
    selectedFile = file;
    $('#file-label').textContent = selectedFile?.name || 'Choose a book or document';
    if (!file) return message('#book-error');
    if (slowImport && !['epub','pdf'].includes(fileExtension(file.name))) { selectedFile=undefined; return message('#book-error','Choose the EPUB or PDF from the slow download. Documents can be converted with Upload file instead.'); }
    if (!importExtensions.includes(fileExtension(file.name))) {
      selectedFile = undefined;
      return message('#book-error', 'Choose EPUB, PDF, TXT, Markdown, HTML, DOCX, ODT, RTF or FB2.');
    }
    if (file.size > Math.min(snapshot.maxUpload,convertsToEPUB(file.name)?conversionLimit:Infinity)) {
      selectedFile = undefined;
      return message('#book-error', `Books must be ${Math.min(snapshot.maxUpload,convertsToEPUB(file.name)?conversionLimit:Infinity) / 1024 ** 2} MiB or smaller.`);
    }
    message('#book-error');
    metadataFields.start(file);
  }

  function showBook(book) {
    if (book?.canEdit === false) return;
    if (pendingCovers.has(book?.id)) { toast('This cover is still importing. Follow its progress in Process queue.'); return; }
    if (bookPending) return toast('The previous book is still saving. Please try again shortly.');
    bookVisit++;
    metadataFields.reset(); coverSearchUI.reset();
    editingBook = book;
    slowImport = null;
    $('#archive-slow-download').hidden = true;
    bookForm.elements.archiveReference.readOnly = false;
    bookForm.reset();
    sharing.set(book, snapshot.sharingAvailable);
    bulkImport.reset();
    stageFile();
    const isEdit = Boolean(book);
    $('#book-dialog-title').textContent = isEdit ? 'Book details' : 'Import book';
    $('#book-submit').textContent = isEdit ? 'Save book' : 'Import book';
    $('#book-submit').disabled = false;
    $('#remove-book').hidden = !isEdit;
    $('#file-field').hidden = isEdit;
    $('#kavita-import-source').hidden = isEdit;
    $('#import-source-field').hidden = isEdit;
    $('#book-auto-audio').hidden = isEdit || snapshot.demo;
    bookForm.elements.autoAudiobook.disabled = isEdit || snapshot.demo;
    bookForm.elements.audiobookDelayMinutes.disabled = true;
    $('#book-source option[value="anna"]').disabled = !snapshot.archive?.available;
    $('#book-source option[value="anna"]').textContent = snapshot.archive?.available ? 'Anna’s Archive' : 'Anna’s Archive (self-hosted)';
    $('#archive-book-fields').hidden = true; $('#web-book-fields').hidden = true; $('#book-web-url').disabled=true; $('#gutenberg-results').replaceChildren(); $('#gutenberg-more').hidden=true;
    $('#book-source option[value=web]').disabled=snapshot.demo;
    message('#book-import-progress');
    $('#file-limit').textContent = `EPUB/PDF: ${snapshot.maxUpload / 1024 ** 2} MiB. Conversion: ${Math.min(snapshot.maxUpload,conversionLimit)/1024**2} MiB.`;
    const choices = [new Option('Uncategorized', ''), ...snapshot.categories.map(({ id, name, language }) => new Option(language ? `${name} · ${languageName(language)}` : name, id))];
    $('#book-categories').replaceChildren(...choices);
    const fields = bookForm.elements;
    bookLanguageSuggestions(readingLanguages());
    fields.title.value = book?.title ?? '';
    fields.title.required = false;
    fields.author.value = book?.author ?? '';
    fields.series.value = book?.series ?? '';
    fields.seriesIndex.value = book?.seriesIndex ?? '';
    fields.seriesIndex.disabled = !fields.series.value.trim();
    fields.coverUrl.value = ''; $('#book-import-cover').hidden = !isEdit; message('#book-cover-error');
    coverPicker.set(book || {});
    fields.language.value = book?.language ?? '';
    fields.language.required = false;
    languagePicker.set(book?.languages);
    $('#book-language-note').hidden = false;
    fields.categoryId.value = book?.categoryId ?? (['all', 'uncategorized'].includes(category) ? '' : category);
    showFolderLanguage();
    bookDialog.showModal();
  }

  function showFolderLanguage() {
    const folder = snapshot.categories.find((entry) => entry.id === bookForm.elements.categoryId.value), language = folder?.language;
    const input = bookForm.elements.language;
    input.readOnly = Boolean(language);
    input.required = false;
    if (language) input.value = language;
    $('#book-folder-language-note').hidden = !language && !folder?.l1Folder;
    $('#book-folder-language-note').textContent = [language ? `This folder sets the primary language to ${languageName(language)}. Other explicitly selected book languages are kept.` : '',
      folder?.l1Folder ? 'L1 Folder · Comprehension assistance is off for books in this folder.' : ''].filter(Boolean).join(' ');
  }

  function showCategory(existing) {
    editingCategory = existing;
    $('#category-dialog-title').textContent = existing ? 'Edit category' : 'New category';
    $('#remove-category').hidden = !existing;
    categoryForm.elements.name.value = existing?.name ?? '';
    categoryForm.elements.language.value = existing?.language ?? '';
    categoryForm.elements.l1Folder.checked = Boolean(existing?.l1Folder);
    void folderABS.load(existing);
    message('#category-error');
    categoryDialog.showModal();
    categoryForm.elements.name.focus();
  }

  $('#add-category').addEventListener('click', () => showCategory());
  $('#all-books').addEventListener('click', () => chooseCategory('all'));
  $('#import-book').addEventListener('click', () => showBook());
  $('#open-reading-history').addEventListener('click', () => $('#reading-history-dialog').showModal());
  $('#open-vocabulary').addEventListener('click', () => $('#reading-history-dialog').close(), true);
  $('#library-details-toggle').addEventListener('click', () => { changePreferences({ quietLibrary: preferences().quietLibrary === false }); render(); });
  $('#library-layout').addEventListener('change', () => { changePreferences({ libraryLayout: $('#library-layout').value }); render(); });
  $('#library-covers-only').addEventListener('change', () => { changePreferences({ coversOnly: $('#library-covers-only').checked }); render(); });
  $('#mobile-filters-toggle').addEventListener('click', () => {
    const button = $('#mobile-filters-toggle'), open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open)); $('.library-toolbar').dataset.filtersOpen = String(open);
  });
  $('#mobile-category').addEventListener('change', () => { category = $('#mobile-category').value; render(); });
  for (const id of ['#mobile-add-category', '#mobile-new-category']) $(id).addEventListener('click', () => { $('.mobile-library-menu').open = false; showCategory(); });
  $('#mobile-edit-category').addEventListener('click', () => { const current = snapshot.categories.find((item) => item.id === category); if (current) showCategory(current); });
  $('#mobile-reading-history').addEventListener('click', () => { $('.mobile-library-menu').open = false; $('#open-reading-history').click(); });
  function showSlowImport(job) {
    slowImport = job;
    $('#archive-slow-download').hidden = false;
    $('#file-field').hidden = false;
    $('#archive-slow-page').href = job.bookUrl;
    $('#archive-slow-notice').textContent = job.error || job.notice;
    $('#book-submit').textContent = 'Import slow download';
    bookForm.elements.archiveReference.readOnly = true;
  }
  function resumeSlow(job) {
    if (job?.state !== 'needs_action' || bookPending) return;
    showBook(); $('#book-source').value = 'anna'; $('#archive-book-fields').hidden = false;
    bookForm.elements.archiveReference.value = job.reference;
    for (const name of ['title', 'author', 'language', 'categoryId']) bookForm.elements[name].value = job.details?.[name] || '';
    let languages = job.details?.languages || [];
    if (typeof languages === 'string') { try { languages = JSON.parse(languages); } catch { languages = []; } }
    languagePicker.set(languages); showFolderLanguage(); showSlowImport(job);
    sharing.set(job.details, snapshot.sharingAvailable);
    coverPicker.set(job.details || {});
    bookForm.elements.autoAudiobook.checked = Boolean(job.details?.autoAudiobook);
    bookForm.elements.audiobookDelayMinutes.value = job.details?.audiobookDelayMinutes ?? 10;
    bookForm.elements.audiobookDelayMinutes.disabled = !bookForm.elements.autoAudiobook.checked;
  }
  function renderDownloads(jobs) {
    clearTimeout(downloadExpiry);
    const time = Date.now(), completed = new Set(jobs.filter((job) => job.state === 'ready').map((job) => job.id));
    for (const id of completedImports.keys()) if (!completed.has(id)) completedImports.delete(id);
    for (const job of jobs) if (job.state === 'ready' && !completedImports.has(job.id)) {
      completedImports.set(job.id, Math.min(time, Number.isFinite(job.completedAt) ? job.completedAt : time));
    }
    const visible = jobs.filter((job) => job.state !== 'ready' || completedImports.get(job.id) + 5000 > time);
    const deadlines = visible.filter((job) => job.state === 'ready').map((job) => completedImports.get(job.id) + 5000);
    if (deadlines.length) {
      downloadExpiry = setTimeout(() => { if (!disposed) renderDownloads(snapshot.archive?.jobs || []); }, Math.max(1, Math.min(...deadlines) - time));
      downloadExpiry.unref?.();
    }
    const host = $('#archive-download-list'); $('#archive-downloads').hidden = !visible.length;
    host.replaceChildren(...visible.slice().reverse().map((job) => {
      const row = element('div', 'archive-download-row');
      row.append(element('strong', '', job.title || job.details?.title || job.book?.title || (job.titlePending ? 'Retrieving book title…' : 'Book download')),
        element('p', 'field-note', job.state === 'ready' ? 'Imported' : job.state === 'cancelled' ? 'Cancelled' : importProgress(job)));
      if (!job.title && !job.details?.title && !['ready', 'cancelled'].includes(job.state)) row.append(archiveTitleActions(job, { refresh }));
      const actions = element('div', 'archive-download-actions');
      if (job.state === 'needs_action') { const button = element('button', 'button secondary small', 'Continue slow download'); button.type = 'button'; button.addEventListener('click', () => resumeSlow(job)); actions.append(button); }
      for (const [label, method, path, show] of [ ['Retry now', 'POST', `/api/imports/anna/${job.id}/retry`, ['error', 'retry_wait', 'needs_action'].includes(job.state)],
        ['Cancel', 'DELETE', `/api/imports/anna/${job.id}`, ['queued', 'downloading', 'retry_wait', 'needs_action'].includes(job.state)] ]) {
        if (!show) continue;
        const button = element('button', 'button quiet small', label); button.type = 'button';
        button.addEventListener('click', async () => { button.disabled = true; try { await api(path, { method }); await refresh(); } catch (error) { message('#library-error', error.message); button.disabled = false; } }); actions.append(button);
      }
      row.append(actions); return row;
    }));
  }
  $('#book-source').addEventListener('change', () => {
    const archive = $('#book-source').value === 'anna', web = $('#book-source').value === 'web';
    metadataFields.cancel();
    $('#file-field').hidden = archive || web; $('#web-book-fields').hidden = !web; $('#book-web-url').disabled=!web;
    $('#archive-book-fields').hidden = !archive;
    slowImport = null; $('#archive-slow-download').hidden = true; bookForm.elements.archiveSlowURL.value = '';
    bookForm.elements.archiveReference.readOnly = false;
    message('#book-error');
    if (!archive && !web && selectedFile) metadataFields.start(selectedFile);
    if (!archive) bulkImport.reset();
  });
  let cataloguePage=1, catalogueQuery='', catalogueEpoch=0;
  async function searchGutenberg(append=false){
    if (!append) {cataloguePage=1;catalogueQuery=$('#gutenberg-query').value.trim();}
    if (!catalogueQuery) return message('#gutenberg-status','Enter a title or author.');
    const epoch=++catalogueEpoch; $('#gutenberg-search').disabled=$('#gutenberg-more').disabled=true; message('#gutenberg-status','Searching Gutenberg…');
    try{const result=await api('/api/book-catalogue/gutenberg?q='+encodeURIComponent(catalogueQuery)+'&page='+cataloguePage); if(epoch!==catalogueEpoch)return;
      if(!append)$('#gutenberg-results').replaceChildren();
      for(const item of result.books){const row=element('div','form-stack'), title=element('strong','',item.title), author=element('span','field-note',item.author), choose=element('button','button secondary small','Use this EPUB');choose.type='button';
        choose.addEventListener('click',()=>{$('#book-web-url').value=item.url;bookForm.elements.title.value=item.title;bookForm.elements.author.value=item.author;if(item.language)bookForm.elements.language.value=item.language;message('#gutenberg-status','Book selected. Review its folder and import options, then choose Import book.');});row.append(title,author,choose);$('#gutenberg-results').append(row);}
      $('#gutenberg-more').hidden=!result.more;message('#gutenberg-status',result.books.length?'Select a book to fill in its download link and details.':'No matching EPUBs found.');
    }catch(error){message('#gutenberg-status',error.message);}finally{if(epoch===catalogueEpoch)$('#gutenberg-search').disabled=$('#gutenberg-more').disabled=false;}
  }
  $('#gutenberg-search').addEventListener('click',()=>void searchGutenberg());
  $('#gutenberg-more').addEventListener('click',()=>{cataloguePage++;void searchGutenberg(true);});
  $('#configure-archive').addEventListener('click', () => bookDialog.close());
  search.addEventListener('input', render);
  $('#reading-filter').addEventListener('change', render);
  $('#book-sort').addEventListener('change', render);
  $('#book-status-filter').addEventListener('change', render);
  $('#book-categories').addEventListener('change', showFolderLanguage);
  bookForm.elements.autoAudiobook.addEventListener('change', () => { bookForm.elements.audiobookDelayMinutes.disabled = !bookForm.elements.autoAudiobook.checked; });
  $('#book-file').accept=importAccept;
  $('#book-file').addEventListener('change', (event) => stageFile(event.target.files[0]));
  bookForm.elements.coverUrl.addEventListener('input', () => { if (bookForm.elements.coverUrl.value.trim()) { bookForm.elements.coverStyle.value = 'auto'; coverPicker.refresh(); } });
  bookForm.elements.series.addEventListener('input', () => { bookForm.elements.seriesIndex.disabled = !bookForm.elements.series.value.trim(); });
  const pendingCovers = new Map();
  function importBookCover(target, url) {
    if (!target || !url || pendingCovers.has(target.id)) return;
    const controller = new AbortController(); pendingCovers.set(target.id, controller);
    const finish = processTasks.begin('Import book cover', { immediate: true, kind: 'cover', bookId: target.id, title: target.title, cancel: () => controller.abort() });
    void (async () => {
      try {
        await api(`/api/books/${target.id}/cover`, { method: 'POST', body: { url }, signal: controller.signal, process: false });
        controller.signal.throwIfAborted();
        if (!disposed) await refresh({ signal: controller.signal }).catch((error) => { if (!controller.signal.aborted) message('#library-error', error.message); });
        controller.signal.throwIfAborted(); finish(); if (!disposed) toast('Cover imported.');
      } catch (error) {
        finish(error);
        if (!disposed && !controller.signal.aborted) message('#library-error', `Cover for “${target.title}”: ${error.message}`);
      } finally { pendingCovers.delete(target.id); }
    })();
    bookForm.elements.coverUrl.value = ''; bookDialog.close(); toast('Importing cover. Follow its progress in Process queue.');
  }
  $('#book-import-cover').addEventListener('click', async (event) => {
    if (bookPending || pendingCovers.has(editingBook?.id)) return;
    if (!bookForm.elements.coverUrl.reportValidity() || !bookForm.elements.coverUrl.value.trim()) return message('#book-cover-error', 'Paste a direct image URL first.');
    importBookCover(editingBook, bookForm.elements.coverUrl.value.trim());
  });
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

  function refreshAfterBookChange() {
    // The write is complete once the dialog closes. A catalog refresh must not
    // reopen the old form or block editing another book in the meantime.
    if (!bookDialog.open) bookPending = false;
    return refresh();
  }

  bookForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (bookPending || pendingCovers.has(editingBook?.id)) return;
    const submittedBook = editingBook, submittedFile = selectedFile, submittedSource = $('#book-source').value, submittedVisit = bookVisit;
    await metadataFields.ready();
    if (bookPending || !bookDialog.open || submittedVisit !== bookVisit || submittedBook !== editingBook || submittedFile !== selectedFile || submittedSource !== $('#book-source').value) return;
    const data = new FormData(bookForm);
    if (!String(data.get('coverUrl') || '').trim()) data.delete('coverUrl');
    if (!editingBook) data.set('autoAudiobook', String(bookForm.elements.autoAudiobook.checked));
    const rawLanguage = String(data.get('language') ?? '').trim();
    const language = parseLanguage(rawLanguage);
    if (rawLanguage && !language) return message('#book-error', 'Choose a language or enter a valid language code.');
    data.set('language', language);
    try {
      sharing.apply(data, Boolean(editingBook));
      data.set('languages', JSON.stringify(languagePicker.value()));
    }
    catch (error) { return message('#book-error', error.message); }
    const archiveImport = !editingBook && $('#book-source').value === 'anna', webImport = !editingBook && $('#book-source').value === 'web';
    const webURL=$('#book-web-url').value.trim();data.delete('bookURL');
    const reference = bookForm.elements.archiveReference.value.trim();
    const downloadMode = bookForm.elements.archiveDownloadMode.value, slowURL = bookForm.elements.archiveSlowURL.value.trim();
    const queueUnavailable = bookForm.elements.archiveQueueUnavailable.checked;
    data.delete('source');
    data.delete('archiveReference');
    data.delete('archiveDownloadMode'); data.delete('archiveSlowURL');
    data.delete('archiveQueueUnavailable');
    if (archiveImport && !bulkImport.enabled() && !reference) return message('#book-error', 'Paste an Anna’s Archive book link or MD5.');
    if (webImport && !webURL) return message('#book-error','Paste a direct EPUB or PDF download link first.');
    if (!editingBook && !archiveImport && !webImport && !selectedFile) return message('#book-error', 'Choose a supported book or document within the upload limit.');
    bookPending = true;
    $('#book-submit').disabled = true;
    $('#book-submit').textContent = editingBook ? 'Saving…' : 'Importing…';
    message('#book-error');
    try {
      if (editingBook) {
        const coverUrl = data.get('coverUrl'); data.delete('coverUrl');
        data.delete('file');
        const updated = await api(`/api/books/${submittedBook.id}`, { method: 'PATCH', body: Object.fromEntries(data) });
        if (coverUrl) { importBookCover(updated, String(coverUrl).trim()); void refresh().catch((error) => message('#library-error', error.message)); return; }
      } else if (webImport) {
        data.delete('file'); await api('/api/imports/web',{method:'POST',body:{...Object.fromEntries(data),url:webURL}}); bookDialog.close(); toast('Book download queued'); await refreshAfterBookChange();return;
      } else if (archiveImport) {
        data.delete('file');
        if (bulkImport.enabled()) {
          const result = await api('/api/imports/anna/batch', { method: 'POST', body: { ...Object.fromEntries(data), downloadMode, queueUnavailable, sameAuthor: bulkImport.sameAuthor(), books: bulkImport.value() } });
          bookDialog.close(); toast(`${result.jobs.length} books queued`); await refreshAfterBookChange(); return;
        }
        let job;
        if (slowImport) {
          if (selectedFile) { const upload = new FormData(); upload.append('file', selectedFile); upload.append('details', JSON.stringify(Object.fromEntries(data)));
            job = await api(`/api/imports/anna/${slowImport.id}/file`, { method: 'POST', body: upload }); }
          else if (slowURL) job = await api(`/api/imports/anna/${slowImport.id}/continue`, { method: 'POST', body: { url: slowURL, details: Object.fromEntries(data) } });
          else { message('#book-error', 'Open the slow download options, then choose the downloaded EPUB/PDF or paste its final file link.'); return; }
        } else job = await api('/api/imports/anna', { method: 'POST', body: { ...Object.fromEntries(data), reference, downloadMode, queueUnavailable } });
        if (job.state === 'needs_action') { showSlowImport(job); await refresh(); return; }
        if (job.state === 'error') throw new Error(job.error || 'The book could not be imported.');
        bookDialog.close(); toast(job.state === 'ready' ? 'Book imported' : 'Book download queued'); await refreshAfterBookChange(); return;
      } else {
        data.set('file', selectedFile);
        const coverUrl = data.get('coverUrl'); data.delete('coverUrl');
        if(convertsToEPUB(selectedFile.name)){
          if(coverUrl)data.set('coverUrl',coverUrl);
          await api('/api/imports/convert',{method:'POST',body:data});bookDialog.close();toast('EPUB conversion queued');await refreshAfterBookChange();return;
        }
        const imported = await api('/api/books', { method: 'POST', body: data });
        if (coverUrl) { importBookCover(imported, String(coverUrl).trim()); void refresh().catch((error) => message('#library-error', error.message)); return; }
      }
      if ((editingBook?.id || '') === (submittedBook?.id || '') && submittedFile === selectedFile) bookDialog.close();
      toast(submittedBook ? 'Book updated' : 'Book imported');
      await refreshAfterBookChange();
    } catch (error) {
      message(submittedVisit === bookVisit && bookDialog.open ? '#book-error' : '#library-error', error.message);
    } finally {
      if (submittedVisit === bookVisit) {
        bookPending = false;
        message('#book-import-progress');
        $('#book-submit').disabled = false;
        $('#book-submit').textContent = editingBook ? 'Save book' : slowImport ? 'Import slow download' : 'Import book';
      }
    }
  });

  $('#remove-book').addEventListener('click', async () => {
    if (bookPending || !editingBook || !window.confirm(`Remove “${editingBook.title}” from this library?`)) return;
    bookPending = true;
    const removedBook = editingBook, submittedVisit = bookVisit;
    try {
      await api(`/api/books/${removedBook.id}`, { method: 'DELETE' });
      onRemove(removedBook.id);
      bookDialog.close();
      await refreshAfterBookChange();
      toast('Book removed');
    } catch (error) { message(submittedVisit === bookVisit && bookDialog.open ? '#book-error' : '#library-error', error.message); }
    finally { if (submittedVisit === bookVisit) bookPending = false; }
  });

  categoryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (categoryPending) return;
    const rawLanguage = categoryForm.elements.language.value.trim(), language = parseLanguage(rawLanguage);
    if (rawLanguage && !language) return message('#category-error', 'Choose a language or enter a valid language code.');
    categoryPending = true;
    try {
      folderABS.validate();
      const path = editingCategory ? `/api/categories/${editingCategory.id}` : '/api/categories';
      const saved = await api(path, { method: editingCategory ? 'PATCH' : 'POST', body: { name: categoryForm.elements.name.value, language, l1Folder: categoryForm.elements.l1Folder.checked } });
      editingCategory = saved; await folderABS.save(saved.id);
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

  bookDialog.addEventListener('close',()=>coverSearchUI.reset());
  bookDialog.addEventListener('cancel', (event) => { if (bookPending && $('#book-source').value !== 'anna') event.preventDefault(); });
  bookDialog.addEventListener('close', () => metadataFields.cancel());
  bookDialog.addEventListener('close', () => { if (!bookDialog.open) sharing.cancel(); });
  categoryDialog.addEventListener('cancel', (event) => { if (categoryPending) event.preventDefault(); });

  return { refresh, render, dispose() { disposed = true; sharing.cancel(); for (const controller of pendingCovers.values()) controller.abort(); pendingCovers.clear(); learningVisit++; unwatchApp(); surface.removeEventListener('langy-library-changed', libraryChanged); surface.removeEventListener('langy-audio-updated', libraryChanged); surface.removeEventListener('langy-open-process', openProcess); surface.removeEventListener('langy-packs-changed', refreshDownloaded); surface.removeEventListener('langy-offline-account', refreshDownloaded); offline.dispose(); ocr.dispose(); clearTimeout(downloadExpiry); clearTimeout(libraryTimer); clearTimeout(learningTimer); clearInterval(storageTimer); }, get state() { return snapshot; } };
}
