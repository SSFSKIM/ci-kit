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

// Runs the check with stubs first on PATH. `lsappinfo`: `front` prints an ASN, `info` prints the current frontmost
// output (`output` at the start) and exits `status`. `open`: records its arguments, then, when `afterOpen` is given,
// makes that the frontmost output, and exits `openStatus`.
function check(output, status = 0, { afterOpen, openStatus = 0 } = {}) {
  const dir = join(root, String(Math.random()).slice(2));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const front = join(dir, 'out.txt');
  writeFileSync(front, output);
  if (afterOpen !== undefined) writeFileSync(join(dir, 'after.txt'), afterOpen);
  const stub = join(dir, 'bin', 'lsappinfo');
  writeFileSync(stub, `#!/bin/bash\nif [[ $1 == front ]]; then echo 'ASN:0x0-0x48b78b3:'; exit 0; fi\ncat '${front}'\nexit ${status}\n`);
  const open = join(dir, 'bin', 'open');
  writeFileSync(
    open,
    `#!/bin/bash\necho "$*" >> '${join(dir, 'opened.txt')}'\n` +
      `[[ -f '${join(dir, 'after.txt')}' ]] && cp '${join(dir, 'after.txt')}' '${front}'\nexit ${openStatus}\n`,
  );
  chmodSync(stub, 0o755);
  chmodSync(open, 0o755);
  const run = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir },
  });
  const logFile = join(dir, 'Library/Logs/ci-kit/mac-runner-hooks.log');
  const openedFile = join(dir, 'opened.txt');
  return {
    ...run,
    log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '',
    opened: existsSync(openedFile) ? readFileSync(openedFile, 'utf8').trim().split('\n') : [],
  };
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
  for (const output of [asnShape('Terminal'), pairShape('Google Chrome'), asnShape('Electron')]) {
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

test('a system dialog is refused before anything is opened', () => {
  const run = check(asnShape('UserNotificationCenter'), 0, { afterOpen: asnShape('Terminal') });
  assert.equal(run.status, 1);
  assert.deepEqual(run.opened, []);
});

test('Finder in front: Terminal is opened through LaunchServices and the job runs, before and after logged', () => {
  const run = check(asnShape('Finder'), 0, { afterOpen: asnShape('Terminal') });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.opened, ['-a Terminal']);
  assert.match(run.stdout, /desktop-check .*frontmost before=Finder after=Terminal/);
  assert.match(run.log, /frontmost before=Finder after=Terminal/);
});

test('the LSDisplayName shape of Finder is handled the same way', () => {
  const run = check(pairShape('Finder'), 0, { afterOpen: pairShape('Terminal') });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.opened, ['-a Terminal']);
});

test('Finder stays in front after open: the job fails fast, saying what was in front', () => {
  const started = Date.now();
  const run = check(asnShape('Finder'));
  assert.equal(run.status, 1);
  assert.deepEqual(run.opened, ['-a Terminal']);
  assert.match(run.stderr, /^ci-kit: Terminal did not come to the front on the mini \(Finder is\) — check its desktop and rerun$/m);
  assert.match(run.log, /frontmost before=Finder after=Finder/);
  assert.ok(Date.now() - started < 15_000, 'the poll is bounded');
});

test('open failing fails the job', () => {
  const run = check(asnShape('Finder'), 0, { openStatus: 1 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^ci-kit: could not open Terminal on the mini/m);
});

test('an app other than Finder in front is left alone: nothing opened', () => {
  for (const output of [asnShape('Terminal'), asnShape('Electron'), pairShape('Google Chrome')]) {
    const run = check(output, 0, { afterOpen: asnShape('Terminal') });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.opened, []);
  }
});

test('an unreadable frontmost app still lets the job run, and nothing is opened', () => {
  const run = check('', 0, { afterOpen: asnShape('Terminal') });
  assert.equal(run.status, 0);
  assert.deepEqual(run.opened, []);
});
