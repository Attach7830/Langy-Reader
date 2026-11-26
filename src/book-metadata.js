import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { cleanMetadata, metadataLanguage } from '../shared/book-metadata.js';
import { archivePath, bookText, epubMetadataValues, filenameTitle, inferBookLanguage, metadataList, parseEpubContainer, parseEpubPackage } from '../shared/book-metadata.js';

const MiB = 1024 ** 2;

async function documentDetails(file, signal) {
  const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, processEntities: false, parseTagValue: false });
  let source = '', metadata = {};
  if (/\.(docx|odt)$/iu.test(file.name)) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer()); signal?.throwIfAborted();
    const entries = Object.values(zip.files);
    if (entries.length > 6000 || entries.reduce((sum, entry) => sum + (entry._data?.uncompressedSize || 0), 0) > 128 * MiB) throw new Error('Document too large');
    const read = async (name) => { const item = zip.file(name); return item && item._data?.uncompressedSize <= 2 * MiB ? item.async('string') : ''; };
    if (/\.docx$/iu.test(file.name)) { metadata = parser.parse(await read('docProps/core.xml')).coreProperties || {}; source = await read('word/document.xml'); }
    else { metadata = parser.parse(await read('meta.xml'))['document-meta']?.meta || {}; source = await read('content.xml'); }
  } else if (/\.(html?|xhtml|txt|md|markdown|fb2)$/iu.test(file.name)) {
    source = await file.slice(0, 128 * 1024).text();
    if (/\.(html?|xhtml)$/iu.test(file.name)) {
      const parsed = parser.parse(source).html || {};
      metadata.title = parsed.head?.title;
      metadata.language = parsed['@_lang'] || parsed['@_xml:lang'];
    }
  }
  signal?.throwIfAborted();
  return { title: cleanMetadata(metadata.title), author: cleanMetadata(metadata.creator || metadata['initial-creator'], 200), language: metadataLanguage(metadata.language) || (source ? inferBookLanguage((/\.(txt|md|markdown)$/iu.test(file.name) ? source : bookText(source)).slice(0, 30000)) : '') };
}

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
      : await documentDetails(file, signal);
  return { ...result, title: result.title || filenameTitle(file.name), titleSource: result.title ? 'metadata' : 'filename' };
}
