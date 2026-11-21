import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import { RequestError } from './books.js';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalIPv6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function downloadURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new RequestError(422, 'The download server returned an invalid URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') {
    throw new RequestError(422, 'Downloads require a public HTTPS URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (isIP(host) && !isPublicAddress(host)) throw new RequestError(422, 'Downloads cannot access local or private network addresses.');
  return url;
}

export async function resolveDownloadHost(host, resolve = lookup) {
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new RequestError(422, 'Downloads cannot access local or private network addresses.');
  }
  return addresses;
}

export async function publicDownload(value, { signal, redirects = 5 } = {}) {
  let url = downloadURL(value);
  for (let hop = 0; ; hop++) {
    const addresses = await resolveDownloadHost(url.hostname.replace(/^\[|\]$/gu, ''));
    const response = await new Promise((resolve, reject) => {
      const req = request(url, {
        signal, headers: { 'User-Agent': 'Langy-Reader/0.1', 'Accept-Encoding': 'identity' },
        // Pin the validated lookup result for this request, including on every redirect.
        lookup(_host, options, callback) {
          const candidates = addresses.filter((entry) => !options.family || entry.family === options.family);
          const selected = candidates.length ? candidates : addresses;
          if (options.all) callback(null, selected);
          else callback(null, selected[0].address, selected[0].family);
        },
      }, resolve);
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error('Download timed out')));
      req.end();
    });
    if (![301, 302, 303, 307, 308].includes(response.statusCode)) return response;
    response.destroy();
    if (hop >= redirects || !response.headers.location) throw new RequestError(502, 'The download server redirected unexpectedly.');
    url = downloadURL(new URL(response.headers.location, url));
  }
}
