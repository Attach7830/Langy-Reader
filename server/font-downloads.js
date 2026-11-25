import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RequestError } from './books.js';
import { publicDownload, downloadURL } from './public-download.js';
import { fontUploadLimit } from './fonts.js';

export function trustedFontURL(value) {
  const url = downloadURL(value), path = decodeURIComponent(url.pathname);
  const trusted = url.hostname === 'fonts.gstatic.com' && path.startsWith('/s/')
    || url.hostname === 'cdn.jsdelivr.net' && /^\/(?:fontsource\/fonts\/|npm\/@fontsource(?:-variable)?\/)/u.test(path)
    || url.hostname === 'raw.githubusercontent.com' && /^\/(?:google\/fonts|notofonts\/noto-cjk)\//u.test(path);
  if (!trusted || !/\.(?:ttf|otf|woff2?)$/iu.test(path)) throw new RequestError(422, 'Use a direct TTF, OTF, WOFF or WOFF2 link from Google Fonts, Fontsource or the official Noto repository. ZIP files and other websites are not supported.');
  return url;
}
export function fontDownloads({ fonts, uploads, request = publicDownload, now = Date.now }) {
  let catalog, until = 0, loading; const details = new Map();
  async function json(path) {
    let response;
    try {
      response = await request('https://api.fontsource.org/v1/fonts' + path, {signal:AbortSignal.timeout(15000), redirects:0});
      if (response.statusCode !== 200) throw new Error();
      let bytes = 0; const chunks = [];
      for await (const chunk of response) { bytes += chunk.length; if (bytes > 6 * 1024 ** 2) throw new Error(); chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks));
    } catch { throw new RequestError(502, 'The free font catalogue is unavailable. Try later or import a downloaded font file.'); }
    finally { response?.destroy(); }
  }
  async function search(query) {
    query = String(query || '').trim().toLowerCase().slice(0,80);
    if (!query) return {fonts:[]};
    if (!catalog || until < now()) {
      loading ||= json('').then((value) => { if (!Array.isArray(value)) throw new RequestError(502, 'The font catalogue returned an invalid list.'); catalog = value; until = now()+86400000; }).finally(() => { loading = undefined; }); await loading;
    }
    return {fonts:catalog.filter((font) => font.type === 'google' && String(font.family).toLowerCase().includes(query)).slice(0,30).map(({id,family,subsets}) => ({id,family,subsets}))};
  }
  async function variants(id) {
    if (!/^[a-z0-9-]{1,100}$/u.test(id)) throw new RequestError(422,'Choose a font from the catalogue.');
    let value = details.get(id); if (!value) { value = await json('/'+id); if (details.size >= 100) details.delete(details.keys().next().value); details.set(id,value); }
    const choices=[];
    for (const [weight,styles] of Object.entries(value.variants || {})) for (const [style,subsets] of Object.entries(styles)) for (const [subset,file] of Object.entries(subsets)) {
      const url=file?.url?.ttf || file?.url?.woff2 || file?.url?.woff;
      try { if (url) choices.push({weight,style,subset,url:trustedFontURL(url).href}); } catch { /* Unsupported segmented/variable files can still be uploaded manually. */ }
    }
    return {id, family:value.family || id, source:'https://fontsource.org/fonts/'+id, choices};
  }
  async function download(body, account) {
    let url, label=body.name, source;
    if (body.id) {
      const font=await variants(body.id), choice=font.choices.find((item) => item.weight === String(body.weight) && item.style === body.style && item.subset === body.subset);
      if (!choice) throw new RequestError(422,'Choose an available font weight, style and language subset.');
      url=choice.url; label=font.family+' · '+choice.subset+' '+choice.weight+' '+choice.style; source=font.source;
    } else { url=trustedFontURL(body.url).href; source=url; }
    const path=join(uploads,'font-'+randomUUID()+'.part'); let response;
    try {
      response=await request(url,{signal:AbortSignal.timeout(60000),validate:trustedFontURL});
      if (response.statusCode !== 200) throw new RequestError(502,'The font website did not return a downloadable file.');
      if (Number(response.headers['content-length'])>fontUploadLimit) throw new RequestError(413,'Font files must be at most 32 MiB.');
      let size=0; const meter=new Transform({transform(chunk,_encoding,done){size+=chunk.length;done(size>fontUploadLimit?new RequestError(413,'Font files must be at most 32 MiB.'):null,chunk);}});
      await pipeline(response,meter,createWriteStream(path,{flags:'wx',mode:0o600}));
      return await fonts.add({path,originalname:basename(new URL(url).pathname)},account,label,source);
    } finally {response?.destroy();await rm(path,{force:true});}
  }
  return {search,variants,download};
}
