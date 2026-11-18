const hideDelay = 2500;

export function readerDocks(screen) {
  const docks = [...screen.querySelectorAll('.reader-top, .reader-footer')];
  const edges = screen.querySelectorAll('.reader-dock-edge');
  let enabled = false;
  let hoveredDock, timer;

  function scheduleHide() {
    clearTimeout(timer);
    if (!enabled) return;
    timer = setTimeout(() => {
      if (hoveredDock?.matches(':hover') || docks.some((dock) => dock.querySelector(':focus-visible'))) return;
      screen.classList.add('docks-hidden');
    }, hideDelay);
  }

  function reveal() {
    if (!enabled) return;
    screen.classList.remove('docks-hidden');
    scheduleHide();
  }

  for (const dock of docks) {
    dock.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'touch') return;
      hoveredDock = dock;
      reveal();
    });
    dock.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'touch' || hoveredDock !== dock) return;
      hoveredDock = undefined;
      scheduleHide();
    });
    dock.addEventListener('pointerdown', reveal);
    dock.addEventListener('focusin', reveal);
    dock.addEventListener('focusout', scheduleHide);
  }

  for (const edge of edges) {
    edge.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'touch') reveal();
    });
    edge.addEventListener('click', reveal);
  }

  return (autoHide) => {
    if (autoHide === enabled) return;
    enabled = autoHide;
    screen.classList.toggle('auto-hide-docks', enabled);
    screen.classList.remove('docks-hidden');
    scheduleHide();
  };
}
