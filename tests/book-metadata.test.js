import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { archivePath, bookText, inferBookLanguage, metadataLanguage, pdfMetadataValues } from '../shared/book-metadata.js';
import { detectBookMetadata } from '../src/book-metadata.js';
import { readPdfMetadata } from '../src/pdf-metadata.js';
import { openLibrary } from '../server/books.js';

const passages = {
  en: 'The children walked down the narrow street and entered the little bookshop. They were looking for a story about a sailor who had travelled around the world. Every evening the old man would tell them about the places he had visited and the people he had met.',
  es: 'Los niños caminaban por las calles del pueblo y escuchaban las historias que contaba su abuela. Cada tarde se sentaban junto a la ventana para leer un libro. La casa estaba cerca del río y desde allí podían ver las montañas y los árboles del bosque.',
  pt: 'As crianças caminhavam pelas ruas da cidade e ouviam as histórias que a avó contava. Todas as tardes elas se sentavam perto da janela para ler um livro. A casa ficava perto do rio e dali podiam ver as montanhas e as árvores da floresta. Ninguém sabia o que aconteceria no dia seguinte.',
  zh: '孩子们在街上走着，来到一家很小的书店。他们想读一个关于旅行的故事。每天晚上，老人都会告诉他们自己去过什么地方，遇见过什么人。',
  ja: '子供たちは通りを歩いて小さな本屋に入りました。世界中を旅した船乗りの物語を探していました。毎晩、おじいさんは訪れた場所について話してくれました。',
  ko: '아이들은 좁은 길을 따라 걸어가 작은 서점에 들어갔습니다. 세계를 여행한 선원의 이야기를 찾고 있었습니다. 매일 저녁 할아버지는 방문했던 장소와 만났던 사람들에 대해 이야기했습니다.',
};

async function epub(metadata, text = passages.en, name = 'A_filename.epub') {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/book.opf', `<package><metadata>${metadata}</metadata><manifest><item id="one" href="text/chapter%20one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>`);
  zip.file('OPS/text/chapter one.xhtml', `<html><head><title>Ignored page title</title></head><body><p>${text}</p></body></html>`);
  return new File([await zip.generateAsync({ type: 'nodebuffer' })], name, { type: 'application/epub+zip' });
}

test('EPUB preview reads main title, author roles and canonical language without making network requests', async () => {
  const file = await epub('<dc:title id="short">Short title</dc:title><dc:title id="main">Mamá &amp; papá</dc:title><meta refines="#main" property="title-type">main</meta><dc:creator id="writer">Mar&#237;a</dc:creator><meta refines="#writer" property="role">aut</meta><dc:creator opf:role="trl">Translator</dc:creator><dc:creator opf:role="aut">Second Writer</dc:creator><dc:language>spa</dc:language>', passages.pt);
  const result = await detectBookMetadata(file);
  assert.deepEqual(result, { title: 'Mamá & papá', author: 'María, Second Writer', language: 'es', titleSource: 'metadata' });
});

test('missing EPUB language is inferred from readable text; filename and unknown-language fallbacks stay editable', async () => {
  for (const [language, text] of Object.entries(passages)) {
    const result = await detectBookMetadata(await epub('', text));
    assert.equal(result.title, 'A filename'); assert.equal(result.author, '');
    assert.equal(result.language, language, language); assert.equal(result.languageSource, 'text');
  }
  const unknown = await detectBookMetadata(await epub('', 'A short line.'));
  assert.equal(unknown.language, ''); assert.equal(unknown.titleSource, 'filename');
  assert.equal(bookText('<html><head><title>Ignore</title></head><body><p>Read <em>these</em> words.</p><script>Ignore this</script></body></html>'), 'Read these words.');
  assert.equal(metadataLanguage(['und', 'pt_BR']), 'pt-BR'); assert.equal(metadataLanguage('Spanish'), '');
  assert.equal(archivePath('OPS/book.opf', 'https://external.test/chapter.xhtml'), '');
  assert.equal(inferBookLanguage('12345'), '');
  await assert.rejects(detectBookMetadata(new File(['not a ZIP'], 'bad.epub')));
});

test('server imports detect missing EPUB language and preserve manual details and subsequent corrections', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-metadata-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const library = await openLibrary(dir);
  async function upload(id, metadata, text, body = {}) {
    const file = await epub(metadata, text), bytes = Buffer.from(await file.arrayBuffer()), path = join(library.uploads, id + '.epub');
    await writeFile(path, bytes);
    const book = await library.importBook(id, { path, originalname: file.name, size: bytes.length }, body);
    assert.deepEqual(await readFile(library.filePath(library.getBook(id))), bytes);
    return book;
  }
  const metadata = '<title>Embedded title</title><creator>Embedded Author</creator>';
  const inferred = await upload('inferred', metadata, passages.pt);
  assert.equal(inferred.title, 'Embedded title'); assert.equal(inferred.author, 'Embedded Author'); assert.equal(inferred.language, 'pt');
  assert.deepEqual(inferred.languages, [], 'primary language detection does not restrict mixed-language passage analysis');
  const manual = await upload('manual', metadata + '<language>es</language>', passages.es, { title: 'My title', author: 'My author', language: 'en' });
  assert.equal(manual.title, 'My title'); assert.equal(manual.author, 'My author'); assert.equal(manual.language, 'en');
  library.editBook('inferred', { title: 'Corrected title', author: '', language: 'zh', languages: ['zh', 'en'] });
  const reopened = (await openLibrary(dir)).getBook('inferred');
  assert.equal(reopened.title, 'Corrected title'); assert.equal(reopened.author, ''); assert.equal(reopened.language, 'zh');
  assert.deepEqual(reopened.languages, ['zh', 'en']);
});

test('PDF metadata prefers XMP with Info fallbacks and canonical language', () => {
  const xmp = new Map([['dc:title', 'The PDF title'], ['dc:creator', ['First Author', 'Second Author']], ['dc:language', ['und', 'por']]]);
  assert.deepEqual(pdfMetadataValues({ info: { Title: 'Other title', Author: 'Other author', Language: 'en' }, metadata: xmp }),
    { title: 'The PDF title', author: 'First Author, Second Author', language: 'pt' });
  assert.deepEqual(pdfMetadataValues({ info: { Title: 'Untitled', Author: 'Writer', Language: 'zh_Hant' } }), { title: '', author: 'Writer', language: 'zh-Hant' });
});

test('PDF text inference uses separated page samples and always releases preview resources', async () => {
  const sampled = [], cleaned = []; let destroyed = 0;
  const file = new File(['%PDF-1.4'], 'book.pdf');
  const result = await readPdfMetadata(file, { getDocument(options) {
    assert.equal(options.isEvalSupported, false);
    return { promise: Promise.resolve({ numPages: 12, async getMetadata() { return { info: { Title: 'Title', Author: 'Writer' } }; },
      async getPage(n) { sampled.push(n); return { async getTextContent() { return { items: [{ str: passages.pt }] }; }, cleanup() { cleaned.push(n); } }; } }),
    async destroy() { destroyed++; } };
  } });
  assert.equal(result.language, 'pt'); assert.equal(result.title, 'Title');
  assert.deepEqual(sampled, [1, 4, 8, 12]); assert.deepEqual(cleaned, sampled); assert.equal(destroyed, 1);
  const signal = AbortSignal.abort();
  await assert.rejects(readPdfMetadata(file, { signal, getDocument() { assert.fail('Aborted previews must not load a PDF'); } }), { name: 'AbortError' });
});

test('password-protected PDF preview fails promptly without prompting and releases its worker', async () => {
  let destroyed = 0;
  await assert.rejects(readPdfMetadata(new File(['locked'], 'locked.pdf'), { getDocument() {
    const task = { promise: new Promise(() => {}), async destroy() { destroyed++; } };
    queueMicrotask(() => task.onPassword()); return task;
  } }), /password-protected PDF/);
  assert.ok(destroyed > 0);
});

function pdfFixture(language) {
  const lines = passages.en.match(/.{1,65}(?:\s|$)/gu);
  const content = 'BT /F1 12 Tf 40 700 Td 16 TL ' + lines.map((line) => `(${line}) Tj T*`).join(' ') + ' ET';
  const objects = [`<< /Type /Catalog /Pages 2 0 R ${language ? `/Lang (${language})` : ''} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Title (An actual PDF) /Author (Test Writer) >>'];
  let source = '%PDF-1.7\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(source)); source += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([source], 'test.pdf', { type: 'application/pdf' });
}

test('real PDF.js preview extracts embedded PDF details and infers language when absent', async (t) => {
  try { await import('@napi-rs/canvas'); } catch { t.skip('Optional Node canvas is unavailable; browser-independent PDF adapter is tested separately.'); return; }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const language of ['es-ES', '']) {
    const result = await readPdfMetadata(pdfFixture(language), { getDocument: (options) => getDocument({ ...options,
      standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)) }) });
    assert.equal(result.title, 'An actual PDF'); assert.equal(result.author, 'Test Writer');
    assert.equal(result.language, language || 'en');
  }
});
