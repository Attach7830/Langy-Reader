// Shared by the browser and Android WebView, including the saved offline shell.
export function startupScreen({ document = globalThis.document, now = Date.now, reload = () => globalThis.location.reload() } = {}) {
  const root = document?.getElementById('startup-loading');
  if (!root) return { start() {}, report() {}, finish() {}, fail() {} };
  const find = (id) => document.getElementById(id);
  const progress = find('startup-progress'), count = find('startup-count'), elapsed = find('startup-elapsed');
  let active = true, started = now(), timer;
  try {
    const theme = JSON.parse(globalThis.localStorage?.getItem('langy-settings-v1') || '{}').theme;
    if (['paper', 'sepia', 'dark', 'dusk', 'midnight'].includes(theme)) document.documentElement.dataset.theme = theme;
  } catch { /* Loading must also work when browser storage is unavailable. */ }
  function tick() {
    const seconds = Math.max(0, Math.floor((now() - started) / 1000));
    elapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    find('startup-slow').hidden = seconds < 12;
  }
  function report({ label = 'Opening your library', complete, total, detail = '' } = {}) {
    if (!active) return;
    find('startup-stage').textContent = label;
    find('startup-detail').textContent = detail;
    const measured = Number.isFinite(complete) && Number.isFinite(total) && total > 0;
    if (measured) {
      const value = Math.max(0, Math.min(total, complete));
      progress.max = total; progress.value = value;
      count.textContent = `${value.toLocaleString()} / ${total.toLocaleString()} · ${Math.floor(value / total * 100)}%`;
    } else { progress.removeAttribute('value'); count.textContent = ''; }
    count.hidden = !measured;
    tick();
  }
  function start(label = 'Starting Langy…') {
    clearInterval(timer); active = true; started = now(); root.hidden = false;
    document.body.dataset.startup = 'loading'; root.setAttribute('aria-busy', 'true');
    find('startup-title').textContent = 'Opening your library';
    find('startup-error').textContent = ''; find('startup-error').hidden = find('startup-retry').hidden = true;
    progress.hidden = false; report({ label });
    timer = setInterval(tick, 1000); timer.unref?.();
  }
  function finish() {
    active = false; clearInterval(timer); root.hidden = true;
    root.setAttribute('aria-busy', 'false'); document.body.dataset.startup = 'ready';
  }
  function fail(error) {
    if (!active) return;
    clearInterval(timer); root.setAttribute('aria-busy', 'false');
    find('startup-title').textContent = 'Your library could not be opened';
    find('startup-stage').textContent = 'Connect to your Langy server and try again.';
    find('startup-detail').textContent = ''; count.hidden = progress.hidden = true;
    find('startup-error').textContent = error?.message || 'Please try again.';
    find('startup-error').hidden = find('startup-retry').hidden = false;
    find('startup-slow').hidden = true;
  }
  find('startup-retry').addEventListener('click', reload);
  return { start, report, finish, fail };
}

export const startup = startupScreen();
