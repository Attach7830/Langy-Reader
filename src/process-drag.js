export function processDrag(list, dialog, { move, refresh }) {
  let drag, frame;

  function setTarget(card, position) {
    if (drag.target) delete drag.target.dataset.dropPosition;
    drag.target = card;
    if (card) card.dataset.dropPosition = position;
  }

  function updateTarget() {
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    if (drag.x < left || drag.x > right || drag.y < top || drag.y > bottom) {
      setTarget(null); return;
    }
    const cards = [...list.children].filter((card) => card !== drag.card && card.hasAttribute('data-process-draggable'));
    const nearest = cards.find((card) => card.getBoundingClientRect().bottom >= drag.y) || cards.at(-1);
    if (!nearest) { setTarget(null); return; }
    const bounds = nearest.getBoundingClientRect();
    setTarget(nearest, drag.y < bounds.top + bounds.height / 2 ? 'before' : 'after');
  }

  function scroll() {
    frame = requestAnimationFrame(scroll);
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    if (drag.x < left || drag.x > right || drag.y < top || drag.y > bottom) return;
    const step = drag.y < top + 42 ? -12 : drag.y > bottom - 42 ? 12 : 0;
    if (!step) return;
    const previous = dialog.scrollTop;
    dialog.scrollTop += step;
    if (previous !== dialog.scrollTop) updateTarget();
  }

  function end(event, drop = false) {
    if (!drag || event && event.pointerId !== drag.pointer) return;
    const { target, card, pointer } = drag, position = target?.dataset.dropPosition;
    cancelAnimationFrame(frame); frame = undefined;
    setTarget(null); delete card.dataset.dragging;
    drag = undefined;
    if (list.hasPointerCapture(pointer)) list.releasePointerCapture(pointer);
    if (drop && target && position) void move(card.dataset.process, target.dataset.process, position);
    else refresh();
  }

  list.addEventListener('pointerdown', (event) => {
    const card = event.target.closest?.('[data-process-drag-handle]')?.closest('[data-process-draggable]');
    if (!card || drag || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    drag = { card, pointer: event.pointerId, startX: event.clientX, startY: event.clientY };
    list.setPointerCapture(event.pointerId);
  });
  list.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const { clientX: x, clientY: y } = event;
    if (!frame && Math.hypot(x - drag.startX, y - drag.startY) < 5) return;
    Object.assign(drag, { x, y });
    if (!frame) { drag.card.dataset.dragging = ''; scroll(); }
    updateTarget();
  });
  list.addEventListener('pointerup', (event) => end(event, true));
  list.addEventListener('pointercancel', (event) => end(event));
  list.addEventListener('lostpointercapture', (event) => end(event));
  dialog.addEventListener('close', () => end());
  return { get active() { return Boolean(drag); }, cancel: () => end() };
}
