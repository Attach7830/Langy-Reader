import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyStorage(dir, expected = process.env.READER_STORAGE_ID || '') {
  if (!expected) return;
  let actual;
  try { actual = (await readFile(join(dir, '.langy-storage-id'), 'utf8')).trim(); }
  catch { /* A missing or inaccessible data drive must not create a new library. */ }
  if (actual !== expected) throw new Error('Configured Langy storage is unavailable or belongs to another location. Check the data drive and READER_DATA_SOURCE before starting the reader.');
}
