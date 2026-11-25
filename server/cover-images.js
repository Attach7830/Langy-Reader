import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadURL, publicDownload } from './public-download.js';
import { RequestError } from './books.js';
const run = promisify(execFile), limit = 4 * 1024 ** 2;

export async function downloadCover(value, { request = publicDownload } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new RequestError(422, 'Paste a direct public HTTPS image URL.');
  const url = downloadURL(value.trim()), folder = await mkdtemp(join(tmpdir(), 'langy-cover-'));
  let response;
  try {
    response = await request(url.href, { signal: AbortSignal.timeout(20000) });
    if (response.statusCode !== 200 || /(?:text\/|json|svg|xml)/iu.test(String(response.headers['content-type'] || ''))) throw new RequestError(422, 'The URL must return an image, rather than a web page.');
    if (Number(response.headers['content-length']) > limit) throw new RequestError(413, 'Cover images must be at most 4 MiB.');
    const chunks = []; let size = 0;
    for await (const chunk of response) { size += chunk.length; if (size > limit) throw new RequestError(413, 'Cover images must be at most 4 MiB.'); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    const image = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || /^GIF8[79]a/u.test(bytes.subarray(0, 6).toString('ascii')) || bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
      || bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/u.test(bytes.toString('ascii', 8, 32));
    if (!image) throw new RequestError(422, 'Choose a JPEG, PNG, WebP, GIF or AVIF image.');
    const source = join(folder, 'source'), output = join(folder, 'cover.png'); await writeFile(source, bytes, { mode: 0o600 });
    const { stdout } = await run('ffprobe', ['-v', 'error', '-max_alloc', '67108864', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', source], { timeout: 10000 });
    const stream = JSON.parse(stdout).streams?.[0];
    if (!stream || !['mjpeg', 'png', 'webp', 'gif', 'av1'].includes(stream.codec_name) || !(stream.width > 0 && stream.height > 0) || stream.width > 12000 || stream.height > 12000 || stream.width * stream.height > 25_000_000) throw new RequestError(422, 'Choose a cover with at most 25 million pixels and dimensions below 12,000 pixels.');
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-i', source, '-frames:v', '1', '-map_metadata', '-1',
      '-vf', "scale=w='min(1600,iw)':h='min(2400,ih)':force_original_aspect_ratio=decrease", '-c:v', 'png', '-threads', '1', output], { timeout: 15000 });
    if ((await stat(output)).size > limit) throw new RequestError(413, 'The decoded cover is too large. Choose a smaller image.');
    return { thumbnail: await readFile(output), thumbnailType: 'image/png' };
  } catch (error) { if (error instanceof RequestError) throw error; throw new RequestError(422, 'The cover could not be downloaded or decoded. Check the direct image URL and try another image.'); }
  finally { response?.destroy(); await rm(folder, { recursive: true, force: true }); }
}
