// Existing Android releases add these controls only after the native message
// channel connects to the configured server. Screen size and user agents do
// not identify the app: a phone browser is still the web version.
export const androidApp = () => Boolean(globalThis.document?.getElementById('android-app-controls'));

export function watchAppCapability(changed) {
  const root = document.querySelector('[data-settings-panel="devices"]') || document.body;
  let previous;
  const update = () => {
    const enabled = androidApp();
    if (enabled === previous) return;
    previous = enabled;
    for (const node of document.querySelectorAll('[data-app-only]')) node.hidden = !enabled;
    changed?.(enabled);
  };
  const observer = new document.defaultView.MutationObserver(update);
  observer.observe(root, { childList: true, subtree: true }); update();
  return () => observer.disconnect();
}
