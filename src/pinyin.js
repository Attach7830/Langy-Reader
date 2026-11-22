import { readingText } from '../shared/reading-text.js';
import { hanPattern, nodeLanguage } from '../shared/language.js';

// Draw pronunciation beside original text ranges. The EPUB/PDF text and its
// position paths are never wrapped, split or replaced with ruby annotations.
export function pinyinOverlay({ host, preferences, renderer, book, request }) {
  const layer = document.createElement('div');
  layer.className = 'pinyin-layer'; layer.setAttribute('aria-hidden', 'true');
  host.parentElement.append(layer);
  const cache = new WeakMap();
  let serial = 0, scheduled, controller;
  function clear() { serial++; controller?.abort(); cancelAnimationFrame(scheduled); layer.replaceChildren(); layer.hidden = true; }
  async function draw(epoch) {
    if (epoch !== serial || !book() || !preferences().showPinyin) return;
    const roots = renderer()?.readingRoots?.() || [renderer()?.audioUnit?.()?.root].filter(Boolean);
    if (!roots.length) return;
    controller = new AbortController();
    const signal = controller.signal;
    const viewport = host.getBoundingClientRect(), origin = host.parentElement.getBoundingClientRect();
    const labels = [];
    for (const root of roots) {
      if (!root.isConnected) continue;
      let data = cache.get(root);
      if (!data) {
        const content = readingText(root);
        data = { content, pages: new Map(), characters: [...content.text.matchAll(new RegExp(hanPattern, 'gu'))]
          .map((match) => ({ character: match[0], from: match.index, to: match.index + match[0].length })) };
        cache.set(root, data);
      }
      if (epoch !== serial) return;
      const doc = root.ownerDocument, frame = doc.defaultView.frameElement?.getBoundingClientRect();
      let runIndex = 0;
      const visible = [];
      for (const character of data.characters) {
        while (runIndex < data.content.runs.length && data.content.runs[runIndex].end <= character.from) runIndex++;
        const run = data.content.runs[runIndex];
        if (!run || run.end < character.to || !run.node.isConnected) continue;
        if (nodeLanguage(run.node, book().language, character.character) !== 'zh') continue;
        const range = doc.createRange();
        range.setStart(run.node, run.offset + character.from - run.start);
        range.setEnd(run.node, run.offset + character.to - run.start);
        const rect = [...range.getClientRects()].find((item) => item.width > 0 && item.height > 0);
        if (!rect) continue;
        const left = rect.left + (frame?.left || 0), top = rect.top + (frame?.top || 0);
        if (left < viewport.left - 1 || left + rect.width > viewport.right + 1 || top < viewport.top || top + rect.height > viewport.bottom + 1) continue;
        const style = doc.defaultView.getComputedStyle(run.node.parentElement);
        if (style.visibility === 'hidden' || style.opacity === '0' || run.node.parentElement.closest('ruby,rt,rp')) continue;
        visible.push({ character, rect, left, top, vertical: style.writingMode.startsWith('vertical'), fontSize: Number.parseFloat(style.fontSize) || preferences().size });
      }
      if (!visible.length) continue;
      let from = Math.max(0, visible[0].character.from - 24);
      if (/[\uDC00-\uDFFF]/u.test(data.content.text[from])) from--;
      const to = Math.min(data.content.text.length, visible.at(-1).character.to + 24);
      if (to - from > 30000) continue;
      const key = `${from}:${to}`;
      let pronunciation = data.pages.get(key);
      if (!pronunciation) {
        try {
          pronunciation = (await request('/api/mandarin/pinyin', { method: 'POST', signal, body: { text: data.content.text.slice(from, to) } })).characters;
          data.pages.set(key, pronunciation);
          if (data.pages.size > 12) data.pages.delete(data.pages.keys().next().value);
        } catch (error) { if (error.name === 'AbortError') return; continue; }
      }
      const readings = new Map(pronunciation.map((item) => [item.from + from, item.pinyin]));
      for (const item of visible) {
        const pinyin = readings.get(item.character.from);
        if (!pinyin) continue;
        const width = item.vertical ? item.rect.height : item.rect.width;
        const size = Math.min(item.fontSize * .43, width / Math.max(1, pinyin.length * .56));
        const label = document.createElement('span');
        label.textContent = pinyin; label.lang = 'zh-Latn';
        label.style.cssText = item.vertical
          ? `left:${item.left + item.rect.width + size + 2 - origin.left}px;top:${item.top - origin.top}px;width:${width}px;font-size:${size}px;transform:rotate(90deg);transform-origin:0 0`
          : `left:${item.left - origin.left}px;top:${item.top - origin.top - size * 1.15}px;width:${width}px;font-size:${size}px`;
        labels.push(label);
      }
    }
    if (epoch !== serial) return;
    layer.replaceChildren(...labels); layer.hidden = !labels.length;
  }
  function refresh() {
    clear(); const epoch = serial;
    if (book() && preferences().showPinyin) scheduled = requestAnimationFrame(() => { scheduled = requestAnimationFrame(() => { void draw(epoch); }); });
  }
  host.addEventListener('scroll', refresh, { passive: true });
  new ResizeObserver(refresh).observe(host);
  window.addEventListener('resize', refresh, { passive: true });
  return { refresh, clear };
}
