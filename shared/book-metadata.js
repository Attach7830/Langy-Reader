import { XMLParser } from 'fast-xml-parser';
import { francAll } from 'franc-min';

const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, processEntities: false });
const textXml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, processEntities: false, preserveOrder: true });
export const metadataList = (value) => value == null ? [] : [value].flat();
const text = (value) => typeof value === 'string' ? value : value?.['#text'] ?? '';
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodedText = (value) => String(text(value)).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (entity, code) => {
  if (!code.startsWith('#')) return entities[code.toLowerCase()];
  const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
  return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
});
export const cleanMetadata = (value, limit = 250) => decodedText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, limit);

export function metadataLanguage(value) {
  for (const item of metadataList(value)) {
    const code = cleanMetadata(item, 70).replaceAll('_', '-');
    if (!/^[a-z]{2,3}(?:-[a-z\d]{2,8})*$/iu.test(code) || /^(?:und|mul|zxx)$/iu.test(code)) continue;
    try { return new Intl.Locale(code).toString(); } catch { /* Try the next declared language. */ }
  }
  return '';
}

export function epubMetadataValues(metadata = {}) {
  const meta = metadataList(metadata.meta);
  const titles = metadataList(metadata.title);
  const main = titles.find((item) => item?.['@_id'] && meta.some((entry) => entry['@_refines'] === '#' + item['@_id'] && entry['@_property'] === 'title-type' && text(entry) === 'main'));
  const authors = metadataList(metadata.creator).filter((item) => {
    const role = item?.['@_role'] || text(meta.find((entry) => item?.['@_id'] && entry['@_refines'] === '#' + item['@_id'] && entry['@_property'] === 'role'));
    return !role || role === 'aut';
  }).map((item) => cleanMetadata(item, 200)).filter(Boolean);
  return { title: cleanMetadata(main || titles[0]), author: [...new Set(authors)].join(', ').slice(0, 200), language: metadataLanguage(metadata.language) };
}

export function parseEpubContainer(source) {
  const roots = metadataList(xml.parse(source).container?.rootfiles?.rootfile);
  return (roots.find((item) => item['@_media-type'] === 'application/oebps-package+xml') || roots[0])?.['@_full-path'] || '';
}

export function parseEpubPackage(source) {
  return xml.parse(source).package;
}

export function archivePath(base, reference) {
  try {
    const url = new URL(reference, 'https://book.invalid/' + base);
    return url.origin === 'https://book.invalid' ? decodeURIComponent(url.pathname.slice(1)) : '';
  } catch { return ''; }
}

export function bookText(source) {
  const parsed = textXml.parse(source);
  const parts = [];
  function walk(value) {
    if (typeof value === 'string' || typeof value === 'number') { parts.push(decodedText(String(value))); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) if (!name.startsWith('@_') && name !== ':@' && !['script', 'style', 'head', 'nav'].includes(name)) walk(child);
  }
  walk(parsed);
  return parts.join(' ').replace(/\s+/gu, ' ').trim().slice(0, 12000);
}

export function inferBookLanguage(sample) {
  sample = String(sample);
  const letters = sample.match(/\p{L}/gu) || [];
  const count = (pattern) => (sample.match(pattern) || []).length;
  const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = count(/\p{Script=Hangul}/gu);
  const han = count(/\p{Script=Han}/gu);
  if (kana >= 5 && (kana + han) / letters.length >= .2) return 'ja';
  if (hangul >= 10 && hangul / letters.length >= .2) return 'ko';
  if (han >= 10 && han / letters.length >= .25) return 'zh';
  if (letters.length < 160) return '';
  // Franc's normalized distances vary with sample length. Vote over bounded
  // passages instead of treating a whole-book distance as a probability.
  const votes = new Map(); let weight = 0;
  for (let start = 0; start < sample.length; start += 512) {
    const passage = sample.slice(start, start + 512), size = (passage.match(/\p{L}/gu) || []).length;
    if (size < 120) continue;
    weight += size;
    const ranked = francAll(passage, { minLength: 120 });
    if (!ranked.length || ranked[0][0] === 'und' || ranked[1] && ranked[0][1] - ranked[1][1] < .015) continue;
    votes.set(ranked[0][0], (votes.get(ranked[0][0]) || 0) + size);
  }
  const winner = [...votes].sort((a, b) => b[1] - a[1])[0];
  return winner && winner[1] / weight >= .6 ? metadataLanguage(winner[0]) : '';
}

export function pdfMetadataValues({ info = {}, metadata } = {}) {
  const get = (name) => metadata?.get?.(name);
  const author = metadataList(get('dc:creator')).map((item) => cleanMetadata(item, 200)).filter(Boolean).join(', ');
  const title = cleanMetadata(get('dc:title')) || cleanMetadata(info.Title);
  return { title: /^(?:untitled|untitled document|document|sin t[ií]tulo)$/iu.test(title) ? '' : title,
    author: (author || cleanMetadata(info.Author, 200)).slice(0, 200),
    language: metadataLanguage(get('dc:language')) || metadataLanguage(info.Language) };
}

export function filenameTitle(name) {
  return cleanMetadata(String(name).replace(/\.(?:epub|pdf|txt|md|markdown|html|htm|xhtml|docx|odt|rtf|fb2)$/iu, '').replaceAll('_', ' '));
}
