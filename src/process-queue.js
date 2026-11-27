import { $, api, element, message } from './ui.js';
import { processTasks } from './process-tasks.js';
import { processHistory } from './process-history.js';
import { getSettings, saveSettings, subscribeSettings } from './settings.js';
import { androidApp } from './platform.js';
import { processElapsed, processProgress } from './process-progress.js';
import { translateUI } from './i18n.js';

const active = (job) => ['queued', 'running', 'waiting', 'downloading'].includes(job.state);
export function processQueue({ now = Date.now, changePreferences = saveSettings } = {}) {
  const dialog = $('#downloads-dialog'), list = $('#process-list'), empty = $('#process-empty'), button = $('#open-process-queue');
  let disposed = false, account, libraryRevision, jobs = [], local = processTasks.snapshot(), timer, pending, redraw, expiry, signature = '', dismissed = new Set(), history = processHistory({ now });
  const version = (job) => JSON.stringify([job.id, job.state, job.created || 0, job.detail, job.phase]);
  function render() {
    const minutes = getSettings().processDismissMinutes;
    // Polling must not replace a number while the reader is editing it.
    if (document.activeElement !== $('#process-dismiss-minutes')) $('#process-dismiss-minutes').value = minutes;
    history.update([...jobs, ...local.tasks]);
    const entries = history.visible(minutes).filter((job) => !dismissed.has(version(job)));
    clearTimeout(expiry); const remaining = history.expiresIn(minutes);
    if (remaining != null) { expiry = setTimeout(render, remaining); expiry?.unref?.(); }
    const count = entries.filter(active).length + local.downloads.filter(active).length;
    const failed = entries.some((job) => job.state === 'failed') || local.downloads.some((job) => job.state === 'failed');
    for (const selector of ['#process-queue-count', '#mobile-process-count']) {
      const badge = $(selector); if (badge) { badge.textContent = String(count || (failed ? '!' : '')); badge.hidden = !count && !failed; }
    }
    button.dataset.active = String(count > 0); button.dataset.failed = String(failed);
    $('#clear-finished-processes').hidden = !entries.some((job) => !active(job)) && !local.downloads.some((job) => !active(job));
    const next = JSON.stringify(entries);
    if (next !== signature) {
      signature = next; entries.sort((a, b) => Number(!active(a)) - Number(!active(b))
        || (a.queuePosition ?? Infinity) - (b.queuePosition ?? Infinity) || Number(b.state === 'running') - Number(a.state === 'running') || b.created - a.created);
      list.replaceChildren(...entries.map((job) => {
        const card = element('article', 'download-card process-card'); card.dataset.process = job.id;
        card.append(element('h3', '', job.label));
        if (active(job) && job.cancellable) {
          const cancel=element('button','icon-button small process-cancel','×');cancel.type='button';cancel.setAttribute('aria-label','Cancel '+job.label);cancel.title='Cancel process';
          cancel.addEventListener('click',async () => {cancel.disabled=true;
            try { if (job.id.startsWith('request:')) processTasks.cancel(job.id); else await api('/api/processes/'+encodeURIComponent(job.id),{method:'DELETE'}); await refresh(); }
            catch(error){message('#process-error',error.message);cancel.disabled=false;}
          });card.append(cancel);
        }
        if (job.title) { const title = element('p', 'process-book-title', job.title); title.setAttribute('data-user-content', ''); card.append(title); }
        const state = ({ queued: 'Queued', running: 'In progress', waiting: 'Waiting', failed: 'Needs attention', completed: 'Finished', cancelled: 'Cancelled' })[job.state] || job.state;
        const detail = job.detail || (job.nextAttempt ? `Retry at ${new Date(job.nextAttempt).toLocaleTimeString()}` : '');
        card.append(element('p', 'field-note', [state, detail].filter(Boolean).join(' · ')));
        if (job.pauseRequested) card.append(element('p', 'field-note', 'Switching after the current step'));
        else if (job.paused && job.state === 'queued') card.append(element('p', 'field-note', 'Paused for higher-priority work'));
        if (job.queuePosition) card.append(element('p', 'field-note', `${translateUI('Queue position')}: ${job.queuePosition}`));
        const priorityBadges = element('div', 'button-row');
        if (active(job) && job.topPriority) priorityBadges.append(element('span', 'book-read-badge', translateUI('Anna’s Archive priority')));
        if (job.priority > 0) priorityBadges.append(element('span', 'book-read-badge', translateUI('Priority raised')));
        if (job.priority < 0) priorityBadges.append(element('span', 'book-read-badge', translateUI('Priority lowered')));
        if (priorityBadges.childElementCount) card.append(priorityBadges);
        if (active(job)) {
          const progress = processProgress(job), bar = document.createElement('progress'); bar.max = 100;
          if (progress.percent != null) bar.value = progress.percent;
          bar.setAttribute('aria-label', job.label); if (progress.text) bar.setAttribute('aria-valuetext', progress.text);
          card.append(bar);
          if (progress.phase) card.append(element('p', 'process-phase', progress.phase));
          if (progress.text) { const count = element('p', 'process-progress-text', progress.text); count.setAttribute('data-user-content', ''); card.append(count); }
          if (progress.detail || progress.unknown) card.append(element('p', 'field-note', progress.detail || progress.unknown));
          if (job.startedAt) { const clock = element('p', 'field-note process-elapsed', processElapsed(job, now())); clock.dataset.started = job.startedAt; card.append(clock); }
        }
        const actions = element('div', 'download-actions');
        if (job.canPrioritize) {
          const controls = [];
          for (const [action, label, title] of [
            ['raise', 'Raise priority', 'Run ahead of the current task'],
            ['top', 'Top priority', 'Move ahead of all other tasks'],
            ['lowest', 'Lowest priority', 'Move behind all other tasks'],
          ]) {
            const control = element('button', 'button secondary small', label); control.type = 'button'; control.title = title;
            control.addEventListener('click', async () => {
              for (const button of controls) button.disabled = true;
              try { await api(`/api/processes/${encodeURIComponent(job.id)}/priority`, { method: 'POST', body: { action } }); await refresh(); }
              catch (error) { message('#process-error', error.message); }
              finally { for (const button of controls) button.disabled = false; }
            }); controls.push(control); actions.append(control);
          }
        }
        for (const [label, path] of [
          ...(job.retryOcr ? [['Retry OCR', `/api/books/${encodeURIComponent(job.bookId)}/ocr/jobs/${encodeURIComponent(job.retryOcr)}/retry`]] : []),
          ...(job.checkUpload ? [['Check ABS upload', `/api/books/${encodeURIComponent(job.bookId)}/audiobookshelf/jobs/${encodeURIComponent(job.checkUpload)}/check`]] : []),
        ]) {
          const retry = element('button', 'button secondary small', label); retry.type = 'button';
          retry.addEventListener('click', async () => { retry.disabled = true;
            try { await api(path, { method: 'POST' }); await refresh(); }
            catch (error) { message('#process-error', error.message); retry.disabled = false; }
          }); actions.append(retry);
        }
        if (job.retry) { const retry=element('button','button secondary small','Retry');retry.type='button';retry.addEventListener('click',async()=>{retry.disabled=true;try{await api('/api/imports/web/'+encodeURIComponent(job.retry)+'/retry',{method:'POST'});await refresh();}catch(error){message('#process-error',error.message);retry.disabled=false;}});actions.append(retry);}
        if (job.decision) for (const [label, replace] of [['Import and replace Langy audio', true], ['Keep current audio', false]]) {
          const decide = element('button', `button ${replace ? '' : 'quiet'} small`, label); decide.type = 'button';
          decide.addEventListener('click', async () => {
            for (const control of actions.querySelectorAll('button')) control.disabled = true;
            try { await api(`/api/books/${encodeURIComponent(job.bookId)}/audiobookshelf/jobs/${encodeURIComponent(job.decision)}/decision`, { method: 'POST', body: { replace } }); await refresh(); window.dispatchEvent(new CustomEvent('langy-processes-changed')); }
            catch (error) { message('#process-error', error.message); for (const control of actions.querySelectorAll('button')) control.disabled = false; }
          }); actions.append(decide);
        }
        if (job.bookId || job.kind === 'archive' || job.kind === 'discovery') {
          const view = element('button', 'button quiet small', 'Details'); view.type = 'button'; view.addEventListener('click', () => {
            dialog.close(); if (job.kind === 'discovery') location.hash = '#discover';
            else window.dispatchEvent(new CustomEvent('langy-open-process', { detail: job }));
          }); actions.append(view);
        }
        if (!active(job)) { const dismiss = element('button', 'button quiet small', 'Dismiss'); dismiss.type = 'button'; dismiss.addEventListener('click', () => { dismissed.add(version(job)); history.dismiss(job); render(); }); actions.append(dismiss); }
        card.append(actions); return card;
      }));
    }
    empty.hidden = Boolean(entries.length || local.downloads.length);
    $('#process-downloads').hidden = !androidApp() || !local.downloads.length;
    for (const clock of list.querySelectorAll('.process-elapsed')) clock.textContent = processElapsed({ startedAt: Number(clock.dataset.started) }, now());
  }
  function scheduleRender() { if (redraw) return; redraw = requestAnimationFrame(() => { redraw = null; render(); }); }
  const unsubscribe = processTasks.subscribe((value) => { local = value; scheduleRender(); });
  async function refresh() {
    if (disposed || !account || pending) return pending;
    clearTimeout(timer);
    pending = (async () => {
      try { const result = await api('/api/processes');
        if (disposed || result.accountId !== account) return;
        if (libraryRevision && result.libraryRevision && libraryRevision !== result.libraryRevision) window.dispatchEvent(new CustomEvent('langy-library-changed'));
        libraryRevision = result.libraryRevision || libraryRevision;
        if (result.jobs.some((job) => job.kind === 'ocr' && job.state === 'completed' && !jobs.some((previous) => previous.id === job.id && previous.state === 'completed'))) window.dispatchEvent(new CustomEvent('langy-library-changed'));
        if (!result.unavailable && jobs.some((job) => ['ocr','conversion','web-import','kavita-import'].includes(job.kind) && active(job) && !result.jobs.some((next) => next.id === job.id))) window.dispatchEvent(new CustomEvent('langy-library-changed'));
        if (!result.unavailable) for (const job of jobs) if ((['narration', 'recording'].includes(job.kind) && active(job) || job.kind === 'audiobookshelf' && job.phase === 'syncing') && !result.jobs.some((next) => next.id === job.id)) window.dispatchEvent(new CustomEvent('langy-audio-updated', { detail: { book: job.bookId } }));
        if (result.unavailable) jobs = [...result.jobs, ...jobs.filter((job) => !result.jobs.some((next) => next.id === job.id))];
        else jobs = result.jobs;
        message('#process-error', result.unavailable ? 'Some process statuses are temporarily unavailable.' : '');
        const checked = $('#process-checked-at'); if (checked) { checked.hidden = false; checked.textContent = `${translateUI('Server status checked')} · ${new Date(now()).toLocaleTimeString()}`; }
        render();
      } catch (error) { if (dialog.open) message('#process-error', 'Server status unavailable. Progress shown may be out of date. Device downloads are shown below.'); }
      finally { pending = undefined; if (!disposed) timer = setTimeout(() => void refresh(), document.hidden ? 30000 : dialog.open || jobs.some(active) ? 2000 : 5000); timer?.unref?.(); }
    })(); return pending;
  }
  function open() { if (!dialog.open) dialog.showModal(); render(); void refresh(); }
  button.addEventListener('click', open);
  for (const control of document.querySelectorAll('[data-open-processes]')) control.addEventListener('click', open);
  $('#process-dismiss-minutes').addEventListener('change', (event) => {
    if (!event.target.reportValidity()) return;
    changePreferences({ processDismissMinutes: Number(event.target.value) }); render();
  });
  const unsubscribeSettings = subscribeSettings(() => render());
  $('#clear-finished-processes').addEventListener('click', () => { for (const job of history.visible(getSettings().processDismissMinutes)) if (!active(job)) { dismissed.add(version(job)); history.dismiss(job); } processTasks.clearFinished(); window.dispatchEvent(new CustomEvent('langy-clear-finished-downloads')); render(); });
  window.addEventListener('langy-processes-changed', () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 100); });
  window.addEventListener('online', () => void refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  return { dispose() { disposed = true; clearTimeout(timer); clearTimeout(expiry); cancelAnimationFrame(redraw); unsubscribe(); unsubscribeSettings(); }, setAccount(id) { if (account !== id) { jobs = []; libraryRevision = undefined; dismissed.clear(); signature = ''; let storage; try { storage = localStorage; } catch {} history = processHistory({ now, storage, key: `langy-process-finished-${id || ''}` }); processTasks.setAccount(id); } account = id; void refresh(); } };
}
