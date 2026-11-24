// Transport and view adapters keep network conflict handling independent of the
// EPUB renderer. Local progress remains usable when the server is unreachable.
export function readingProgressSync({ request, progress, persist, preferences, available, deviceId,
  applyRemote, notify, visible = () => true, debounce = 1200, poll = 20000 }) {
  let current, syncingSaved;
  const enabled = () => preferences().progressSyncEnabled !== false;
  const entry = (session) => progress[session.book.id] ||= {};
  const active = (session) => current === session;
  const endpoint = (session) => `/api/books/${encodeURIComponent(session.book.id)}/progress`;
  function report(session, state, extra = {}) { if (active(session)) notify({ state, pending: session.pending, ...extra }); }

  function capture(session) {
    const value = session.view.syncPosition?.();
    session.latest = value;
    return value;
  }

  function schedule(session) {
    clearTimeout(session.timer);
    if (session.enabled && enabled() && !session.loading && !session.pending) session.timer = setTimeout(() => void flush(session), debounce);
  }

  async function flush(session = current, keepalive = false) {
    if (!session || !session.enabled || !enabled() || session.loading || session.checking || session.applying
      || session.pending || !entry(session).syncDirty) return;
    if (session.writing) return session.writing;
    if (active(session)) capture(session);
    if (!session.latest) return;
    const value = { ...session.latest }, serial = session.serial;
    report(session, 'syncing');
    session.writing = (async () => {
      try {
        const result = await request(endpoint(session), { method: 'PUT', keepalive,
          signal: keepalive ? undefined : AbortSignal.timeout(8000), body: { ...value,
          baseVersion: session.base, device: (preferences().syncDeviceName || 'Langy browser').trim().slice(0, 120) || 'Langy browser', device_id: deviceId } });
        if (!Number.isSafeInteger(result.version) || typeof result.document !== 'string') throw new Error('Invalid sync server response.');
        session.base = result.version;
        const saved = entry(session);
        if ((saved.syncVersion || 0) <= result.version) {
          saved.syncVersion = result.version;
          saved.syncDocument = result.document;
          saved.syncDirty = saved.target !== value.target || session.serial !== serial;
          persist();
        }
        report(session, 'synced');
      } catch (error) {
        if (error.status === 409 && error.details?.progress) {
          session.pending = error.details;
          session.document = error.details.document;
          report(session, 'conflict');
        } else report(session, 'offline', { error: error.message });
      } finally {
        session.writing = null;
        if (active(session) && session.serial !== serial && entry(session).syncDirty && !session.pending) schedule(session);
      }
    })();
    return session.writing;
  }

  async function apply(session, remote, version) {
    if (!active(session)) return;
    clearTimeout(session.timer);
    session.applying = true;
    report(session, 'syncing');
    try {
      const result = await applyRemote(remote);
      if (!active(session)) return;
      if (result === false) throw new Error('The saved position could not be opened.');
      session.pending = null;
      session.base = version;
      capture(session);
      session.serial++;
      Object.assign(entry(session), { syncDirty: false, syncVersion: version, syncDocument: session.document });
      persist();
      report(session, result?.exact === false ? 'approximate' : 'synced');
    } catch (error) { report(session, 'error', { error: error.message }); }
    finally { session.applying = false; }
  }

  async function check(opening = false, session = current) {
    if (!session || !active(session) || !session.enabled || !enabled() || session.checking || session.applying) return;
    session.checking = true;
    try {
      if (session.writing) await session.writing;
      if (!active(session)) return;
      const result = await request(endpoint(session), { signal: AbortSignal.timeout(8000) });
      if (!active(session)) return;
      if (!Number.isSafeInteger(result.version) || typeof result.document !== 'string') throw new Error('Invalid sync server response.');
      session.document = result.document;
      let saved = entry(session);
      if (saved.syncDocument && saved.syncDocument !== result.document) session.base = 0;
      if (result.progress && result.version !== session.base) {
        if (opening && !saved.syncDirty && !session.moved) {
          session.pending = result;
          await apply(session, result.progress, result.version);
        }
        else {
          session.pending = result;
          report(session, saved.syncDirty ? 'conflict' : 'remote');
        }
      } else {
        session.base = result.version;
        session.pending = null;
        if (saved.syncDirty) report(session, 'waiting');
        else report(session, 'synced');
      }
      session.loading = false;
      saved = entry(session);
      if (!result.progress && !saved.syncDirty) {
        capture(session);
        saved.syncDirty = true;
        persist();
      }
    } catch (error) {
      session.loading = false;
      report(session, 'offline', { error: error.message });
    } finally { session.checking = false; }
    if (active(session) && entry(session).syncDirty && !session.pending) await flush(session);
  }

  function stop() {
    const session = current;
    if (!session) return;
    clearTimeout(session.timer); clearInterval(session.poll);
    void flush(session, true);
    current = undefined;
    notify({ state: 'disabled' });
  }

  async function start(book, view) {
    stop();
    if (!available()) { notify({ state: 'disabled' }); return; }
    const session = { book, view, base: progress[book.id]?.syncVersion || 0, serial: 0,
      pending: null, enabled: enabled(), loading: enabled(), applying: false, checking: false, moved: false };
    current = session;
    capture(session);
    if (!enabled()) { report(session, 'disabled'); return; }
    report(session, 'syncing');
    await check(true, session);
    if (!active(session)) return;
    session.poll = setInterval(() => { if (visible()) void check(false, session); }, poll);
  }

  function changed() {
    const session = current;
    if (!session || session.applying) return;
    capture(session);
    session.serial++;
    session.moved = true;
    Object.assign(entry(session), { syncDirty: true, syncVersion: session.base, syncPayload: session.latest,
      ...(session.document ? { syncDocument: session.document } : {}) });
    persist();
    if (session.enabled && enabled()) {
      report(session, session.pending ? 'conflict' : 'waiting');
      schedule(session);
    }
  }

  return {
    start, stop, changed, check: () => check(), flush: () => flush(current, true),
    async flushSaved() {
      if (syncingSaved || !available() || !enabled()) return syncingSaved;
      syncingSaved = (async () => {
        for (const [id, saved] of Object.entries(progress)) {
          if (id === current?.book.id || !saved.syncDirty || !saved.syncPayload) continue;
          const value = structuredClone(saved.syncPayload);
          try {
            const endpoint = `/api/books/${encodeURIComponent(id)}/progress`;
            const remote = await request(endpoint, { signal: AbortSignal.timeout(8000) });
            if (id === current?.book.id || JSON.stringify(saved.syncPayload) !== JSON.stringify(value)) continue;
            if (saved.syncDocument && saved.syncDocument !== remote.document) { saved.syncConflict = true; persist(); continue; }
            if (remote.version !== (saved.syncVersion || 0)) {
              if (remote.progress?.progress === value.progress && Math.abs(remote.progress.percentage - value.percentage) < .000001) {
                saved.syncVersion = remote.version; saved.syncDirty = false; saved.syncConflict = false; persist();
              } else { saved.syncConflict = true; persist(); }
              continue;
            }
            const result = await request(endpoint, { method: 'PUT', signal: AbortSignal.timeout(8000), body: { ...value, baseVersion: remote.version,
              device: preferences().syncDeviceName || 'Langy browser', device_id: deviceId } });
            saved.syncVersion = result.version; saved.syncDocument = result.document;
            if (JSON.stringify(saved.syncPayload) === JSON.stringify(value)) saved.syncDirty = false;
            saved.syncConflict = false; persist();
          } catch (error) {
            if ([404, 410].includes(error.status)) { saved.syncDirty = false; persist(); }
            else if (error.status === 409) { saved.syncConflict = true; persist(); }
            else break;
          }
        }
      })().finally(() => { syncingSaved = undefined; }); return syncingSaved;
    },
    async resume() {
      const session = current;
      if (session?.pending) await apply(session, session.pending.progress, session.pending.version);
    },
    async keepLocal() {
      const session = current;
      if (!session?.pending) return;
      session.base = session.pending.version;
      session.pending = null;
      capture(session);
      entry(session).syncDirty = true;
      persist();
      await flush(session);
    },
  };
}
