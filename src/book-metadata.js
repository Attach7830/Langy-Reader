import JSZip from 'jszip';
import { archivePath, bookText, epubMetadataValues, filenameTitle, inferBookLanguage, metadataList, parseEpubContainer, parseEpubPackage } from '../shared/book-metadata.js';

const MiB = 1024 ** 2;

async function epubDetails(file, signal) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  signal?.throwIfAborted();
  const entries = Object.values(zip.files);
  if (entries.length > 12000 || entries.some((entry) => entry._data?.uncompressedSize > 80 * MiB)
    || entries.reduce((sum, entry) => sum + (entry._data?.uncompressedSize || 0), 0) > 384 * MiB) throw new Error('The EPUB metadata is too large to preview.');
  async function read(name, limit) {
    signal?.throwIfAborted();
    const entry = zip.file(name);
    if (!entry || entry._data?.uncompressedSize > limit) return '';
    const value = await entry.async('string');
    signal?.throwIfAborted();
    return value.length <= limit ? value : '';
  }
  const opf = archivePath('', parseEpubContainer(await read('META-INF/container.xml', 128 * 1024)));
  const book = opf && parseEpubPackage(await read(opf, 2 * MiB));
  if (!book?.manifest?.item || !book.spine?.itemref) throw new Error('The EPUB package could not be read.');
  const result = epubMetadataValues(book.metadata);
  if (!result.language) {
    const manifest = new Map(metadataList(book.manifest.item).map((item) => [item['@_id'], item]));
    const spine = metadataList(book.spine.itemref).filter((item) => item['@_linear'] !== 'no');
    const indices = [...new Set([0, 1, Math.floor(spine.length / 3), Math.floor(spine.length * 2 / 3), spine.length - 1])].filter((n) => n >= 0 && n < spine.length);
    const passages = [];
    for (const index of indices) {
      const item = manifest.get(spine[index]['@_idref']);
      if (!item?.['@_href']) continue;
      const source = await read(archivePath(opf, item['@_href']), 2 * MiB);
      if (source) { try { passages.push(bookText(source)); } catch { /* A damaged section need not prevent reading the remaining samples. */ } }
    }
    result.language = inferBookLanguage(passages.join(' ').slice(0, 30000));
    if (result.language) result.languageSource = 'text';
  }
  return result;
}

export async function detectBookMetadata(file, { signal } = {}) {
  signal?.throwIfAborted();
  const result = /\.epub$/iu.test(file.name) ? await epubDetails(file, signal)
    : /\.pdf$/iu.test(file.name) ? await (await import('./pdf-metadata.js')).readPdfMetadata(file, { signal })
      : {};
  return { ...result, title: result.title || filenameTitle(file.name), titleSource: result.title ? 'metadata' : 'filename' };
}
