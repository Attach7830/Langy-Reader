const interactive = 'a,button,input,select,textarea,label,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[data-page-navigation-ignore],.reader-message';
const doubleTapDelay = 320;

export function pageNavigation({ host, turn, enabled = () => true, canSwipe = () => true, canDoubleTap = () => true,
  canCenterTap = () => false, centerTap = () => {}, centerDoubleTap, wordAt = () => false, swipeUp, swipeDown,
  pinch: onPinch, canPan = () => false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const bindings = new Map(), pointers = new Map(), doc = host.ownerDocument, viewport = doc.defaultView.visualViewport;
  const originalTouch = host.style.touchAction;
  let gesture, pinch, multi = false, suppressUntil = 0, lastTap, tapTimer;
  const zoomed = () => (viewport?.scale || 1) > 1.01;
  const ignored = (target) => Boolean((target?.nodeType === 1 ? target : target?.parentElement)?.closest?.(interactive));
  const selection = (source) => [source, doc].some((item) => item.getSelection?.() && !item.getSelection().isCollapsed);
  const inside = (p, rect) => p && p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
  const consume = (event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
  const clearTap = () => { clearTimer(tapTimer); tapTimer = undefined; lastTap = undefined; };
  function point(event, source) {
    let x = event.clientX, y = event.clientY, win = source.defaultView;
    if (!win) return null;
    while (win !== doc.defaultView) {
      const frame = win.frameElement; if (!frame?.isConnected || !host.contains(frame)) return null;
      const box = frame.getBoundingClientRect();
      x = box.left + (x + frame.clientLeft) * (frame.offsetWidth ? box.width / frame.offsetWidth : 1);
      y = box.top + (y + frame.clientTop) * (frame.offsetHeight ? box.height / frame.offsetHeight : 1);
      win = frame.ownerDocument.defaultView;
    }
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  function zone(p) {
    const box = host.getBoundingClientRect(); if (!inside(p, box)) return null;
    return p.x < box.left + box.width / 3 ? -1 : p.x > box.left + box.width * 2 / 3 ? 1 : 0;
  }
  function policy() {
    const action = zoomed() || canPan() ? 'auto' : 'none';
    host.style.touchAction = action; host.classList.toggle('reader-native-zoom', zoomed());
    const css = 'html,body,body * {touch-action:' + action + ' !important;}';
    for (const { style } of bindings.values()) if (style && style.textContent !== css) style.textContent = css;
  }
  function reset() {
    clearTap(); if (pinch) onPinch?.({ phase: 'cancel', factor: pinch.factor });
    gesture = pinch = undefined; pointers.clear(); multi = false; suppressUntil = 0;
  }
  function pair() {
    const [a, b] = [...pointers.values()]; if (!a || !b) return null;
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
  function release(event, source) {
    const id = event.pointerId ?? 1, current = point(event, source), previous = gesture;
    pointers.delete(id);
    if (multi) {
      consume(event); suppressUntil = now() + 700;
      if (!pointers.size) {
        const value = pinch; pinch = gesture = undefined; multi = false;
        if (value) onPinch?.({ phase: value.changed ? 'end' : 'cancel', factor: value.factor, center: value.center });
      }
      return;
    }
    if (!previous || previous.id !== id) return;
    gesture = undefined;
    if (!current || !enabled() || selection(source) || now() - previous.time > 1000) { clearTap(); suppressUntil = now() + 700; return; }
    const dx = current.x - previous.start.x, dy = current.y - previous.start.y;
    const distance = Math.hypot(dx, dy), elapsed = now() - previous.time;
    const threshold = Math.min(72, Math.max(38, previous.width * .12));
    if (previous.type === 'touch' && !zoomed() && !canPan() && distance >= threshold) {
      let handled = false;
      if (Math.abs(dx) > Math.abs(dy) * 1.4 && canSwipe()) { clearTap(); consume(event); turn(dx < 0 ? 1 : -1); handled = true; }
      else if (Math.abs(dy) > Math.abs(dx) * 1.5 && (dy < 0 ? swipeUp : swipeDown)) { clearTap(); consume(event); (dy < 0 ? swipeUp : swipeDown)(); handled = true; }
      if (handled) { suppressUntil = now() + 700; return; }
    }
    if (previous.moved || distance > 10 || elapsed > 550 || ignored(event.target)) { clearTap(); suppressUntil = now() + 700; if (previous.type === 'touch') consume(event); return; }
    if (previous.type !== 'touch' || zoomed()) return;
    const side = zone(current); if (side == null || side !== zone(previous.start)) return;
    const doubled = lastTap && lastTap.doc === source && lastTap.side === side && now() - lastTap.time <= doubleTapDelay
      && Math.hypot(current.x - lastTap.point.x, current.y - lastTap.point.y) <= 30;
    if (doubled && (side === 0 ? centerDoubleTap : canDoubleTap())) {
      clearTap(); consume(event); suppressUntil = now() + 700;
      if (side === 0) centerDoubleTap(); else turn(side);
      return;
    }
    clearTap(); lastTap = { doc: source, side, point: current, time: now() };
    if (side === 0 && canCenterTap() && !wordAt(event)) tapTimer = setTimer(() => {
      const pending = lastTap; clearTap();
      if (pending && enabled() && !selection(source)) centerTap();
    }, doubleTapDelay);
  }
  function bind(root) {
    if (!root || bindings.has(root)) return bindings.get(root)?.unbind || (() => {});
    for (const item of [...bindings.values()]) if (item.frame && !item.frame.isConnected) item.unbind();
    const source = root.nodeType === 9 ? root : root.ownerDocument, frame = source.defaultView?.frameElement;
    const style = root.nodeType === 9 ? source.createElement('style') : null;
    if (style) source.head?.append(style);
    const listeners = [], listen = (name, handler) => { root.addEventListener(name, handler, { capture: true, passive: false }); listeners.push([name, handler]); };
    listen('pointerdown', (event) => {
      policy();
      if (!pointers.size) { multi = false; gesture = undefined; suppressUntil = 0; }
      const start = point(event, source), rect = host.getBoundingClientRect();
      if (!enabled() || event.button > 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !inside(start, rect)) { clearTap(); return; }
      pointers.set(event.pointerId ?? 1, start);
      if (pointers.size > 1 || event.isPrimary === false) {
        multi = true; gesture = undefined; clearTap(); const value = pair();
        if (!pinch && onPinch && !zoomed() && !canPan() && value?.distance > 8) {
          pinch = { initial: value.distance, factor: 1, center: value.center, changed: false };
          onPinch({ phase: 'start', factor: 1, center: value.center });
        }
        return;
      }
      if (ignored(event.target) || event.defaultPrevented || selection(source)) { clearTap(); return; }
      gesture = { id: event.pointerId ?? 1, start, time: now(), type: event.pointerType || 'mouse', width: rect.width, moved: false };
    });
    listen('pointermove', (event) => {
      const current = point(event, source), id = event.pointerId ?? 1;
      if (!current || !pointers.has(id)) return;
      pointers.set(id, current);
      if (pinch && pointers.size >= 2) {
        const value = pair(); pinch.factor = Math.max(.4, Math.min(3, value.distance / pinch.initial)); pinch.center = value.center;
        pinch.changed ||= Math.abs(Math.log(pinch.factor)) > .035;
        consume(event); onPinch({ phase: 'move', factor: pinch.factor, center: value.center }); return;
      }
      if (gesture && gesture.id === id && Math.hypot(current.x - gesture.start.x, current.y - gesture.start.y) > 10) { gesture.moved = true; clearTap(); }
    });
    listen('pointerup', (event) => release(event, source));
    listen('pointercancel', () => { reset(); suppressUntil = now() + 700; });
    listen('click', (event) => { if (now() < suppressUntil) { suppressUntil = 0; consume(event); } });
    const unbind = () => { for (const [name, handler] of listeners) root.removeEventListener(name, handler, true); style?.remove(); bindings.delete(root); };
    bindings.set(root, { frame, style, unbind }); policy(); return unbind;
  }
  function outside(event) { if (!host.contains(event.target) && pointers.has(event.pointerId ?? 1)) release(event, doc); }
  bind(host); viewport?.addEventListener('resize', policy); doc.addEventListener('pointerup', outside, true);
  return { bind, refresh: policy,
    reset() { reset(); for (const [root, item] of [...bindings]) if (root !== host) item.unbind(); },
    destroy() { reset(); for (const item of [...bindings.values()]) item.unbind(); host.style.touchAction = originalTouch; host.classList.remove('reader-native-zoom'); viewport?.removeEventListener('resize', policy); doc.removeEventListener('pointerup', outside, true); },
  };
}
