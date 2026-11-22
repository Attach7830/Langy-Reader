import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const run = promisify(execFile);

test('benchmark reference parsing and scoring pass the dependency-free Python checks', async () => {
  const { stderr } = await run('python3', ['-m', 'unittest', 'discover', '-s', 'benchmarks/lemmas', '-p', 'test_*.py'], { maxBuffer: 1024 * 1024 });
  assert.match(stderr, /Ran \d+ tests/); assert.match(stderr, /OK/);
});

test('benchmark wrapper starts only its standalone project and preserves reader configuration and data', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'langy-benchmark-command-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const project = join(folder, 'Langy Reader'), bin = join(folder, 'bin'), log = join(folder, 'docker.jsonl');
  await mkdir(join(project, 'scripts'), { recursive: true }); await mkdir(bin);
  await copyFile(new URL('../scripts/benchmark-lemmas.sh', import.meta.url), join(project, 'scripts', 'benchmark-lemmas.sh'));
  const settings = "READER_PASSWORD='example$literal'\nREADER_DATA_SOURCE=/srv/langy/library\n";
  await writeFile(join(project, '.env'), settings);
  await writeFile(join(bin, 'docker'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.BENCHMARK_TEST_LOG,JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o755 });
  const result = await run('bash', [join(project, 'scripts', 'benchmark-lemmas.sh'), '--languages', 'es', '--threads', '2'], {
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, BENCHMARK_TEST_LOG: log },
  });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const compose = calls.find((args) => args[0] === 'compose');
  assert.deepEqual(compose.slice(0, 8), ['compose', '--env-file', '/dev/null', '-f', 'compose.benchmark.yaml', 'run', '--rm', '--build']);
  assert.ok(compose.includes('--user'));
  assert.deepEqual(compose.slice(-5), ['benchmark', '--languages', 'es', '--threads', '2']);
  assert.ok(!calls.some((args) => args.includes('reader') || args.includes('stop') || args.includes('up')));
  assert.equal(await readFile(join(project, '.env'), 'utf8'), settings);
  assert.match(result.stdout, /LATEST.txt/);
});
