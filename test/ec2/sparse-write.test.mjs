import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The image uses GNU dd. On macOS, put Homebrew coreutils' gnubin first in PATH for this focused test.
const gnu = /\(coreutils\)/.test(spawnSync('dd', ['--version'], { encoding: 'utf8' }).stdout ?? '');
const script = new URL('../../ec2/bake/write-sparse.sh', import.meta.url).pathname;
const BLOCK = 512 * 1024;
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-kit-sparse-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const tail of ['zero', 'nonzero']) test(`raw pipe preserves every byte and a ${tail} partial tail across sparse block boundaries`, { skip: !gnu }, () => fixture(dir => {
  const input = Buffer.alloc(8 * BLOCK + 137);
  input[BLOCK + 17] = 0x59;
  input[6 * BLOCK + BLOCK - 1] = 0xa7;
  if (tail === 'nonzero') input[input.length - 1] = 0x31;
  const target = join(dir, 'target');
  const r = spawnSync('bash', [script, target], { input });
  assert.equal(r.status, 0, r.stderr?.toString());
  assert.deepEqual(readFileSync(target), input);
  assert.equal(statSync(target).size, input.length);
  // APFS allocates skipped ranges after later writes; Linux hole accounting is the useful proxy here.
  if (process.platform === 'linux') assert.ok(statSync(target).blocks * 512 < 3 * BLOCK, 'writing zero runs would allocate most of the stream');
}));

test('all-zero input retains logical length without writing payload blocks', { skip: !gnu }, () => fixture(dir => {
  const input = Buffer.alloc(4 * BLOCK + 123);
  const target = join(dir, 'zero');
  const r = spawnSync('bash', [script, target], { input });
  assert.equal(r.status, 0, r.stderr?.toString());
  assert.deepEqual(readFileSync(target), input);
  assert.equal(statSync(target).blocks, 0);
}));

test('file input preserves raw partition bytes with the same zero-skipping behavior', { skip: !gnu }, () => fixture(dir => {
  const input = Buffer.alloc(6 * BLOCK);
  input.fill(0x62, 2 * BLOCK, 3 * BLOCK);
  const source = join(dir, 'source with spaces');
  const target = join(dir, 'target with spaces');
  writeFileSync(source, input);
  const r = spawnSync('bash', [script, target, source]);
  assert.equal(r.status, 0, r.stderr?.toString());
  assert.deepEqual(readFileSync(target), input);
  if (process.platform === 'linux') assert.ok(statSync(target).blocks * 512 <= 2 * BLOCK);
}));

test('raw Linux block devices retain geometry and incur writes only for nonzero chunks', {
  skip: process.env.CI_KIT_EXT4_TEST !== '1', timeout: 60_000,
}, () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 0);
  const r = spawnSync('bash', [new URL('./sparse-write-linux.sh', import.meta.url).pathname, script], {
    encoding: 'utf8', timeout: 55_000,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('read and destination errors fail instead of producing a successful copy', { skip: !gnu }, () => fixture(dir => {
  assert.notEqual(spawnSync('bash', [script, join(dir, 'target'), join(dir, 'missing')]).status, 0);
  assert.notEqual(spawnSync('bash', [script, dir], { input: Buffer.alloc(BLOCK, 1) }).status, 0);
}));
