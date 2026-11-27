import { $, api, element } from './ui.js';
import { readerDeadline } from './reader-navigation.js';
import { deviceMediaControls } from './audio-media-session.js';
import { visibleAudioPosition } from './audio-page-position.js';

const timeLabel = (value) => {
  const seconds = Math.max(0, Math.floor(value || 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes >= 60 ? Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`;
};
function atTime(items, time, field = 'start') {
  let low = 0, high = items.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle][field] <= time) { found = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return found;
}
export function narration({ preferences, renderer, book, navigate, changePreferences, readingPosition = () => null }) {
  const player = $('#narration-player'), audio = $('#narration-audio');
  const play = $('#narration-play'), generate = $('#narration-generate');
  const status = $('#narration-status'), seek = $('#narration-seek');
  const clock = $('#narration-time'), completion = $('#narration-completion'), percent = $('#narration-percent');
  const chapters = $('#narration-chapter'), markers = $('#narration-markers');
  const rewind = $('#narration-rewind'), forward = $('#narration-forward');
  const previousChapter = $('#narration-previous-chapter'), nextChapter = $('#narration-next-chapter');
  const rate = $('#narration-rate'), podcastToggle = $('#podcast-toggle');
  const recordingChoice = $('#narration-recording');
  let recordingCount = 0, markerRate, absConnected = false;
  let recording, recordingBook, connection = false, previewAudio = false, unit, local, descriptor, timed = [], timingMap = new Map();
  let lifecycle = 0, controller, poll, animation, bookRequest, following = false, followAgain = false, forceFollow = false;
  let wantPlaying = false, enabled = false, initialSeek = true, highlighted, highlightedWindow;
  let waitingForMetadata = true;
  let manualNavigation = false, navigationVersion = 0, manualPage;
  let pendingWordTime, wordPlayback = 0;
  const cache = new Map();
  const ready = () => recording?.state === 'ready';
  const playbackSpeed = () => Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1;
  const segmentFor = (key) => recording?.segments?.find((part) => part.key === key);
  // Media clocks can round a chapter's exact start down by a fraction of a millisecond.
  // Apply the same tolerance to text following as to the chapter controls, or
  // seeking to a new chapter can immediately navigate back to the old one.
  const segmentAt = (time) => recording?.segments?.[Math.max(0, atTime(recording.segments, time + .01))];
  const chapterIndex = () => atTime(recording?.markers || [], audio.currentTime + .01, 'time');
  const deviceControls = deviceMediaControls({
    play: () => { if (enabled && ready()) { wantPlaying = true; void startPlayback(); } },
    pause: pausePlayback,
    seekbackward: () => skipBy(-10), seekforward: () => skipBy(10),
    previoustrack: () => jumpChapter(-1), nexttrack: () => jumpChapter(1),
    seekto: (details) => { if (Number.isFinite(details?.seekTime)) seekTo(details.seekTime); },
  });

  function clearHighlight() {
    highlightedWindow?.CSS?.highlights?.delete('langy-narration');
    highlighted = highlightedWindow = undefined;
  }
  function controls() {
    const loaded = ready() && audio.getAttribute('src') === recording.url && Number.isFinite(audio.duration);
    play.disabled = seek.disabled = chapters.disabled = !loaded;
    play.textContent = audio.paused ? 'Play' : 'Pause';
    play.setAttribute('aria-label', audio.paused ? 'Play narration' : 'Pause narration');
    const time = audio.currentTime || 0;
    const speed = playbackSpeed(), duration = recording?.duration || 0;
    const elapsed = timeLabel(time / speed), total = timeLabel(duration / speed), remaining = timeLabel((duration - time) / speed);
    const hasDuration = ready() && Number.isFinite(duration) && duration > 0;
    const position = loaded && !waitingForMetadata ? (audio.ended ? duration : time) : 0;
    const complete = hasDuration ? Math.floor(Math.max(0, Math.min(100, 100 * position / duration))) : 0;
    const percentLabel = `${complete}%`;
    seek.max = String(recording?.duration || 1);
    seek.value = String(time);
    clock.textContent = `${elapsed} / ${total}`;
    clock.setAttribute('aria-label', `Listening time at ${speed}×: ${elapsed} of ${total}; ${remaining} remaining.`);
    clock.title = `${remaining} remaining at ${speed}×. Recording position: ${timeLabel(time)} / ${timeLabel(duration)}.`;
    completion.hidden = !hasDuration;
    if (percent.textContent !== percentLabel) percent.textContent = percentLabel;
    if (markerRate !== speed) renderMarkers();
    const index = chapterIndex();
    rewind.disabled = !loaded || time <= 0;
    forward.disabled = !loaded || time >= recording.duration;
    previousChapter.disabled = !loaded || index <= 0;
    nextChapter.disabled = !loaded || index >= recording.markers.length - 1;
    if (index >= 0) chapters.value = String(index);
    const title = index >= 0 ? recording.markers[index].title : segmentAt(time)?.title;
    seek.setAttribute('aria-valuetext', `${elapsed} of ${total} at ${speed}×${hasDuration ? ` · ${percentLabel} complete` : ''}${title ? ` · ${title}` : ''}`);
    if (ready() && title) status.textContent = title
      + (recording.quality ? ` · ${recording.quality.textPercent}% of text matched` : '')
      + (recording.approximateSections ? ' · Some page timing is approximate.' : '');
    $('#podcast-book-title').textContent = book()?.title || 'Book audio';
    deviceControls.update({
      active: enabled && loaded, title: book()?.title || 'Book audio', author: book()?.author, chapter: title,
      duration: recording?.duration, position: time, rate: audio.playbackRate, paused: audio.paused,
    });
  }
  function drawHighlight() {
    const stamp = timed[atTime(timed, audio.currentTime)];
    const word = stamp && !stamp.estimated && audio.currentTime <= stamp.end ? timingMap.get(stamp.index) : null;
    if (!enabled || !preferences().audioHighlight || !word) { clearHighlight(); return; }
    if (word === highlighted) return;
    clearHighlight();
    const range = local?.rangeFor(word), win = local?.root.ownerDocument.defaultView;
    if (range && win?.CSS?.highlights && win.Highlight) {
      win.CSS.highlights.set('langy-narration', new win.Highlight(range));
      highlighted = word; highlightedWindow = win;
    }
  }
  function bindLocal(current, next) {
    descriptor = current; unit = next; local = current.track();
    local.annotate(next.tokens || []);
    const segment = segmentFor(next.key);
    timingMap = segment?.pageOnly ? new Map() : local.match(next.audio.timings || []);
    timed = segment ? (next.audio.timings || []).flatMap((stamp, index) => stamp.start == null ? [] : [{
      index, start: segment.start + stamp.start * segment.scale, end: segment.start + stamp.end * segment.scale, estimated: stamp.estimated,
    }]) : [];
    clearHighlight(); drawHighlight();
  }
  async function loadCurrent() {
    const active = book(), current = renderer()?.audioUnit?.();
    if (!active || !current) return;
    const recordingId = ready() ? recording.id : undefined;
    if (unit?.key === current.key && descriptor?.root === current.root && unit.recordingId === recordingId) return;
    const epoch = lifecycle, key = `${current.key}:${recordingId || ''}`;
    if (!cache.has(key)) {
      const query = ready() ? `?recording=${encodeURIComponent(recording.id)}` : '';
      cache.set(key, api(`/api/books/${active.id}/chapters/${encodeURIComponent(current.key)}${query}`, { signal: controller.signal })
        .catch((error) => { cache.delete(key); throw error; }));
      if (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    const next = await cache.get(key);
    if (epoch !== lifecycle || book()?.id !== active.id || (ready() ? recording.id : undefined) !== recordingId) return;
    const latest = renderer()?.audioUnit?.();
    if (latest?.key === current.key) bindLocal(latest, { ...next, recordingId });
  }
  function firstVisibleTime() {
    const segment = segmentFor(unit?.key);
    const position = visibleAudioPosition(local, timed, timingMap, segment);
    if (position) return position.time;
    const ordinal = Number(unit?.key?.split(':')[1]);
    return recording?.segments?.find((part) => Number(part.key.split(':')[1]) > ordinal)?.start ?? recording?.duration ?? 0;
  }
  function syncInitialPosition() {
    const current = renderer()?.audioUnit?.();
    if (!initialSeek || waitingForMetadata || !ready() || !current || descriptor?.root !== current.root || unit?.key !== current.key
      || !descriptor?.root.isConnected || unit?.recordingId !== recording.id || !Number.isFinite(audio.duration)) return;
    initialSeek = false;
    audio.currentTime = pendingWordTime ?? firstVisibleTime(); pendingWordTime = undefined;
    controls();
  }
  // Page changes run serially; another scrub replaces the pending target.
  async function follow(force = false) {
    const current = renderer()?.audioUnit?.();
    if (!enabled || !ready() || initialSeek || manualNavigation || !current) return;
    if (audio.paused && !force && current.key.startsWith('pdf:') && !segmentFor(current.key)) return;
    followAgain = true; forceFollow ||= force;
    if (following) return;
    following = true;
    const epoch = lifecycle, navigation = navigationVersion;
    try {
      while (followAgain && epoch === lifecycle && navigation === navigationVersion && !manualNavigation && enabled) {
        followAgain = false;
        const forced = forceFollow; forceFollow = false;
        const segment = segmentAt(audio.currentTime);
        if (!segment) break;
        if (renderer()?.audioUnit?.()?.key !== segment.key) {
          const moved = await navigate(renderer()?.audioTarget(segment.key));
          if (moved === false) { setTimeout(() => { if (epoch === lifecycle) void follow(true); }, 50); break; }
        }
        if (epoch !== lifecycle || navigation !== navigationVersion || manualNavigation) break;
        await loadCurrent();
        if (navigation !== navigationVersion || manualNavigation) break;
        if (segmentAt(audio.currentTime)?.key !== segment.key) { followAgain = true; continue; }
        if (unit?.key !== segment.key || !local) continue;
        const stamp = timed[Math.max(0, atTime(timed, audio.currentTime + .01))];
        const word = stamp && timingMap.get(stamp.index), range = word && local.rangeFor(word);
        const behindPage = manualPage?.key === segment.key && word?.from < manualPage.from && audio.currentTime >= manualPage.time - .05;
        if (manualPage && (manualPage.key !== segment.key || word?.from >= manualPage.from)) manualPage = undefined;
        if (range && !behindPage && (forced || !local.visible(word))) await renderer()?.revealWord(range, { valid: () => epoch === lifecycle && navigation === navigationVersion && !manualNavigation });
        if (epoch !== lifecycle) break;
        drawHighlight();
      }
    } catch (error) { if (epoch === lifecycle && error.name !== 'AbortError') status.textContent = error.message; }
    finally { if (epoch === lifecycle) following = false; }
  }
  async function startPlayback() {
    try { await audio.play(); }
    catch { wantPlaying = false; status.textContent = 'Press Play to start narration.'; }
  }
  function seekTo(time, { page = false } = {}) {
    if (!enabled || !ready() || waitingForMetadata || !Number.isFinite(audio.duration)) return;
    if (!page) { manualPage = undefined; pendingWordTime = undefined; }
    initialSeek = false;
    audio.currentTime = Math.max(0, Math.min(recording.duration, time));
    controls(); drawHighlight(); void follow(!page);
  }
  function skipBy(seconds) { seekTo(audio.currentTime + seconds); }
  function jumpChapter(direction) {
    const entries = recording?.markers || [];
    const index = Math.max(0, chapterIndex()) + direction;
    if (index >= 0 && index < entries.length) seekTo(entries[index].time);
  }
  function pausePlayback() { wantPlaying = false; audio.pause(); }
  function renderMarkers() {
    const entries = recording?.markers || [];
    markerRate = playbackSpeed();
    chapters.replaceChildren(...entries.map((marker, index) => new Option(marker.title, String(index))));
    markers.replaceChildren(...entries.map((marker) => {
      const tick = element('button', 'narration-marker');
      tick.type = 'button'; tick.tabIndex = -1;
      tick.title = `${marker.title} · ${timeLabel(marker.time / markerRate)} at ${markerRate}×`;
      tick.setAttribute('aria-label', tick.title);
      tick.style.left = `${marker.time / recording.duration * 100}%`;
      tick.addEventListener('click', () => seekTo(marker.time));
      return tick;
    }));
    chapters.hidden = !entries.length;
  }
  async function updateRecording(result) {
    const epoch = lifecycle;
    const changed = recording?.id !== result.audio.id || recording?.state !== result.audio.state
      || recording?.alignmentRevision !== result.audio.alignmentRevision;
    recording = result.audio; connection = result.connected; previewAudio = Boolean(result.previewAudio); absConnected = Boolean(result.absConnected);
    const isReady = ready();
    if (!isReady) play.disabled = seek.disabled = true;
    generate.hidden = !enabled || isReady || !['missing', 'error', 'cancelled'].includes(recording.state);
    generate.disabled = !connection;
    generate.title = previewAudio ? 'Connect Kokoro on a self-hosted installation to generate audio.' : '';
    generate.textContent = recording.state === 'error' ? 'Retry book audio' : 'Generate book audio';
    status.textContent = previewAudio && !isReady ? 'Audio and podcast preview · Narration is not connected in this demo.' : ({
      missing: recordingCount ? 'Choose a synced recording, or generate book audio.' : connection ? 'Generate the complete book to listen.' : 'Connect Kokoro in Settings → Narration.',
      queued: `Generating book audio · ${recording.complete} / ${recording.total} sections`,
      assembling: 'Finishing the complete book recording…', cancelled: 'Book audio generation cancelled.', error: recording.error,
    })[recording.state] || '';
    if (changed) { clearHighlight(); cache.clear(); unit = descriptor = local = undefined; renderMarkers(); }
    await loadCurrent().catch((error) => { if (!previewAudio) throw error; });
    if (epoch !== lifecycle || recording !== result.audio) return;
    if (enabled && isReady && audio.getAttribute('src') !== recording.url) {
      // duration can still describe the previous source until loadedmetadata.
      // An early seek would be discarded when the new source resets its clock.
      initialSeek = true; waitingForMetadata = true;
      audio.onloadedmetadata = () => {
        if (epoch !== lifecycle) return;
        waitingForMetadata = false;
        syncInitialPosition(); controls();
        window.dispatchEvent(new CustomEvent('langy-recording-ready'));
        if (wantPlaying) void startPlayback();
      };
      audio.src = recording.url;
      audio.playbackRate = preferences().audioRate;
    }
    syncInitialPosition();
    controls();
  }
  async function loadRecording() {
    if (bookRequest) return bookRequest;
    const active = book(), epoch = lifecycle;
    if (!active) return;
    bookRequest = (async () => {
      clearTimeout(poll);
      try {
        const selected = preferences().audioRecordings?.[active.id] || '';
        const result = await api(`/api/books/${active.id}/narration${selected ? `?recording=${encodeURIComponent(selected)}` : ''}`, { signal: controller.signal });
        if (epoch !== lifecycle) return;
        const choices = result.recordings || [];
        recordingCount = choices.length;
        recordingChoice.replaceChildren(new Option('Latest recording', ''), ...choices.map(({ id, name }) => new Option(name, id)));
        recordingChoice.value = choices.some((item) => item.id === selected) ? selected : '';
        $('#recording-choice').hidden = !choices.length;
        await updateRecording(result);
        if (['queued', 'assembling'].includes(recording.state) || ['queued', 'running'].includes(recording.rescan?.state)) poll = setTimeout(() => { void loadRecording(); }, 1800);
      } catch (error) {
        if (epoch !== lifecycle) return;
        status.textContent = error.message;
        const analysis = await api(`/api/books/${active.id}/learning`, { signal: controller.signal }).catch(() => null);
        if (epoch === lifecycle && ['queued', 'running'].includes(analysis?.analysis.state)) {
          status.textContent = 'Analyzing this book…';
          poll = setTimeout(() => { cache.clear(); void loadRecording(); }, 1800);
        }
      }
    })().finally(() => { if (epoch === lifecycle) bookRequest = undefined; });
    return bookRequest;
  }
  async function refresh({ seekToPage = false } = {}) {
    if (!book()) return;
    const navigation = navigationVersion, epoch = lifecycle;
    if (recordingBook !== book().id) {
      recordingBook = book().id; controller = new AbortController(); await loadRecording();
    }
    try {
      await loadCurrent();
      if (navigation !== navigationVersion || epoch !== lifecycle) return;
      const current = renderer()?.audioUnit?.();
      if (!current || unit?.key !== current.key || descriptor?.root !== current.root) return;
      syncInitialPosition();
      if (seekToPage && (!following || manualNavigation) && enabled && ready()) {
        const position = visibleAudioPosition(local, timed, timingMap, segmentFor(unit?.key));
        if (position) manualPage = { ...position, key: unit?.key };
        seekTo(position?.time ?? firstVisibleTime(), { page: true });
      }
      else { drawHighlight(); void follow(); }
    } catch (error) { if (!previewAudio && error.name !== 'AbortError') status.textContent = error.message; }
  }
  window.addEventListener('langy-audio-updated', (event) => {
    if (book()?.id === event.detail?.book) void loadRecording();
  });
  window.addEventListener('online', () => { if (book()) void loadRecording(); });
  function stop() {
    lifecycle++; controller?.abort(); clearTimeout(poll); cancelAnimationFrame(animation);
    audio.onloadedmetadata = null; audio.pause(); audio.removeAttribute('src'); audio.load(); clearHighlight();
    recording = unit = descriptor = local = recordingBook = bookRequest = undefined;
    timed = []; timingMap.clear(); cache.clear();
    following = followAgain = forceFollow = wantPlaying = false;
    manualNavigation = false; manualPage = pendingWordTime = undefined; navigationVersion++; wordPlayback++;
    initialSeek = true; waitingForMetadata = true;
    previewAudio = false;
    absConnected = false;
    recordingCount = 0;
    deviceControls.clear();
    markers.replaceChildren(); chapters.replaceChildren(); play.disabled = seek.disabled = true; controls();
  }
  function apply() {
    enabled = preferences().audioEnabled; player.hidden = !enabled || Boolean(preferences().audioToolbarHidden);
    const toggle = $('#audio-toggle');
    toggle.setAttribute('aria-pressed', String(!player.hidden));
    toggle.title = player.hidden ? 'Show audio toolbar' : 'Hide audio toolbar';
    toggle.setAttribute('aria-label', toggle.title);
    audio.playbackRate = preferences().audioRate;
    const podcast = Boolean(preferences().podcastMode);
    player.classList.toggle('podcast-mode', podcast);
    podcastToggle.setAttribute('aria-pressed', String(podcast));
    podcastToggle.textContent = podcast ? 'Compact player' : 'Podcast mode';
    $('#podcast-info').hidden = !podcast;
    for (const control of player.querySelectorAll('[data-podcast-control]')) control.hidden = !podcast;
    const value = String(preferences().audioRate);
    if (![...rate.options].some((option) => option.value === value)) {
      rate.querySelector('[data-custom-rate]')?.remove();
      const custom = new Option(`${value}×`, value); custom.dataset.customRate = ''; rate.add(custom);
    }
    rate.value = value;
    if (!enabled) { audio.pause(); wantPlaying = false; clearHighlight(); }
    else if (recording) void updateRecording({ connected: connection, previewAudio, absConnected, audio: recording }).catch((error) => { status.textContent = error.message; });
    if (!preferences().audioHighlight) clearHighlight();
    controls();
  }
  function toggle() {
    if (!enabled || !ready()) return;
    if (audio.paused) { wantPlaying = true; void startPlayback(); }
    else pausePlayback();
  }
  play.addEventListener('click', toggle);
  podcastToggle.addEventListener('click', () => changePreferences({ podcastMode: !preferences().podcastMode }));
  recordingChoice.addEventListener('change', () => {
    const active = book();
    if (!active) return;
    changePreferences({ audioRecordings: { ...preferences().audioRecordings, [active.id]: recordingChoice.value } });
    stop(); apply(); void refresh();
  });
  rewind.addEventListener('click', () => skipBy(-10));
  forward.addEventListener('click', () => skipBy(10));
  previousChapter.addEventListener('click', () => jumpChapter(-1));
  nextChapter.addEventListener('click', () => jumpChapter(1));
  rate.addEventListener('change', () => {
    const selected = Number(rate.value);
    if (Number.isFinite(selected) && selected >= .5 && selected <= 2) changePreferences({ audioRate: selected });
  });
  let lastWheel = -Infinity;
  rate.title = 'Playback speed · scroll up/down to adjust by 0.05×';
  rate.addEventListener('wheel', (event) => {
    if (rate.disabled || event.ctrlKey || event.metaKey || event.altKey || !event.deltaY) return;
    event.preventDefault();
    if (event.timeStamp - lastWheel < 80) return;
    lastWheel = event.timeStamp;
    const next = Math.max(.5, Math.min(2, Math.round((preferences().audioRate + (event.deltaY < 0 ? .05 : -.05)) * 100) / 100));
    if (next !== preferences().audioRate) changePreferences({ audioRate: next });
  }, { passive: false });
  generate.addEventListener('click', async () => {
    if (!book()) return;
    generate.disabled = true;
    try { await api(`/api/books/${book().id}/narration`, { method: 'POST', body: {} }); await loadRecording(); }
    catch (error) { status.textContent = error.message; generate.disabled = false; }
  });
  seek.addEventListener('input', () => seekTo(Number(seek.value)));
  chapters.addEventListener('change', () => seekTo(recording?.markers[Number(chapters.value)]?.time || 0));
  audio.addEventListener('seeking', () => { void follow(); });
  audio.addEventListener('timeupdate', () => { controls(); drawHighlight(); void follow(); });
  function tick() { drawHighlight(); void follow(); if (!audio.paused) animation = requestAnimationFrame(tick); }
  audio.addEventListener('play', () => { controls(); cancelAnimationFrame(animation); tick(); });
  audio.addEventListener('pause', () => { controls(); cancelAnimationFrame(animation); });
  audio.addEventListener('ratechange', controls);
  audio.addEventListener('ended', () => { wantPlaying = false; controls(); clearHighlight(); });
  audio.addEventListener('error', () => { if (audio.getAttribute('src')) status.textContent = 'This book recording could not be played. Try generating it again.'; });
  return {
    refresh, apply, stop, toggle, skipBy,
    get ready() { return ready(); },
    get absConnected() { return absConnected; },
    beginNavigation() { manualNavigation = true; pendingWordTime = undefined; wordPlayback++; return ++navigationVersion; },
    async endNavigation(version, { seekToPage = true } = {}) {
      if (version !== navigationVersion) return;
      // Audio metadata must never keep the reader's navigation lock held. A
      // known source-section boundary is safe while finer timestamps reload.
      const current = renderer()?.audioUnit?.(), segment = segmentFor(current?.key);
      if (seekToPage && enabled && ready() && segment && unit?.key !== current?.key) seekTo(segment.start);
      try { if (enabled && ready()) await readerDeadline(() => refresh({ seekToPage }), { signal: controller?.signal, milliseconds: 4000 }); }
      catch (error) { if (version === navigationVersion && error?.name !== 'AbortError') status.textContent = 'Waiting for this page’s audio timing. You can keep reading.'; }
      finally { if (version === navigationVersion) { manualNavigation = false; void follow(); } }
    },
    playbackPosition() { return ready() && !initialSeek && !waitingForMetadata && !manualNavigation && audio.getAttribute('src') === recording.url && Number.isFinite(audio.duration)
      ? { book: book().id, recording: recording.id, time: audio.currentTime, duration: recording.duration, absConnected, readingTarget: readingPosition() } : null; },
    async resumeAt(time) { seekTo(time); await follow(true); },
    async seekSource(key, from) {
      if (!enabled || !ready()) return;
      await loadCurrent(); if (unit?.key !== key) return;
      const index = (unit.audio.timings || []).findIndex((stamp) => stamp.to > from && stamp.start != null);
      const stamp = timed.find((item) => item.index === index); if (stamp) seekTo(stamp.start);
    },
    lemmaAt(node, offset) { return unit?.method === 'word forms' ? null : local?.at(node, offset)?.token; },
    async playWord(node, offset) {
      const request = ++wordPlayback, epoch = lifecycle, navigation = navigationVersion;
      if (!enabled) return false;
      await refresh();
      if (request !== wordPlayback || epoch !== lifecycle || navigation !== navigationVersion || !enabled || !ready() || !node.isConnected) return false;
      const word = local?.at(node, offset)?.word;
      if (!word) return false;
      const position = visibleAudioPosition({ ...local, visible: (candidate) => candidate === word }, timed, timingMap, segmentFor(unit?.key));
      if (!position) return false;
      wantPlaying = true;
      if (waitingForMetadata) pendingWordTime = position.time;
      else { seekTo(position.time); await startPlayback(); }
      return true;
    },
    seekWord(node, offset) {
      if (!enabled || !ready()) return;
      const word = local?.at(node, offset)?.word;
      const index = [...timingMap].find(([, mapped]) => mapped === word)?.[0];
      const stamp = timed.find((stamp) => stamp.index === index);
      if (stamp) seekTo(stamp.start);
    },
  };
}
