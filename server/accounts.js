import { createHash, randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RequestError } from './books.js';

const scrypt = promisify(derive), sessionName = 'langy_session';
const parameters = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 ** 2 };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const md5 = (value) => createHash('md5').update(value).digest('hex'); // KOReader wire protocol only; never stored unhashed.
const passwordValid = (value) => typeof value === 'string' && value.length >= 15 && value.length <= 256;
const publicUser = ({ id, username, role, disabled, created }) => ({ id, username, role, disabled: Boolean(disabled), created });
const cookies = (req) => Object.fromEntries((req.get('Cookie') || '').split(';').flatMap((part) => {
  const at = part.indexOf('='); return at < 0 ? [] : [[part.slice(0, at).trim(), part.slice(at + 1).trim()]];
}));

export async function hashPassword(value) {
  const salt = randomBytes(16), key = await scrypt(value, salt, 64, parameters);
  return `scrypt:32768:8:3:${salt.toString('hex')}:${key.toString('hex')}`;
}
export async function verifyPassword(value, encoded) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const [, n, r, p, salt, hex] = String(encoded).split(':');
  if (Number(n) !== parameters.N || Number(r) !== parameters.r || Number(p) !== parameters.p || !/^[a-f0-9]{32}$/u.test(salt || '') || !/^[a-f0-9]{128}$/u.test(hex || '')) return false;
  const key = await scrypt(value, Buffer.from(salt, 'hex'), 64, parameters);
  return timingSafeEqual(key, Buffer.from(hex, 'hex'));
}

export async function openAccounts(dir, { demo = false, username = 'reader', password = '', now = Date.now, reservedUsernames = [] } = {}) {
  const path = join(dir, 'accounts.sqlite'), db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS account_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,password TEXT NOT NULL,sync TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')),disabled INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,
      owner TEXT NOT NULL UNIQUE,settingsKey TEXT NOT NULL UNIQUE,created INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created INTEGER NOT NULL,expires INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS session_user ON sessions(user);`);
  const meta = (key) => db.prepare('SELECT value FROM account_meta WHERE key=?').get(key)?.value;
  const setMeta = (key, value) => db.prepare('INSERT INTO account_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  const userById = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const userByOwner = (id = '') => db.prepare('SELECT * FROM users WHERE owner=?').get(id);
  if (!demo && password) {
    const fingerprint = digest(`${username}:${password}`), bootstrap = meta('bootstrap');
    if (!bootstrap) {
      const id = randomUUID(), hashes = await Promise.all([hashPassword(password), hashPassword(md5(password))]);
      db.prepare('INSERT INTO users(id,username,password,sync,role,owner,settingsKey,created) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, username, ...hashes, 'admin', '', `user:${username}`, now());
      setMeta('bootstrap', id); setMeta('environment', await hashPassword(fingerprint));
    } else if (!await verifyPassword(fingerprint, meta('environment'))) {
      const hashes = await Promise.all([hashPassword(password), hashPassword(md5(password))]);
      // An explicit change in .env remains an administrator recovery path.
      // A password changed in the UI survives restarts with the same .env.
      db.prepare("UPDATE users SET username=?,password=?,sync=?,role='admin',disabled=0,version=version+1 WHERE id=?").run(username, ...hashes, bootstrap);
      db.prepare('DELETE FROM sessions WHERE user=?').run(bootstrap); setMeta('environment', await hashPassword(fingerprint));
    }
  }
  const enabled = !demo && Boolean(db.prepare('SELECT 1 FROM users LIMIT 1').get());
  const attempts = new Map(), verified = new Map(); let inFlight = 0, dummy;
  function visitorForUser(user) {
    return { id: user.owner, userId: user.id, username: user.username, role: user.role, accountKey: user.settingsKey, authenticated: true };
  }
  function visitorForOwner(owner = '', expires = null) { const user = userByOwner(owner); return user ? visitorForUser(user) : owner ? { id: owner, expires } : undefined; }
  function throttle(key) {
    const time = now();
    if (attempts.size > 2000) for (const [name, value] of attempts) if (value.until <= time) attempts.delete(name);
    let entry = attempts.get(key);
    if (!entry || entry.until <= time) { entry = { count: 0, until: time + 60000 }; attempts.set(key, entry); }
    if (++entry.count > 12 || attempts.size > 4000 || inFlight >= 4) throw new RequestError(429, 'Too many sign-in attempts. Wait a minute and try again.');
  }
  async function authenticate(name, value, { sync = false, source = 'login' } = {}) {
    if (!enabled || typeof name !== 'string' || name.length > 128 || typeof value !== 'string' || value.length > 256) return null;
    const key = digest(`${sync}:${name.toLowerCase()}:${value}`), hit = verified.get(key), user = db.prepare('SELECT * FROM users WHERE username=?').get(name);
    if (hit && hit.until > now() && user && !user.disabled && user.id === hit.id && user.version === hit.version) return visitorForUser(user);
    throttle(`${source}:${name.toLowerCase()}`); inFlight++;
    try {
      if (!dummy) dummy = hashPassword(randomBytes(24).toString('hex'));
      const valid = await verifyPassword(value, user?.[sync ? 'sync' : 'password'] || await dummy);
      if (!valid || !user || user.disabled) return null;
      // Check again after the KDF, so a concurrent disable/reset takes effect.
      const latest = userById(user.id);
      if (!latest || latest.disabled || latest.version !== user.version) return null;
      if (verified.size >= 512) verified.delete(verified.keys().next().value);
      verified.set(key, { id: user.id, version: user.version, until: now() + 30000 });
      return visitorForUser(latest);
    } finally { inFlight--; }
  }
  function cookieOptions(req) {
    return { httpOnly: true, sameSite: 'lax', secure: req.secure || req.get('X-Forwarded-Proto')?.split(',')[0].trim() === 'https', path: '/' };
  }
  function session(req) {
    const token = cookies(req)[sessionName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user WHERE s.token=? AND s.expires>? AND u.disabled=0').get(digest(token), now());
    return row ? visitorForUser(row) : null;
  }
  function issue(req, res, visitor) {
    const token = randomBytes(32).toString('base64url'), duration = 30 * 86400000;
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token), visitor.userId, now(), now() + duration);
    db.prepare('DELETE FROM sessions WHERE user=? AND token NOT IN (SELECT token FROM sessions WHERE user=? ORDER BY created DESC,rowid DESC LIMIT 30)').run(visitor.userId, visitor.userId);
    res.cookie(sessionName, token, { ...cookieOptions(req), maxAge: duration });
    // Keep stale browser/native Basic credentials from taking over after this session expires.
    res.cookie('langy_no_basic', '1', { ...cookieOptions(req), maxAge: 400 * 86400000 });
  }
  function logout(req, res) {
    const token = cookies(req)[sessionName]; if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token));
    res.clearCookie(sessionName, cookieOptions(req));
    // A legacy browser Basic-auth cache must not silently sign back in.
    res.cookie('langy_no_basic', '1', { ...cookieOptions(req), maxAge: 400 * 86400000 });
  }
  async function identify(req) {
    if (!enabled) return null;
    const current = session(req); if (current) return current;
    if (cookies(req).langy_no_basic === '1') return null;
    const auth = req.get('Authorization') || '';
    if (!auth.startsWith('Basic ') || auth.length > 1500) return null;
    const raw = Buffer.from(auth.slice(6), 'base64').toString('utf8'), at = raw.indexOf(':');
    if (at < 0) return null;
    return authenticate(raw.slice(0, at), raw.slice(at + 1), { source: `basic:${req.ip}` });
  }
  function requireAdmin(visitor) { if (!enabled || visitor?.role !== 'admin') throw new RequestError(403, 'Administrator access is required.'); }
  async function create(body) {
    if (!enabled || demo) throw new RequestError(403, 'Set the server administrator credentials before adding accounts.');
    const name = typeof body?.username === 'string' ? body.username.trim() : '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(name)) throw new RequestError(422, 'Use a username of 1–64 letters, numbers, dots, underscores or hyphens.');
    if (reservedUsernames.some((value) => value && value.toLowerCase() === name.toLowerCase())) throw new RequestError(409, 'That username is reserved for the existing device-sync account.');
    if (!passwordValid(body.password)) throw new RequestError(422, 'Use a password of 15–256 characters.');
    if (!['user', 'admin'].includes(body.role || 'user')) throw new RequestError(422, 'Choose a valid account role.');
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(name)) throw new RequestError(409, 'That username is already in use.');
    const id = randomUUID(), hashes = await Promise.all([hashPassword(body.password), hashPassword(md5(body.password))]);
    try { db.prepare('INSERT INTO users(id,username,password,sync,role,owner,settingsKey,created) VALUES(?,?,?,?,?,?,?,?)').run(id, name, ...hashes, body.role || 'user', id, `user-id:${id}`, now()); }
    catch (error) { if (error.errcode === 2067 || error.code?.includes('CONSTRAINT')) throw new RequestError(409, 'That username is already in use.'); throw error; }
    return publicUser(userById(id));
  }
  function update(id, body) {
    const user = userById(id); if (!user) throw new RequestError(404, 'Account not found.');
    if (body.role !== undefined && !['user', 'admin'].includes(body.role) || body.disabled !== undefined && typeof body.disabled !== 'boolean') throw new RequestError(422, 'Choose valid account permissions.');
    const role = body.role ?? user.role, disabled = body.disabled === undefined ? user.disabled : Number(body.disabled);
    if (id === meta('bootstrap') && (role !== 'admin' || disabled)) throw new RequestError(409, 'The environment administrator must stay active with the administrator role.');
    if (user.role === 'admin' && !user.disabled && (role !== 'admin' || disabled) && db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND disabled=0").get().n <= 1) throw new RequestError(409, 'Keep at least one active administrator.');
    db.prepare('UPDATE users SET role=?,disabled=?,version=version+1 WHERE id=?').run(role, disabled, id);
    db.prepare('DELETE FROM sessions WHERE user=?').run(id); return publicUser(userById(id));
  }
  async function resetPassword(id, value) {
    if (!passwordValid(value)) throw new RequestError(422, 'Use a password of 15–256 characters.');
    if (!userById(id)) throw new RequestError(404, 'Account not found.');
    const hashes = await Promise.all([hashPassword(value), hashPassword(md5(value))]);
    db.prepare('UPDATE users SET password=?,sync=?,version=version+1 WHERE id=?').run(...hashes, id);
    db.prepare('DELETE FROM sessions WHERE user=?').run(id); return publicUser(userById(id));
  }
  return { enabled, demo, identify, authenticate, issue, logout, requireAdmin, create, update, resetPassword, visitorForOwner,
    preferenceOwner: (visitor) => visitor?.accountKey || userByOwner(visitor?.id || '')?.settingsKey || `user:${username}`,
    list: () => db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(publicUser),
    describe(visitor) { const user = visitor?.userId && userById(visitor.userId); return { enabled, demo, authenticated: enabled ? Boolean(user && !user.disabled) : true,
      user: user && !user.disabled ? publicUser(user) : null }; },
    close() { db.close(); },
  };
}
