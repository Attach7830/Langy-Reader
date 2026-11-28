export function audioSyncTime(time) {
  const centiseconds = Math.round(time * 100);
  const minutes = Math.floor(centiseconds / 6000);
  return `${minutes}:${(centiseconds % 6000 / 100).toFixed(2).padStart(5, '0')}`;
}
