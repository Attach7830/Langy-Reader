import { $, api, message } from './ui.js';
import { pdfBoxes, textInPdfBoxes } from './pdf-boxes.js';

const readable = (value) => typeof value === 'string' && /[\p{L}\p{N}]/u.test(value);

function parsePageRanges(value, total) {
  const pages = new Set();
  if (!value.trim()) return pages;
  for (const part of value.split(/[,，]/u)) {
    const match = /^\s*(\d+)(?:\s*[-–—]\s*(\d+))?\s*$/u.exec(part);
    const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
    if (!match || start < 1 || end < start || end > total) throw new Error(`Enter page numbers or ranges from 1 to ${total}, separated by commas.`);
    for (let page = start; page <= end; page++) pages.add(page);
  }
  return pages;
}

function formatPageRanges(pages) {
  const ranges = [];
  for (const page of [...pages].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last.end + 1 === page) last.end = page;
    else ranges.push({ start: page, end: page });
  }
  return ranges.map(({ start, end }) => start === end ? String(start) : `${start}–${end}`).join(', ');
}

export function reviewPdfText({ saved }) {
  const dialog = $('#pdf-review-dialog'), form = $('#pdf-review-form');
  const { page: number, text, excluded, skip } = form.elements;
  const previous = $('#pdf-review-previous'), next = $('#pdf-review-next'), save = $('#pdf-review-save');
  const preview = $('#pdf-review-preview'), original = $('#pdf-review-original'), copy = $('#pdf-review-copy');
  const extract = $('#pdf-review-extract-boxes'), forceOCR = $('#pdf-review-box-ocr');
  let editor, poll;
  const selectionBoxes = pdfBoxes({ preview, changed(boxes) {
    const { number, boxes: saved = [] } = editor.page;
    if (JSON.stringify(boxes) === JSON.stringify(saved)) editor.boxes.delete(number);
    else editor.boxes.set(number, boxes);
    message('#pdf-review-box-status');
    controls();
  } });

  function selectedText() {
    const selection = document.getSelection(), root = preview.querySelector('.textLayer');
    if (!root || !selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return '';
    return selection.toString().trim();
  }

  function controls() {
    const ready = Boolean(editor?.page && !editor.loading && !editor.saving && !editor.extraction);
    const previewReady = ready && editor.preview && editor.renderedPage === editor.page.number && selectionBoxes.attached;
    number.disabled = excluded.disabled = !ready;
    text.disabled = original.disabled = !ready;
    previous.disabled = !ready || editor.page.number === 1;
    next.disabled = !ready || editor.page.number === editor.total;
    save.disabled = !ready || editor.stale;
    copy.disabled = !previewReady || !selectedText();
    selectionBoxes.enable(Boolean(previewReady) && !editor.stale);
    forceOCR.disabled = !previewReady || editor.stale || !selectionBoxes.boxes.length;
    extract.textContent = editor?.extraction ? 'Cancel extraction' : 'Extract boxes to editor';
    extract.disabled = !editor?.extraction && (!previewReady || editor.stale || !selectionBoxes.boxes.length);
    $('#pdf-review-columns').hidden = !editor?.page;
    skip.disabled = !ready;
    if (ready) {
      try { skip.checked = parsePageRanges(excluded.value, editor.total).has(editor.page.number); }
      catch { skip.disabled = true; }
    }
  }

  async function showPreview(session, data) {
    message('#pdf-review-preview-status', 'Loading the original page…');
    try {
      session.previewRequest ||= import('./pdf.js').then(({ openPdf }) => openPdf({
        host: preview, position: data.page.number, language: session.book.language,
        url: `/api/books/${encodeURIComponent(session.book.id)}/file${data.sourceRevision ? `?revision=${encodeURIComponent(data.sourceRevision)}` : ''}`,
        signal: session.controller.signal,
        hooks: {
          bindWords() {},
          position({ target }) {
            if (editor === session && session.page.number === target) {
              session.renderedPage = target;
              selectionBoxes.attach();
              controls();
            }
          },
          error(error) { if (editor === session) message('#pdf-review-preview-status', error.message); },
        },
      }));
      const renderer = await session.previewRequest;
      if (editor !== session) { renderer.destroy(); return; }
      session.preview = renderer;
      if (session.page.number !== data.page.number) return;
      if (renderer.pageNumber !== data.page.number) await renderer.go(data.page.number);
      if (editor === session && session.page.number === data.page.number) {
        selectionBoxes.attach();
        message('#pdf-review-preview-status');
        controls();
      }
    } catch (error) {
      session.previewRequest = undefined;
      if (editor === session) message('#pdf-review-preview-status', error.message);
    }
  }

  async function load(page) {
    const session = editor;
    if (!session || session.loading || session.extraction) return;
    clearTimeout(poll); session.loading = true; controls(); message('#pdf-review-error');
    message('#pdf-review-status', 'Loading extracted PDF text…');
    try {
      const data = await api(`/api/books/${encodeURIComponent(session.book.id)}/pdf-review?page=${page}`, { signal: session.controller.signal });
      if (editor !== session) return;
      if (data.state === 'error') throw new Error(data.error);
      if (data.state !== 'ready') { poll = setTimeout(() => void load(page), 1200); return; }
      if (session.revision === undefined) {
        session.revision = data.revision;
        excluded.value = formatPageRanges(data.excluded);
      } else if (session.revision !== data.revision) {
        session.stale = true;
        throw new Error('The PDF text changed. Copy any unsaved edits, then reopen the editor.');
      }
      session.page = data.page; session.total = data.total;
      selectionBoxes.set(session.boxes.get(data.page.number) ?? data.page.boxes);
      message('#pdf-review-box-status');
      number.value = String(data.page.number); number.max = String(data.total);
      $('#pdf-review-total').textContent = `of ${data.total}`;
      text.value = session.edits.get(data.page.number) ?? data.page.text;
      text.lang = session.book.language;
      message('#pdf-review-status'); controls();
      void showPreview(session, data);
    } catch (error) {
      if (editor === session) { message('#pdf-review-status'); message('#pdf-review-error', error.message); }
    } finally { if (editor === session) { session.loading = false; controls(); } }
  }

  function edit(value) {
    const { number, text: savedText } = editor.page;
    if (value === savedText) editor.edits.delete(number);
    else editor.edits.set(number, value);
    if (text.value !== value) text.value = value;
  }

  extract.addEventListener('click', async () => {
    const session = editor;
    if (session?.extraction) { session.extraction.abort(); return; }
    if (extract.disabled || !selectionBoxes.attached) return;
    const useOCR = forceOCR.checked, boxes = selectionBoxes.boxes, page = session.page.number;
    const request = session.extraction = new AbortController();
    const signal = AbortSignal.any([request.signal, session.controller.signal]);
    controls(); message('#pdf-review-error'); message('#pdf-review-box-status', 'Extracting text from the boxes…');
    try {
      const texts = useOCR ? boxes.map(() => '') : textInPdfBoxes($('.pdf-sheet', preview), boxes);
      const missing = texts.flatMap((value, index) => readable(value) ? [] : [index]);
      if (missing.length) {
        message('#pdf-review-box-status', 'Scanning selected boxes with OCR…');
        const images = await session.preview.boxImages(page, missing.map((index) => boxes[index]), signal);
        const body = new FormData();
        body.set('page', String(page)); body.set('revision', session.revision);
        for (const image of images) body.append('image', image, 'box.jpg');
        const result = await api(`/api/books/${encodeURIComponent(session.book.id)}/pdf-review/ocr`, { method: 'POST', body, signal });
        missing.forEach((index, ordinal) => { texts[index] = result.texts[ordinal]; });
      }
      signal.throwIfAborted();
      if (editor !== session) return;
      const blank = texts.flatMap((value, index) => readable(value) ? [] : [index + 1]);
      const revised = texts.filter(readable).join('\n\n');
      if (!revised) throw new Error('No readable text was found in these boxes. Try a tighter selection or check the book’s OCR language.');
      edit(revised);
      message('#pdf-review-box-status', blank.length ? `Text added to the editor. No readable text in boxes ${blank.join(', ')}.` : 'Text added to the editor.');
    } catch (error) {
      if (editor !== session) return;
      message('#pdf-review-box-status', signal.aborted ? 'Extraction cancelled.' : '');
      if (!signal.aborted) message('#pdf-review-error', error.message);
    } finally {
      if (editor === session) { session.extraction = undefined; controls(); }
    }
  });
  document.addEventListener('selectionchange', () => { if (dialog.open) controls(); });
  copy.addEventListener('pointerdown', (event) => event.preventDefault());
  copy.addEventListener('click', () => { const value = selectedText(); if (value && editor?.page) { edit(value); text.focus(); } });
  text.addEventListener('input', () => edit(text.value));
  original.addEventListener('click', () => edit(editor.page.original));
  excluded.addEventListener('input', controls);
  skip.addEventListener('change', () => {
    const pages = parsePageRanges(excluded.value, editor.total);
    if (skip.checked) pages.add(editor.page.number);
    else pages.delete(editor.page.number);
    excluded.value = formatPageRanges(pages);
  });
  previous.addEventListener('click', () => void load(editor.page.number - 1));
  next.addEventListener('click', () => void load(editor.page.number + 1));
  function goToPage() {
    const value = number.valueAsNumber;
    if (Number.isInteger(value) && value >= 1 && value <= editor.total) void load(value);
    else { number.value = String(editor.page.number); message('#pdf-review-error', `Choose a PDF page from 1 to ${editor.total}.`); }
  }
  number.addEventListener('change', goToPage);
  number.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); goToPage(); } });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = editor;
    if (save.disabled) return;
    session.saving = true; controls(); message('#pdf-review-error');
    try {
      const pages = [...parsePageRanges(excluded.value, session.total)];
      const edits = [...session.edits].map(([page, text]) => ({ page, text }));
      const boxes = [...session.boxes].map(([page, boxes]) => ({ page, boxes }));
      await api(`/api/books/${encodeURIComponent(session.book.id)}/pdf-review`, { method: 'PUT', body: { revision: session.revision, excluded: pages, edits, boxes } });
      if (editor === session && dialog.open) { dialog.close(); saved(session.book); }
    } catch (error) { if (editor === session) message('#pdf-review-error', error.message); }
    finally { if (editor === session) { session.saving = false; controls(); } }
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    clearTimeout(poll); editor?.controller.abort(); editor?.preview?.destroy(); editor = undefined;
    selectionBoxes.set([], { reset: true });
    preview.replaceChildren();
  });
  return { open(book) {
    if (dialog.open) return;
    editor = { book, controller: new AbortController(), edits: new Map(), boxes: new Map() };
    form.reset(); controls(); message('#pdf-review-error'); message('#pdf-review-preview-status');
    $('#pdf-review-total').textContent = '';
    dialog.showModal(); void load(1);
  } };
}
