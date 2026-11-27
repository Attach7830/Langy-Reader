import { accountPreferences, defaults, isObject, mergePreferences, preferenceChanges, shortcutDefaults } from '../shared/reader-preferences.js';

const cacheKey = 'langy-account-settings-v1';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function acknowledged(pending, sent) {
  const remaining = { ...pending };
  for (const [key, value] of Object.entries(sent)) {
    if (key === 'languageDefaults') {
      const map = structuredClone(remaining[key] || {});
      for (const [language, fields] of Object.entries(value)) {
        if (same(map[language], fields)) { delete map[language]; continue; }
        if (!isObject(map[language]) || !isObject(fields)) continue;
        for (const [field, target] of Object.entries(fields)) if (same(map[language][field], target)) delete map[language][field];
        if (!Object.keys(map[language]).length) delete map[language];
      }
      if (Object.keys(map).length) remaining[key] = map; else delete remaining[key];
    } else if (['keys', 'audioRecordings'].includes(key)) {
      const map = { ...remaining[key] };
      for (const [name, setting] of Object.entries(value)) if (same(map[name], setting)) delete map[name];
      if (Object.keys(map).length) remaining[key] = map; else delete remaining[key];
    } else if (same(remaining[key], value)) delete remaining[key];
  }
  return remaining;
}

export function accountSettings({ request, preferences, apply, busy = () => false, status = () => {}, storage }) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { /* Server preferences still work when browser storage is blocked. */ } }
  let saved;
  try { saved = JSON.parse(storage?.getItem(cacheKey) || 'null'); } catch { /* Storage may be disabled. */ }
  let accountId = saved?.accountId || null, pending = isObject(saved?.pending) ? saved.pending : {};
  let snapshot, running, timer, deferred = false, closed = false;
  function persist() {
    try { storage?.setItem(cacheKey, JSON.stringify({ accountId, pending })); } catch { /* Keep the in-memory outbox. */ }
  }
  function hydrate() {
    if (!snapshot) return;
    if (busy()) { deferred = true; return; }
    deferred = false;
    const local = preferences();
    const saved = mergePreferences(snapshot.preferences, pending);
    apply(mergePreferences({ ...defaults, progressSyncEnabled: local.progressSyncEnabled, syncDeviceName: local.syncDeviceName }, { ...saved, keys: shortcutDefaults(saved.keys) }));
  }
  function receive(remote) {
    if (closed) return;
    if (!remote?.accountId || !Number.isSafeInteger(remote.revision) || !isObject(remote.preferences)) throw new Error('Reader settings could not be loaded.');
    const switched = accountId && accountId !== remote.accountId;
    if (switched) pending = {};
    // Import the existing browser's preferences once, only into an empty account.
    if (!accountId && remote.revision === 0) pending = mergePreferences(accountPreferences(preferences()), pending);
    accountId = remote.accountId; snapshot = remote; persist(); hydrate();
  }
  function schedule() {
    clearTimeout(timer);
    if (!closed) timer = setTimeout(() => { void flush(); }, 500);
  }
  function changed(after, before) {
    const changes = preferenceChanges(before, after);
    if (!Object.keys(changes).length) return;
    pending = mergePreferences(pending, changes); persist(); status('pending'); schedule();
  }
  async function sync(keepalive) {
    try {
      receive(await request('/api/settings/reader', { signal: AbortSignal.timeout(8000) }));
      for (let attempts = 0; Object.keys(pending).length && attempts < 4; attempts++) {
        const sent = structuredClone(pending);
        try {
          const result = await request('/api/settings/reader', { method: 'PATCH', keepalive,
            body: { revision: snapshot.revision, changes: sent }, signal: AbortSignal.timeout(8000) });
          pending = acknowledged(pending, sent); receive(result);
        } catch (error) {
          if (error.status !== 409 || !error.details?.accountId) throw error;
          receive(error.details);
        }
      }
      status(Object.keys(pending).length ? 'pending' : 'saved');
    } catch { status('offline'); }
  }
  function flush({ keepalive = false } = {}) {
    clearTimeout(timer);
    if (closed) return Promise.resolve();
    if (running) return running;
    running = sync(keepalive).finally(() => { running = null; });
    return running;
  }
  function resume() { if (deferred) hydrate(); return flush(); }
  return { start: flush, flush, changed, resume, close() { closed = true; clearTimeout(timer); } };
}
