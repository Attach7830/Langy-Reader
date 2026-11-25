import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openAISettings } from './ai.js';
import { RequestError } from './books.js';

// Users may use the instance's approved endpoint or these public providers.
// A member-controlled URL must never receive the administrator's saved key.
const publicEndpoints = new Set(['https://api.openai.com/v1', 'https://openrouter.ai/api/v1', 'https://api.groq.com/openai/v1']);
export async function openAIProfiles(dir, root, accounts, { demo = false } = {}) {
  const context = new AsyncLocalStorage(), profiles = new Map();
  async function prepare(user) {
    const visitor = accounts.visitorForOwner(user.id);
    if (!visitor?.authenticated || !visitor.id || profiles.has(visitor.id)) return;
    const folder = join(dir, 'ai-users', visitor.id); await mkdir(folder, { recursive: true, mode: 0o700 });
    profiles.set(visitor.id, { folder, custom: existsSync(join(folder, 'ai-settings.json')), service: await openAISettings(folder, false) });
  }
  for (const user of accounts.list()) await prepare(user);
  const entry = () => profiles.get(context.getStore()?.id);
  function write(own, operation) { const pending = (own.writing || Promise.resolve()).then(operation); own.writing = pending.catch(() => {}); return pending; }
  const service = () => entry()?.custom ? entry().service : root;
  function permitted(body) {
    if (demo || !context.getStore()?.id || context.getStore()?.role === 'admin' || !body?.baseUrl) return;
    const url = body.baseUrl.trim().replace(/\/+$/u, ''), approved = root.settings().baseUrl;
    if (url !== approved && !publicEndpoints.has(url)) throw new RequestError(403, 'Use the server AI endpoint or a supported public provider. Ask an administrator to approve another server.');
  }
  function settings() {
    const own = entry(), member = Boolean(context.getStore()?.id);
    return { ...service().settings(), ...(member ? { inherited: !own?.custom, hasKey: Boolean(own?.custom && own.service.settings().hasKey), canUseServerDefault: true } : {}) };
  }
  return new Proxy({
    run: (visitor, task) => context.run(visitor, task), prepare, settings,
    cacheIdentity: () => service().cacheIdentity(),
    async save(body) { permitted(body); const own = entry(); if (!own && context.getStore()?.id) throw new RequestError(503, 'Account AI settings are being prepared. Try again.'); if (!own) return root.save(body); return write(own, async () => { const result = await own.service.save(body); own.custom = true; return { ...result, inherited: false, canUseServerDefault: true }; }); },
    async removeKey() { const own = entry(); if (!own && context.getStore()?.id) return settings(); if (!own) return root.removeKey(); return write(own, async () => { if (own.custom) await own.service.removeKey(); return settings(); }); },
    async useServer() { const own = entry(); if (!own) throw new RequestError(403, 'The administrator configures the server AI connection.'); return write(own, async () => { await rm(join(own.folder, 'ai-settings.json'), { force: true }); own.service = await openAISettings(own.folder, false); own.custom = false; return settings(); }); },
    models(body) { permitted(body); return service().models(body); },
  }, { get(target, name) { if (Object.hasOwn(target, name)) return target[name]; const value = service()[name]; return typeof value === 'function' ? (...args) => service()[name](...args) : value; } });
}
