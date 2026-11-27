import { getDocument, GlobalWorkerOptions, TextLayer, PasswordResponses } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { trackText } from './text-tracking.js';
import { hanPattern } from '../shared/language.js';
import { pdfLinkLayer } from './book-links.js';
import { serializeRenderer } from './reader-navigation.js';
import { savedReadingFile } from './book-source.js';
import { adjacentSection } from './section-navigation.js';
import { maxPdfBoxImageBytes, maxPdfBoxPixels, maxPdfBoxSide, pdfBoxDpi } from '../shared/pdf-regions.js';

GlobalWorkerOptions.workerSrc = workerUrl;
const baseUrl = new URL('/pdf-assets/', location.href);
const asset = (name) => new URL(`${name}/`, baseUrl).href;

function pageText(content) {
  let text = '';
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    const chineseBoundary = new RegExp(`${hanPattern}$`, 'u').test(text) && new RegExp(`^${hanPattern}`, 'u').test(item.str);
    if (text && !chineseBoundary && !/\s$/u.test(text) && !/^\s|^[,.;:!?]/u.test(item.str)) text += ' ';
    text += item.str + (item.hasEOL ? '\n' : '');
  }
  return text.trim();
}

function pdfContents(items, depth = 0) {
  return (items ?? []).flatMap((item) => {
    const children = pdfContents(item.items, depth + 1);
    const label = item.title?.trim();
    if (!label || (item.dest == null && !children.length)) return children;
    return [{ label, depth, target: item.dest }, ...children];
  });
}

export async function openPdf({ host, url, position, language, hooks, signal }) {
  const saved = await savedReadingFile(url, { signal });
  const source = saved ? { data: new Uint8Array(await saved.arrayBuffer()) } : { url };
  signal.throwIfAborted();
  const loading = getDocument({
    ...source, cMapUrl: asset('cmaps'), cMapPacked: true, standardFontDataUrl: asset('standard_fonts'),
    wasmUrl: asset('wasm'), iccUrl: asset('iccs'), enableXfa: false, isEvalSupported: false,
  });
  signal.addEventListener('abort', () => { void loading.destroy().catch(() => {}); }, { once: true });
  loading.onPassword = (submit, reason) => {
    const password = window.prompt(reason === PasswordResponses.INCORRECT_PASSWORD ? 'Incorrect password. Enter the PDF password again.' : 'Enter the PDF password.');
    if (password) submit(password);
    else void loading.destroy().catch(() => {});
  };
  let pdf, observer, active, unbind, render;
  let serial = 0;
  let text = '';
  let zoom = 1;
  let pageNumber = 1;
  let closed = false;
  let syncResolution, sectionHeaders = [];
  const excerpts = new Map();
  const shell = document.createElement('div');
  shell.className = 'pdf-sheet';
  host.replaceChildren(shell);

  function destroy() {
    if (closed) return;
    closed = true;
    serial++;
    observer?.disconnect();
    active?.cancel();
    render?.cancel();
    unbind?.();
    host.classList.remove('pdf-panning');
    void loading.destroy().catch(() => {});
  }

  async function draw(number) {
    if (closed || number < 1 || number > pdf.numPages) return;
    const id = ++serial;
    const resetScroll = pageNumber !== number;
    pageNumber = number;
    active?.cancel();
    render?.cancel();
    unbind?.();
    const page = await pdf.getPage(number);
    if (id !== serial) return;

    const actual = page.getViewport({ scale: 1 });
    const fit = Math.max(.05, Math.min((host.clientWidth - 32) / actual.width, (host.clientHeight - 28) / actual.height));
    const viewport = page.getViewport({ scale: fit * zoom });
    const ratio = Math.min(devicePixelRatio || 1, 2, 4096 / Math.max(viewport.width, viewport.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    canvas.setAttribute('aria-label', `PDF page ${number}`);
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    shell.style.width = `${viewport.width}px`;
    shell.style.height = `${viewport.height}px`;
    host.classList.toggle('pdf-panning', viewport.width + 32 > host.clientWidth + 1);
    shell.style.setProperty('--total-scale-factor', viewport.scale * viewport.userUnit);
    shell.replaceChildren(canvas, layer);
    if (resetScroll) {
      host.scrollTo(0, 0);
      text = '';
    }

    render = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    try {
      const [content] = await Promise.all([page.getTextContent(), render.promise]);
      if (id !== serial) return;
      text = pageText(content);
      excerpts.set(number, text);
      active = new TextLayer({ textContentSource: content, container: layer, viewport });
      await active.render();
      if (id !== serial) return;
      const annotations = await page.getAnnotations({ intent: 'display' }).catch(() => []);
      if (id !== serial) return;
      shell.append(pdfLinkLayer(annotations, viewport, (target) => hooks.followLink?.(target)));
      unbind = hooks.bindWords(layer, language, ({ word }) => {
        const offset = Math.max(0, text.toLocaleLowerCase().indexOf(word.toLocaleLowerCase()) - 420);
        return text.slice(offset, offset + 1100);
      });
      hooks.position({
        target: number, heading: sectionHeaders.findLast((entry) => entry.page <= number)?.label || `Page ${number}`, label: `Page ${number} of ${pdf.numPages}`, detail: 'PDF',
        percent: number / pdf.numPages, previous: number > 1, next: number < pdf.numPages,
      });
    } catch (error) {
      if (id === serial) throw error;
    }
  }

  try {
    pdf = await loading.promise;
    signal.throwIfAborted();
    const initial = Number.isInteger(position) ? Math.min(pdf.numPages, Math.max(position, 1)) : 1;
    const [outline] = await Promise.all([pdf.getOutline().catch(() => null), draw(initial)]);
    const contents = pdfContents(outline);
    void Promise.all(contents.map(async (entry) => {
      try {
        const destination = typeof entry.target === 'string' ? await pdf.getDestination(entry.target) : entry.target;
        if (destination?.[0] == null) return null;
        return { label: entry.label, page: (Number.isInteger(destination[0]) ? destination[0] : await pdf.getPageIndex(destination[0])) + 1 };
      } catch { return null; }
    })).then((entries) => {
      if (closed || signal.aborted) return;
      sectionHeaders = entries.filter(Boolean).sort((a, b) => a.page - b.page);
      hooks.position({ target: pageNumber, heading: sectionHeaders.findLast((entry) => entry.page <= pageNumber)?.label || `Page ${pageNumber}`, label: `Page ${pageNumber} of ${pdf.numPages}`, detail: 'PDF',
        percent: pageNumber / pdf.numPages, previous: pageNumber > 1, next: pageNumber < pdf.numPages });
    }).catch(() => {});
    let dimensions = [host.clientWidth, host.clientHeight];
    let schedule;
    observer = new ResizeObserver(() => {
      const next = [host.clientWidth, host.clientHeight];
      if (next.every((value, i) => value === dimensions[i])) return;
      dimensions = next;
      void schedule(() => draw(pageNumber)).catch((error) => { if (!closed) hooks.error(error); });
    });
    observer.observe(host);
    const opened = {
      destroy,
      syncPosition: () => ({ progress: String(pageNumber), percentage: pageNumber / pdf.numPages, target: pageNumber }),
      get syncResolution() { return syncResolution; },
      contents,
      async sectionTarget(direction) {
        const entries = [{ position: 1, target: 1 }];
        for (const item of contents) {
          try {
            const destination = typeof item.target === 'string' ? await pdf.getDestination(item.target) : item.target;
            if (destination?.[0] == null) continue;
            const position = (Number.isInteger(destination[0]) ? destination[0] : await pdf.getPageIndex(destination[0])) + 1;
            if (!entries.some((entry) => entry.position === position)) entries.push({ position, target: position });
          } catch { /* Skip invalid outline destinations. */ }
        }
        signal.throwIfAborted(); entries.sort((a, b) => a.position - b.position);
        return adjacentSection(entries, pageNumber, direction);
      },
      readingRoots() { return [shell.querySelector('.textLayer')].filter(Boolean); },
      bookmarkTarget(range) {
        const root = shell.querySelector('.textLayer');
        if (!root?.contains(range.startContainer)) return;
        const from = trackText(root, language, true).offsetForRange(range);
        return from == null ? pageNumber : { text: true, key: `pdf:${pageNumber}`, from };
      },
      audioUnit() {
        const root = shell.querySelector('.textLayer');
        return root ? { key: `pdf:${pageNumber}`, root, track: () => trackText(root, language, true) } : null;
      },
      audioTarget(key) { return Number(key.split(':')[1]); },
      revealWord(range, { valid = () => true } = {}) {
        if (!valid() || !range.startContainer.isConnected) return;
        range.startContainer.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      },
      get pageCount() { return pdf.numPages; },
      get pageNumber() { return pageNumber; },
      async boxImages(number, boxes, requestSignal) {
        requestSignal.throwIfAborted();
        const page = await pdf.getPage(number), actual = page.getViewport({ scale: 1 }), images = [];
        for (const [left, top, right, bottom] of boxes) {
          requestSignal.throwIfAborted();
          const width = actual.width * (right - left), height = actual.height * (bottom - top);
          const scale = Math.min(pdfBoxDpi / 72, (maxPdfBoxSide - 1) / Math.max(width, height),
            Math.sqrt((maxPdfBoxPixels - 2 * maxPdfBoxSide) / (width * height)));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(width * scale));
          canvas.height = Math.max(1, Math.ceil(height * scale));
          // Use the same rotated viewport as the preview. Translate its
          // selected area to the origin of a small, higher-resolution canvas.
          const task = page.render({ canvas, viewport, background: '#fff', transform: [1, 0, 0, 1, -left * viewport.width, -top * viewport.height] });
          const stop = () => task.cancel();
          requestSignal.addEventListener('abort', stop, { once: true });
          try {
            await task.promise;
            requestSignal.throwIfAborted();
            const image = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .94));
            requestSignal.throwIfAborted();
            if (!image || image.size > maxPdfBoxImageBytes) throw new Error('The box image is too large. Draw a smaller box.');
            images.push(image);
          } finally {
            requestSignal.removeEventListener('abort', stop);
            canvas.width = canvas.height = 0;
          }
        }
        return images;
      },
      move: (direction) => draw(pageNumber + direction),
      async go(target) {
        if (target?.text) {
          await draw(Number(target.key.split(':')[1]));
          const root = shell.querySelector('.textLayer'), track = root && trackText(root, language, true);
          const word = track?.words.find((item) => item.to > target.from), range = word && track.rangeFor(word);
          range?.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' }); return;
        }
        if (target?.sync) {
          const remote = target.sync;
          const saved = Number.isInteger(remote.langyTarget) ? remote.langyTarget
            : /^\d+$/u.test(remote.progress) ? Number(remote.progress) : null;
          const exact = saved != null && saved >= 1 && saved <= pdf.numPages;
          const page = exact ? saved : Math.max(1, Math.min(pdf.numPages, Math.round(remote.percentage * pdf.numPages)));
          await draw(page);
          syncResolution = { exact };
          return;
        }
        if (Number.isInteger(target)) return draw(target);
        const destination = typeof target === 'string' ? await pdf.getDestination(target) : target;
        const pageRef = destination?.[0];
        if (pageRef == null) throw new Error('This bookmark has no page destination.');
        const index = Number.isInteger(pageRef) ? pageRef : await pdf.getPageIndex(pageRef);
        return draw(index + 1);
      },
      summaryPage() {
        const number = pageNumber;
        return {
          text,
          async *earlier(contextSignal) {
            for (let previous = 1; previous < number; previous++) {
              contextSignal.throwIfAborted();
              if (!excerpts.has(previous)) {
                const page = await pdf.getPage(previous);
                const content = await page.getTextContent();
                contextSignal.throwIfAborted();
                excerpts.set(previous, pageText(content));
              }
              yield excerpts.get(previous);
            }
          },
        };
      },
      async setZoom(factor) {
        zoom = factor;
        await draw(pageNumber);
      },
    };
    const serialized = serializeRenderer(opened, { signal, stalled: destroy });
    schedule = serialized.run;
    return serialized.renderer;
  } catch (error) {
    destroy();
    throw error;
  }
}
