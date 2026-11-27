import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { dictionaryLanguage, thesaurusDir, wiktionaryFile, wordKey } from '../server/thesaurus.js';

const dataset = 'https://kaikki.org/eswiktionary/raw-wiktextract-data.jsonl.gz';
const partsOfSpeech = { noun: 'n', verb: 'v', adj: 'a', adv: 'r', participle: 'a' };
const ignoredLanguages = new Set(['mul', 'und', 'zxx']);
const isTerm = (value) => typeof value === 'string' && value.length <= 100 && /\p{L}/u.test(value);

function locale(code) {
  if (typeof code !== 'string' || ignoredLanguages.has(code)) return '';
  try { return dictionaryLanguage(code); }
  catch { return ''; }
}

console.log('Downloading the Wiktionary index source…');
const response = await fetch(dataset, { signal: AbortSignal.timeout(180_000) });
if (!response.ok || !response.body) throw new Error(`Could not download Wiktionary (HTTP ${response.status})`);
const input = Readable.fromWeb(response.body).compose(createGunzip());
await mkdir(thesaurusDir, { recursive: true });
const temporary = `${wiktionaryFile}.${randomUUID()}.tmp`;
const db = new DatabaseSync(temporary);
try {
  db.exec(`
    CREATE TABLE entries (language TEXT NOT NULL, word TEXT NOT NULL, pos TEXT NOT NULL, senses TEXT NOT NULL) STRICT;
    CREATE TABLE forms (
      language TEXT NOT NULL, word TEXT NOT NULL, lemma TEXT NOT NULL, pos TEXT NOT NULL,
      PRIMARY KEY(language, word, lemma, pos)
    ) STRICT, WITHOUT ROWID;
    BEGIN;
  `);
  const insertEntry = db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?)');
  const insertForm = db.prepare('INSERT OR IGNORE INTO forms VALUES (?, ?, ?, ?)');
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const entry = JSON.parse(line);
    const language = locale(entry.lang_code);
    if (!language || !isTerm(entry.word)) continue;
    const word = wordKey(entry.word, language);
    const pos = partsOfSpeech[entry.pos] || entry.pos || '';
    const senses = entry.senses || [];
    const definitions = [];
    for (const sense of senses) {
      for (const { word: lemma } of sense.form_of ?? []) {
        if (isTerm(lemma) && wordKey(lemma, language) !== word) {
          insertForm.run(language, word, wordKey(lemma, language), pos);
        }
      }
      if (sense.form_of?.length || sense.tags?.includes('form-of') || entry.tags?.includes('form-of')) continue;
      const gloss = sense.glosses?.at(-1);
      const label = typeof gloss === 'string' ? gloss.replace(/\s+/gu, ' ').trim() : '';
      const linked = (entry.synonyms ?? []).filter((synonym) => synonym.sense_index
        ? synonym.sense_index === sense.sense_index : senses.length === 1 && !synonym.sense);
      const terms = [...(sense.synonyms ?? []), ...linked].map((synonym) => synonym.word).filter(isTerm);
      if (label || terms.length) definitions.push({ label, terms: [...new Set(terms)].slice(0, 8) });
    }
    if (!definitions.length) continue;
    insertEntry.run(language, word, pos, JSON.stringify(definitions));
    for (const { form, tags = [] } of entry.forms ?? []) {
      if (isTerm(form) && !/\s/u.test(form)
        && tags.some((tag) => ['plural', 'singular', 'feminine', 'masculine', 'participle', 'gerund'].includes(tag))) {
        const formKey = wordKey(form, language);
        if (formKey !== word) insertForm.run(language, formKey, word, pos);
      }
    }
  }
  db.exec('CREATE INDEX entries_term ON entries(language, word); COMMIT;');
  const count = db.prepare('SELECT COUNT(*) AS entries FROM entries').get().entries;
  if (!count) throw new Error('Wiktionary returned an empty dictionary.');
  db.close();
  await rename(temporary, wiktionaryFile);
  const licenses = join(thesaurusDir, 'licenses', 'wiktionary');
  await mkdir(licenses, { recursive: true });
  await writeFile(join(licenses, 'README'), [
    'Spanish Wiktionary contributors — https://es.wiktionary.org/',
    `Extracted by Wiktextract and distributed by Kaikki — ${dataset}`,
    'Langy’s Wiktionary index contains selected glosses, synonyms, and forms.',
    'CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/',
    '',
  ].join('\n'));
  console.log(`Indexed ${count.toLocaleString('en')} Wiktionary headword entries.`);
} finally {
  if (db.isOpen) db.close();
  await rm(temporary, { force: true });
}
