(() => {
  window.__langyFullscreenCleanup?.();
  let port, previous;
  const token = '__LANGY_FULLSCREEN_TOKEN__';
  function sync() {
    if (!port) return;
    const state = document.fullscreenElement || document.documentElement.classList.contains('focus-mode') ? 'enter' : 'exit';
    if (previous !== state) { previous = state; port.postMessage(state); }
  }
  const observer = new MutationObserver(sync);
  function connect(event) {
    if (event.data !== token || !event.ports?.length) return;
    window.removeEventListener('message', connect);
    port = event.ports[0];
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('fullscreenchange', sync);
    sync();
  }
  window.addEventListener('message', connect);
  window.__langyFullscreenCleanup = () => {
    window.removeEventListener('message', connect); document.removeEventListener('fullscreenchange', sync);
    observer.disconnect(); port?.close();
  };
})();
