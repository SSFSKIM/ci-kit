import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hooks = fileURLToPath(new URL('../mac/hooks/', import.meta.url));
let root;
before(() => { root = mkdtempSync(join(tmpdir(), 'ci-kit-posture-')); });
after(() => rmSync(root, { recursive: true, force: true }));

// Real hook wrappers and desktop reads; only the desktop, cursor and process-sweeping boundaries are faked.
function fixture({ display = '2560x1440@2x', displayStatus = 0, hang = false, missing = false, parsec, logFailure = false, frontStatus = 0, frontHang = false, connections = 'Proto Recv-Q Send-Q Local Address Foreign Address (state)\n', netStatus = 0 } = {}) {
  const dir = mkdtempSync(join(root, 'job-'));
  const bin = join(dir, 'bin');
  const installed = join(dir, 'hooks');
  mkdirSync(bin);
  mkdirSync(installed);
  for (const file of ['job-started.sh', 'job-completed.sh', 'desktop-check.sh', 'desktop-posture.sh']) {
    if (existsSync(join(hooks, file))) copyFileSync(join(hooks, file), join(installed, file));
  }
  const executable = (path, text) => { writeFileSync(path, `#!/bin/bash\n${text}\n`); chmodSync(path, 0o755); };
  const front = join(dir, 'front');
  writeFileSync(front, 'Terminal');
  executable(join(bin, 'lsappinfo'), `${frontHang ? 'exec /bin/sleep 60' : ''}\nif [[ $1 == front ]]; then echo ASN:0x0-1:; else printf '"LSDisplayName"="%s"\\n' "$(cat '${front}')"; fi\nexit ${frontStatus}`);
  executable(join(bin, 'open'), 'exit 91'); // Already in Terminal; no real LaunchServices calls.
  writeFileSync(join(dir, 'connections'), connections);
  executable(join(bin, 'netstat'), `[[ $* == -an ]] || exit 92; cat '${join(dir, 'connections')}'; exit ${netStatus}`);
  executable(join(bin, 'node'), 'echo "sweep $*"');
  if (!missing) executable(join(installed, 'cursor-park'), `
if [[ \${1:-} != --describe ]]; then echo cursor-parked; exit 0; fi
${hang ? `trap '' ALRM\necho $$ > '${join(dir, 'helper-pid')}'\nexec /bin/sleep 60` : `echo '${display}'; exit ${displayStatus}`}`);
  if (parsec !== undefined) {
    mkdirSync(join(dir, '.parsec'));
    writeFileSync(join(dir, '.parsec/log.txt'), parsec);
  }
  const log = join(dir, 'Library/Logs/ci-kit/mac-runner-hooks.log');
  if (logFailure) {
    mkdirSync(join(dir, 'Library/Logs/ci-kit'), { recursive: true });
    mkdirSync(log); // Even a failed hooks-log append cannot fail the hook or hide its stdout line.
  }
  function run(phase = 'start', sweepStatus = 0) {
    executable(join(bin, 'node'), `echo "sweep $*"; exit ${sweepStatus}`);
    const started = Date.now();
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', join(installed, phase === 'start' ? 'job-started.sh' : 'job-completed.sh')], {
      encoding: 'utf8', timeout: 8_000,
      env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin`, GITHUB_RUN_ID: '123456', GITHUB_JOB: 'e2e' },
    });
    const survivors = [];
    if (existsSync(join(dir, 'helper-pid'))) {
      const pid = Number(readFileSync(join(dir, 'helper-pid'), 'utf8').trim());
      try { process.kill(pid, 0); survivors.push(pid); process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return { ...result, elapsed: Date.now() - started, survivors, log: !logFailure && existsSync(log) ? readFileSync(log, 'utf8') : '' };
  }
  return { run, front };
}

const posture = (stdout) => stdout.split('\n').filter((line) => line.startsWith('ci-kit desktop ('));

test('start reports the desktop after the cursor work; end observes drift without changing focus', () => {
  const job = fixture();
  const start = job.run();
  assert.equal(start.status, 0, start.stderr);
  assert.deepEqual(posture(start.stdout), ['ci-kit desktop (start): frontmost=Terminal display=2560x1440@2x remote=none']);
  assert.ok(start.stdout.indexOf('cursor-parked') < start.stdout.indexOf('ci-kit desktop (start)'));
  assert.ok(start.stdout.indexOf('ci-kit desktop (start)') < start.stdout.indexOf('sweep '));
  assert.match(start.log, /run=123456 job=e2e ci-kit desktop \(start\): frontmost=Terminal display=2560x1440@2x remote=none/);
  writeFileSync(job.front, 'Google Chrome');
  const end = job.run('end');
  assert.equal(end.status, 0, end.stderr);
  assert.deepEqual(posture(end.stdout), ['ci-kit desktop (end): frontmost=Google Chrome display=2560x1440@2x remote=none']);
  assert.match(end.log, /ci-kit desktop \(end\): frontmost=Google Chrome/);
});

test('missing, failing and malformed display helpers leave display unknown and let the sweep run', () => {
  for (const options of [{ missing: true }, { displayStatus: 2 }, { display: 'not a display' }]) {
    const run = fixture(options).run();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /ci-kit desktop \(start\): frontmost=Terminal display=unknown remote=none/);
    assert.match(run.stdout, /sweep .*job-started/);
  }
});

test('a display helper ignoring SIGALRM is killed and reaped within a few seconds', () => {
  const run = fixture({ hang: true }).run('end');
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.elapsed < 5_000, `posture took ${run.elapsed} ms`);
  assert.deepEqual(run.survivors, []);
  assert.deepEqual(posture(run.stdout), ['ci-kit desktop (end): frontmost=Terminal display=unknown remote=none']);
});

const connected = '[I 2026-10-17 10:30:04] user#123 connected.';
const disconnected = '[I 2026-10-17 10:34:04] user#123 disconnected.';
test('Parsec uses the newest host connection event, ignoring unrelated lines and older sessions', () => {
  for (const [parsec, remote] of [
    [`${connected}\n`, 'parsec'],
    [`${connected}\n${disconnected}\n[I 2026-10-17 10:35:00] unrelated event\n`, 'none'],
    [`${disconnected}\n${connected}\n[I 2026-10-17 10:35:00] relay disconnected.\n`, 'parsec'],
    [undefined, 'none'],
    ['[I 2026-10-17 10:30:04] starting\n', 'unknown'],
  ]) {
    const run = fixture({ parsec }).run();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`remote=${remote}$`, 'm'));
  }
});

const tcp = (local, foreign, state) => `Proto Recv-Q Send-Q Local Address Foreign Address (state)\ntcp4 0 0 ${local} ${foreign} ${state}\n`;
test('Screen Sharing means an established incoming 5900 transport, not a listener or an outgoing viewer', () => {
  for (const [connections, remote] of [
    [tcp('192.168.1.2.5900', '192.168.1.3.53100', 'ESTABLISHED'), 'screensharing'],
    [tcp('::1.5900', '::1.53100', 'ESTABLISHED').replace('tcp4', 'tcp6'), 'screensharing'],
    [tcp('*.5900', '*.*', 'LISTEN'), 'none'],
    [tcp('192.168.1.2.53100', '192.168.1.3.5900', 'ESTABLISHED'), 'none'],
  ]) {
    const run = fixture({ connections }).run('end');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`remote=${remote}$`, 'm'));
  }
  const both = fixture({ connections: tcp('127.0.0.1.5900', '127.0.0.1.53100', 'ESTABLISHED'), parsec: connected }).run('end');
  assert.match(both.stdout, /remote=parsec,screensharing$/m);
});

test('high-performance Screen Sharing uses peer-associated UDP 5900–5902, not wildcard listeners', () => {
  for (const port of [5900, 5901, 5902]) {
    for (const [foreign, remote] of [['192.168.1.3.53100', 'screensharing'], ['*.*', 'none'], ['192.168.1.3.*', 'none']]) {
      const connections = `Proto Recv-Q Send-Q Local Address Foreign Address (state)\nudp4 0 0 192.168.1.2.${port} ${foreign}\n`;
      const run = fixture({ connections }).run('end');
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, new RegExp(`remote=${remote}$`, 'm'));
    }
  }
});

test('failed or unrecognized remote reads are unknown rather than a clean desktop', () => {
  for (const options of [{ netStatus: 1 }, { connections: 'unrecognized output' }]) {
    const run = fixture(options).run('end');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /remote=unknown$/m);
  }
});

test('failed or hanging frontmost reads are unknown without blocking the other fields or the job', () => {
  for (const options of [{ frontStatus: 3 }, { frontHang: true }]) {
    const run = fixture(options).run('end');
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.elapsed < 5_000, `posture took ${run.elapsed} ms`);
    assert.deepEqual(posture(run.stdout), ['ci-kit desktop (end): frontmost=unknown display=2560x1440@2x remote=none']);
  }
});

test('posture logging failures do not hide stdout or mask the sweep outcome', () => {
  const end = fixture({ logFailure: true }).run('end', 23);
  assert.equal(end.status, 23, end.stderr);
  assert.equal(posture(end.stdout).length, 1);
  const start = fixture().run('start', 23);
  assert.equal(start.status, 23, start.stderr);
  assert.equal(posture(start.stdout).length, 1);
});
