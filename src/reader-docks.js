const hideDelay = 2500;

export function readerDocks(screen) {
  const docks = [...screen.querySelectorAll('.reader-top, .reader-footer')];
  const edges = screen.querySelectorAll('.reader-dock-edge');
  let enabled = false, hovered, timer;
  function schedule() {
    clearTimeout(timer);
    if (enabled) timer = setTimeout(() => {
      if (!hovered?.matches(':hover') && !docks.some((dock) => dock.querySelector(':focus-visible'))) screen.classList.add('docks-hidden');
    }, hideDelay);
  }
  function show() {
    if (!enabled) return;
    screen.classList.remove('docks-hidden');
    schedule();
  }
  for (const dock of docks) {
    dock.addEventListener('pointerenter', (event) => { if (event.pointerType !== 'touch') { hovered = dock; show(); } });
    dock.addEventListener('pointerleave', (event) => { if (event.pointerType !== 'touch' && hovered === dock) { hovered = undefined; schedule(); } });
    dock.addEventListener('pointerdown', show);
    dock.addEventListener('focusin', show);
    dock.addEventListener('focusout', schedule);
  }
  for (const edge of edges) {
    edge.addEventListener('pointerenter', (event) => { if (event.pointerType !== 'touch') show(); });
    edge.addEventListener('click', show);
  }
  const footer = screen.querySelector('.reader-footer');
  if (footer && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (footer.offsetHeight) screen.style.setProperty('--bottom-dock-height', `${footer.offsetHeight}px`);
    }).observe(footer);
  }
  return (next) => {
    if (next === enabled) return;
    enabled = next;
    screen.classList.toggle('auto-hide-docks', enabled);
    screen.classList.remove('docks-hidden');
    schedule();
  };
}
