import { lstat, readdir, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RequestError } from './books.js';

export function userStorage(dir, { policy, paths, now = Date.now }) {
  const reservations = new Map(), cached = new Map();
  async function size(path, seen) {
    path = resolve(path); if (seen.has(path)) return 0; seen.add(path);
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    let total = 0;
    for (const name of await readdir(path)) total += await size(join(path, name), seen);
    return total;
  }
  async function used(owner, fresh = false) {
    const old = cached.get(owner); if (!fresh && old && old.until > now()) return old.bytes;
    try {
      const seen = new Set(); let bytes = 0;
      for (const path of await paths(owner)) if (path) bytes += await size(path, seen);
      cached.set(owner, { bytes, until: now() + 1000 }); return bytes;
    } catch { throw new RequestError(503, 'Storage usage could not be checked. Try again before adding files.'); }
  }
  async function reserve(owner, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RequestError(422, 'Choose a valid file size.');
    const current = policy(owner);
    if (!current.active) throw new RequestError(403, 'This account is no longer active.');
    let released = false;
    const release = () => { if (released) return; released = true; reservations.set(owner, Math.max(0, (reservations.get(owner) || 0) - bytes)); cached.delete(owner); };
    reservations.set(owner, (reservations.get(owner) || 0) + bytes);
    try {
      if (current.storageLimit !== null && current.storageLimit !== undefined && await used(owner, true) + (reservations.get(owner) || 0) > current.storageLimit) {
        throw new RequestError(507, 'Your account storage limit has been reached. Remove files or ask the administrator to increase it.');
      }
      return release;
    } catch (error) { release(); throw error; }
  }
  async function summary(owner) {
    const current = policy(owner), usedBytes = await used(owner), totalBytes = current.storageLimit;
    let free = null, drive = { available: false, scope: 'drive' };
    try {
      const info = await statfs(dir, { bigint: true }), capacity = Number(info.blocks * info.bsize);
      if (capacity > 0) {
        free = Number(info.bavail * info.bsize);
        drive = { available: true, scope: 'drive', totalBytes: capacity, availableBytes: free,
          usedBytes: Number((info.blocks - info.bfree) * info.bsize), reservedBytes: Number((info.bfree - info.bavail) * info.bsize) };
      }
    } catch {}
    return { available: true, scope: 'account', usedBytes, totalBytes: totalBytes ?? usedBytes + (free || 0), unlimited: totalBytes === null || totalBytes === undefined,
      availableBytes: totalBytes == null ? free : Math.max(0, Math.min(totalBytes - usedBytes, free ?? Infinity)), overLimit: totalBytes != null && usedBytes > totalBytes, drive };
  }
  return { reserve, used, summary, invalidate: (owner) => cached.delete(owner) };
}
