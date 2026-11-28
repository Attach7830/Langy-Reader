const interactive = 'a,button,input,select,textarea,label,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[data-page-navigation-ignore],.reader-message';
const doubleTapDelay = 320;
const holdDelay = 420;
const tapSlop = 12;

export function pageNavigation({ host, turn, enabled = () => true, canSwipe = () => true, canDoubleTap = () => true,
  canCenterTap = () => false, centerTap = () => {}, centerDoubleTap, wordAt = () => false, wordDoubleTap, swipeUp, swipeDown,
  pinch: onPinch, canPan = () => false, panBy, selectPassage, passageSelected = () => false, dismissPassage = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const bindings = new Map(), pointers = new Map(), doc = host.ownerDocument, viewport = doc.defaultView.visualViewport;
  const originalTouch = host.style.touchAction;
  let gesture, pinch, multi = false, suppressUntil = 0, lastTap, tapTimer, holdTimer;
  let desktopPinch, desktopTimer, nativeGestureUntil = 0;
  const zoomed = () => (viewport?.scale || 1) > 1.01;
  const ignored = (target) => Boolean((target?.nodeType === 1 ? target : target?.parentElement)?.closest?.(interactive));
  const selection = (source) => passageSelected() || [source, doc].some((item) => item.getSelection?.()?.isCollapsed === false);
  const inside = (p, rect) => p && p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
  const consume = (event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
  const clearTap = () => { clearTimer(tapTimer); tapTimer = undefined; lastTap = undefined; };
  function clearHold() { clearTimer(holdTimer); holdTimer = undefined; }
  const sameWord = (a, b) => a?.node && a.node === b?.node && a.index === b.index;
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
    const action = zoomed() ? 'auto' : canPan() && !panBy ? 'pan-x pan-y' : 'none';
    host.style.touchAction = action; host.classList.toggle('reader-native-zoom', zoomed());
    const css = 'html,body,body * {touch-action:' + action + ' !important;}';
    for (const { style } of bindings.values()) if (style && style.textContent !== css) style.textContent = css;
  }
  function reset() {
    finishDesktopPinch(true);
    clearTap(); clearHold();
    gesture?.passage?.finish();
    if (pinch) onPinch?.({ phase: 'cancel', factor: pinch.factor });
    gesture = pinch = undefined; pointers.clear(); multi = false; suppressUntil = 0;
  }
  function finishDesktopPinch(cancelled = false) {
    clearTimer(desktopTimer);
    const current = desktopPinch; desktopPinch = undefined;
    if (current) onPinch?.({ phase: cancelled || !current.changed || !enabled() ? 'cancel' : 'end', factor: current.factor, center: current.center });
  }
  function desktopAllowed(event, source) {
    return onPinch && enabled() && !pointers.size && !zoomed() && !event.target?.closest?.(interactive.replace('a,', '').replace(',[role="link"]', ''))
      && inside(point(event, source), host.getBoundingClientRect());
  }
  function startDesktopPinch(kind, event, source) {
    clearTap(); gesture = undefined; suppressUntil = now() + 700;
    desktopPinch = { kind, factor: 1, changed: false, center: point(event, source), initial: event.scale || 1 };
    onPinch({ phase: 'start', factor: 1, center: desktopPinch.center });
  }
  function moveDesktopPinch(factor) {
    desktopPinch.factor = Math.max(.4, Math.min(3, factor));
    desktopPinch.changed ||= Math.abs(Math.log(desktopPinch.factor)) > .015;
    onPinch({ phase: 'move', factor: desktopPinch.factor, center: desktopPinch.center });
  }
  function pair() {
    const [a, b] = [...pointers.values()]; if (!a || !b) return null;
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
  function beginPassage(previous) {
    if (gesture !== previous || previous.moved || multi || !enabled() || zoomed()) return;
    const passage = selectPassage?.(previous.word);
    if (!passage) return;
    previous.passage = passage;
    clearHold(); clearTap();
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
    gesture = undefined; clearHold();
    if (previous.passage) {
      previous.passage.finish(); consume(event); suppressUntil = now() + 700; return;
    }
    if (!current || !enabled() || selection(source) || now() - previous.time > 1000) { clearTap(); suppressUntil = now() + 700; return; }
    const dx = current.x - previous.start.x, dy = current.y - previous.start.y;
    const distance = Math.hypot(dx, dy), elapsed = now() - previous.time;
    const threshold = Math.min(60, Math.max(32, previous.width * .105));
    const movedBeforeHold = (previous.motionTime ?? now()) - previous.time < holdDelay;
    if (previous.type === 'touch' && !zoomed() && !canPan() && movedBeforeHold && distance >= threshold) {
      let handled = false;
      if (Math.abs(dx) > Math.abs(dy) * 1.4 && canSwipe()) { clearTap(); consume(event); turn(dx < 0 ? 1 : -1); handled = true; }
      else if (Math.abs(dy) > Math.abs(dx) * 1.5 && (dy < 0 ? swipeUp : swipeDown)) { clearTap(); consume(event); (dy < 0 ? swipeUp : swipeDown)(); handled = true; }
      if (handled) { suppressUntil = now() + 700; return; }
    }
    if (previous.dismissed || previous.moved || distance > tapSlop || elapsed >= holdDelay || ignored(event.target)) {
      clearTap(); suppressUntil = now() + 700; if (previous.type === 'touch') consume(event); return;
    }
    if (previous.type !== 'touch' || zoomed()) return;
    const side = zone(current); if (side == null || side !== zone(previous.start)) return;
    const word = wordAt(event);
    const doubled = lastTap && lastTap.doc === source && now() - lastTap.time <= doubleTapDelay
      && Math.hypot(current.x - lastTap.point.x, current.y - lastTap.point.y) <= 30;
    if (doubled && wordDoubleTap && sameWord(word, lastTap.word)) {
      clearTap(); consume(event); suppressUntil = now() + 700; wordDoubleTap(word); return;
    }
    if (doubled && lastTap.side === side && !(wordDoubleTap && (word || lastTap.word)) && (side === 0 ? centerDoubleTap : canDoubleTap())) {
      clearTap(); consume(event); suppressUntil = now() + 700;
      if (side === 0) centerDoubleTap(); else turn(side);
      return;
    }
    clearTap(); lastTap = { doc: source, side, point: current, time: now(), word };
    if (side === 0 && canCenterTap() && !word) tapTimer = setTimer(() => {
      const pending = lastTap; clearTap();
      if (pending && enabled() && !selection(source)) centerTap();
    }, doubleTapDelay);
  }
  function bind(root) {
    if (!root || bindings.has(root)) return bindings.get(root)?.unbind || (() => {});
    for (const item of [...bindings.values()]) if (item.frame && !item.frame.isConnected) item.unbind();
    const source = root.nodeType === 9 ? root : root.ownerDocument, frame = source.defaultView?.frameElement;
    const style = root.nodeType === 9 ? source.createElementNS(source.documentElement.namespaceURI, 'style') : null;
    if (style) source.head?.append(style);
    const listeners = [], listen = (name, handler) => { root.addEventListener(name, handler, { capture: true, passive: false }); listeners.push([name, handler]); };
    listen('wheel', (event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || !Number.isFinite(event.deltaY) || !event.deltaY || !desktopAllowed(event, source)) return;
      // Chromium and Firefox expose trackpad pinches as Ctrl+wheel events.
      // Native Safari gesture events take precedence if both are delivered.
      if (desktopPinch?.kind === 'native' || now() < nativeGestureUntil) { consume(event); return; }
      if (!desktopPinch) {
        if (!event.cancelable) return;
        startDesktopPinch('wheel', event, source);
      }
      consume(event);
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight || 600 : 1;
      moveDesktopPinch(desktopPinch.factor * Math.exp(-Math.max(-100, Math.min(100, event.deltaY * units)) * .01));
      clearTimer(desktopTimer); desktopTimer = setTimer(() => finishDesktopPinch(), 180);
    });
    listen('gesturestart', (event) => {
      if (pinch) { consume(event); return; }
      if (!desktopAllowed(event, source) || !event.cancelable) return;
      if (desktopPinch?.kind === 'wheel') finishDesktopPinch(true);
      startDesktopPinch('native', event, source); consume(event);
    });
    listen('gesturechange', (event) => {
      if (pinch) { consume(event); return; }
      if (desktopPinch?.kind !== 'native') return;
      consume(event);
      if (!enabled()) { finishDesktopPinch(true); return; }
      if (Number.isFinite(event.scale) && event.scale > 0) moveDesktopPinch(event.scale / desktopPinch.initial);
    });
    listen('gestureend', (event) => {
      if (desktopPinch?.kind !== 'native') return;
      consume(event); nativeGestureUntil = now() + 100;
      if (Number.isFinite(event.scale) && event.scale > 0) moveDesktopPinch(event.scale / desktopPinch.initial);
      finishDesktopPinch();
    });
    // Some touch browsers still dispatch native zoom events inside EPUB frames.
    const reservePinch = (event) => {
      if (onPinch && enabled() && !zoomed() && event.touches?.length > 1 && event.cancelable) event.preventDefault();
    };
    listen('touchstart', reservePinch);
    listen('touchmove', reservePinch);
    listen('contextmenu', (event) => {
      if (!gesture?.word || gesture.source !== source || gesture.type !== 'touch') return;
      if (!gesture.passage) beginPassage(gesture);
      if (gesture.passage) consume(event);
    });
    listen('pointerdown', (event) => {
      if (desktopPinch) finishDesktopPinch();
      policy();
      if (!pointers.size) { multi = false; gesture = undefined; suppressUntil = 0; }
      const start = point(event, source), rect = host.getBoundingClientRect();
      if (!enabled() || event.button > 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !inside(start, rect)) { clearTap(); return; }
      pointers.set(event.pointerId ?? 1, { ...start, source });
      if (pointers.size > 1 || event.isPrimary === false) {
        if (gesture?.passage) { pointers.delete(event.pointerId ?? 1); return; }
        clearHold();
        multi = true; gesture = undefined; clearTap(); const value = pair();
        if (!pinch && onPinch && !zoomed() && value?.distance > 8) {
          pinch = { initial: value.distance, factor: 1, center: value.center, changed: false };
          onPinch({ phase: 'start', factor: 1, center: value.center });
        }
        return;
      }
      if (ignored(event.target) || event.defaultPrevented) { clearTap(); return; }
      const dismissed = event.pointerType === 'touch' && passageSelected();
      if (dismissed) { dismissPassage(); clearTap(); }
      if (selection(source)) { clearTap(); return; }
      const side = zone(start), word = wordAt(event);
      if (event.pointerType === 'touch' && lastTap?.doc === source
        && now() - lastTap.time <= doubleTapDelay && Math.hypot(start.x - lastTap.point.x, start.y - lastTap.point.y) <= 30
        && (wordDoubleTap && sameWord(word, lastTap.word) || lastTap.side === side && !(wordDoubleTap && (word || lastTap.word)) && (side === 0 ? centerDoubleTap : canDoubleTap())) && event.cancelable) {
        // Native multi-tap selection starts on pointerdown, before our
        // pointerup action. Keep it from swallowing consecutive double taps.
        event.preventDefault();
      }
      const previous = gesture = {
        id: event.pointerId ?? 1, source, start, word, time: now(), type: event.pointerType || 'mouse', width: rect.width, moved: false, dismissed,
      };
      if (selectPassage && word && previous.type === 'touch' && !zoomed()) {
        holdTimer = setTimer(() => beginPassage(previous), holdDelay);
      }
    });
    listen('pointermove', (event) => {
      const current = point(event, source), id = event.pointerId ?? 1;
      const last = pointers.get(id);
      if (!current || !last) return;
      pointers.set(id, { ...current, source: last.source });
      if (pinch && pointers.size >= 2) {
        const value = pair(); pinch.factor = Math.max(.4, Math.min(3, value.distance / pinch.initial)); pinch.center = value.center;
        pinch.changed ||= Math.abs(Math.log(pinch.factor)) > .035;
        consume(event); onPinch({ phase: 'move', factor: pinch.factor, center: value.center }); return;
      }
      if (!gesture || gesture.id !== id) return;
      if (gesture.passage) { gesture.passage.extend(current, wordAt(event)); consume(event); return; }
      if (!gesture.moved && Math.hypot(current.x - gesture.start.x, current.y - gesture.start.y) > tapSlop) {
        gesture.moved = true; gesture.motionTime = now(); clearHold(); clearTap();
      }
      if (gesture.moved && gesture.type === 'touch' && !zoomed() && !selection(source) && canPan() && panBy) {
        panBy(last.x - current.x, last.y - current.y);
        consume(event);
      }
    });
    listen('pointerup', (event) => release(event, source));
    listen('pointercancel', () => { reset(); suppressUntil = now() + 700; });
    listen('lostpointercapture', (event) => {
      if (pointers.has(event.pointerId)) { reset(); suppressUntil = now() + 700; }
    });
    listen('click', (event) => { if (now() < suppressUntil) { suppressUntil = 0; consume(event); } });
    const unbind = () => {
      for (const [name, handler] of listeners) root.removeEventListener(name, handler, true);
      // An EPUB frame can disappear during an audio turn before it sends pointerup.
      if (frame && [...pointers.values()].some((contact) => contact.source === source)) reset();
      if (lastTap?.doc === source) clearTap();
      style?.remove(); bindings.delete(root);
    };
    bindings.set(root, { frame, style, unbind }); policy(); return unbind;
  }
  function outside(event) { if (!host.contains(event.target) && pointers.has(event.pointerId ?? 1)) release(event, doc); }
  bind(host); viewport?.addEventListener('resize', policy); doc.addEventListener('pointerup', outside, true);
  return { bind, refresh: policy,
    reset() { reset(); for (const [root, item] of [...bindings]) if (root !== host) item.unbind(); },
    destroy() { reset(); for (const item of [...bindings.values()]) item.unbind(); host.style.touchAction = originalTouch; host.classList.remove('reader-native-zoom'); viewport?.removeEventListener('resize', policy); doc.removeEventListener('pointerup', outside, true); },
  };
}
