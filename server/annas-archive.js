import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, rename, rm, readdir, open } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { maxUpload, normalizeLanguage, RequestError } from './books.js';
import { publicDownload } from './public-download.js';

const mirrors = ['https://annas-archive.gl', 'https://annas-archive.pk', 'https://annas-archive.gd'];
const pending = new Set(['queued', 'downloading', 'importing']);

export function archiveMD5(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^[a-f0-9]{32}$/iu.test(text)) return text.toLowerCase();
  let url;
  try { url = new URL(text); } catch { /* Validate below. */ }
  if (text.length <= 2000 && url?.protocol === 'https:' && !url.username && !url.password
    && /^(?:www\.)?annas-archive\.[a-z]{2,24}$/iu.test(url.hostname)) {
    const match = /^\/(?:md5|fast_download)\/([a-f0-9]{32})(?:\/\d+(?:\/\d+)?)?\/?$/iu.exec(url.pathname);
    if (match) return match[1].toLowerCase();
  }
  throw new RequestError(422, 'Paste an Anna’s Archive book link or a 32-character MD5.');
}

function membershipError(status, data) {
  const error = typeof data?.error === 'string' ? data.error.toLowerCase() : '';
  if (status === 429 || /limit|quota|too many/u.test(error)) return new RequestError(429, 'Anna’s Archive’s download allowance has been reached. Try again when your membership allowance resets.');
  if ([401, 402, 403].includes(status) || /key|member|donat|auth|expired/u.test(error)) return new RequestError(401, 'Check your Anna’s Archive membership key and membership status in Settings → Book sources.');
  if (status === 404 || /md5|not found|unavailable|no fast download/u.test(error)) return new RequestError(404, 'This book has no available member download. Choose another EPUB or PDF edition.');
  return new RequestError(502, 'Anna’s Archive could not provide a download link. Try again later or select another mirror in Book sources.');
}

function filename(headers, md5, format) {
  const disposition = String(headers['content-disposition'] || '');
  let name = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  try { name = name && decodeURIComponent(name); } catch { name = ''; }
  name ||= /filename="([^"]+)"/iu.exec(disposition)?.[1] || /filename=([^;]+)/iu.exec(disposition)?.[1];
  const clean = basename(String(name || md5).replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/gu, '').trim().slice(0, 240);
  return (basename(clean, extname(clean)) || md5) + '.' + format;
}

export async function openArchive(dir, { library, demo = false, request = publicDownload, onImport = () => {} }) {
  const path = join(dir, 'archive-settings.json');
  let current = { baseUrl: mirrors[0], apiKey: '' };
  if (!demo) {
    try { current = { ...current, ...JSON.parse(await readFile(path, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of await readdir(library.uploads)) {
    if (/^aa-[a-f0-9-]{36}\.part$/u.test(name)) await rm(join(library.uploads, name), { force: true });
  }
  const settings = () => demo ? { configurable: false, hasKey: false }
    : { configurable: true, baseUrl: current.baseUrl, hasKey: Boolean(current.apiKey), mirrors };
  let writes = Promise.resolve();
  function save(body) {
    if (demo) throw new RequestError(403, 'Anna’s Archive connections are available on self-hosted installations.');
    const operation = writes.then(async () => {
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.replace(/\/+$/u, '') : current.baseUrl;
      if (!mirrors.includes(baseUrl)) throw new RequestError(422, 'Choose one of the listed Anna’s Archive mirrors.');
      const input = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (input.length > 4096 || /[^\x21-\x7e]/u.test(input)) throw new RequestError(422, 'Enter a valid membership key without spaces.');
      const next = { baseUrl, apiKey: body.clearKey === true ? '' : input || current.apiKey };
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
        current = next;
      } finally { await rm(temporary, { force: true }); }
      return settings();
    });
    writes = operation.catch(() => {});
    return operation;
  }
  const jobs = new Map();
  const publicJob = (job) => ({ id: job.id, state: job.state, bytes: job.bytes, total: job.total, error: job.error, book: job.book });
  const latest = () => jobs.size ? publicJob([...jobs.values()].at(-1)) : null;

  async function run(job, config, md5, body) {
    const temporary = join(library.uploads, `aa-${job.id}.part`);
    try {
      const endpoint = new URL('/dyn/api/fast_download.json', config.baseUrl);
      endpoint.search = new URLSearchParams({ md5, key: config.apiKey }).toString();
      const response = await request(endpoint, { signal: AbortSignal.timeout(30_000), redirects: 0 });
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 128 * 1024) { response.destroy(); throw new RequestError(502, 'Anna’s Archive returned an unreadable response.'); }
        chunks.push(chunk);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { throw new RequestError(502, 'Anna’s Archive returned an unreadable response. Try another mirror in Book sources.'); }
      if (![200, 204].includes(response.statusCode) || !data.download_url) throw membershipError(response.statusCode, data);
      job.state = 'downloading';
      const download = await request(data.download_url, { signal: AbortSignal.timeout(600_000) });
      if (download.statusCode !== 200) { download.destroy(); throw new RequestError(502, 'The book download server is unavailable. Try importing again.'); }
      const length = Number(download.headers['content-length']);
      if (Number.isFinite(length) && length > maxUpload) {
        download.destroy(); throw new RequestError(413, `Books must be ${maxUpload / 1024 ** 2} MiB or smaller.`);
      }
      job.total = Number.isFinite(length) && length > 0 ? length : null;
      const digest = createHash('md5');
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          job.bytes += chunk.length;
          if (job.bytes > maxUpload) return callback(new RequestError(413, `Books must be ${maxUpload / 1024 ** 2} MiB or smaller.`));
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(download, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (digest.digest('hex') !== md5) throw new RequestError(502, 'The downloaded file did not match the requested MD5. Nothing was imported; try another edition or mirror.');
      const handle = await open(temporary, 'r');
      const prefix = Buffer.alloc(1024);
      let bytesRead;
      try { ({ bytesRead } = await handle.read(prefix)); } finally { await handle.close(); }
      const format = /%PDF-\d\.\d/u.test(prefix.toString('latin1', 0, bytesRead)) ? 'pdf'
        : prefix.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) ? 'epub' : null;
      if (!format) throw new RequestError(415, 'This download is not a supported EPUB or PDF. Choose another edition.');
      job.state = 'importing';
      const book = await library.importBook(randomUUID(), { path: temporary, size: job.bytes,
        originalname: filename(download.headers, md5, format) }, body);
      job.book = book;
      job.state = 'ready';
      try { onImport(book); } catch { /* Library refresh can start analysis again. */ }
    } catch (error) {
      // Do not expose upstream URLs, signed links, keys, or raw transport errors.
      job.error = error instanceof RequestError ? error.message : 'The import could not finish. Check the mirror and membership key, then retry.';
    } finally {
      await rm(temporary, { force: true });
      if (job.error) job.state = 'error';
    }
  }

  function queue(body) {
    if (demo) throw new RequestError(403, 'Anna’s Archive imports are available on self-hosted installations.');
    if (!current.apiKey) throw new RequestError(422, 'Add your membership key in Settings → Book sources first.');
    if ([...jobs.values()].some((job) => pending.has(job.state))) throw new RequestError(409, 'An Anna’s Archive import is already running. Wait for it to finish.');
    const md5 = archiveMD5(body.reference);
    const language = typeof body.language === 'string' ? body.language.trim() : '';
    if (language && !normalizeLanguage(language)) throw new RequestError(422, 'Enter a valid book language code.');
    if (body.categoryId && !library.snapshot().categories.some(({ id }) => id === body.categoryId)) throw new RequestError(422, 'Choose a category that exists.');
    const job = { id: randomUUID(), state: 'queued', bytes: 0, total: null, error: null };
    if (jobs.size >= 20) jobs.delete(jobs.keys().next().value);
    jobs.set(job.id, job);
    void run(job, { ...current }, md5, body);
    return publicJob(job);
  }
  return {
    settings, save, queue, latest,
    job(id) {
      const job = jobs.get(id);
      if (!job) throw new RequestError(404, 'Import not found. The server may have restarted; check your library before retrying.');
      return publicJob(job);
    },
  };
}
