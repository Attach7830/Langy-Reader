import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openFonts, fontType } from '../server/fonts.js';
import { validatePreferences } from '../shared/reader-preferences.js';

test('imported fonts persist privately per account, deduplicate, reject invalid files, and support removal', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'langy-fonts-')); let store = await openFonts(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const bytes = await readFile(new URL('../node_modules/@fontsource/spectral/files/spectral-latin-400-normal.woff2', import.meta.url));
  assert.equal(fontType(bytes), 'woff2');
  for (const value of [Buffer.from('<script>bad font</script>'), Buffer.from('ttcf collection'), Buffer.alloc(30)]) assert.throws(() => fontType(value), { status: 422 });
  const add = async (owner, name = 'My reading font') => { const path = join(dir, 'upload-' + owner); await writeFile(path, bytes); return store.add({ path, originalname: 'reading.woff2' }, { id: owner }, name); };
  const first = await add('first'), repeat = await add('first', 'Duplicate'); assert.equal(first.id, repeat.id); assert.equal((await store.list('first')).length, 1);
  validatePreferences({ font: first.id }); assert.throws(() => validatePreferences({ font: 'url(https://tracker.invalid/font)' }));
  const second = await add('second'); assert.notEqual(second.id, first.id);
  assert.throws(() => store.file(first.id.slice(7), 'second'), { status: 404 });
  assert.deepEqual(await readFile(store.file(first.id.slice(7), 'first').path), bytes);
  store.close(); store = await openFonts(dir); assert.equal((await store.list('first'))[0].name, 'My reading font');
  await assert.rejects(store.remove(first.id.slice(7), 'second'), { status: 404 });
  await store.remove(first.id.slice(7), 'first'); assert.equal((await store.list('first')).length, 0); assert.equal((await store.list('second')).length, 1);
});
