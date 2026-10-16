import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../mac/hooks/desktop-check.sh', import.meta.url));
let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'ci-kit-desktop-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

// Runs the check with a stub `lsappinfo` first on PATH: `front` prints an ASN, `info` prints `output` and exits `status`.
function check(output, status = 0, name = String(Math.random()).slice(2)) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'out.txt'), output);
  const stub = join(dir, 'bin', 'lsappinfo');
  writeFileSync(stub, `#!/bin/bash\nif [[ $1 == front ]]; then echo 'ASN:0x0-0x48b78b3:'; exit 0; fi\ncat '${join(dir, 'out.txt')}'\nexit ${status}\n`);
  chmodSync(stub, 0o755);
  const run = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir },
  });
  const logFile = join(dir, 'Library/Logs/ci-kit/mac-runner-hooks.log');
  return { ...run, log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '' };
}
// The two shapes lsappinfo prints for `info -only name`: macOS 27 over ssh, and the LSDisplayName pair.
const asnShape = (name) => `"${name}" ASN:0x0-0x48b78b3: (in front) \n    bundleID=[ NULL ] \n`;
const pairShape = (name) => `"LSDisplayName"="${name}"\n`;

for (const name of ['UserNotificationCenter', 'CoreServicesUIAgent', 'SecurityAgent', 'loginwindow']) {
  test(`a system dialog in front (${name}) fails the job at once, saying what to do`, () => {
    const run = check(asnShape(name));
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`^ci-kit: a system dialog \\(${name}\\) holds focus on the mini — dismiss it there and rerun$`, 'm'));
    assert.match(run.log, new RegExp(`desktop-check .*${name}`));
  });
}

test('the LSDisplayName shape is read too', () => {
  const run = check(pairShape('SecurityAgent'));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /\(SecurityAgent\) holds focus/);
});

test('an ordinary app in front passes', () => {
  for (const output of [asnShape('Finder'), pairShape('Google Chrome'), asnShape('Electron')]) {
    const run = check(output);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
  }
});

test('a name that only contains a listed one passes', () => {
  assert.equal(check(asnShape('loginwindowhelper')).status, 0);
});

test('empty output passes, and is logged', () => {
  const run = check('');
  assert.equal(run.status, 0);
  assert.match(run.log, /desktop-check .*could not read the frontmost app/);
});

test('lsappinfo failing passes, and is logged', () => {
  const run = check('lsappinfo: error', 3);
  assert.equal(run.status, 0);
  assert.match(run.log, /desktop-check .*could not read the frontmost app/);
});
