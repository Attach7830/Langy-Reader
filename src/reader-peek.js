export function temporaryControls({ changed, delay = 5000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let visible = false, timer, held = false;
  function schedule() { clearTimer(timer); if (visible && !held) timer = setTimer(hide, delay); }
  function hide() { clearTimer(timer); if (!visible) return; visible = false; changed(false); }
  return { get visible() { return visible; }, show() { if (!visible) { visible = true; changed(true); } schedule(); }, hide,
    activity() { if (visible) schedule(); }, hold() { held = true; clearTimer(timer); }, release() { held = false; schedule(); }, reset() { held = false; hide(); } };
}
