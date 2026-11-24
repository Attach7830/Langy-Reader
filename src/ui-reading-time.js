import { languageName } from './settings.js';
export function readingDuration(milliseconds) {
  const seconds = Math.floor(Math.max(0, Number(milliseconds) || 0) / 1000), minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
export function showReadingTime(summary) {
  document.querySelector('#reading-time-total').textContent = `Total reading time: ${readingDuration(summary?.totalMs)}`;
  document.querySelector('#reading-time-languages').textContent = summary?.byLanguage?.length
    ? summary.byLanguage.map((row) => `${row.language === 'zh' ? 'Mandarin' : languageName(row.language)}: ${readingDuration(row.milliseconds)}`).join(' · ')
    : 'Reading time will appear here as you read.';
}
