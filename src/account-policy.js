import { element } from './ui.js';

// Used for both account creation and editing so all security controls agree.
export function accountPolicyFields(value = {}, { current = false } = {}) {
  const root = element('div', 'form-stack'), controls = {};
  function field(key, title, type, initial, options = {}) {
    const label = element('label', type === 'checkbox' ? 'checkbox-row' : 'field'), input = document.createElement('input');
    input.type = type; input.dataset.accountPolicy = key; input.setAttribute('aria-label', title); Object.assign(input, options);
    if (type === 'checkbox') { input.defaultChecked = input.checked = initial; label.append(input, document.createTextNode(title)); }
    else { input.defaultValue = input.value = initial; label.append(document.createTextNode(title), input); }
    root.append(label); controls[key] = input; return input;
  }
  const safeMode = field('safeMode', 'Safe mode', 'checkbox', Boolean(value.safeMode));
  const safeNote = element('p', 'field-note', 'Allows reading and listening to existing books and keeping personal reading data. Disables uploads, book editing, processing, AI and device integrations.');
  root.append(safeNote);
  function setReader(reader) {
    safeMode.disabled = safeMode.closest('label').hidden = safeNote.hidden = !reader;
    if (!reader) safeMode.checked = false;
  }
  setReader(value.role !== 'admin');
  field('sharedArchive', 'Allow use of the administrator’s Anna’s Archive membership key', 'checkbox', Boolean(value.sharedArchive));
  root.append(element('p','field-note','Readers need this permission or their own private membership key. Administrators manage the shared connection.'));
  field('storageLimit', 'Saved library limit (GiB, blank for unlimited)', 'number', value.storageLimit == null ? '' : value.storageLimit / 1024 ** 3, { min: '0', max: '1048576', step: 'any' });
  root.append(element('p', 'field-note', `${value.storage ? (value.storage.usedBytes / 1024 ** 3).toFixed(2) + ' GiB currently saved. ' : ''}Counts owned books, covers, audio, transcripts and imported fonts. Shared service models and temporary processing space are separate. Lowering a limit keeps existing files.`));
  const date = value.expiresAt == null ? '' : new Date(value.expiresAt - new Date(value.expiresAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  field('expiresAt', 'Account expires (local time, blank for no expiry)', 'datetime-local', date, { disabled: current });
  field('allowRemember', 'Allow Remember me', 'checkbox', value.allowRemember !== false);
  field('rememberDays', 'Remembered sign-in duration (days)', 'number', value.rememberDays ?? 30, { min: '1', max: '365', step: '1' });
  field('sessionHours', 'Session sign-in duration (hours)', 'number', value.sessionHours ?? 24, { min: '1', max: '168', step: '1' });
  field('maxSessions', 'Maximum browser sessions', 'number', value.maxSessions ?? 30, { min: '1', max: '100', step: '1' });
  field('allowDevices', 'Allow OPDS / KOReader device sign-ins', 'checkbox', value.allowDevices !== false);
  return { root, safeMode, setReader, read() {
    if (!Object.values(controls).every((input) => input.reportValidity())) throw new Error('Check the account permissions and limits.');
    const result = Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, input.type === 'checkbox' ? input.checked
      : key === 'expiresAt' ? input.value ? new Date(input.value).getTime() : null
      : key === 'storageLimit' ? input.value === '' ? null : Math.round(Number(input.value) * 1024 ** 3) : Number(input.value)]));
    if (current) delete result.expiresAt;
    return result;
  }, reset() {
    for (const input of Object.values(controls)) {
      if (input.type === 'checkbox') input.checked = input.defaultChecked;
      else input.value = input.defaultValue;
    }
  } };
}
