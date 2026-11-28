import { closeOfflineDatabase, offlineDownloadJobs, packPrefix } from './offline-store.js';

let current, leaving = false, preparation;
export const beforeSignOut = (callback) => { preparation = callback; };
export const accountSession = () => current;
async function request(path, body) {
  const response = await fetch(path, { signal: AbortSignal.timeout(12000), method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (response.headers.get('X-Langy-Offline') === '1' || response.headers.get('X-Langy-Cached') === '1') throw new TypeError('Offline');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to sign in.');
  return result;
}
function stored(key) { try { return localStorage.getItem(key); } catch { return null; } }
export async function clearAccountData({ removeDownloads = false } = {}) {
  const owner = stored('langy-offline-owner') || oldAccount();
  for (const audio of document.querySelectorAll('audio')) audio.pause();
  // Let other tabs stop saving this reader's data before local stores are reset.
  try { localStorage.removeItem('langy-auth-account'); localStorage.removeItem('langy-offline-owner'); } catch {}
  await closeOfflineDatabase();
  if (removeDownloads && owner && globalThis.indexedDB) {
    for (const item of await offlineDownloadJobs.all()) if (item.owner === owner) await offlineDownloadJobs.remove(item.id);
    await closeOfflineDatabase();
  }
  if (globalThis.caches) {
    for (const name of await caches.keys()) if (name.startsWith('langy-covers-') || name === 'langy-offline-control' || removeDownloads && owner && (name.startsWith(packPrefix(owner)) || name === `langy-fonts-${owner}`)) await caches.delete(name);
    navigator.serviceWorker?.controller?.postMessage({ type: 'ACCOUNT', id: '' });
  }
  try { for (const key of Object.keys(localStorage)) if (key.startsWith('langy-')) localStorage.removeItem(key); } catch {}
}
function oldAccount() {
  try { return JSON.parse(stored('langy-account-settings-v1') || '{}').accountId || stored('langy-offline-owner'); } catch { return stored('langy-offline-owner'); }
}
async function accept(session) {
  if (session.user) {
    const previous = stored('langy-auth-account'), previousReader = oldAccount();
    if (previous && previous !== session.user.id || previousReader && previousReader !== session.readerAccountId || !previous && !previousReader && !session.legacyAccount) await clearAccountData();
    try { localStorage.setItem('langy-auth-account', session.user.id); localStorage.setItem('langy-auth-user', JSON.stringify(session.user)); } catch {}
  }
  try { localStorage.setItem('langy-auth-mode', session.enabled ? 'accounts' : 'public'); } catch {}
  current = session;
  document.body.dataset.auth = 'ready'; document.querySelector('#login-screen').hidden = true;
  document.body.dataset.safeMode = String(session.user?.safeMode === true);
  for (const notice of document.querySelectorAll('[data-safe-mode-notice]')) notice.hidden = !session.user?.safeMode;
  for (const tab of document.querySelectorAll('[data-account-control]')) tab.hidden = !session.enabled;
  return session;
}
export async function signOut({ removeDownloads = false } = {}) {
  // Confirm revocation with the server before deleting offline work on this device.
  await preparation?.();
  await request('/api/account/logout', {});
  leaving = true; document.body.dataset.auth = 'loading';
  window.dispatchEvent(new Event('langy-signing-out'));
  await clearAccountData({ removeDownloads }); location.hash = '#library'; location.reload();
}
export async function authenticationGate() {
  let session;
  try { session = await request('/api/account'); }
  catch {
    if (stored('langy-offline-owner') && (stored('langy-auth-account') || stored('langy-auth-mode') === 'public')) {
      let user; try { user = JSON.parse(stored('langy-auth-user') || 'null'); } catch {}
      return accept({ enabled: stored('langy-auth-mode') !== 'public', authenticated: true, offline: true, user, readerAccountId: oldAccount() });
    }
    document.querySelector('#login-status').textContent = 'Connect to your Langy server to sign in.';
  }
  if (session?.authenticated) return accept(session);
  document.body.dataset.auth = 'signed-out'; document.querySelector('#login-screen').hidden = false;
  const form = document.querySelector('#login-form'), status = document.querySelector('#login-status');
  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); const button = form.querySelector('button[type="submit"]'); if (button.disabled) return;
      button.disabled = true; status.textContent = 'Signing in…';
      try {
        const value = await request('/api/account/login', { username: form.elements.username.value.trim(), password: form.elements.password.value, rememberMe: form.elements.rememberMe.checked });
        form.elements.password.value = ''; resolve(await accept(value));
      } catch (error) { status.textContent = error instanceof TypeError ? 'Connect to your Langy server to sign in.' : error.message; }
      finally { button.disabled = false; }
    });
  });
}
if (typeof window !== 'undefined') window.addEventListener('langy-auth-expired', () => { if (leaving) return; for (const audio of document.querySelectorAll('audio')) audio.pause(); location.reload(); }, { once: true });
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (leaving || !current?.enabled || !current.user || event.key !== 'langy-auth-account' || event.newValue === current.user.id) return;
  leaving = true; document.body.dataset.auth = 'loading';
  for (const audio of document.querySelectorAll('audio')) audio.pause();
  window.dispatchEvent(new Event('langy-signing-out')); location.reload();
});
