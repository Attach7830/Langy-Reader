const interactive = 'a, button, input, select, textarea, label, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [data-page-navigation-ignore], .reader-message';

export function pageNavigation({ host, turn, enabled = () => true, canSwipe = () => true, canTap = () => true,
  canCenterTap = () => false, centerTap = () => {}, now = Date.now }) {
  const bindings = new Map(), pointers = new Set();
  let gesture, multiple = false, suppressUntil = 0, pointerSeen = false;
  const viewport = host.ownerDocument.defaultView.visualViewport;
  const nativeZoomed = () => (viewport?.scale || 1) > 1.01;
  function updateTouchPolicy() {
    host.classList.toggle('reader-native-zoom', nativeZoomed());
    for (const [root] of bindings) if (root.nodeType === 9) root.documentElement.style.setProperty('touch-action', nativeZoomed() ? 'auto' : 'pan-y pinch-zoom', 'important');
  }
  const selected = (doc) => [doc, host.ownerDocument].some((item) => {
    const selection = item.getSelection?.(); return selection && !selection.isCollapsed;
  });
  const ignored = (target) => Boolean((target?.nodeType === 1 ? target : target?.parentElement)?.closest?.(interactive));
  function point(event, doc) {
    let x = event.clientX, y = event.clientY, win = doc.defaultView;
    if (!win) return null;
    while (win && win !== host.ownerDocument.defaultView) {
      const frame = win.frameElement;
      if (!frame?.isConnected || !host.contains(frame)) return null;
      const rect = frame.getBoundingClientRect();
      const scaleX = frame.offsetWidth ? rect.width / frame.offsetWidth : 1;
      const scaleY = frame.offsetHeight ? rect.height / frame.offsetHeight : 1;
      x = rect.left + (x + frame.clientLeft) * scaleX;
      y = rect.top + (y + frame.clientTop) * scaleY;
      win = frame.ownerDocument.defaultView;
    }
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  function inside(position, rect) {
    return position && position.x >= rect.left && position.x <= rect.right && position.y >= rect.top && position.y <= rect.bottom;
  }
  function edge(position) {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !inside(position, rect)) return 0;
    const width = Math.min(64, Math.max(18, rect.width * .055));
    return position.x <= rect.left + width ? -1 : position.x >= rect.right - width ? 1 : 0;
  }
  function center(position) {
    const rect = host.getBoundingClientRect();
    return inside(position, rect) && position.x >= rect.left + rect.width / 3 && position.x <= rect.right - rect.width / 3;
  }
  function consume(event, prevent = false) {
    if (prevent && event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  }
  function resetGesture() { gesture = undefined; pointers.clear(); multiple = false; suppressUntil = 0; pointerSeen = false; }
  function bind(root) {
    if (!root || bindings.has(root)) return bindings.get(root)?.unbind || (() => {});
    for (const binding of [...bindings.values()]) if (binding.frame && !binding.frame.isConnected) binding.unbind();
    const doc = root.nodeType === 9 ? root : root.ownerDocument, frame = doc.defaultView?.frameElement;
    const style = root.nodeType === 9 ? doc.documentElement.style : null;
    const originalTouch = style?.getPropertyValue('touch-action'), originalPriority = style?.getPropertyPriority('touch-action');
    if (style) style.setProperty('touch-action', nativeZoomed() ? 'auto' : 'pan-y pinch-zoom', 'important');
    const listeners = [];
    const listen = (type, handler, passive = false) => {
      root.addEventListener(type, handler, { capture: true, passive }); listeners.push([type, handler]);
    };
    listen('pointerdown', (event) => {
      pointerSeen = true;
      if (!pointers.size) { suppressUntil = 0; gesture = undefined; multiple = false; }
      pointers.add(event.pointerId ?? 1);
      if (pointers.size > 1 || event.isPrimary === false) { multiple = true; return; }
      const start = point(event, doc), rect = host.getBoundingClientRect();
      if (!enabled() || ignored(event.target) || event.defaultPrevented || event.button > 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || selected(doc) || !inside(start, rect)) return;
      gesture = { id: event.pointerId ?? 1, doc, start, time: now(), type: event.pointerType || 'mouse',
        swipe: canSwipe() && !nativeZoomed(), width: rect.width, moved: false, vertical: false };
    }, true);
    listen('pointermove', (event) => {
      if (!gesture || gesture.id !== (event.pointerId ?? 1) || gesture.doc !== doc) return;
      const current = point(event, doc);
      if (!current) return;
      const dx = Math.abs(current.x - gesture.start.x), dy = Math.abs(current.y - gesture.start.y);
      if (dx > 10 || dy > 10) gesture.moved = true;
      if (dy > 12 && dy > dx) gesture.vertical = true;
    }, true);
    listen('pointerup', (event) => {
      pointers.delete(event.pointerId ?? 1);
      const current = point(event, doc), previous = gesture;
      if (!previous || previous.id !== (event.pointerId ?? 1) || previous.doc !== doc) {
        if (multiple) { suppressUntil = now() + 700; consume(event); }
        if (!pointers.size) { multiple = false; gesture = undefined; }
        return;
      }
      gesture = undefined;
      const wasMultiple = multiple;
      if (!pointers.size) multiple = false;
      const dx = current ? current.x - previous.start.x : 0, dy = current ? current.y - previous.start.y : 0;
      const moved = previous.moved || Math.abs(dx) > 10 || Math.abs(dy) > 10;
      const elapsed = now() - previous.time;
      if (wasMultiple || !current || selected(doc) || elapsed > 1000 || previous.vertical || !enabled()) {
        suppressUntil = now() + 700;
        if (previous.type === 'touch') consume(event);
        return;
      }
      const swipe = previous.type === 'touch' && previous.swipe && canSwipe() && !nativeZoomed() && elapsed <= 1000
        && Math.abs(dx) >= Math.min(90, Math.max(40, previous.width * .15)) && Math.abs(dx) > Math.abs(dy) * 1.5;
      const tap = !moved && elapsed <= 600 && !ignored(event.target) && !nativeZoomed();
      const fullscreen = tap && previous.type === 'touch' && canCenterTap() && center(previous.start) && center(current);
      const direction = swipe ? (dx < 0 ? 1 : -1)
        : tap && canTap() && edge(previous.start) === edge(current) ? edge(current) : 0;
      if (fullscreen || direction || moved || elapsed > 600) {
        suppressUntil = now() + 700;
        consume(event, Boolean(direction || fullscreen));
        if (direction) turn(direction);
        else if (fullscreen) centerTap();
      }
    });
    listen('pointercancel', () => { gesture = undefined; pointers.clear(); multiple = false; suppressUntil = now() + 700; }, true);
    listen('click', (event) => {
      const hadPointer = pointerSeen; pointerSeen = false;
      if (now() < suppressUntil) { suppressUntil = 0; consume(event, true); return; }
      if (hadPointer) return;
      if (!enabled() || event.defaultPrevented || event.detail === 0 || ignored(event.target) || selected(doc)
        || event.button > 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const direction = canTap() && !nativeZoomed() ? edge(point(event, doc)) : 0;
      if (direction) { consume(event, true); turn(direction); }
    });
    const unbind = () => {
      for (const [type, handler] of listeners) root.removeEventListener(type, handler, true);
      if (style) {
        if (originalTouch) style.setProperty('touch-action', originalTouch, originalPriority);
        else style.removeProperty('touch-action');
      }
      if (gesture?.doc === doc) resetGesture();
      bindings.delete(root);
    };
    bindings.set(root, { frame, unbind });
    return unbind;
  }
  function releaseOutside(event) {
    if (host.contains(event.target)) return;
    pointers.delete(event.pointerId ?? 1);
    if (gesture?.id === (event.pointerId ?? 1)) gesture = undefined;
    if (!pointers.size) multiple = false;
  }
  bind(host);
  updateTouchPolicy();
  viewport?.addEventListener('resize', updateTouchPolicy);
  host.ownerDocument.addEventListener('pointerup', releaseOutside, true);
  host.ownerDocument.addEventListener('pointercancel', releaseOutside, true);
  return {
    bind,
    reset() { resetGesture(); for (const [root, binding] of [...bindings]) if (root !== host) binding.unbind(); },
    destroy() {
      resetGesture(); for (const binding of [...bindings.values()]) binding.unbind();
      viewport?.removeEventListener('resize', updateTouchPolicy); host.classList.remove('reader-native-zoom');
      host.ownerDocument.removeEventListener('pointerup', releaseOutside, true);
      host.ownerDocument.removeEventListener('pointercancel', releaseOutside, true);
    },
  };
}
