import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RequestError } from './books.js';

const cookieName = 'langy_visitor';
const lifetime = 24 * 60 * 60 * 1000;
const maxJobs = 4;
export const demoUploadLimit = 20 * 1024 * 1024;
export const demoBookLimit = 4;
export const demoStorageLimit = 512 * 1024 * 1024;

export async function visitorMiddleware(dir) {
  const path = join(dir, 'demo-secret');
  let secret;
  try { secret = await readFile(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    secret = randomBytes(32);
    await writeFile(path, secret, { flag: 'wx', mode: 0o600 });
  }
  const signature = (id, expiry) => createHmac('sha256', secret).update(`${id}.${expiry}`).digest();
  return (req, res, next) => {
    const cookie = req.get('Cookie')?.split(/;\s*/u).find((part) => part.startsWith(`${cookieName}=`));
    const token = cookie?.slice(cookieName.length + 1);
    const match = /^[\w-]{32}\.(\d{13})\.[\w-]{43}$/u.exec(token || '');
    if (match) {
      const [id, expiry, signed] = token.split('.');
      if (Number(expiry) > Date.now() && timingSafeEqual(signature(id, expiry), Buffer.from(signed, 'base64url'))) {
        req.visitor = { id, expires: Number(expiry) };
        return next();
      }
    }
    const id = randomBytes(24).toString('base64url');
    const expires = Date.now() + lifetime;
    const value = `${id}.${expires}.${signature(id, expires).toString('base64url')}`;
    res.cookie(cookieName, value, { maxAge: lifetime, httpOnly: true, sameSite: 'strict',
      secure: req.secure || req.get('X-Forwarded-Proto') === 'https' });
    req.visitor = { id, expires };
    next();
  };
}

export function limitJobs({ perMinute = Infinity, perVisitor = Infinity } = {}) {
  let pending = 0;
  let window = 0;
  let started = 0;
  const visitors = new Map();
  return (req, res, next) => {
    const minute = Math.floor(Date.now() / 60_000);
    if (window !== minute) {
      window = minute;
      started = 0;
      visitors.clear();
    }
    const id = req.visitor?.id ?? '';
    const used = visitors.get(id) ?? 0;
    if (pending >= maxJobs || started >= perMinute || used >= perVisitor) {
      res.set('Retry-After', '30');
      return next(new RequestError(429, 'The demo is busy. Try again in a moment.'));
    }
    pending++;
    started++;
    visitors.set(id, used + 1);
    res.once('close', () => { pending--; });
    next();
  };
}
