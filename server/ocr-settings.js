import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RequestError } from './books.js';

export async function ocrSettings(dir, { demo = false, request = fetch, busy = () => false, workerURL }) {
  const path = join(dir, 'ocr-settings.json'); let writing = Promise.resolve();
  let config = { provider: 'builtin', baseUrl: '', apiKey: '' };
  if (!demo) try { config = { ...config, ...JSON.parse(await readFile(path, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const settings = () => ({ provider: config.provider, baseUrl: config.baseUrl, hasKey: Boolean(config.apiKey), configurable: !demo, connected: config.provider === 'builtin' || Boolean(config.baseUrl) });
  const fingerprint = (value = config) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  function connection(provider = config.provider) {
    const external = provider === 'paddle';
    return { ...config, provider, baseUrl: external ? config.baseUrl : workerURL, apiKey: external ? config.apiKey : '' };
  }
  async function languages(current = connection()) {
    if (demo) return [];
    if (!current.baseUrl) throw new RequestError(422, 'Enter the URL of your Langy PaddleOCR PDF service in Settings → Devices.');
    let response, body;
    try { response = await request(new URL(current.baseUrl.replace(/\/+$/u, '') + '/ocr/languages'), { redirect: 'error', headers: current.apiKey ? { Authorization: `Bearer ${current.apiKey}` } : {}, signal: AbortSignal.timeout(15000) }); body = response.ok && await response.json(); }
    catch { throw new RequestError(503, 'Could not reach the OCR service. Check its address and network connection.'); }
    if ([401, 403].includes(response.status)) throw new RequestError(422, 'The OCR service rejected the API key.');
    if (!Array.isArray(body?.languages) || current.provider === 'paddle' && (body.engine !== 'paddleocr' || body.protocol !== 1)) throw new RequestError(503, current.provider === 'paddle' ? 'Use the Langy PaddleOCR PDF service supplied with this repository. A generic PaddleOCR JSON endpoint cannot return a searchable PDF.' : 'PDF OCR is unavailable. Rebuild the language service, then try again.');
    return body.languages.filter((code) => typeof code === 'string' && /^[a-zA-Z][a-zA-Z0-9_]*$/u.test(code));
  }
  function save(body, { verify = true } = {}) {
    const operation = writing.then(async () => {
      if (demo) throw new RequestError(403, 'OCR connections are available on self-hosted installations.');
      if (busy()) throw new RequestError(409, 'Wait for the current OCR scan to finish before changing its connection.');
      if (typeof body === 'function') body = body();
      if (!['builtin', 'paddle'].includes(body.provider)) throw new RequestError(422, 'Choose built-in OCR or PaddleOCR.');
      if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string' || body.apiKey !== undefined && typeof body.apiKey !== 'string') throw new RequestError(422, 'Enter a valid OCR address and API key.');
      const baseUrl = (body.baseUrl ?? config.baseUrl).trim().replace(/\/+$/u, '');
      if (baseUrl) { let url; try { url = new URL(baseUrl); } catch { throw new RequestError(422, 'Enter a valid OCR service URL.'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new RequestError(422, 'Use an HTTP(S) OCR URL without embedded credentials, a query or a fragment.'); }
      if (body.provider === 'paddle' && !baseUrl) throw new RequestError(422, 'Enter the PaddleOCR service URL.');
      const apiKey = body.clearKey ? '' : body.apiKey?.trim() || (baseUrl === config.baseUrl ? config.apiKey : '');
      if (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\s\x00-\x1f]/u.test(apiKey)) throw new RequestError(422, 'Enter a valid OCR API key.');
      const next = { provider: body.provider, baseUrl, apiKey };
      if (verify && next.provider === 'paddle') await languages(next);
      const temporary = path + '.' + randomUUID() + '.tmp';
      try { await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); await rename(temporary, path); config = next; }
      finally { await rm(temporary, { force: true }); }
      return settings();
    }); writing = operation.catch(() => {}); return operation;
  }
  return { settings, connection, fingerprint, languages, save, removeKey: () => save(() => ({ ...config, clearKey: true }), { verify: false }) };
}
