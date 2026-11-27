import { $, message } from './ui.js';
import { offlineOwner } from './offline-store.js';

export function audiobookshelfProgress({ audio, request, reading }) {
  const notice = $('#abs-sync-notice'); let session, checking, syncingSaved, offered, applying, suspended = false, syncAgain = false;
  const keyFor = (state) => `langy-listening-${offlineOwner()}-${state.book}-${state.recording}`;
  const position = () => audio.playbackPosition() || reading?.playbackPosition();
  const tolerance = (state) => state.recording === 'reading' ? .00001 : .5;
  const sameTime = (state, a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < tolerance(state);
  const scopeFor = (state, remote) => remote.scope || `${state.recording}:${remote.item || ''}`;
  const ackKey = (state) => `langy-abs-ack-${state.owner || offlineOwner()}-${state.book}`;
  const read = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const fraction = (state, remote) => Number.isFinite(remote.percentage) ? remote.percentage : remote.currentTime / (remote.duration || state.duration);
  const matches = (saved, state, remote) => saved?.scope === scopeFor(state, remote) && (saved.version === remote.version
    || Number.isFinite(saved.fraction) && Math.abs(saved.fraction - fraction(state, remote)) < tolerance(state) / state.duration);
  function acknowledged(state, remote) {
    const saved = read(ackKey(state));
    return matches(saved, state, remote) ? saved : null;
  }
  function unchanged(state, remote) {
    return (!state.scope || state.scope === scopeFor(state, remote)) && (state.version === remote.version
      || sameTime(state, state.remoteTime, remote.currentTime) || matches(state.initialAck, state, remote)
      || !state.dirty && Boolean(acknowledged(state, remote)));
  }
  function change(state) {
    const key = `langy-abs-change-${state.owner || offlineOwner()}`;
    const value = Math.max(Number(read(key)) || 0, state.changeId || 0) + 1;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    state.changeId = value; return value;
  }
  function remember(state, remote, resolved = 0, applied = false) {
    const scope = scopeFor(state, remote), previous = read(ackKey(state));
    const old = previous?.scope === scope ? previous : {};
    state.version = remote.version; state.scope = scope; state.remoteTime = remote.currentTime;
    try { localStorage.setItem(ackKey(state), JSON.stringify({ ...old, scope, version: remote.version, fraction: fraction(state, remote),
      readingTarget: applied || sameTime(state, state.time, remote.currentTime) ? state.readingTarget : old.readingTarget,
      ...(resolved ? { resolvedChange: resolved, resolvedRecording: state.recording } : {}) })); } catch {}
  }
  function clearOffer() { offered = null; notice.hidden = true; }
  function persist() { if (session) try { localStorage.setItem(session.key, JSON.stringify({ book: session.book, recording: session.recording, duration: session.duration,
    absConnected: session.absConnected, absLinked: session.absLinked, time: session.time, readingTarget: session.readingTarget, version: session.version, dirty: session.dirty,
    owner: session.owner, scope: session.scope, remoteTime: session.remoteTime, changeId: session.changeId })); } catch {} }
  function tell(text) { message('#abs-sync-status', text); }
  async function resume(remote, explicit = false) {
    if (!session || remote.recording !== session.recording) return;
    const current = session;
    applying = current;
    try {
      await (current.recording === 'reading' ? reading : audio).resumeAt(remote.currentTime); if (session !== current) return;
      const actual = position();
      const page = actual?.book === current.book && actual.recording === current.recording ? actual : null;
      session.time = page?.time ?? remote.currentTime; session.readingTarget = page?.readingTarget ?? session.readingTarget;
      session.dirty = false; remember(current, remote, explicit ? change(current) : 0, true); persist(); clearOffer();
      tell(remote.approximate ? 'Audiobookshelf position synced by book percentage.' : 'Audiobookshelf position synced.');
    }
    finally { if (applying === current) applying = null; if (syncAgain && !checking) { syncAgain = false; void sync(); } }
  }
  function offer(remote) {
    offered = remote; notice.hidden = false;
    const label = remote.recording === 'reading' ? `${Math.round(remote.currentTime * 100)}%` : `${Math.floor(remote.currentTime / 60)}:${String(Math.floor(remote.currentTime % 60)).padStart(2, '0')}`;
    $('#abs-sync-message').textContent = `Audiobookshelf has a different position (${label}). Choose where to continue.`;
  }
  function sample() {
    if (suspended) return;
    const state = position();
    if (!state) return;
    const key = keyFor(state);
    if (session?.key !== key) {
      persist();
      let saved; try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
      // Keep a newer reading page authoritative. An older listening clock can
      // resume within that same saved page, but cannot pull a manual jump back.
      const samePage = saved?.readingTarget != null && saved.readingTarget === state.readingTarget;
      session = { ...state, key, owner: offlineOwner(), absLinked: saved?.absLinked, time: samePage ? saved.time : state.time,
        version: saved?.version || 'none', scope: saved?.scope, remoteTime: saved?.remoteTime, changeId: saved?.changeId || 0,
        dirty: samePage && Boolean(saved?.dirty), serial: 0, loaded: !state.absConnected, fresh: true };
      session.initialAck = read(ackKey(session));
      clearOffer();
      if (samePage && Number.isFinite(saved.time) && saved.time >= 0 && saved.time <= state.duration) {
        const current = session; applying = current;
        current.restoring = Promise.resolve().then(() => (state.recording === 'reading' ? reading : audio).resumeAt(saved.time))
          .catch(() => { if (session === current) current.time = position()?.time ?? state.time; })
          .finally(() => { current.restoring = null; if (applying === current) applying = null; });
      }
      void sync(); return;
    }
    session.absConnected = state.absConnected;
    session.readingTarget = state.readingTarget;
    if (applying !== session && Math.abs(state.time - session.time) > tolerance(state) / 2) { session.time = state.time; session.dirty = true; session.serial++; change(session); persist(); }
  }
  async function sync() {
    if (!session || !position()?.absConnected) return;
    if (checking || applying === session && !session.restoring) { syncAgain = true; return; }
    const current = session; checking = current;
    try {
      await current.restoring; if (session !== current) return;
      const remote = await request(`/api/books/${current.book}/audiobookshelf/progress?recording=${encodeURIComponent(current.recording)}`, { signal: AbortSignal.timeout(8000) });
      if (session !== current) return; current.loaded = true;
      const firstLink = !current.absLinked || current.scope && remote.scope && current.scope !== remote.scope;
      current.absLinked = remote.linked; persist();
      if (!remote.linked) { tell(remote.notice || ''); return; }
      const known = unchanged(current, remote), same = sameTime(current, remote.currentTime, current.time), ack = acknowledged(current, remote), fresh = current.fresh;
      current.fresh = false;
      if (known || same) {
        if (fresh && !current.dirty && current.recording !== 'reading' && remote.updated > 0 && ack?.readingTarget != null && ack.readingTarget === current.readingTarget) { await resume(remote); return; }
        remember(current, remote); clearOffer();
        if (same) current.dirty = false;
        else if (firstLink && remote.version === 'none') { current.dirty = true; change(current); }
      } else if (firstLink && !current.dirty) {
        const hasRemotePosition = remote.updated > 0 || remote.currentTime > tolerance(current);
        if (remote.automatic && (current.hasSavedPosition || reading?.hasSavedPosition?.()) && hasRemotePosition && Math.abs(remote.currentTime - current.time) > tolerance(current)) { offer(remote); return; }
        if (hasRemotePosition) { await resume(remote); return; }
        remember(current, remote); current.dirty = true; change(current);
      } else { offer(remote); return; }
      persist();
      if (current.dirty) {
        const serial = current.serial, changeId = current.changeId;
        const result = await request(`/api/books/${current.book}/audiobookshelf/progress`, { method: 'PUT', signal: AbortSignal.timeout(8000), body: {
          recording: current.recording, currentTime: current.time, baseVersion: current.version } });
        if (session !== current) return;
        remember(current, result, changeId, true); if (serial === current.serial) current.dirty = false; persist(); tell('Audiobookshelf position synced.');
      }
    } catch (error) {
      if (session !== current) return; current.loaded = true;
      if (error.status === 409 && error.details?.currentTime != null) offer(error.details);
      else tell('Listening position saved on this device. Sync will retry when connected.');
    } finally { if (checking === current) checking = null; if (syncAgain && applying !== session) { syncAgain = false; void sync(); } }
  }
  async function syncSaved() {
    if (syncingSaved || !offlineOwner()) return syncingSaved;
    syncingSaved = (async () => {
      const prefix = `langy-listening-${offlineOwner()}-`;
      const keys = Object.keys(localStorage).filter((value) => value.startsWith(prefix)).sort((a, b) => (read(b)?.changeId || 0) - (read(a)?.changeId || 0));
      for (const key of keys) {
        if (session?.key === key) continue;
        const original = localStorage.getItem(key); let saved;
        try { saved = JSON.parse(original); } catch { continue; }
        if (!saved?.dirty || !saved.absConnected || !saved.book || !saved.recording) continue;
        if (session?.book === saved.book) continue;
        saved.owner = offlineOwner();
        const path = `/api/books/${encodeURIComponent(saved.book)}/audiobookshelf/progress`;
        try {
          const remote = await request(`${path}?recording=${encodeURIComponent(saved.recording)}`, { signal: AbortSignal.timeout(8000) });
          if (session?.book === saved.book || localStorage.getItem(key) !== original) continue;
          const ack = acknowledged(saved, remote);
          if (!remote.linked) { saved.absLinked = false; }
          else if (ack?.resolvedChange > (saved.changeId || 0) && ack.resolvedRecording !== saved.recording) {
            saved.time = remote.currentTime; saved.readingTarget = null; saved.dirty = false; saved.conflict = false; remember(saved, remote);
          }
          else if (!unchanged(saved, remote) && !sameTime(saved, remote.currentTime, saved.time)) { saved.conflict = true; }
          else if (sameTime(saved, remote.currentTime, saved.time)) { saved.dirty = false; saved.conflict = false; remember(saved, remote); }
          else {
            const result = await request(path, { method: 'PUT', signal: AbortSignal.timeout(8000), body: { recording: saved.recording, currentTime: saved.time, baseVersion: remote.version } });
            remember(saved, result, saved.changeId, true); saved.dirty = false; saved.conflict = false;
          }
          if (localStorage.getItem(key) === original && session?.key !== key) localStorage.setItem(key, JSON.stringify(saved));
        } catch (error) { if (error.status === 409) continue; break; }
      }
    })().finally(() => { syncingSaved = null; }); return syncingSaved;
  }
  $('#abs-sync-resume').addEventListener('click', () => { if (offered) void resume(offered, true).catch((error) => tell(error.message)); });
  $('#abs-sync-keep').addEventListener('click', () => { if (session && offered?.recording === session.recording) { remember(session, offered); session.dirty = true; session.serial++; change(session); persist(); clearOffer(); void sync(); } });
  const element = $('#narration-audio');
  element.addEventListener('timeupdate', sample);
  for (const name of ['pause', 'seeked']) element.addEventListener(name, () => { sample(); void sync(); });
  window.addEventListener('langy-recording-ready', () => { suspended = false; sample(); });
  window.addEventListener('online', () => { void sync(); void syncSaved(); });
  window.addEventListener('pagehide', () => { sample(); persist(); });
  setInterval(() => { sample(); void sync(); void syncSaved(); }, 15000);
  return { syncSaved, start() { suspended = false; sample(); }, changed: sample, stop() { sample(); persist(); suspended = true; session = null; syncAgain = false; clearOffer(); tell(''); } };
}
