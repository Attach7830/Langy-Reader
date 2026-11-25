import { fonts } from './settings.js';
import { offlineOwner } from './offline-store.js';
const custom = /^custom-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const formats = new Set(['ttf', 'otf', 'woff', 'woff2']);
const cssFormat = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' };
let account, manifest, loading, epoch = 0; const pending = new Map(), sources = new Map();
function owner() { try { return offlineOwner() || JSON.parse(localStorage.getItem('langy-account-settings-v1') || '{}').accountId || ''; } catch { return ''; } }
async function storage() { try { return owner() && globalThis.caches ? await caches.open('langy-fonts-' + owner()) : null; } catch { return null; } }
function reset() {
  epoch++;
  for (const [id, url] of sources) { URL.revokeObjectURL(url); delete fonts[id]; }
  sources.clear(); pending.clear(); manifest = loading = undefined; account = owner();
}
async function list(refresh = false) {
  if (account !== owner()) reset();
  if (manifest && !refresh) return manifest;
  if (loading) return loading;
  const current = account;
  loading = (async () => {
    const cache = await storage(); let result;
    if (!refresh) try { result = await (await cache?.match('/api/fonts'))?.json(); } catch {}
    if (!result) {
      try {
        const response = await fetch('/api/fonts', { signal: AbortSignal.timeout(6000), cache: 'no-store' });
        if (!response.ok) throw new Error('Font list unavailable'); result = await response.json();
        if (current !== owner() || result.accountId !== current) throw new Error('The signed-in account changed.');
        try { await cache?.put('/api/fonts', Response.json(result)); } catch {}
      } catch (error) {
        try { result = await (await cache?.match('/api/fonts'))?.json(); } catch {}
        if (!result) throw error;
      }
    }
    if (current !== owner() || result.accountId !== current) return [];
    manifest = (result.fonts || []).filter((font) => custom.test(font.id) && formats.has(font.format));
    const ids = new Set(manifest.map((font) => font.id));
    for (const [id, url] of sources) if (!ids.has(id)) { URL.revokeObjectURL(url); sources.delete(id); delete fonts[id]; }
    return manifest;
  })().finally(() => { loading = undefined; }); return loading;
}
async function ensure(id) {
  if (!custom.test(id)) return;
  if (account !== owner()) reset();
  if (sources.has(id)) return fonts[id];
  if (pending.has(id)) return pending.get(id);
  const current = owner(), version = epoch;
  const operation = (async () => {
    let font = (await list()).find((font) => font.id === id);
    if (!font) font = (await list(true)).find((font) => font.id === id);
    if (!font) throw new Error('The imported font is unavailable.');
    const path = '/api/fonts/' + id.slice(7) + '/file', cache = await storage(); let response = await cache?.match(path);
    if (!response) {
      response = await fetch(path, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
      if (!response.ok) throw new Error('The font could not be downloaded.');
      const bytes = await response.blob(); if (!bytes.size || bytes.size > 32 * 1024 ** 2) throw new Error('The font is too large.');
      response = new Response(bytes, { headers: { 'Content-Type': 'font/' + font.format } });
      if (current !== owner() || version !== epoch) return;
      try { await cache?.put(path, response.clone()); } catch {}
    }
    const blob = await response.blob(); if (current !== owner() || version !== epoch) return;
    const url = URL.createObjectURL(blob), family = 'LangyFont' + id.slice(7).replaceAll('-', '');
    try {
      if (typeof FontFace !== 'undefined') { const face = await new FontFace(family, `url("${url}")`).load(); document.fonts.add(face); }
      if (current !== owner() || version !== epoch) { URL.revokeObjectURL(url); return; }
      sources.set(id, url); fonts[id] = { name: font.name, stack: `"${family}", Georgia, serif`, face: `@font-face{font-family:"${family}";src:url("${url}") format("${cssFormat[font.format]}");font-display:swap;}` };
      return fonts[id];
    } catch { URL.revokeObjectURL(url); throw new Error('This font could not be loaded. Try another TTF, OTF, WOFF or WOFF2 file.'); }
  })().finally(() => pending.delete(id)); pending.set(id, operation); return operation;
}
async function cacheSelected(id) {
  if (!custom.test(id)) return;
  await ensure(id); const cache = await storage();
  if (!await cache?.match('/api/fonts/' + id.slice(7) + '/file') || !await cache?.match('/api/fonts')) throw new Error('The selected font could not be saved offline. Free some storage or select a built-in font.');
}
async function forget(id) {
  epoch++;
  const url = sources.get(id); if (url) URL.revokeObjectURL(url); sources.delete(id); delete fonts[id];
  await (await storage())?.delete('/api/fonts/' + id.slice(7) + '/file'); manifest = undefined;
}
export const userFonts = { list, ensure, cacheSelected, forget, custom: (id) => custom.test(id) };
