import { eventKey } from './settings.js';

export function readingShortcut(event, settings) {
  if (event.defaultPrevented || event.target?.closest?.('input, textarea, select, [contenteditable]')) return null;
  const key = eventKey(event), keys = settings.keys;
  if (!key || key === 'Space' && event.target?.closest?.('button, a')) return null;
  if (key === 'Space' && settings.audioEnabled) {
    event.preventDefault(); return event.repeat ? null : 'playback';
  }
  let action = Object.keys(keys).find((name) => keys[name] === key);
  if (!action) return null;
  if (event.repeat && !['previous', 'next'].includes(action)) return null;
  if (action === 'alternate') action = 'next';
  event.preventDefault(); return action;
}
