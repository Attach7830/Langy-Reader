import JSZip from 'jszip';

const xmlCharacters = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xml = (value) => String(value ?? '').replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/[&<>"']/gu, (character) => xmlCharacters[character]);
const documentHeader = '<?xml version="1.0" encoding="UTF-8"?>';

export async function pdfEpub(book, { pages }) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', documentHeader + '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const language = xml(book.language || 'und'), title = xml(book.title), creator = xml(book.author);
  const modified = new Date(Number(book.updatedAt) || 0).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const toc = [], manifest = [], spine = [];
  for (const { number, title: pageTitle, text } of pages) {
    const id = `page-${number}`, file = id + '.xhtml', label = xml(pageTitle || `Page ${number}`);
    const content = text.trim().split(/\r?\n\s*\r?\n/u).map((part) => `<p dir="auto">${xml(part)}</p>`).join('');
    zip.file('EPUB/' + file, documentHeader + `<html xmlns="http://www.w3.org/1999/xhtml" lang="${language}" xml:lang="${language}"><head><title>${label}</title></head><body>${content}</body></html>`);
    manifest.push(`<item id="${id}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    toc.push(`<li><a href="${file}">${label}</a></li>`);
  }
  zip.file('EPUB/nav.xhtml', documentHeader + `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${language}"><head><title>${title}</title></head><body><nav epub:type="toc" id="toc"><h1>${title}</h1><ol>${toc.join('')}</ol></nav></body></html>`);
  zip.file('EPUB/book.opf', documentHeader + `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:langy:pdf:${xml(book.id)}</dc:identifier><dc:title>${title}</dc:title><dc:language>${language}</dc:language>${creator ? `<dc:creator>${creator}</dc:creator>` : ''}<meta property="dcterms:modified">${modified}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  return zip.generateAsync({ type: 'arraybuffer', mimeType: 'application/epub+zip' });
}
