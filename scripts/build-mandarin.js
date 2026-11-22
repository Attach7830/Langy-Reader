import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import yauzl from 'yauzl';
import { mandarinFile } from '../server/mandarin.js';
import { thesaurusDir } from '../server/thesaurus.js';

const cedict = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz';
const unihan = 'https://www.unicode.org/Public/17.0.0/ucd/Unihan.zip';
async function download(url) {
  const result = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!result.ok || !result.body) throw new Error(`Mandarin dictionary download failed (HTTP ${result.status}).`);
  return result;
}
await mkdir(thesaurusDir, { recursive: true });
const temporary = `${mandarinFile}.${randomUUID()}.tmp`, db = new DatabaseSync(temporary);
try {
  db.exec(`CREATE TABLE words(word TEXT, traditional TEXT, simplified TEXT, pinyin TEXT, meanings TEXT) STRICT;
    CREATE TABLE characters(character TEXT PRIMARY KEY,pinyin TEXT NOT NULL DEFAULT '',meaning TEXT NOT NULL DEFAULT '') STRICT; BEGIN;`);
  const insert = db.prepare('INSERT INTO words VALUES(?,?,?,?,?)');
  const response = await download(cedict);
  let count = 0;
  for await (const line of createInterface({ input: Readable.fromWeb(response.body).compose(createGunzip()), crlfDelay: Infinity })) {
    const entry = /^(\S+) (\S+) \[([^\]]+)\] \/(.+)\/$/u.exec(line);
    if (!entry) continue;
    const [, traditional, simplified, pinyin, gloss] = entry;
    const meanings = JSON.stringify(gloss.split('/'));
    for (const word of new Set([traditional, simplified])) insert.run(word, traditional, simplified, pinyin, meanings);
    count++;
  }
  if (count < 100000) throw new Error('The CC-CEDICT dictionary was incomplete.');
  const zip = await yauzl.fromBufferPromise(Buffer.from(await (await download(unihan)).arrayBuffer()), { autoClose: false });
  const update = db.prepare("INSERT INTO characters(character,pinyin,meaning) VALUES(?,?,?) ON CONFLICT(character) DO UPDATE SET pinyin=CASE WHEN excluded.pinyin!='' THEN excluded.pinyin ELSE pinyin END,meaning=CASE WHEN excluded.meaning!='' THEN excluded.meaning ELSE meaning END");
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== 'Unihan_Readings.txt') continue;
      for await (const line of createInterface({ input: await zip.openReadStreamPromise(entry), crlfDelay: Infinity })) {
        const item = /^U\+([0-9A-F]+)\t(kMandarin|kDefinition)\t(.+)$/u.exec(line);
        if (item) update.run(String.fromCodePoint(Number.parseInt(item[1], 16)), item[2] === 'kMandarin' ? item[3] : '', item[2] === 'kDefinition' ? item[3] : '');
      }
    }
  } finally { zip.close(); }
  if (db.prepare('SELECT COUNT(*) AS count FROM characters').get().count < 10000) throw new Error('The Unicode Unihan character data was incomplete.');
  db.exec('CREATE INDEX word_lookup ON words(word); COMMIT;'); db.close();
  await rename(temporary, mandarinFile);
  const credits = join(thesaurusDir, 'licenses', 'mandarin'); await mkdir(credits, { recursive: true });
  await writeFile(join(credits, 'README'), `CC-CEDICT contributors / MDBG: ${cedict}\nCC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/\nIndexed traditional and simplified headwords, pinyin and English glosses; no changes to source definitions.\nUnicode Unihan 17.0.0: ${unihan}\nUnicode license: https://www.unicode.org/license.txt\n`);
  await writeFile(join(credits, 'UNICODE-LICENSE.txt'), await (await download('https://www.unicode.org/license.txt')).text());
  console.log(`Indexed ${count} CC-CEDICT word entries and Unihan character readings/definitions.`);
} finally { if (db.isOpen) db.close(); await rm(temporary, { force: true }); }
