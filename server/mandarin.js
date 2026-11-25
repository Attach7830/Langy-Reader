import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { hasHan, hanPattern } from '../shared/language.js';
import { pinyinCharacters, toneMarks } from '../shared/mandarin-pinyin.js';
import { RequestError } from './books.js';

export const mandarinFile = fileURLToPath(new URL('./thesaurus-data/mandarin.sqlite', import.meta.url));
export function openMandarin(path = mandarinFile) {
  const identity = existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'fallback';
  const revision = `pinyin-pro-3.29.5-cedict-v1-${identity}`;
  const db = existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : null;
  const find = db?.prepare('SELECT traditional,simplified,pinyin,meanings FROM words WHERE word=? ORDER BY rowid');
  const character = db?.prepare('SELECT pinyin,meaning FROM characters WHERE character=?');
  const characterData = (point) => character?.get(point) || character?.get(point.normalize('NFKC'));
  const entries = (word) => {
    let rows = find?.all(word) || [];
    if (!rows.length && word.normalize('NFKC') !== word) rows = find?.all(word.normalize('NFKC')) || [];
    return rows.map((row) => ({ ...row, pinyin: toneMarks(row.pinyin), meanings: JSON.parse(row.meanings) }))
      .sort((a, b) => Number(/^[A-Z]/u.test(a.pinyin)) - Number(/^[A-Z]/u.test(b.pinyin)));
  };
  const unique = (items) => [...new Set(items)];
  function pronounce(text) {
    const parts = pinyinCharacters(text), byOffset = new Map(parts.map((part) => [part.from, part]));
    for (const segment of new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)) {
      if (!hasHan(segment.segment)) continue;
      const readings = unique(entries(segment.segment).map((row) => row.pinyin.toLowerCase()));
      if (readings.length !== 1) continue;
      const syllables = readings[0].split(/\s+/u), points = [...segment.segment];
      if (syllables.length !== points.length) continue;
      let from = segment.index;
      for (const [index, point] of points.entries()) {
        const part = byOffset.get(from); if (part) part.pinyin = syllables[index]; from += point.length;
      }
    }
    for (const part of parts) if (!part.pinyin) part.pinyin = characterData(part.character)?.pinyin?.split(' ')[0] || entries(part.character)[0]?.pinyin || '';
    return parts;
  }
  function lookup(body) {
    const text = typeof body.text === 'string' ? body.text : '';
    const offset = body.offset;
    if (!text || text.length > 500 || !Number.isInteger(offset) || offset < 0 || offset >= text.length) throw new RequestError(422, 'Choose a Chinese character in its surrounding text.');
    // A browser caret can point to either UTF-16 half of a supplementary ideograph.
    const at = /[\uDC00-\uDFFF]/u.test(text[offset]) && offset ? offset - 1 : offset;
    const run = [...text.matchAll(new RegExp(`${hanPattern}+`, 'gu'))].find((item) => item.index <= at && item.index + item[0].length > at);
    if (!run) throw new RequestError(422, 'Choose a Chinese character.');
    const segmented = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(run[0])];
    const segment = segmented.find((item) => run.index + item.index <= at && run.index + item.index + item.segment.length > at);
    let from = run.index + segment.index, word = segment.segment, senses = entries(word);
    if (!senses.length) {
      const points = []; let index = run.index;
      for (const point of run[0]) { points.push({ point, index }); index += point.length; }
      const hit = points.findIndex((point) => point.index <= at && point.index + point.point.length > at);
      const candidates = [];
      for (let a = Math.max(0, hit - 15); a <= hit; a++) for (let b = hit + 1; b <= Math.min(points.length, a + 16); b++) {
        const candidate = points.slice(a, b).map((point) => point.point).join('');
        if (candidate.length <= 1) continue;
        const found = entries(candidate);
        if (found.length) candidates.push({ word: candidate, from: points[a].index, senses: found });
      }
      candidates.sort((a, b) => [...b.word].length - [...a.word].length);
      if (candidates.length) ({ word, from, senses } = candidates[0]);
      else { word = String.fromCodePoint(text.codePointAt(at)); from = at; senses = entries(word); }
    }
    const context = pronounce(text);
    const parts = context.filter((item) => item.from >= from && item.to <= from + word.length);
    const knownReadings = unique(senses.map((sense) => sense.pinyin.toLowerCase()));
    const pronunciation = knownReadings.length === 1 ? knownReadings[0] : parts.map((item) => item.pinyin).filter(Boolean).join(' ');
    const syllables = pronunciation.split(/\s+/u);
    if (knownReadings.length === 1 && syllables.length === parts.length) parts.forEach((part, index) => { part.pinyin = syllables[index]; });
    senses.sort((a, b) => Number(b.pinyin.toLowerCase() === pronunciation.toLowerCase()) - Number(a.pinyin.toLowerCase() === pronunciation.toLowerCase()));
    const characters = parts.map((item) => {
      const rows = entries(item.character), fallback = characterData(item.character);
      const sameReading = rows.filter((row) => row.pinyin.toLowerCase() === item.pinyin.toLowerCase());
      const common = sameReading.filter((row) => row.pinyin === row.pinyin.toLowerCase());
      const matched = common.length ? common : sameReading;
      const readings = unique([...rows.map((row) => row.pinyin), ...item.readings, ...(fallback?.pinyin?.split(' ') || [])].map((reading) => reading.toLowerCase()));
      return { character: item.character, pinyin: item.pinyin.toLowerCase() || readings[0] || '', readings,
        meanings: unique((matched.length ? matched : rows).flatMap((row) => row.meanings)).slice(0, 8),
        ...(fallback?.meaning && !rows.length ? { meanings: [fallback.meaning], source: 'Unicode Unihan' } : { source: 'CC-CEDICT' }) };
    });
    return { word, from, to: from + word.length, language: 'zh', available: Boolean(db),
      pinyin: knownReadings.length > 1 ? knownReadings.join(' / ') : pronunciation || senses[0]?.pinyin || characters.map((item) => item.pinyin).join(' '),
      senses: senses.slice(0, 8), characters,
      source: 'CC-CEDICT / Unicode Unihan',
      note: 'Character meanings are separate clues; they do not necessarily compose the meaning of the whole word.' };
  }
  function readings(body) {
    if (typeof body.characters !== 'string' || [...body.characters].length > 256) throw new RequestError(422, 'Request up to 256 Chinese character readings.');
    return { characters: [...new Set([...body.characters])].filter(hasHan).map((point) => {
      const row = characterData(point);
      return { character: point, pinyin: row?.pinyin?.split(' ')[0] || entries(point)[0]?.pinyin || '' };
    }) };
  }
  function annotation(body) {
    if (typeof body.text !== 'string' || body.text.length > 30000) throw new RequestError(422, 'Pinyin supports passages of up to 30,000 characters.');
    return { characters: pronounce(body.text).map(({ character, from, to, pinyin }) => ({ character, from, to, pinyin })) };
  }
  return { lookup, readings, annotation, revision, close: () => db?.close() };
}
