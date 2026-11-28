import { $, element } from './ui.js';
import { maxPdfBoxes } from '../shared/pdf-regions.js';
import { hanPattern } from '../shared/language.js';

const clamp = (value) => Math.max(0, Math.min(1, value));
const boxBetween = ([x, y], [endX, endY]) => [
  Math.min(x, endX), Math.min(y, endY), Math.max(x, endX), Math.max(y, endY),
];
const styleBox = (node, [left, top, right, bottom]) => {
  Object.assign(node.style, { left: `${100 * left}%`, top: `${100 * top}%`, width: `${100 * (right - left)}%`, height: `${100 * (bottom - top)}%` });
};
const hanStart = new RegExp(`^${hanPattern}`, 'u'), hanEnd = new RegExp(`${hanPattern}$`, 'u');
const printable = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function textInPdfBoxes(sheet, boxes) {
  const page = sheet.getBoundingClientRect(), layer = $('.textLayer', sheet);
  if (!layer) return boxes.map(() => '');
  const range = sheet.ownerDocument.createRange();
  const fragments = [...layer.querySelectorAll('span, br')].flatMap((item) => {
    if (item.tagName === 'BR') return [{ lineBreak: true }];
    if (item.firstChild?.nodeType !== 3 || !item.textContent.trim()) return [];
    return [{ node: item.firstChild, bounds: item.getBoundingClientRect() }];
  });
  return boxes.map(([x1, y1, x2, y2]) => {
    const left = page.left + x1 * page.width, right = page.left + x2 * page.width;
    const top = page.top + y1 * page.height, bottom = page.top + y2 * page.height;
    let text = '';
    for (const { lineBreak, node, bounds } of fragments) {
      if (lineBreak) { if (text && !text.endsWith('\n')) text += '\n'; continue; }
      if (bounds.right <= left || bounds.left >= right || bounds.bottom <= top || bounds.top >= bottom) continue;
      let piece = node.data;
      if (bounds.left < left || bounds.right > right || bounds.top < top || bounds.bottom > bottom) {
        piece = '';
        for (const { segment, index } of printable.segment(node.data)) {
          range.setStart(node, index); range.setEnd(node, index + segment.length);
          const glyph = range.getBoundingClientRect(), x = glyph.left + glyph.width / 2, y = glyph.top + glyph.height / 2;
          if (x >= left && x <= right && y >= top && y <= bottom) piece += segment;
          else if (piece && !piece.endsWith(' ')) piece += ' ';
        }
      }
      piece = piece.trim();
      if (!piece) continue;
      if (text && !/\s$/u.test(text) && !/^[,.;:!?，。；：！？]/u.test(piece) && !(hanEnd.test(text) && hanStart.test(piece))) text += ' ';
      text += piece;
    }
    return text.trim();
  });
}

export function pdfBoxes({ preview, changed }) {
  const draw = $('#pdf-review-draw-box'), list = $('#pdf-review-boxes');
  const layer = element('div', 'pdf-box-layer');
  layer.setAttribute('aria-hidden', 'true');
  let boxes = [], drawing = false, drag, ready = false;

  function outline(box, index) {
    const mark = element('div', 'pdf-selection-box', index == null ? '' : String(index + 1));
    styleBox(mark, box);
    return mark;
  }
  function update() {
    draw.setAttribute('aria-pressed', String(drawing));
    draw.textContent = drawing ? 'Done drawing' : 'Draw boxes';
    draw.disabled = !ready || (!drawing && boxes.length >= maxPdfBoxes);
    layer.classList.toggle('drawing', drawing && ready && boxes.length < maxPdfBoxes);
    list.hidden = !boxes.length;
    for (const button of list.querySelectorAll('button')) button.disabled = !ready || button.dataset.edge === 'true';
  }
  function cancelDrag(event) {
    if (!drag) return;
    if (event && event.pointerId !== drag.pointer) return;
    drag.mark.remove();
    if (layer.hasPointerCapture(drag.pointer)) layer.releasePointerCapture(drag.pointer);
    drag = undefined;
  }
  function render() {
    layer.replaceChildren(...boxes.map(outline));
    list.replaceChildren(...boxes.map((box, index) => {
      const row = element('li', 'pdf-box-row');
      const name = element('span', '', `Box ${index + 1}`);
      row.append(name);
      function action(symbol, label, disabled, transform, focus) {
        const button = element('button', 'button quiet small', symbol);
        button.type = 'button';
        button.title = label;
        button.setAttribute('aria-label', `${label} · ${name.textContent}`);
        button.dataset.edge = String(disabled);
        button.addEventListener('click', () => {
          const next = [...boxes];
          transform(next);
          commit(next);
          const row = list.children[Math.min(focus, list.children.length - 1)];
          (row?.querySelector('button:not(:disabled)') || draw).focus({ preventScroll: true });
        });
        row.append(button);
      }
      action('↑', 'Move earlier', index === 0, (next) => next.splice(index - 1, 0, ...next.splice(index, 1)), index - 1);
      action('↓', 'Move later', index === boxes.length - 1, (next) => next.splice(index + 1, 0, ...next.splice(index, 1)), index + 1);
      action('×', 'Remove', false, (next) => next.splice(index, 1), index);
      return row;
    }));
    update();
  }
  function commit(next) {
    boxes = next;
    render();
    changed(boxes);
  }
  function point(event) {
    const rect = layer.getBoundingClientRect();
    return [clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height)];
  }
  layer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary || drag || !drawing || !ready || boxes.length >= maxPdfBoxes) return;
    event.preventDefault();
    preview.focus({ preventScroll: true });
    const start = point(event), mark = outline([...start, ...start]);
    mark.classList.add('drawing-box');
    layer.append(mark);
    drag = { start, pointer: event.pointerId, mark };
    layer.setPointerCapture(event.pointerId);
  });
  layer.addEventListener('pointermove', (event) => {
    if (drag?.pointer === event.pointerId) styleBox(drag.mark, boxBetween(drag.start, point(event)));
  });
  layer.addEventListener('pointerup', (event) => {
    if (drag?.pointer !== event.pointerId) return;
    const box = boxBetween(drag.start, point(event)).map((value) => Math.round(value * 1_000_000) / 1_000_000);
    const rect = layer.getBoundingClientRect();
    cancelDrag();
    if ((box[2] - box[0]) * rect.width >= 4 && (box[3] - box[1]) * rect.height >= 4) commit([...boxes, box]);
  });
  layer.addEventListener('pointercancel', cancelDrag);
  layer.addEventListener('lostpointercapture', cancelDrag);
  draw.addEventListener('click', () => {
    drawing = !drawing;
    if (drawing) document.getSelection()?.removeAllRanges();
    else cancelDrag();
    update();
  });
  return {
    set(value = [], { reset = false } = {}) {
      cancelDrag();
      layer.remove();
      ready = false;
      if (reset) drawing = false;
      boxes = value;
      render();
    },
    attach() {
      const sheet = $('.pdf-sheet', preview);
      if (sheet && layer.parentElement !== sheet) sheet.append(layer);
    },
    get boxes() { return boxes; },
    get attached() { return layer.isConnected; },
    enable(value) { ready = value && layer.isConnected; if (!ready) cancelDrag(); update(); },
  };
}
