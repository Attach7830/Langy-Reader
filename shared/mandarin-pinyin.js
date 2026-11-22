import { pinyin, convert } from 'pinyin-pro';
import { hasHan } from './language.js';

export const toneMarks = (text) => convert(text.replaceAll('u:', 'ü').replaceAll('U:', 'Ü').replace(/([a-züA-ZÜ]+)[05]\b/gu, '$1'));
export function pinyinCharacters(text) {
  let from = 0;
  return pinyin(text, { type: 'all', toneSandhi: false }).map((item) => {
    const offset = from; from += item.origin.length;
    return { character: item.origin, from: offset, to: from, pinyin: item.isZh ? item.pinyin : '',
      readings: item.polyphonic || [], han: hasHan(item.origin) };
  }).filter((item) => item.han);
}
