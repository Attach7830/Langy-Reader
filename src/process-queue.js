import { $, api, element, message } from './ui.js';
import { processTasks } from './process-tasks.js';

const active = (job) => ['queued', 'running', 'waiting', 'downloading'].includes(job.state);
export function processQueue() {
  const dialog = $('#downloads-dialog'), list = $('#process-list'), empty = $('#process-empty'), button = $('#open-process-queue');
  let disposed = false, account, jobs = [], local = processTasks.snapshot(), timer, pending, redraw, signature = '', dismissed = new Set();
  const version = (job) => `${job.id}:${job.state}:${job.created || 0}`;
  function render() {
    const entries = [...jobs, ...local.tasks].filter((job) => !dismissed.has(version(job)));
    const count = entries.filter(active).length + local.downloads.filter(active).length;
    const failed = entries.some((job) => job.state === 'failed') || local.downloads.some((job) => job.state === 'failed');
    for (const selector of ['#process-queue-count', '#mobile-process-count']) {
      const badge = $(selector); if (badge) { badge.textContent = String(count || (failed ? '!' : '')); badge.hidden = !count && !failed; }
    }
    button.dataset.active = String(count > 0); button.dataset.failed = String(failed);
    const next = JSON.stringify(entries);
    if (next !== signature) {
      signature = next; entries.sort((a, b) => Number(!active(a)) - Number(!active(b)) || b.created - a.created);
      list.replaceChildren(...entries.map((job) => {
        const card = element('article', 'download-card process-card'); card.dataset.process = job.id;
        card.append(element('h3', '', job.label));
        if (job.title) { const title = element('p', 'process-book-title', job.title); title.setAttribute('data-user-content', ''); card.append(title); }
        const state = ({ queued: 'Queued', running: 'In progress', waiting: 'Waiting', failed: 'Needs attention', completed: 'Finished', cancelled: 'Cancelled' })[job.state] || job.state;
        const detail = job.detail || (job.nextAttempt ? `Retry at ${new Date(job.nextAttempt).toLocaleTimeString()}` : '');
        card.append(element('p', 'field-note', [state, detail].filter(Boolean).join(' · ')));
        if (active(job)) { const bar = document.createElement('progress'); bar.max = 100; if (Number.isFinite(job.progress)) bar.value = job.progress; bar.setAttribute('aria-label', job.label); card.append(bar); }
        const actions = element('div', 'download-actions');
        if (job.bookId || job.kind === 'archive' || job.kind === 'discovery') {
          const view = element('button', 'button quiet small', 'Details'); view.type = 'button'; view.addEventListener('click', () => {
            dialog.close(); if (job.kind === 'discovery') location.hash = '#discover';
            else window.dispatchEvent(new CustomEvent('langy-open-process', { detail: job }));
          }); actions.append(view);
        }
        if (!active(job)) { const dismiss = element('button', 'button quiet small', 'Dismiss'); dismiss.type = 'button'; dismiss.addEventListener('click', () => { dismissed.add(version(job)); render(); }); actions.append(dismiss); }
        card.append(actions); return card;
      }));
    }
    empty.hidden = Boolean(entries.length || local.downloads.length);
    $('#process-downloads').hidden = !local.downloads.length;
  }
  function scheduleRender() { if (redraw) return; redraw = requestAnimationFrame(() => { redraw = null; render(); }); }
  const unsubscribe = processTasks.subscribe((value) => { local = value; scheduleRender(); });
  async function refresh() {
    if (disposed || !account || pending) return pending;
    clearTimeout(timer);
    pending = (async () => {
      try { const result = await api('/api/processes');
        if (disposed || result.accountId !== account) return;
        jobs = result.jobs; message('#process-error', result.unavailable ? 'Some process statuses are temporarily unavailable.' : ''); render();
      } catch (error) { if (dialog.open) message('#process-error', 'Server status unavailable. Device downloads are shown below.'); }
      finally { pending = undefined; if (!disposed) timer = setTimeout(() => void refresh(), document.hidden ? 30000 : dialog.open || jobs.some(active) ? 2000 : 5000); timer?.unref?.(); }
    })(); return pending;
  }
  function open() { if (!dialog.open) dialog.showModal(); render(); void refresh(); }
  button.addEventListener('click', open);
  for (const control of document.querySelectorAll('[data-open-processes]')) control.addEventListener('click', open);
  $('#clear-finished-processes').addEventListener('click', () => { for (const job of jobs) if (!active(job)) dismissed.add(version(job)); processTasks.clearFinished(); window.dispatchEvent(new CustomEvent('langy-clear-finished-downloads')); render(); });
  window.addEventListener('langy-processes-changed', () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 100); });
  window.addEventListener('online', () => void refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  return { dispose() { disposed = true; clearTimeout(timer); cancelAnimationFrame(redraw); unsubscribe(); }, setAccount(id) { if (account !== id) { jobs = []; dismissed.clear(); signature = ''; processTasks.setAccount(id); } account = id; void refresh(); } };
}
