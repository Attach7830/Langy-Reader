import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyStorage } from '../server/storage-location.js';
const run = promisify(execFile);
const originalSettings = "READER_USER=reader\nREADER_PASSWORD='test$literal#password'\nREADER_PORT=8088\n";

// Model Docker's mounts and process outcomes; filesystem copying, byte comparison,
// dotenv edits, backup permissions and the script's recovery traps execute for real.
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'langy-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), mount = join(root, 'drive'), old = join(root, 'old-volume'), bin = join(root, 'bin');
  await Promise.all([mkdir(join(project, 'scripts'), { recursive: true }), mkdir(mount), mkdir(join(old, 'narration'), { recursive: true }), mkdir(bin)]);
  await copyFile(new URL('../scripts/migrate-storage.sh', import.meta.url), join(project, 'scripts/migrate-storage.sh'));
  await writeFile(join(project, '.env'), originalSettings, { mode: 0o600 });
  await writeFile(join(old, 'library.sqlite'), 'the complete original library');
  await writeFile(join(old, 'progress.sqlite'), 'reader progress');
  await writeFile(join(old, 'narration', 'narrator.mp3'), Buffer.from([0, 255, 10, 3, 80]));
  await writeFile(join(bin, 'id'), '#!/bin/sh\nprintf "0\\n"\n', { mode: 0o755 });
  await writeFile(join(bin, 'mountpoint'), '#!/bin/sh\n[ "$MOCK_MOUNTED" != "0" ]\n', { mode: 0o755 });
  await writeFile(join(bin, 'findmnt'), '#!/bin/sh\nprintf "/dev/md2 %s ext4\\n" "$MOCK_MOUNT"\n', { mode: 0o755 });
  await writeFile(join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const args = process.argv.slice(2), env = fs.readFileSync(path.join(process.env.MOCK_PROJECT, '.env'), 'utf8');
const source = /^READER_DATA_SOURCE=(.*)$/m.exec(env)?.[1] || 'original-volume';
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ args, source }) + '\\n');
if (args[0] === 'compose') {
  if (args.includes('ps')) process.stdout.write('reader-container\\n');
  if (args.includes('up') && args.includes('--wait') && process.env.MOCK_START_FAIL) process.exit(19);
} else if (args[0] === 'inspect') {
  const format = args[args.indexOf('--format') + 1];
  process.stdout.write(format === '{{.Image}}' ? 'sha256:unavailable-config-digest\\n' : format === '{{.Config.Image}}' ? 'langy-reader:latest\\n' : format.includes('.Type') ? 'original-volume\\n' : source + ' -> /data\\n');
} else if (args[0] === 'run') {
  if (!args.includes('langy-reader:latest')) process.exit(125);
  if (!args.includes('--mount')) process.exit(process.env.MOCK_HELPER_FAIL ? 125 : 0);
  fs.cpSync(process.env.MOCK_OLD, process.env.MOCK_DEST, { recursive: true, preserveTimestamps: true });
  if (process.env.MOCK_COPY_FAIL) fs.writeFileSync(path.join(process.env.MOCK_DEST, 'library.sqlite'), 'damaged copy');
  const result = cp.spawnSync('diff', ['-qr', '--no-dereference', process.env.MOCK_OLD, process.env.MOCK_DEST], { stdio: 'pipe' });
  process.exit(result.status ?? 1);
}
`, { mode: 0o755 });
  const destination = join(mount, 'library'), log = join(root, 'docker.jsonl');
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, MOCK_PROJECT: project, MOCK_OLD: old,
    MOCK_DEST: destination, MOCK_LOG: log, MOCK_MOUNT: mount, MOCK_MOUNTED: options.mounted === false ? '0' : '1',
    MOCK_COPY_FAIL: options.copyFail ? '1' : '', MOCK_START_FAIL: options.startFail ? '1' : '', MOCK_HELPER_FAIL: options.helperFail ? '1' : '' };
  return { project, mount, old, destination,
    execute: () => run('bash', [join(project, 'scripts/migrate-storage.sh'), mount, '--tunnel'], { env, timeout: 30000 }),
    settings: () => readFile(join(project, '.env'), 'utf8'),
    log: async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse); } catch { return []; } },
  };
}

test('migration preserves books, audio, progress, original bytes and credentials, then activates verified storage', async (t) => {
  const f = await fixture(t);
  const result = await f.execute();
  assert.match(result.stdout, /migration completed/u);
  const settings = await f.settings();
  assert.ok(settings.startsWith(originalSettings));
  assert.ok(settings.includes('READER_DATA_SOURCE=' + f.destination));
  const identifier = /^READER_STORAGE_ID=(.+)$/mu.exec(settings)[1];
  await verifyStorage(f.destination, identifier);
  assert.equal((await readFile(join(f.destination, 'progress.sqlite'))).toString(), 'reader progress');
  assert.deepEqual(await readFile(join(f.destination, 'narration', 'narrator.mp3')), await readFile(join(f.old, 'narration', 'narrator.mp3')));
  assert.deepEqual((await readdir(f.old)).sort(), ['library.sqlite', 'narration', 'progress.sqlite']);
  assert.equal((await stat(join(f.project, '.env'))).mode & 0o777, 0o600);
  const backups = (await readdir(f.project)).filter((name) => name.startsWith('.env.storage-before-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(f.project, backups[0]), 'utf8'), originalSettings);
  const calls = await f.log(), build = calls.findIndex(({ args }) => args.includes('build')), stop = calls.findIndex(({ args }) => args.includes('stop'));
  assert.ok(build >= 0 && stop > build);
  const probe = calls.findIndex(({ args }) => args[0] === 'run' && !args.includes('--mount'));
  assert.ok(probe > build && probe < stop);
  assert.ok(!calls.some(({ args }) => args.includes('sha256:unavailable-config-digest')));
  assert.equal(calls.find(({ args }) => args.includes('--wait')).source, f.destination);
});

test('an unavailable migration helper fails before stopping the reader or changing settings', async (t) => {
  const f = await fixture(t, { helperFail: true });
  await assert.rejects(f.execute());
  assert.equal(await f.settings(), originalSettings);
  assert.ok(!(await f.log()).some(({ args }) => args.includes('stop') || args.includes('up')));
  assert.equal(await readFile(join(f.old, 'library.sqlite'), 'utf8'), 'the complete original library');
});

test('an unmounted drive or nonempty target cannot stop the reader or overwrite destination data', async (t) => {
  const missing = await fixture(t, { mounted: false });
  await assert.rejects(missing.execute(), /not mounted/u);
  assert.deepEqual(await missing.log(), []);
  const occupied = await fixture(t);
  await mkdir(occupied.destination);
  await writeFile(join(occupied.destination, 'keep.txt'), 'keep this');
  await assert.rejects(occupied.execute(), /already contains files/u);
  assert.equal(await readFile(join(occupied.destination, 'keep.txt'), 'utf8'), 'keep this');
  assert.equal(await occupied.settings(), originalSettings);
  assert.ok(!(await occupied.log()).some(({ args }) => args.includes('stop') || args[0] === 'run'));
});

test('a failed byte comparison leaves original storage unchanged and restarts its reader', async (t) => {
  const f = await fixture(t, { copyFail: true });
  await assert.rejects(f.execute());
  assert.equal(await f.settings(), originalSettings);
  assert.equal(await readFile(join(f.old, 'library.sqlite'), 'utf8'), 'the complete original library');
  const starts = (await f.log()).filter(({ args }) => args.includes('up'));
  assert.equal(starts.length, 1);
  assert.equal(starts[0].source, 'original-volume');
  assert.ok(!starts[0].args.includes('--wait'));
});

test('a failed migrated startup restores old settings before restarting the original volume', async (t) => {
  const f = await fixture(t, { startFail: true });
  await assert.rejects(f.execute());
  assert.equal(await f.settings(), originalSettings);
  const starts = (await f.log()).filter(({ args }) => args.includes('up'));
  assert.deepEqual(starts.map(({ source }) => source), [f.destination, 'original-volume']);
  assert.equal(await readFile(join(f.destination, 'library.sqlite'), 'utf8'), 'the complete original library');
});
