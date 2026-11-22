import { inferBookLanguage, pdfMetadataValues } from '../shared/book-metadata.js';

export async function readPdfMetadata(file, { signal, getDocument } = {}) {
  signal?.throwIfAborted();
  getDocument ||= (await import('./pdf-metadata-engine.js')).getDocument;
  const assets = typeof location === 'object' ? new URL('/pdf-assets/', location.href) : null;
  const loading = getDocument({ data: new Uint8Array(await file.arrayBuffer()), enableXfa: false, isEvalSupported: false,
    ...(assets ? { cMapUrl: new URL('cmaps/', assets).href, cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', assets).href, wasmUrl: new URL('wasm/', assets).href } : {}) });
  let rejectCancelled;
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
  const abort = () => {
    rejectCancelled(signal?.reason || new Error('Enter book details manually for a password-protected PDF.'));
    void loading.destroy().catch(() => {});
  };
  loading.onPassword = abort;
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const pdf = await Promise.race([loading.promise, cancelled]);
    const result = pdfMetadataValues(await pdf.getMetadata());
    if (!result.language) {
      const indices = [...new Set([1, Math.max(1, Math.ceil(pdf.numPages / 3)), Math.max(1, Math.ceil(pdf.numPages * 2 / 3)), pdf.numPages])];
      const passages = [];
      for (const index of indices) {
        signal?.throwIfAborted();
        const page = await pdf.getPage(index);
        const content = await page.getTextContent();
        passages.push(content.items.map((item) => item.str || '').join(' ').slice(0, 10000));
        page.cleanup();
      }
      result.language = inferBookLanguage(passages.join(' ').slice(0, 30000));
      if (result.language) result.languageSource = 'text';
    }
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await loading.destroy().catch(() => {});
  }
}
