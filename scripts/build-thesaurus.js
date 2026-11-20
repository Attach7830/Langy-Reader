import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import yauzl from 'yauzl';
import { thesaurusDir, thesaurusFile, dictionaryLanguage, wordKey } from '../server/thesaurus.js';

// NLTK's published archives and SHA-256 digests. Source data and its licenses stay separate from app code.
const corporaURL = 'https://raw.githubusercontent.com/nltk/nltk_data/550b6625bcef1f2abff2ff770a5a0d272c9c6b2a/packages/corpora/';

async function downloadCorpus(name, digest) {
  console.log(`Downloading ${name} for the local thesaurus…`);
  const response = await fetch(new URL(name, corporaURL), { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Could not download ${name} (HTTP ${response.status})`);
  const content = Buffer.from(await response.arrayBuffer());
  const checksum = createHash('sha256').update(content).digest('hex');
  if (checksum !== digest) throw new Error(`SHA-256 mismatch for ${name}`);
  return yauzl.fromBufferPromise(content, { autoClose: false });
}

async function copyCredits(zip, entry) {
  const path = join(thesaurusDir, 'licenses', entry.fileName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await zip.openReadStreamPromise(entry));
}

function readLines(zip, entry) {
  return zip.openReadStreamPromise(entry).then((input) => createInterface({ input, crlfDelay: Infinity }));
}

await mkdir(thesaurusDir, { recursive: true });
const temporary = `${thesaurusFile}.${randomUUID()}.tmp`;
const db = new DatabaseSync(temporary);
try {
  db.exec(`
    CREATE TABLE senses (id INTEGER PRIMARY KEY, pos TEXT NOT NULL, label TEXT NOT NULL, terms TEXT NOT NULL) STRICT;
    CREATE TABLE lexemes (
      language TEXT NOT NULL, word TEXT NOT NULL, sense INTEGER NOT NULL REFERENCES senses(id),
      PRIMARY KEY (language, word, sense)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE english_exceptions (
      word TEXT NOT NULL, lemma TEXT NOT NULL, pos TEXT NOT NULL,
      PRIMARY KEY (word, lemma, pos)
    ) STRICT, WITHOUT ROWID;
    BEGIN;
  `);
  const insertSense = db.prepare('INSERT INTO senses (pos, label, terms) VALUES (?, ?, ?)');
  const insertLexeme = db.prepare('INSERT INTO lexemes (language, word, sense) VALUES (?, ?, ?)');
  const insertException = db.prepare('INSERT OR IGNORE INTO english_exceptions (word, lemma, pos) VALUES (?, ?, ?)');

  function addSense(language, pos, label, terms) {
    const words = new Map();
    for (const raw of terms) {
      const term = raw.trim().replaceAll('_', ' ');
      if (term && term.length <= 100) words.set(wordKey(term, language), term);
    }
    if (!words.size) return;
    const { lastInsertRowid } = insertSense.run(pos === 's' ? 'a' : pos, label, JSON.stringify([...words.values()]));
    for (const word of words.keys()) insertLexeme.run(language, word, lastInsertRowid);
  }

  const isCredit = (name) => /^(?:wordnet|omw-1\.4)(?:\/[a-z]+)?\/(?:LICENSE|README|citation\.bib)$/u.test(name);
  const englishParts = { noun: 'n', verb: 'v', adj: 'a', adv: 'r' };
  const senseLabels = new Map();
  const english = await downloadCorpus('wordnet.zip', 'cbda5ea6eef7f36a97a43d4a75f85e07fccbb4f23657d27b4ccbc93e2646ab59');
  try {
    for await (const entry of english.eachEntry()) {
      const exceptions = /^wordnet\/(noun|verb|adj|adv)\.exc$/u.exec(entry.fileName);
      if (exceptions) {
        for await (const line of await readLines(english, entry)) {
          const [word, ...lemmas] = line.trim().split(/\s+/u);
          for (const lemma of lemmas) insertException.run(wordKey(word, 'en'), wordKey(lemma, 'en'), englishParts[exceptions[1]]);
        }
      } else if (/^wordnet\/data\.(?:noun|verb|adj|adv)$/u.test(entry.fileName)) {
        for await (const line of await readLines(english, entry)) {
          if (!/^\d{8} /u.test(line)) continue;
          const [data, gloss = ''] = line.split(' | ', 2);
          const [offset, , pos, count, ...words] = data.split(/\s+/u);
          const terms = words.slice(0, 2 * Number.parseInt(count, 16)).filter((_, index) => index % 2 === 0);
          const definition = gloss.split(';', 1)[0].trim();
          const label = definition.length > 96 ? `${definition.slice(0, 96).replace(/\s+\S*$/u, '')}…` : definition;
          senseLabels.set(`${offset}-${pos === 's' ? 'a' : pos}`, label);
          addSense('en', pos, label, terms);
        }
      } else if (isCredit(entry.fileName)) {
        await copyCredits(english, entry);
      }
    }
  } finally {
    english.close();
  }

  const multilingual = await downloadCorpus('omw-1.4.zip', '3b941e664852f3297b6040236626065796a2aaf7d7f9eec8779a3beaa1096c2d');
  try {
    for await (const entry of multilingual.eachEntry()) {
      const match = /^omw-1\.4\/[a-z]+\/wn-data-([a-z]{3})\.tab$/u.exec(entry.fileName);
      if (!match) {
        if (isCredit(entry.fileName)) await copyCredits(multilingual, entry);
        continue;
      }
      const language = dictionaryLanguage(match[1]);
      const senses = new Map();
      for await (const line of await readLines(multilingual, entry)) {
        const [id, type, term] = line.split('\t', 3);
        if (!term || !/^\d{8}-[nvars]$/u.test(id) || !/(?:^|:)lemma$/u.test(type)) continue;
        if (!senses.has(id)) senses.set(id, []);
        senses.get(id).push(term);
      }
      for (const [id, terms] of senses) addSense(language, id.at(-1), senseLabels.get(id.replace(/-s$/u, '-a')) ?? '', terms);
    }
  } finally {
    multilingual.close();
  }
  db.exec('COMMIT;');
  const counts = db.prepare('SELECT COUNT(*) AS entries, COUNT(DISTINCT language) AS languages FROM lexemes').get();
  db.close();
  await rename(temporary, thesaurusFile);
  console.log(`Indexed ${counts.entries.toLocaleString('en')} dictionary entries in ${counts.languages} languages.`);
} finally {
  if (db.isOpen) db.close();
  await rm(temporary, { force: true });
}
