import { api, message, toast } from './ui.js';
import { translateUI } from './i18n.js';

const locks = new WeakMap();
function lockSave(button) {
  const form = button.closest('form'), submit = form?.querySelector('button[type="submit"]');
  if (!submit) return () => {};
  let state = locks.get(form);
  if (!state) { state = { count: 0, disabled: submit.disabled }; locks.set(form, state); }
  state.count++; submit.disabled = true;
  return () => { if (!--state.count) { submit.disabled = state.disabled; locks.delete(form); } };
}

export function credentialRemoval({ button, input, endpoint, changed, status, revision = () => 0, membership = false }) {
  let busy = false;
  function refresh(config) { button.hidden = !config?.hasKey; button.disabled = busy; }
  button.addEventListener('click', async () => {
    if (busy || !window.confirm(translateUI(membership
      ? 'Are you sure you want to remove the saved membership key?'
      : 'Are you sure you want to remove the saved API key?'))) return;
    const version = revision(), wasDisabled = input.disabled, unlock = lockSave(button);
    busy = true; button.disabled = input.disabled = true;
    try {
      const config = await api(endpoint, { method: 'DELETE' });
      if (version !== revision()) return;
      input.value = ''; changed(config); refresh(config);
      message(status); toast(membership ? 'Saved membership key removed.' : 'Saved API key removed.');
    } catch (error) { if (version === revision()) message(status, error.message); }
    finally { busy = false; button.disabled = false; input.disabled = wasDisabled; unlock(); }
  });
  return { refresh };
}
