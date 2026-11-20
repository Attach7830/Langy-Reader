// Optional device media controls. Unsupported browser actions must not affect the reader.
export function deviceMediaControls(actions) {
  const session = navigator.mediaSession;
  let attached = false, metadataKey = '';
  function attach(handlers) {
    for (const [name, handler] of Object.entries(actions)) {
      try { session.setActionHandler(name, handlers ? handler : null); }
      catch { /* The browser may support only some media actions. */ }
    }
    attached = handlers;
  }
  function clear() {
    if (!session) return;
    if (attached) attach(false);
    metadataKey = '';
    try {
      session.metadata = null;
      session.playbackState = 'none';
      session.setPositionState?.();
    } catch { /* Position-state reporting is optional. */ }
  }
  function update({ active, title, author, chapter, duration, position, rate, paused }) {
    if (!session) return;
    if (!active || !Number.isFinite(duration) || duration <= 0) { clear(); return; }
    if (!attached) attach(true);
    const key = JSON.stringify([title, author, chapter]);
    try {
      if (key !== metadataKey && typeof MediaMetadata === 'function') {
        session.metadata = new MediaMetadata({ title, artist: author || 'Langy Reader', album: chapter || '' });
        metadataKey = key;
      }
      session.playbackState = paused ? 'paused' : 'playing';
      session.setPositionState?.({ duration, playbackRate: rate, position: Math.max(0, Math.min(duration, position)) });
    } catch { /* Device controls remain optional if a browser rejects metadata. */ }
  }
  return { update, clear };
}
