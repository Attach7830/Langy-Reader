import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, stat, rm, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import { RequestError, maxUpload } from './books.js';
import { conversionFormats, conversionLimit, fileExtension } from '../shared/import-formats.js';
import { filenameTitle } from '../shared/book-metadata.js';

const execute = promisify(execFile), filter = fileURLToPath(new URL('./conversion-filter.lua', import.meta.url));
// Validate every compressed stream before passing a container to the converter.
async function checkArchive(path, signal) {
  const zip = await yauzl.openPromise(path, { autoClose: false });
  try {
    if (zip.entryCount > 6000) throw new Error();
    let total = 0;
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted(); total += entry.uncompressedSize;
      if (total > 128 * 1024 ** 2 || entry.uncompressedSize > 32 * 1024 ** 2 || entry.generalPurposeBitFlag & 1) throw new Error();
      if (entry.fileName.endsWith('/')) continue;
      const stream = await zip.openReadStreamPromise(entry); let size = 0;
      for await (const chunk of stream) { signal?.throwIfAborted(); size += chunk.length; if (size > entry.uncompressedSize) throw new Error(); }
    }
  } finally { zip.close(); }
}

export function bookConverter({ binary = process.env.LANGY_PANDOC_BIN || 'pandoc', timeout = 120000 } = {}) {
  return async function convert(file, { signal, details = {} } = {}) {
    const format = conversionFormats[fileExtension(file.originalname)];
    if (!format) throw new RequestError(415, 'This file type is not supported for EPUB conversion.');
    const size = (await stat(file.path)).size;
    if (!size || size > conversionLimit) throw new RequestError(413, 'Documents for EPUB conversion must be nonempty and at most 30 MiB.');
    let work;
    try {
      if (['docx', 'odt'].includes(format)) await checkArchive(file.path, signal);
      else if (['fb2', 'html'].includes(format)) {
        const source = await readFile(file.path, 'utf8');
        if (/<!DOCTYPE[^>]*\[|<!ENTITY/iu.test(source)) throw new RequestError(422, 'Documents containing custom XML entities are not supported.');
      }
      work = await mkdtemp(join(dirname(file.path), 'convert-'));
      const path = join(work, 'book.epub');
      let input = file.path;
      if (format === 'plain') {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file.path));
        input = join(work, 'source.html');
        await writeFile(input, '<html><body>' + text.split(/\n\s*\n/u).map((part) => '<p>' + part.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/\n/gu, '<br>') + '</p>').join('') + '</body></html>', { mode: 0o600 });
      }
      const args = ['--sandbox', '--from=' + (format === 'plain' ? 'html' : format === 'markdown' ? 'markdown-yaml_metadata_block' : format), '--to=epub3', '--toc', '--split-level=2', '--lua-filter=' + filter, '--output=' + path];
      args.push('--metadata=langy-fallback-title:' + filenameTitle(basename(file.originalname)));
      for (const [key, value] of Object.entries({ title: details.title, author: details.author, lang: details.language })) if (typeof value === 'string' && value.trim()) args.push('--metadata=' + key + ':' + value.trim().slice(0, 250));
      args.push(input, '+RTS', '-M512M', '-RTS');
      await execute(binary, args, { signal, timeout, killSignal: 'SIGKILL', cwd: work, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, maxBuffer: 256 * 1024 });
      signal?.throwIfAborted();
      const output = (await stat(path)).size;
      if (!output || output > maxUpload) throw new Error();
      // The library validates the resulting EPUB container/spine before saving.
      return { path, size: output, originalname: basename(file.originalname, extname(file.originalname)) + '.epub', cleanup: () => rm(work, { recursive: true, force: true }) };
    } catch (error) {
      if (work) await rm(work, { recursive: true, force: true });
      if (signal?.aborted) throw signal.reason;
      if (error instanceof RequestError) throw error;
      if (error.code === 'ENOENT') throw new RequestError(503, 'EPUB conversion is unavailable. Rebuild the reader image or install the bundled Pandoc version.');
      throw new RequestError(422, 'This document could not be converted safely. Try exporting it as DOCX, HTML or EPUB. Encrypted and image-only documents are not supported.');
    }
  };
}
