import { $, api, element, message } from './ui.js';

export function bookSharing(form) {
  const controls = $('#book-sharing-controls', form), mode = $('#book-sharing-mode', form);
  const fieldset = $('#book-sharing-users', form), list = $('#book-sharing-list', form);
  const retry = $('#book-sharing-retry', form);
  let selected, original, users, pending;

  function renderUsers() {
    const missing = [...selected].filter((id) => !users.some((user) => user.id === id));
    const people = [...users, ...missing.map((id) => ({ id }))];
    list.replaceChildren(...people.map(({ id, username }) => {
      const label = element('label', 'checkbox-row'), checkbox = document.createElement('input');
      const name = element('span', '', username || 'Unavailable account');
      if (username) name.setAttribute('data-user-content', '');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(id);
        else selected.delete(id);
      });
      label.append(checkbox, name);
      return label;
    }));
    message('#book-sharing-status', people.length ? '' : 'No other active users on this server.');
  }

  async function loadUsers() {
    if (users || pending) return;
    const request = new AbortController();
    pending = request;
    retry.hidden = true;
    message('#book-sharing-status', 'Loading users…');
    try {
      const result = await api('/api/sharing/recipients', { signal: request.signal });
      if (pending !== request) return;
      users = result.users;
      renderUsers();
    } catch (error) {
      if (pending !== request) return;
      message('#book-sharing-status', error.message);
      retry.hidden = false;
    } finally {
      if (pending === request) pending = undefined;
    }
  }

  function update() {
    fieldset.hidden = controls.hidden || mode.value !== 'selected';
    if (!fieldset.hidden) void loadUsers();
  }
  function cancel() { pending?.abort(); pending = undefined; }
  mode.addEventListener('change', update);
  retry.addEventListener('click', () => void loadUsers());

  return {
    set(book, available) {
      cancel();
      let recipients = book?.shareWith;
      if (typeof recipients === 'string') {
        try { recipients = JSON.parse(recipients); } catch { recipients = []; }
      }
      selected = new Set(Array.isArray(recipients) ? recipients : []);
      mode.value = book?.shared === true || book?.shared === 'true' ? 'everyone' : selected.size ? 'selected' : 'private';
      original = { mode: mode.value, recipients: JSON.stringify([...selected].sort()) };
      controls.hidden = mode.disabled = !available;
      users = undefined;
      list.replaceChildren();
      retry.hidden = true;
      message('#book-sharing-status');
      update();
    },
    apply(data, editing) {
      if (controls.hidden) return;
      const recipients = mode.value === 'selected' ? [...selected].sort() : [];
      if (mode.value === 'selected' && !recipients.length) throw new Error('Choose at least one user to share with.');
      const value = JSON.stringify(recipients);
      if (editing && mode.value === original.mode && value === original.recipients) return;
      data.set('shared', String(mode.value === 'everyone'));
      data.set('shareWith', value);
    },
    cancel,
  };
}
