import { $, message } from './ui.js';
import { offlineOwner } from './offline-store.js';

export function audiobookshelfProgress({ audio, request }) {
  const notice = $('#abs-sync-notice'); let session, checking, syncingSaved, offered, applying = false, suspended = false;
  const keyFor = (state) => `langy-listening-${offlineOwner()}-${state.book}-${state.recording}`;
  function persist() { if (session) try { localStorage.setItem(session.key, JSON.stringify({ book: session.book, recording: session.recording, duration: session.duration,
    absConnected: session.absConnected, absLinked: session.absLinked, time: session.time, readingTarget: session.readingTarget, version: session.version, dirty: session.dirty })); } catch {} }
  function tell(text) { message('#abs-sync-status', text); }
  async function resume(remote) {
    if (!session || remote.recording !== session.recording) return;
    const current = session;
    applying = true;
    try { await audio.resumeAt(remote.currentTime); if (session !== current) return; session.time = remote.currentTime; session.version = remote.version; session.dirty = false; persist(); notice.hidden = true; tell('Audiobookshelf position synced.'); }
    finally { applying = false; }
  }
  function offer(remote) {
    offered = remote; notice.hidden = false;
    $('#abs-sync-message').textContent = `Audiobookshelf has a different listening position (${Math.floor(remote.currentTime / 60)}:${String(Math.floor(remote.currentTime % 60)).padStart(2, '0')}). Choose where to continue.`;
  }
  function sample() {
    if (suspended) return;
    const state = audio.playbackPosition();
    if (!state) return;
    const key = keyFor(state);
    if (session?.key !== key) {
      let saved; try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
      // Keep a newer reading page authoritative. An older listening clock can
      // resume within that same saved page, but cannot pull a manual jump back.
      const samePage = saved?.readingTarget != null && saved.readingTarget === state.readingTarget;
      session = { ...state, key, absLinked: saved?.absLinked, time: samePage ? saved.time : state.time,
        version: saved?.version || 'none', dirty: samePage && Boolean(saved?.dirty), serial: 0, loaded: !state.absConnected };
      notice.hidden = true;
      if (samePage && Number.isFinite(saved.time) && saved.time >= 0 && saved.time <= state.duration) {
        applying = true; void audio.resumeAt(saved.time).finally(() => { applying = false; });
      }
      void sync(); return;
    }
    session.absConnected = state.absConnected;
    session.readingTarget = state.readingTarget;
    if (!applying && session.loaded && Math.abs(state.time - session.time) > .25) { session.time = state.time; session.dirty = true; session.serial++; persist(); }
  }
  async function sync() {
    if (checking || !session || !audio.playbackPosition()?.absConnected) return;
    const current = session; checking = current;
    try {
      const remote = await request(`/api/books/${current.book}/audiobookshelf/progress?recording=${encodeURIComponent(current.recording)}`, { signal: AbortSignal.timeout(8000) });
      if (session !== current) return; current.loaded = true;
      const firstLink = !current.absLinked;
      current.absLinked = remote.linked; persist();
      if (!remote.linked) { tell(''); return; }
      if (firstLink && !current.dirty) {
        if (remote.updated > 0) { await resume(remote); return; }
        current.version = remote.version; current.dirty = true;
      }
      if (remote.version !== current.version) { offer(remote); return; }
      current.version = remote.version;
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
    } finally { if (checking === current) checking = null; }
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
          else if (remote.version !== saved.version && Math.abs(remote.currentTime - saved.time) >= .5) { saved.conflict = true; }
          else if (Math.abs(remote.currentTime - saved.time) < .5) { saved.dirty = false; saved.version = remote.version; }
          else {
            const result = await request(path, { method: 'PUT', signal: AbortSignal.timeout(8000), body: { recording: saved.recording, currentTime: saved.time, baseVersion: remote.version } });
            saved.version = result.version; saved.dirty = false;
          }
          if (localStorage.getItem(key) === original && session?.key !== key) localStorage.setItem(key, JSON.stringify(saved));
        } catch (error) { if (error.status === 409) continue; break; }
      }
    })().finally(() => { syncingSaved = null; }); return syncingSaved;
  }
  $('#abs-sync-resume').addEventListener('click', () => { if (offered) void resume(offered); });
  $('#abs-sync-keep').addEventListener('click', () => { if (session && offered) { session.version = offered.version; session.dirty = true; persist(); notice.hidden = true; void sync(); } });
  const element = $('#narration-audio');
  element.addEventListener('timeupdate', sample);
  for (const name of ['pause', 'seeked']) element.addEventListener(name, () => { sample(); void sync(); });
  window.addEventListener('langy-recording-ready', () => { suspended = false; sample(); });
  window.addEventListener('online', () => { void sync(); void syncSaved(); });
  window.addEventListener('pagehide', () => { sample(); persist(); });
  setInterval(() => { sample(); void sync(); void syncSaved(); }, 15000);
  return { syncSaved, stop() { sample(); persist(); suspended = true; session = null; offered = null; notice.hidden = true; tell(''); } };
}
