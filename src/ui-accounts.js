import { $, api, element, message, toast } from './ui.js';
import { signOut } from './auth.js';
import { accountPolicyFields } from './account-policy.js';
import { androidApp } from './platform.js';

export function accountPanel(session) {
  const user = session.user;
  if (!user) return;
  $('#account-name').textContent = user.username;
  $('#account-role').textContent = user.role === 'admin' ? 'Administrator' : user.safeMode ? 'Reader · Safe mode' : 'Reader';
  $('#account-admin').hidden = user.role !== 'admin';
  $('#account-offline-note').hidden = !session.offline;
  for (const label of document.querySelectorAll('[data-account-name]')) label.textContent = user.username;
  let loading, resetting;
  const newPolicy = accountPolicyFields(), newRole = $('#account-new-role');
  $('#account-create').before(newPolicy.root);
  newPolicy.setReader(newRole.value === 'user');
  newRole.addEventListener('change', () => newPolicy.setReader(newRole.value === 'user'));
  function error(text = '') { message('#account-message', text); }
  async function loadUsers() {
    if (user.role !== 'admin' || loading) return loading;
    loading = (async () => {
      try {
        const { users } = await api('/api/admin/users');
        $('#account-users').replaceChildren(...users.map((item) => {
          const row = element('article', 'account-user');
          const name = element('strong', '', item.username); name.setAttribute('data-user-content', '');
          const state = element('span', 'field-note', [item.role === 'admin' ? 'Administrator' : 'Reader',
            item.disabled ? 'Disabled' : 'Active', item.safeMode ? 'Safe mode' : ''].filter(Boolean).join(' · '));
          const role = document.createElement('select'); role.setAttribute('aria-label', `Role for ${item.username}`);
          role.append(new Option('Reader', 'user', item.role === 'user', item.role === 'user'), new Option('Administrator', 'admin', item.role === 'admin', item.role === 'admin')); role.value = item.role; role.disabled = item.id === user.id;
          role.addEventListener('change', async () => {
            role.disabled = true; error();
            try { await api(`/api/admin/users/${item.id}`, { method: 'PATCH', body: { role: role.value } }); }
            catch (failure) { error(failure.message); }
            finally { await loadUsersAfter(); }
          });
          const actions = element('div', 'button-row');
          const reset = element('button', 'button quiet small', 'Reset password'); reset.type = 'button'; reset.disabled = item.id === user.id;
          reset.addEventListener('click', () => { resetting = item; $('#account-reset-name').textContent = item.username; $('#account-reset-form').reset(); message('#account-reset-error'); $('#account-reset-dialog').showModal(); });
          const toggle = element('button', 'button quiet small', item.disabled ? 'Enable' : 'Disable'); toggle.type = 'button'; toggle.disabled = item.id === user.id;
          toggle.addEventListener('click', async () => {
            if (!item.disabled && !window.confirm(`Disable ${item.username}? Their current sessions will end.`)) return;
            toggle.disabled = true; error();
            try { await api(`/api/admin/users/${item.id}`, { method: 'PATCH', body: { disabled: !item.disabled } }); }
            catch (failure) { error(failure.message); }
            finally { await loadUsersAfter(); }
          });
          const revoke = element('button', 'button quiet small', 'Revoke browser sessions'); revoke.type = 'button'; revoke.disabled = item.id === user.id;
          revoke.addEventListener('click', async () => { revoke.disabled = true; error(); try { await api(`/api/admin/users/${item.id}/sessions/revoke`, { method: 'POST' }); error('Browser sessions revoked. Reset the password to revoke saved device credentials too.'); } catch (failure) { error(failure.message); } finally { revoke.disabled = false; } });
          const details = document.createElement('details'), summary = element('summary', '', 'Permissions and limits'), policy = accountPolicyFields(item, { current: item.id === user.id });
          const save = element('button', 'button secondary small', 'Save account limits'); save.type = 'button';
          save.addEventListener('click', async () => { save.disabled = true; error(); try { await api(`/api/admin/users/${item.id}`, { method: 'PATCH', body: policy.read() }); error('Account permissions and limits saved.'); await loadUsersAfter(); } catch (failure) { error(failure.message); } finally { save.disabled = false; } });
          details.append(summary, policy.root, save);
          actions.append(role, reset, toggle, revoke); row.append(name, state, actions, details); return row;
        }));
      } catch (failure) { error(failure.message); }
      finally { loading = null; }
    })(); return loading;
  }
  async function loadUsersAfter() { if (loading) await loading; return loadUsers(); }
  $('#account-create').addEventListener('click', async (event) => {
    const name = $('#account-new-name'), password = $('#account-new-password');
    if (!name.reportValidity() || !password.reportValidity()) return;
    event.target.disabled = true; error();
    try {
      await api('/api/admin/users', { method: 'POST', body: { username: name.value.trim(), password: password.value, role: newRole.value, ...newPolicy.read() } });
      name.value = password.value = ''; newPolicy.reset(); error('Account created. The new user can sign in with these credentials.'); await loadUsers();
    } catch (failure) { error(failure.message); }
    finally { event.target.disabled = false; }
  });
  $('#account-create-fields').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#account-create').click(); } });
  $('#account-password-fields').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#account-change-password').click(); } });
  $('#account-change-password').addEventListener('click', async (event) => {
    const old = $('#account-old-password'), next = $('#account-new-own-password');
    if (!old.reportValidity() || !next.reportValidity()) return;
    event.target.disabled = true; error();
    try { await api('/api/account/password', { method: 'POST', body: { currentPassword: old.value, newPassword: next.value } }); old.value = next.value = ''; error('Password changed. Other sessions have been signed out.'); }
    catch (failure) { error(failure.message); }
    finally { event.target.disabled = false; }
  });
  $('#account-reset-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (!resetting) return; const button = event.target.querySelector('[type="submit"]'); button.disabled = true;
    try { await api(`/api/admin/users/${resetting.id}/password`, { method: 'POST', body: { password: event.target.elements.password.value } }); $('#account-reset-dialog').close(); error('Password reset. Existing sessions for that account have ended.'); }
    catch (failure) { message('#account-reset-error', failure.message); }
    finally { button.disabled = false; }
  });
  for (const button of document.querySelectorAll('[data-sign-out]')) button.addEventListener('click', () => {
    const action = button.hasAttribute('data-switch-user') ? 'Switch user' : 'Log out';
    $('#sign-out-form').reset(); $('#sign-out-title').textContent = action; $('#sign-out-confirm').textContent = action;
    message('#sign-out-error'); $('#sign-out-dialog').showModal();
  });
  $('#sign-out-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = $('#sign-out-confirm'); if (button.disabled) return; button.disabled = true;
    try { await signOut({ removeDownloads: androidApp() && $('#sign-out-remove-downloads').checked }); }
    catch { const text = 'Reconnect to your server to log out or switch users. Your offline books have been kept.'; message('#sign-out-error', text); toast(text); button.disabled = false; }
  });
  function route() { if (location.hash === '#settings/account') void loadUsers(); }
  window.addEventListener('hashchange', route);
  $('[data-settings-tab="account"]').addEventListener('click', () => void loadUsers()); route();
}
