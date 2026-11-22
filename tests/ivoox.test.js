import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { ivooxEpisode, ivooxPage, openIvoox } from '../server/ivoox.js';
const url = 'https://www.ivoox.com/11-como-agua-para-chocolate-audios-mp3_rf_79273667_1.html';
const page = (id, extra = '') => `<script>window.__NUXT__=(function(a,b,c,d){return {data:[{audio:{id:a,title:b,downloadUrl:c,audioPaid:d,isSample:false,hidden:false,${extra}program:{id:2}},relatedAudios:[]}]}}(${id},"Capítulo ${id}","\\u002Flisten_mn_${id}_1.mp3",false));</script>`;
const stream = (body, type = 'text/html', length) => Object.assign(Readable.from([Buffer.from(body)]), { statusCode: 200, headers: { 'content-type': type, ...(length ? { 'content-length': length } : {}) } });
test('iVoox links resolve only the selected episode public download without evaluating remote JavaScript', () => {
  const episode = ivooxEpisode(url + '?utm_source=test#anchor');
  assert.equal(episode.id, '79273667'); assert.equal(episode.url, url);
  assert.equal(ivooxPage(page(79273667), episode).url, 'https://www.ivoox.com/listen_mn_79273667_1.mp3');
  for (const invalid of ['http://www.ivoox.com/test_rf_123_1.html', 'https://ivoox.com.evil.test/a_rf_123_1.html',
    'https://user:pass@ivoox.com/a_rf_123_1.html', 'https://127.0.0.1/a_rf_123_1.html', 'https://www.ivoox.com/podcast_sq_f123_1.html']) assert.throws(() => ivooxEpisode(invalid));
  assert.throws(() => ivooxPage(page(79273667).replace('audioPaid:d', 'audioPaid:true'), episode), /restricted/u);
  assert.throws(() => ivooxPage(page(79273667).replace('downloadUrl:c', 'downloadUrl:null'), episode), /public download/u);
  assert.throws(() => ivooxPage(page(7), episode), /public download/u);
  assert.throws(() => ivooxPage(page(79273667).replace('downloadUrl:c', 'downloadUrl:(globalThis.ivooxExecuted=true)'), episode));
  assert.equal(globalThis.ivooxExecuted, undefined);
});
test('iVoox imports episodes in input order, limits downloads, reports errors, and never accepts non-audio pages', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-ivoox-'));
  const db = new DatabaseSync(join(folder, 'test.sqlite'));
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE analyses(book TEXT PRIMARY KEY); INSERT INTO analyses VALUES('book')");
  let imported, oversized = false, htmlAudio = false;
  const requests = [];
  const importer = await openIvoox({ db, folder, library: { getBook: () => ({ id: 'book', title: 'Libro' }) },
    recordings: { async acceptChapters(_book, files) { imported = await Promise.all(files.map(async (file) => ({ name: file.originalname, data: (await readFile(file.path)).toString() }))); return { id: 'recording' }; } },
    request: async (value) => {
      const address = new URL(value); requests.push(address.href);
      const id = /(?:_rf_|listen_mn_)(\d+)/u.exec(address.pathname)[1];
      if (address.pathname.endsWith('.html')) return stream(page(id));
      return stream(`audio-${id}`, htmlAudio ? 'text/html' : 'audio/mpeg', oversized ? 1024 ** 3 + 1 : undefined);
    } });
  t.after(async () => { db.close(); await rm(folder, { recursive: true, force: true }); });
  const book = { id: 'book' };
  async function complete() { for (let n = 0; n < 100; n++) { const value = importer.latest(book); if (['ready', 'error', 'cancelled'].includes(value.state)) return value; await delay(10); } throw new Error('Import did not finish'); }
  importer.queue(book, { links: url + '\nhttps://www.ivoox.com/next_rf_123_1.html' });
  assert.equal((await complete()).state, 'ready');
  assert.deepEqual(imported.map((file) => file.data), ['audio-79273667', 'audio-123']);
  assert.equal(importer.latest(book).recording, 'recording');
  assert.ok(!JSON.stringify(importer.latest(book)).includes('listen_mn'));
  oversized = true; importer.queue(book, { links: url });
  assert.match((await complete()).error, /1 GiB/u);
  oversized = false; htmlAudio = true; importer.queue(book, { links: url });
  assert.match((await complete()).error, /audio file/u);
  assert.throws(() => importer.queue(book, { links: url + '\n' + url }), /duplicate/u);
  assert.ok(requests.length >= 6);
});
