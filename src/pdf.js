import { getDocument, GlobalWorkerOptions, TextLayer, PasswordResponses } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { trackText } from './text-tracking.js';

GlobalWorkerOptions.workerSrc = workerUrl;
const baseUrl = new URL('/pdf-assets/', location.href);
const asset = (name) => new URL(`${name}/`, baseUrl).href;

function pageText(content) {
  let text = '';
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    if (text && !/\s$/u.test(text) && !/^\s|^[,.;:!?]/u.test(item.str)) text += ' ';
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
  const loading = getDocument({
    url, cMapUrl: asset('cmaps'), cMapPacked: true, standardFontDataUrl: asset('standard_fonts'),
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
      unbind = hooks.bindWords(layer, language, ({ word }) => {
        const offset = Math.max(0, text.toLocaleLowerCase().indexOf(word.toLocaleLowerCase()) - 420);
        return text.slice(offset, offset + 1100);
      });
      hooks.position({
        target: number, label: `Page ${number} of ${pdf.numPages}`, detail: 'PDF',
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
    let dimensions = [host.clientWidth, host.clientHeight];
    observer = new ResizeObserver(() => {
      const next = [host.clientWidth, host.clientHeight];
      if (next.every((value, i) => value === dimensions[i])) return;
      dimensions = next;
      draw(pageNumber).catch(hooks.error);
    });
    observer.observe(host);
    return {
      destroy,
      contents,
      audioUnit() {
        const root = shell.querySelector('.textLayer');
        return root?.childElementCount ? { key: `pdf:${pageNumber}`, root, track: () => trackText(root, language, true) } : null;
      },
      audioTarget(key) { return Number(key.split(':')[1]); },
      revealWord(range) {
        range.startContainer.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      },
      get pageCount() { return pdf.numPages; },
      get pageNumber() { return pageNumber; },
      move: (direction) => draw(pageNumber + direction),
      async go(target) {
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
  } catch (error) {
    destroy();
    throw error;
  }
}
