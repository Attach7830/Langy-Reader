// A drag that starts inside a dialog must not dismiss it when released outside.
export function dismissOnBackdrop(dialog, focus = () => {}) {
  let startedOutside = false;
  function outside(event) {
    const rect = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom);
  }
  dialog.addEventListener('pointerdown', (event) => { startedOutside = event.button === 0 && outside(event); });
  dialog.addEventListener('pointercancel', () => { startedOutside = false; });
  dialog.addEventListener('click', (event) => {
    const dismiss = startedOutside && outside(event); startedOutside = false;
    if (dialog.open && dismiss) { dialog.close(); focus(); }
  });
}
