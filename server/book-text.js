import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { XMLParser } from 'fast-xml-parser';
import yauzl from 'yauzl';
import { readingText } from '../shared/reading-text.js';
import { languageSpans, bookLanguages } from '../shared/language.js';
import { RequestError } from './books.js';

const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, processEntities: false });
const list = (value) => value == null ? [] : [value].flat();
const parser = new DOMParser({ onError() {} });
const elements = (root, tag) => Array.from(root.getElementsByTagName(tag));
const label = (node) => node?.textContent?.replace(/\s+/gu, ' ').trim().slice(0, 150);

function archiveTarget(href, base) {
  try {
    const url = new URL(href, `https://epub.invalid/${base}`);
    if (url.origin !== 'https://epub.invalid') return null;
    return { file: decodeURIComponent(url.pathname.slice(1)), fragment: decodeURIComponent(url.hash.slice(1)) };
  } catch { return null; }
}

function chapterMarkers(doc, body, content, targets, title) {
  const { text, runs } = content;
  const order = new Map();
  function visit(node) {
    order.set(node, order.size);
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  }
  if (body) visit(body);
  const all = elements(doc, '*');
  const offset = (node) => {
    const index = order.get(node);
    return index == null ? null : runs.find((run) => order.get(run.node) >= index)?.start ?? null;
  };
  const linked = targets.map((target) => ({ title: target.title,
    from: target.fragment ? offset(all.find((node) => node.getAttribute('id') === target.fragment)) : 0,
  })).filter((marker) => marker.from != null);
  const headings = all.filter((node) => /^h[1-3]$/u.test(node.localName)).map((node) => ({ title: label(node), from: offset(node) }))
    .filter((marker) => marker.title && marker.from != null);
  const source = linked.length > 1 ? linked : [...linked, ...headings];
  if (source.length <= 1) {
    for (const node of all.filter((node) => node.localName === 'hr' || /(?:scene|section)[-_]?break|separator|separador/iu.test(node.getAttribute('class') || ''))) {
      const from = offset(node);
      if (from != null) source.push({ from, title: text.slice(from).split(/\s/u).slice(0, 12).join(' ') + '…' });
    }
    if (source.length <= 1) {
      for (let distance = 5400; distance < text.length - 300; distance += 5400) {
        const from = runs.find((run) => run.start >= distance)?.start;
        if (from != null) source.push({ from, title: 'Reading marker · ' + text.slice(from).split(/\s/u).slice(0, 10).join(' ') + '…' });
      }
    }
  }
  const unique = new Map();
  for (const marker of source.sort((a, b) => a.from - b.from)) if (!unique.has(marker.from)) unique.set(marker.from, marker);
  if (!unique.has(0)) unique.set(0, { title, from: 0 });
  return [...unique.values()].sort((a, b) => a.from - b.from);
}

export async function extractBook(book, path, languageCall) {
  if (book.format === 'pdf') {
    const data = await languageCall('/pdf', await readFile(path), 'application/pdf');
    return data.chapters.map((section) => ({ ...section, languages: languageSpans({ text: section.text,
      runs: [{ start: 0, end: section.text.length, node: null }] }, book.language, bookLanguages(book)) }));
  }
  const zip = await yauzl.openPromise(path, { autoClose: false });
  try {
    const entries = new Map();
    for await (const entry of zip.eachEntry()) entries.set(entry.fileName, entry);
    async function text(name) {
      const entry = entries.get(name);
      if (!entry || entry.uncompressedSize > 80 * 1024 * 1024) throw new RequestError(422, 'An EPUB section could not be read.');
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf8');
    }
    const container = xml.parse(await text('META-INF/container.xml'));
    const root = list(container.container?.rootfiles?.rootfile).find((item) => item['@_full-path']);
    const opf = root?.['@_full-path'];
    if (!opf) throw new RequestError(422, 'The EPUB package could not be read.');
    const packageDoc = xml.parse(await text(opf)).package;
    const manifest = new Map(list(packageDoc.manifest.item).map((item) => [item['@_id'], item]));
    const targets = [];
    const nav = [...manifest.values()].find((item) => item['@_properties']?.split(/\s/u).includes('nav'));
    const ncx = [...manifest.values()].find((item) => item['@_media-type'] === 'application/x-dtbncx+xml');
    const navigation = nav || ncx;
    if (navigation) {
      const navPath = posix.join(posix.dirname(opf), decodeURIComponent(navigation['@_href']));
      try {
        const doc = parser.parseFromString(await text(navPath), 'application/xml');
        if (nav) {
          const toc = elements(doc, 'nav').find((node) => (node.getAttribute('epub:type') || '').split(/\s/u).includes('toc')
            || node.getAttribute('role') === 'doc-toc') || elements(doc, 'nav')[0];
          for (const link of toc ? elements(toc, 'a') : []) {
            const target = archiveTarget(link.getAttribute('href'), navPath);
            if (target && label(link)) targets.push({ ...target, title: label(link) });
          }
        } else {
          for (const point of elements(doc, 'navPoint')) {
            const content = elements(point, 'content')[0];
            const target = content && archiveTarget(content.getAttribute('src'), navPath);
            const title = label(elements(point, 'navLabel')[0]);
            if (target && title) targets.push({ ...target, title });
          }
        }
      } catch { /* Missing navigation falls back to the book's own headings. */ }
    }
    const chapters = [];
    for (const [index, reference] of list(packageDoc.spine.itemref).entries()) {
      if (reference['@_linear'] === 'no') continue;
      const item = manifest.get(reference['@_idref']);
      if (!item?.['@_href']) continue;
      const file = posix.join(posix.dirname(opf), decodeURIComponent(item['@_href'].split('#')[0]));
      if (item['@_media-type']?.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|svg|avif)$/iu.test(file)) {
        chapters.push({ key: `epub:${index}`, title: `Section ${index + 1}`, text: '', languages: [], markers: [] });
        continue;
      }
      const doc = parser.parseFromString(await text(file), 'application/xhtml+xml');
      const body = doc.getElementsByTagName('body')[0] || doc.getElementsByTagNameNS('*', 'body')[0];
      const heading = ['h1', 'h2', 'h3'].flatMap((tag) => Array.from(doc.getElementsByTagName(tag)))[0];
      const title = label(heading) || `Section ${index + 1}`;
      const content = readingText(body);
      chapters.push({
        key: `epub:${index}`, title, text: content.text,
        languages: languageSpans(content, book.language, bookLanguages(book)),
        markers: chapterMarkers(doc, body, content, targets.filter((target) => target.file === file), title),
      });
    }
    return chapters;
  } finally {
    zip.close();
  }
}

export function textChunks(text, limit) {
  const chunks = [];
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + limit);
    if (to < text.length) {
      const boundary = text.lastIndexOf(' ', to);
      if (boundary > from) to = boundary;
      // Preserve surrogate pairs in languages with astral characters.
      if (/[\uD800-\uDBFF]/u.test(text[to - 1])) to--;
    }
    chunks.push({ text: text.slice(from, to), from, to });
    from = to;
    while (text[from] === ' ') from++;
  }
  return chunks;
}

export function languageChunks(section, limit, fallback) {
  const languages = Array.isArray(section.languages) ? section.languages : JSON.parse(section.languages || '[]');
  const spans = languages.length ? languages : languageSpans({ text: section.text,
    runs: [{ start: 0, end: section.text.length, node: null }] }, fallback);
  return spans.flatMap((span) => textChunks(section.text.slice(span.from, span.to), limit)
    .map((chunk) => ({ ...chunk, from: chunk.from + span.from, to: chunk.to + span.from, language: span.language })));
}

export function readingSamples(sections, limit = 900, maximum = 5) {
  const available = sections.filter(({ text }) => text.trim());
  const total = available.reduce((sum, section) => sum + section.text.length, 0);
  const count = Math.min(maximum, Math.max(available.length, Math.ceil(total / limit)));
  const passages = [], sampled = new Set(), seen = new Set();
  for (let index = 0; index < count; index++) {
    let offset = count > 1 ? Math.floor(index * Math.max(0, total - 1) / (count - 1)) : 0;
    let sectionIndex = 0;
    while (sectionIndex < available.length - 1 && offset >= available[sectionIndex].text.length) {
      offset -= available[sectionIndex++].text.length;
    }
    const text = available[sectionIndex].text;
    let from = Math.min(offset, Math.max(0, text.length - limit));
    if (from > 0 && !/\s/u.test(text[from - 1])) {
      const nextSpace = text.slice(from, from + 60).search(/\s/u);
      if (nextSpace >= 0) from += nextSpace + 1;
    }
    const passage = text.slice(from, from + limit).trim();
    const key = `${sectionIndex}:${from}`;
    if (!passage || seen.has(key)) continue;
    seen.add(key);
    sampled.add(sectionIndex);
    passages.push(passage);
  }
  return { passages, sampledSections: sampled.size, totalSections: available.length };
}
