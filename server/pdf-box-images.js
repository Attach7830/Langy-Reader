import { maxPdfBoxImageBytes, maxPdfBoxes, maxPdfBoxPixels, maxPdfBoxSide, maxPdfBoxUpload, pdfBoxDpi } from '../shared/pdf-regions.js';
import { RequestError } from './books.js';

function jpegDimensions(image) {
  if (image.length < 4 || image.readUInt16BE(0) !== 0xffd8 || image.readUInt16BE(image.length - 2) !== 0xffd9) return null;
  for (let offset = 2; offset + 4 <= image.length;) {
    if (image[offset++] !== 0xff) return null;
    while (offset < image.length && image[offset] === 0xff) offset++;
    if (offset + 3 > image.length) return null;
    const marker = image[offset++], length = image.readUInt16BE(offset);
    if (length < 2 || offset + length > image.length || marker === 0xda) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 17 || image[offset + 2] !== 8 || image[offset + 7] !== 3) return null;
      const width = image.readUInt16BE(offset + 5), height = image.readUInt16BE(offset + 3);
      return width > 0 && height > 0 && width <= maxPdfBoxSide && height <= maxPdfBoxSide && width * height <= maxPdfBoxPixels ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

// One image per page lets both existing PDF OCR engines recognize all the
// selected regions in order, with one request and no changes to the source PDF.
export function pdfBoxImages(images) {
  if (!images.length || images.length > maxPdfBoxes) throw new RequestError(422, 'Choose at least one box to scan.');
  if (images.some((image) => image.length > maxPdfBoxImageBytes) || images.reduce((sum, image) => sum + image.length, 0) > maxPdfBoxUpload) {
    throw new RequestError(413, 'These boxes are too large to scan together. Use smaller boxes.');
  }
  const sizes = images.map(jpegDimensions);
  if (sizes.some((size) => !size)) throw new RequestError(422, 'The PDF box images could not be read. Reopen the page and try again.');
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')], offsets = [0];
  let position = chunks[0].length;
  function append(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'ascii');
    chunks.push(bytes);
    position += bytes.length;
  }
  function object(...contents) {
    append(`${offsets.push(position) - 1} 0 obj\n`);
    for (const content of contents) append(content);
    append('\nendobj\n');
  }
  object('<< /Type /Catalog /Pages 2 0 R >>');
  object(`<< /Type /Pages /Count ${images.length} /Kids [${images.map((_, index) => `${3 + 3 * index} 0 R`).join(' ')}] >>`);
  for (const [index, image] of images.entries()) {
    const { width, height } = sizes[index];
    const w = (width * 72 / pdfBoxDpi).toFixed(3), h = (height * 72 / pdfBoxDpi).toFixed(3), id = offsets.length;
    object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    const paint = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
    object(`<< /Length ${paint.length} >>\nstream\n${paint}endstream`);
    object(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`, image, '\nendstream');
  }
  const xref = position;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) append(`${String(offset).padStart(10, '0')} 00000 n \n`);
  append(`trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks, position);
}
