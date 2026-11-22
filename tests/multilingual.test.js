import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import { readingText } from '../shared/reading-text.js';
import { languageSpans, detectLanguage, characterProfile } from '../shared/language.js';
import { pinyinCharacters, toneMarks } from '../shared/mandarin-pinyin.js';
import { openMandarin } from '../server/mandarin.js';
import { addVocabulary, vocabularySummary } from '../server/vocabulary.js';
import { voiceFor, narrationOptions, sectionLanguages } from '../server/language-voices.js';
import { languageChunks } from '../server/book-text.js';
import { annotateSyncPaths, koReaderXPath, resolveKOReaderXPath, positionFraction } from '../shared/epub-sync-position.js';

test('mixed EPUB language spans honor paragraph and inline tags with stable source offsets', () => {
  const root = new DOMParser().parseFromString('<body lang="en"><p>I study 中文 every day.</p><p xml:lang="pt-BR">As pessoas estavam lendo livros na biblioteca.</p><p lang="ja">日本語</p><p lang="zh-Hant">我喜歡學習漢語。</p></body>', 'text/xml');
  const content = readingText(root), spans = languageSpans(content, 'en');
  assert.deepEqual([...new Set(spans.map((part) => part.language))], ['en', 'zh', 'pt', 'ja']);
  const chunks = languageChunks({ text: content.text, languages: spans }, 12, 'en');
  for (const part of chunks) assert.equal(content.text.slice(part.from, part.to), part.text);
  assert.ok(chunks.some((part) => part.language === 'pt' && part.text.includes('pessoas')));
  assert.ok(chunks.some((part) => part.language === 'zh' && part.text.includes('中文')));
  assert.ok(chunks.some((part) => part.language === 'ja' && part.text.includes('日本語')));
  assert.equal(detectLanguage('As pessoas estavam lendo os livros na biblioteca durante toda a tarde.', 'en'), 'pt');
});

test('Mandarin vocabulary totals never combine Han characters with English or Portuguese lemmas', () => {
  const groups = new Map();
  addVocabulary(groups, 'en', { method: 'contextual', tokens: [1, 2, 3], lemmas: ['read', 'book'] });
  addVocabulary(groups, 'pt', { method: 'contextual', tokens: [1, 2, 3, 4], lemmas: ['ler', 'livro'] });
  addVocabulary(groups, 'es', { method: 'contextual', tokens: [1, 2, 3], lemmas: ['leer', 'libro'] });
  addVocabulary(groups, 'zh', { method: 'characters', tokens: [1, 2, 3, 4], lemmas: ['中', '文'] });
  const metrics = vocabularySummary('中文中文𠮷', groups, 'zh-Hant');
  assert.equal(metrics.unit, 'characters'); assert.equal(metrics.count, 3);
  assert.equal(metrics.lemmaCount, 6); assert.equal(metrics.characterCount, 3);
  assert.deepEqual(metrics.byLanguage, [
    { language: 'zh', unit: 'characters', count: 3, total: 5 },
    { language: 'en', unit: 'lemmas', count: 2, total: 3 },
    { language: 'es', unit: 'lemmas', count: 2, total: 3 },
    { language: 'pt', unit: 'lemmas', count: 2, total: 4 },
  ]);
  const english = vocabularySummary('中文中文𠮷', groups, 'en');
  assert.equal(english.count, 2); assert.equal(english.characterCount, 3);
  assert.equal(characterProfile('我我🙂A文').total, 3);
});

test('pinyin preserves character offsets and distinguishes contextual polyphonic readings and neutral tones', () => {
  const text = '🙂银行音乐快乐 hello';
  const parts = pinyinCharacters(text);
  assert.deepEqual(parts.map((part) => part.pinyin), ['yín', 'háng', 'yīn', 'yuè', 'kuài', 'lè']);
  assert.equal(parts[0].from, 2);
  for (const part of parts) assert.equal(text.slice(part.from, part.to), part.character);
  assert.equal(toneMarks('nu:3 hai2 zi5'), 'nǚ hái zi');
  assert.equal(toneMarks('dong1 xi5'), 'dōng xi');
});

test('Mandarin dictionary returns whole-word senses and each character, in both scripts and without invented rare-character entries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-mandarin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'test.sqlite'), db = new DatabaseSync(path);
  db.exec('CREATE TABLE words(word TEXT,traditional TEXT,simplified TEXT,pinyin TEXT,meanings TEXT); CREATE TABLE characters(character TEXT PRIMARY KEY,pinyin TEXT,meaning TEXT)');
  const add = (word, pinyin, meanings, traditional = word, simplified = word) => db.prepare('INSERT INTO words VALUES(?,?,?,?,?)').run(word, traditional, simplified, pinyin, JSON.stringify(meanings));
  add('银行', 'yin2 hang2', ['bank'], '銀行', '银行'); add('銀行', 'yin2 hang2', ['bank'], '銀行', '银行');
  add('银', 'yin2', ['silver']); add('銀', 'yin2', ['silver']); add('行', 'hang2', ['line of business']); add('行', 'xing2', ['to walk']);
  add('东西', 'dong1 xi5', ['thing']); add('东', 'dong1', ['east']); add('西', 'xi1', ['west']);
  add('中国', 'Zhong1 guo2', ['China']); add('中', 'Zhong1', ['surname Zhong']); add('中', 'zhong1', ['middle']); add('国', 'guo2', ['country']);
  add('一', 'yi1', ['one']);
  db.prepare('INSERT INTO characters VALUES(?,?,?)').run('𠀀', 'hē', 'character dictionary fixture');
  db.close();
  const dictionary = openMandarin(path); t.after(() => dictionary.close());
  for (const text of ['我去银行。', '我去銀行。']) {
    const result = dictionary.lookup({ text, offset: text.indexOf('行') });
    assert.equal(result.pinyin, 'yín háng');
    assert.equal(result.senses[0].meanings[0], 'bank');
    assert.equal(result.characters.length, 2);
    assert.equal(result.characters[1].pinyin, 'háng');
    assert.ok(result.characters[1].readings.includes('xíng'));
  }
  const compound = dictionary.lookup({ text: '这是东西。', offset: 2 });
  assert.ok(compound.senses.some((sense) => sense.meanings.includes('thing')));
  assert.deepEqual(compound.characters.map((part) => part.meanings[0]), ['east', 'west']);
  const china = dictionary.lookup({ text: '中国', offset: 0 });
  assert.equal(china.senses[0].meanings[0], 'China');
  assert.equal(china.characters[0].meanings[0], 'middle');
  assert.equal(dictionary.lookup({ text: '⼀', offset: 0 }).characters[0].meanings[0], 'one');
  const supplementary = dictionary.lookup({ text: '𠀀', offset: 1 });
  assert.equal(supplementary.word, '𠀀'); assert.equal(supplementary.characters[0].source, 'Unicode Unihan');
  assert.equal(dictionary.lookup({ text: '𠮷', offset: 0 }).characters[0].meanings.length, 0);
  for (const invalid of [{ text: 'hello', offset: 0 }, { text: '中', offset: -1 }, { text: '中', offset: 1 }, { text: '中'.repeat(501), offset: 0 }]) assert.throws(() => dictionary.lookup(invalid));
});

test('source ruby pronunciation is excluded from readable text and progress fractions without changing XPath anchors', () => {
  const root = new DOMParser().parseFromString('<body><p><ruby>中文<rt>zhōng wén</rt><rp>()</rp></ruby> english</p></body>', 'text/xml').documentElement;
  const node = root.firstChild.firstChild.firstChild;
  annotateSyncPaths(root, 0);
  assert.equal(readingText(root).text, '中文 english');
  const xpath = koReaderXPath(root, node, 1, 0);
  assert.equal(resolveKOReaderXPath(root, xpath).node, node);
  assert.equal(positionFraction(root, node, 1), 1 / 10);
});

test('language voices route Mandarin, Portuguese and English while retaining compatible monolingual caches', () => {
  const config = { voice: 'ef_dora', model: 'kokoro', speed: 1, baseUrl: 'http://kokoro/v1', autoLanguageVoices: true };
  assert.equal(voiceFor(config, 'zh-Hant'), 'zf_xiaobei');
  assert.equal(voiceFor(config, 'pt-PT'), 'pf_dora');
  assert.equal(voiceFor(config, 'en'), 'af_heart');
  assert.equal(voiceFor({ ...config, voicesByLanguage: { pt: 'my-european-portuguese' } }, 'pt-PT'), 'my-european-portuguese');
  assert.equal(voiceFor({ ...config, autoLanguageVoices: false }, 'zh'), 'ef_dora');
  assert.deepEqual(narrationOptions(config, ['es']), { voice: 'ef_dora', model: 'kokoro', speed: 1, baseUrl: 'http://kokoro/v1' });
  assert.deepEqual(narrationOptions(config, ['zh', 'en', 'pt']).voiceMap, { zh: 'zf_xiaobei', en: 'af_heart', pt: 'pf_dora' });
  assert.deepEqual(sectionLanguages([{ languages: JSON.stringify([{ language: 'en' }, { language: 'zh' }]) }], 'pt'), ['en', 'zh']);
});
