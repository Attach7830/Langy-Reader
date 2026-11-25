import { readingText } from '../shared/reading-text.js';
import { hanPattern, nodeLanguage, bookLanguages } from '../shared/language.js';
import { pdfPinyinLayout } from './pinyin-layout.js';

export function pinyinToolbar({ button, preferences, book, change }) {
  function refresh() {
    const settings = preferences();
    button.hidden = !book() || Boolean(book().l1Folder) || !bookLanguages(book()).includes('zh');
    button.setAttribute('aria-pressed', String(settings.showPinyin));
    button.title = `${settings.showPinyin ? 'Hide' : 'Show'} pinyin${settings.keys?.pinyin ? ` (${settings.keys.pinyin.toUpperCase()})` : ''}`;
  }
  button.addEventListener('click', () => { if (!button.hidden) { change(!preferences().showPinyin); refresh(); } });
  refresh(); return { refresh };
}

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
    if (epoch !== serial || !book() || book().l1Folder || !preferences().showPinyin) return;
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
        if (nodeLanguage(run.node, book().language, character.character, bookLanguages(book())) !== 'zh') continue;
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
      // Stable passage boundaries survive page size, font and viewport changes.
      let from = Math.max(0, Math.floor(visible[0].character.from / 10000) * 10000 - 24);
      if (/[\uDC00-\uDFFF]/u.test(data.content.text[from])) from--;
      const to = Math.min(data.content.text.length, Math.ceil(visible.at(-1).character.to / 10000) * 10000 + 24);
      if (to - from > 30000) continue;
      const key = `${from}:${to}`;
      let pronunciation = data.pages.get(key);
      if (!pronunciation) {
        try {
          const path = book().id ? `/api/books/${encodeURIComponent(book().id)}/pinyin` : '/api/mandarin/pinyin';
          pronunciation = (await request(path, { method: 'POST', signal, body: { text: data.content.text.slice(from, to) } })).characters;
          data.pages.set(key, pronunciation);
          if (data.pages.size > 12) data.pages.delete(data.pages.keys().next().value);
        } catch (error) { if (error.name === 'AbortError') return; continue; }
      }
      const readings = new Map(pronunciation.map((item) => [item.from + from, item.pinyin]));
      const pdf = root.classList.contains('textLayer');
      if (pdf) for (const placed of pdfPinyinLayout(visible.filter((item) => !item.vertical).map((item) => ({ ...item, pinyin: readings.get(item.character.from) })).filter((item) => item.pinyin), viewport)) {
        const label = document.createElement('span'); label.textContent = placed.text; label.lang = 'zh-Latn';
        label.style.cssText = `left:${placed.left - origin.left}px;top:${placed.top - origin.top}px;width:${placed.width}px;font-size:${placed.size}px`;
        labels.push(label);
      }
      for (const item of visible) {
        if (pdf && !item.vertical) continue;
        const pinyin = readings.get(item.character.from);
        if (!pinyin) continue;
        const width = item.vertical ? item.rect.height : item.rect.width;
        const fontSize = pdf ? item.rect.width : item.fontSize;
        const size = Math.min(fontSize * .43, width / Math.max(1, pinyin.length * .56));
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
    if (book() && !book().l1Folder && preferences().showPinyin) scheduled = requestAnimationFrame(() => { scheduled = requestAnimationFrame(() => { void draw(epoch); }); });
  }
  host.addEventListener('scroll', refresh, { passive: true });
  new ResizeObserver(refresh).observe(host);
  window.addEventListener('resize', refresh, { passive: true });
  return { refresh, clear };
}
