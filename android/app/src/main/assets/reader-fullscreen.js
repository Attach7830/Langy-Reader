(() => {
  window.__langyFullscreenCleanup?.();
  let port, previous, controls, edges;
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
    // Keep the phone/tablet reading surface flush even on older servers.
    // Native window insets still protect the system bars and display cutouts.
    edges = document.createElement('style'); edges.id = 'android-reader-edges';
    edges.textContent = `@media (max-width: 620px), (pointer: coarse) {
      .reading-main { padding: 0 !important; }
      .viewer:not(.pdf-viewer) { width: 100% !important; border-radius: 0 !important; box-shadow: none !important; }
    }`;
    document.head.append(edges);
    const settings = document.querySelector('[data-settings-panel="devices"]') || document.querySelector('#settings .modal-body');
    if (settings) {
      controls = document.createElement('fieldset'); controls.className = 'form-stack'; controls.id = 'android-app-controls';
      const title = document.createElement('legend'); title.textContent = 'Android app'; controls.append(title);
      for (const [label, command] of [['Server connection', 'connection'], ['Reload app', 'reload']]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'button secondary'; button.textContent = label;
        button.addEventListener('click', () => port?.postMessage(command)); controls.append(button);
      }
      settings.append(controls);
    }
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('fullscreenchange', sync);
    sync();
  }
  window.addEventListener('message', connect);
  window.__langyFullscreenCleanup = () => {
    window.removeEventListener('message', connect); document.removeEventListener('fullscreenchange', sync);
    observer.disconnect(); controls?.remove(); edges?.remove(); port?.close();
  };
})();
