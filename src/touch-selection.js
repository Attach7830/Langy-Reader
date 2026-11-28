import { caretAt } from './words.js';

export function touchSelection({ roots, changed }) {
  const viewer = document.querySelector('#viewer');
  const handles = document.querySelector('#selection-handles');
  let selection, drag;
  const connected = () => {
    const root = selection?.root, win = root?.ownerDocument.defaultView;
    return root?.isConnected && (win === window || win?.frameElement?.isConnected);
  };

  function place() {
    if (!connected()) {
      handles.hidden = true;
      return;
    }
    const { root, range } = selection;
    const frame = root.ownerDocument.defaultView.frameElement?.getBoundingClientRect();
    const clip = viewer.getBoundingClientRect();
    handles.hidden = false;
    for (const handle of handles.children) {
      const start = handle.dataset.selectionEdge === 'start', edge = range.cloneRange();
      edge.collapse(start);
      const rect = edge.getBoundingClientRect();
      const x = rect.left + (frame?.left || 0), y = (start ? rect.top : rect.bottom) + (frame?.top || 0);
      handle.hidden = !rect.height || x < clip.left || x > clip.right || y < clip.top || y > clip.bottom;
      handle.style.left = `${x}px`; handle.style.top = `${y}px`;
    }
  }

  function clear() {
    if (!selection) return;
    const { root, range, native } = selection;
    root.ownerDocument.defaultView?.CSS?.highlights?.delete('langy-passage');
    if (native.rangeCount && native.getRangeAt(0) === range) native.removeAllRanges();
    selection = drag = undefined;
    handles.hidden = true;
  }

  function boundary(x, y) {
    const { root } = selection, doc = root.ownerDocument;
    const frame = doc.defaultView.frameElement?.getBoundingClientRect(), clip = viewer.getBoundingClientRect();
    const insideX = Math.max(clip.left, Math.min(clip.right - 1, x)) - (frame?.left || 0);
    const insideY = Math.max(clip.top, Math.min(clip.bottom - 1, y)) - (frame?.top || 0);
    const point = caretAt(doc, insideX, insideY);
    return point?.node.nodeType === 3 && root.contains(point.node) ? point : null;
  }

  function extend(x, y, edge, word) {
    if (!connected()) return;
    const point = boundary(x, y);
    if (!point) return;
    const { node, offset } = point, { original, range } = selection;
    if (!edge) {
      const side = original.comparePoint(node, offset);
      range.setStart(original.startContainer, original.startOffset);
      range.setEnd(original.endContainer, original.endOffset);
      if (side < 0) range.setStart(node, word?.node === node ? word.index : offset);
      else if (side > 0) range.setEnd(node, word?.node === node ? word.index + word.word.length : offset);
    } else {
      const opposite = range.cloneRange();
      opposite.collapse(edge === 'end');
      if (opposite.comparePoint(node, offset) !== (edge === 'start' ? -1 : 1)) return;
      if (edge === 'start') range.setStart(node, offset);
      else range.setEnd(node, offset);
    }
    place();
  }

  for (const handle of handles.children) {
    const edge = handle.dataset.selectionEdge;
    const start = edge === 'start';
    handle.addEventListener('pointerdown', (event) => {
      if (!selection || drag || event.button !== 0) return;
      event.preventDefault();
      const rect = handle.getBoundingClientRect();
      drag = { id: event.pointerId, dx: event.clientX - (rect.left + rect.width / 2), dy: event.clientY - (start ? rect.bottom : rect.top) };
      handle.setPointerCapture(event.pointerId);
      changed(true);
    });
    handle.addEventListener('pointermove', (event) => {
      if (drag?.id !== event.pointerId) return;
      extend(event.clientX - drag.dx, event.clientY - drag.dy + (start ? 1 : -1), edge);
    });
    handle.addEventListener('lostpointercapture', (event) => {
      if (drag?.id !== event.pointerId) return;
      drag = undefined;
      changed(false);
    });
  }

  return {
    get active() { return Boolean(connected()); },
    range(root) { return selection?.root === root && connected() ? selection.range : null; },
    clear, place,
    start(word) {
      const root = roots().find((item) => item.contains(word.node));
      if (!root?.isConnected || word.node.data.slice(word.index, word.index + word.word.length) !== word.word) return null;
      clear();
      const doc = root.ownerDocument, range = doc.createRange();
      range.setStart(word.node, word.index);
      range.setEnd(word.node, word.index + word.word.length);
      const native = doc.getSelection();
      native.removeAllRanges();
      const current = selection = { root, range, native, original: range.cloneRange() };
      const win = doc.defaultView;
      if (win.CSS?.highlights && win.Highlight) win.CSS.highlights.set('langy-passage', new win.Highlight(range));
      else native.addRange(range);
      place();
      changed(true);
      return {
        extend({ x, y }, word) { if (selection === current) extend(x, y, undefined, word); },
        finish() { if (selection === current) changed(false); },
      };
    },
  };
}
