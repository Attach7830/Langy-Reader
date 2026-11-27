export function isPdfTextBookmark(target) {
  return target?.text === true && typeof target.key === 'string' && /^pdf:[1-9]\d{0,6}$/u.test(target.key)
    && Number(target.key.slice(4)) <= 1_000_000 && Number.isSafeInteger(target.from) && target.from >= 0;
}

export function bookmarkTargetKey(target) {
  // Keep PDF text destinations independent of the order of incoming JSON fields.
  return JSON.stringify(isPdfTextBookmark(target) ? { text: true, key: target.key, from: target.from } : target);
}
