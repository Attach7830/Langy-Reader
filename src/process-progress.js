import { translateUI } from './i18n.js';

const phases = {
  generating: 'Creating speech', aligning: 'Synchronizing spoken words', analyzing: 'Analyzing vocabulary',
  assembling: 'Combining audio sections', saving: 'Saving section audio', importing: 'Saving the finished file',
  converting: 'Converting document', downloading: 'Downloading', syncing: 'Synchronizing audio with text',
  linking: 'Linking the recording', scanning: 'Scanning PDF pages', searching: 'Searching', ranking: 'Comparing recommendations',
};
const units = { sections: 'sections completed', passages: 'passages completed', windows: 'repair windows completed', pages: 'pages processed' };
export function progressCount(counter) {
  if (!Number.isFinite(counter?.complete) || !Number.isFinite(counter?.total) || counter.total <= 0) return '';
  return `${Math.max(0, Math.min(counter.complete, counter.total)).toLocaleString()} / ${counter.total.toLocaleString()} ${translateUI(units[counter.unit] || counter.unit || '')}`;
}
export function processProgress(job) {
  const percent = Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : null;
  const counts = [...new Set([progressCount(job.counter), progressCount(job.activity)].filter(Boolean))];
  const phase = job.kind === 'ocr' ? job.phase === 'saving' || job.phase === 'importing' ? 'Saving the finished file' : job.phase === 'preparing' ? 'Preparing PDF scan' : job.phase === 'running' || job.phase === 'scanning' ? 'Scanning PDF pages' : phases[job.phase] : phases[job.phase];
  return { percent, text: [...counts, ...(percent == null ? [] : [`${percent > 0 && percent < 1 ? '<1' : Math.floor(percent)}%`])].join(' · '),
    phase: translateUI(phase || ''), detail: job.activity?.detail || '',
    unknown: percent == null && !counts.length ? translateUI('This step does not report a percentage yet.') : '' };
}
export function processElapsed(job, now = Date.now()) {
  if (!Number.isFinite(job.startedAt) || job.startedAt <= 0) return '';
  const seconds = Math.max(0, Math.floor((now - job.startedAt) / 1000));
  return `${translateUI('Elapsed')} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
