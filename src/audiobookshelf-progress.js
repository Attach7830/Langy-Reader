import { $, message } from './ui.js';
import { offlineOwner } from './offline-store.js';

export function audiobookshelfProgress({ audio, request, reading, notify = () => {} }) {
  let session, syncingSaved, offered, applying, suspended = false;
  const keyFor = (state) => `langy-listening-${offlineOwner()}-${state.book}-${state.recording}`;
  const position = () => audio.playbackPosition() || reading?.playbackPosition();
  const tolerance = (state) => state.recording === 'reading' ? .00001 : .5;
  function persist() { if (session) try { localStorage.setItem(session.key, JSON.stringify({ book: session.book, recording: session.recording, duration: session.duration,
    absConnected: session.absConnected, absLinked: session.absLinked, time: session.time, readingTarget: session.readingTarget, version: session.version, dirty: session.dirty })); } catch {} }
  function tell(text) { message('#abs-sync-status', text); }
  function clearOffer() {
    if (!offered) return;
    offered = null;
    notify(null);
  }
  async function resume(remote, useCurrent = false) {
    if (!session || remote.recording !== session.recording) return false;
    const current = session;
    applying = current;
    try {
      if (!useCurrent) await (current.recording === 'reading' ? reading : audio).resumeAt(remote.currentTime);
      if (session !== current) return false;
      const actual = current.recording === 'reading' ? position() : null;
      const page = actual?.book === current.book && actual.recording === current.recording ? actual : null;
      session.time = page?.time ?? remote.currentTime; session.readingTarget = page?.readingTarget ?? session.readingTarget;
      session.version = remote.version; session.dirty = false; persist(); clearOffer();
      tell(remote.approximate ? 'Audiobookshelf position synced by book percentage.' : 'Audiobookshelf position synced.');
      return true;
    }
    finally { if (applying === current) applying = null; }
  }
  function offer(remote) {
    if (offered?.version === remote.version) return;
    const current = session;
    offered = remote;
    const readingOnly = remote.recording === 'reading';
    const label = readingOnly ? `${Math.round(remote.currentTime * 100)}%` : `${Math.floor(remote.currentTime / 60)}:${String(Math.floor(remote.currentTime % 60)).padStart(2, '0')}`;
    const valid = () => session === current && offered === remote && applying !== current;
    notify({
      key: `${current.key}:${remote.version}`, label, device: 'Audiobookshelf',
      percentage: readingOnly ? remote.currentTime : null,
      resume: (useCurrent = false) => valid() && resume(remote, useCurrent),
      async keep() {
        if (!valid()) return false;
        current.version = remote.version; current.dirty = true; persist(); clearOffer();
        await sync();
        return true;
      },
    });
  }
  function sample() {
    if (suspended) return;
    const state = position();
    if (!state) return;
    const key = keyFor(state);
    if (session?.key !== key) {
      let saved; try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
      // Keep a newer reading page authoritative. An older listening clock can
      // resume within that same saved page, but cannot pull a manual jump back.
      const samePage = saved?.readingTarget != null && saved.readingTarget === state.readingTarget;
      session = { ...state, key, absLinked: saved?.absLinked, time: samePage ? saved.time : state.time,
        version: saved?.version || 'none', dirty: samePage && Boolean(saved?.dirty), serial: 0, loaded: !state.absConnected };
      clearOffer();
      if (samePage && Number.isFinite(saved.time) && saved.time >= 0 && saved.time <= state.duration) {
        const current = session;
        applying = current;
        return current.restoring = (state.recording === 'reading' ? reading : audio).resumeAt(saved.time).catch((error) => {
          if (session === current) tell(error.message);
        }).finally(() => {
          current.restoring = null;
          if (applying === current) applying = null;
          if (session === current) return sync();
        });
      }
      return sync();
    }
    session.absConnected = state.absConnected;
    session.readingTarget = state.readingTarget;
    if (applying !== session && Math.abs(state.time - session.time) > tolerance(state) / 2) { session.time = state.time; session.dirty = true; session.serial++; persist(); }
  }
  function sync() {
    const current = session;
    if (!current || applying === current || !position()?.absConnected) return;
    return current.checking ||= check(current).finally(() => { current.checking = null; });
  }
  async function check(current) {
    try {
      const remote = await request(`/api/books/${current.book}/audiobookshelf/progress?recording=${encodeURIComponent(current.recording)}`, { signal: AbortSignal.timeout(8000) });
      if (session !== current || applying === current) return; current.loaded = true;
      const firstLink = !current.absLinked;
      current.absLinked = remote.linked; persist();
      if (!remote.linked) { clearOffer(); tell(remote.notice || ''); return; }
      if (firstLink && !current.dirty) {
        if (remote.automatic && (current.hasSavedPosition || reading?.hasSavedPosition?.()) && remote.updated > 0 && Math.abs(remote.currentTime - current.time) > tolerance(current)) { offer(remote); return; }
        if (remote.updated > 0) { await resume(remote); return; }
        current.version = remote.version; current.dirty = true;
      }
      if (remote.version !== current.version) {
        if (Math.abs(remote.currentTime - current.time) > tolerance(current)) { offer(remote); return; }
        current.dirty = false;
      }
      current.version = remote.version;
      persist();
      clearOffer();
      if (current.dirty) {
        const serial = current.serial;
        const result = await request(`/api/books/${current.book}/audiobookshelf/progress`, { method: 'PUT', signal: AbortSignal.timeout(8000), body: {
          recording: current.recording, currentTime: current.time, baseVersion: current.version } });
        if (session !== current) return;
        current.version = result.version; if (serial === current.serial) current.dirty = false; persist(); tell('Audiobookshelf position synced.');
      }
    } catch (error) {
      if (session !== current) return; current.loaded = true;
      if (error.status === 409 && error.details?.currentTime != null) offer(error.details);
      else tell('Listening position saved on this device. Sync will retry when connected.');
    }
  }
  async function syncSaved() {
    if (syncingSaved || !offlineOwner()) return syncingSaved;
    syncingSaved = (async () => {
      const prefix = `langy-listening-${offlineOwner()}-`;
      for (const key of Object.keys(localStorage).filter((value) => value.startsWith(prefix))) {
        if (session?.key === key) continue;
        const original = localStorage.getItem(key); let saved;
        try { saved = JSON.parse(original); } catch { continue; }
        if (!saved?.dirty || !saved.absConnected || !saved.book || !saved.recording) continue;
        const path = `/api/books/${encodeURIComponent(saved.book)}/audiobookshelf/progress`;
        try {
          const remote = await request(`${path}?recording=${encodeURIComponent(saved.recording)}`, { signal: AbortSignal.timeout(8000) });
          if (session?.key === key || localStorage.getItem(key) !== original) continue;
          if (!remote.linked) { saved.absLinked = false; }
          else if (remote.version !== saved.version && Math.abs(remote.currentTime - saved.time) >= tolerance(saved)) { saved.conflict = true; }
          else if (Math.abs(remote.currentTime - saved.time) < tolerance(saved)) { saved.dirty = false; saved.version = remote.version; }
          else {
            const result = await request(path, { method: 'PUT', signal: AbortSignal.timeout(8000), body: { recording: saved.recording, currentTime: saved.time, baseVersion: remote.version } });
            saved.version = result.version; saved.dirty = false;
          }
          if (localStorage.getItem(key) === original && session?.key !== key) localStorage.setItem(key, JSON.stringify(saved));
        } catch (error) { if (error.status === 409) continue; break; }
      }
    })().finally(() => { syncingSaved = null; }); return syncingSaved;
  }
  const element = $('#narration-audio');
  element.addEventListener('timeupdate', sample);
  for (const name of ['pause', 'seeked']) element.addEventListener(name, () => { sample(); void sync(); });
  window.addEventListener('langy-recording-ready', () => { suspended = false; sample(); });
  window.addEventListener('online', () => { void sync(); void syncSaved(); });
  window.addEventListener('pagehide', () => { sample(); persist(); });
  setInterval(() => { sample(); void sync(); void syncSaved(); }, 15000);
  return { syncSaved, start() { suspended = false; return sample() ?? session?.restoring ?? sync(); },
    changed: sample, stop() { sample(); persist(); suspended = true; session = null; clearOffer(); tell(''); } };
}
