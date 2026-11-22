import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chapterByteLimit } from './chapter-audio.js';
import { RequestError } from './books.js';

// Multer's per-file limit alone would allow N times the recording allowance.
export function chapterStorage(folder) {
  return {
    _handleFile(req, file, callback) {
      const path = join(folder, randomUUID()); let size = 0;
      const meter = new Transform({ transform(chunk, _encoding, done) {
        size += chunk.length; req.chapterBytes = (req.chapterBytes || 0) + chunk.length;
        done(req.chapterBytes > chapterByteLimit ? new RequestError(413, 'Chapter files must total 1 GiB or less per recording.') : null, chunk);
      } });
      pipeline(file.stream, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
        .then(() => callback(null, { path, size }), async (error) => { await rm(path, { force: true }); callback(error); });
    },
    _removeFile(_req, file, callback) { rm(file.path, { force: true }).then(() => callback(null), callback); },
  };
}
