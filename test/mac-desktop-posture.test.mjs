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

// Production's supervisors always arm a real 1 s alarm per probe, far too tight for positive fakes when suites run
// concurrently. Fixtures load a fixture-local Perl module (PERL5OPT/PERL5LIB) that scales every alarm, so each hung probe
// costs `scaled` seconds; the real fork, group kill and reap still run. The spawn timeout only has to outlast the longest
// hung run, and well under the fakes' 60 s sleep.
const scaled = 5;
const hookTimeout = 30_000;
const withinHangs = (run, hangs, deadline = scaled) => {
  const limit = (hangs * deadline + 15) * 1000;
  assert.ok(run.elapsed < limit, `posture took ${run.elapsed} ms (limit ${limit} ms)`);
};

// The process table `ps -axco pid=,comm=` prints: each executable name in full, never its path, so a cua runtime's node is
// `node`. None of these is a computer-use process or a Screen Sharing viewer: SSMenuAgent keeps running after a session.
const idle = '    1 launchd\n  410 Terminal\n  512 cursor-park\n  520 node\n  521 node_repl\n  540 SSMenuAgent\n  733 Google Chrome Helper (Renderer)\n';
// A viewer attached: launchd has started screensharingd, and its agent with it.
const sharing = `${idle}  690 screensharingd\n  691 ScreensharingAgent\n`;
// The table `ps -axo pid=,comm=` prints: each executable's path. Parsec's host process runs beside Apple's CoreParsec
// parsecd, which `ps -c` would print under the same name.
const coreParsec = '94312 /System/Library/PrivateFrameworks/CoreParsec.framework/parsecd\n';
const parsecRunning = `    1 /sbin/launchd\n  444 /Applications/Parsec.app/Contents/MacOS/parsecd\n${coreParsec}`;
const parsecGone = `    1 /sbin/launchd\n${coreParsec}`;
// What netstat prints inside a job hook on the mini (#50): exit 0 and no Internet section, while the Multipath, pfkey and
// routing sections still carry a Local/Foreign Address header. Every fixture's netstat prints it, as every job's does.
const jobNetstat = [
  'Active Multipath Internet connections',
  'Proto/ID  Flags      Local Address          Foreign Address        (state)',
  'Active LOCAL (UNIX) domain sockets',
  'Address          Type   Recv-Q Send-Q            Inode             Conn             Refs          Nextref Addr',
  'eb3b92f1b45a02a7 stream      0      0                0 463131fb0676b37a                0                0',
  'Active pfkey sockets',
  'Proto  Recv-Q Send-Q Local Address      Foreign Address',
  'Active routing sockets',
  'Proto  Recv-Q Send-Q Local Address      Foreign Address',
  '',
].join('\n');

// Real hook wrappers and desktop reads; only the desktop, cursor, process-table, load and process-sweeping boundaries are faked.
function fixture({ display = '2560x1440@2x', displayStatus = 0, hang = false, missing = false, parsec, parsecHang = false, logFailure = false, frontStatus = 0, frontHang = false, processes = idle, parsecHost = parsecRunning, psStatus = 0, psHang = false, loadavg = '{ 1.52 1.37 1.29 }\n', loadStatus = 0, loadHang = false, ignoreAlarm = false, clock = scaled, forkDelay = 0, hidIdle = '600000000000', hidStatus = 0, hidHang = false } = {}) {
  const dir = mkdtempSync(join(root, 'job-'));
  const bin = join(dir, 'bin');
  const installed = join(dir, 'hooks');
  mkdirSync(bin);
  mkdirSync(installed);
  for (const file of ['job-started.sh', 'job-completed.sh', 'desktop-check.sh', 'dialog.sh', 'desktop-posture.sh', 'instances.sh', 'shared-hold.sh']) {
    if (existsSync(join(hooks, file))) copyFileSync(join(hooks, file), join(installed, file));
  }
  const executable = (path, text) => { writeFileSync(path, `#!/bin/bash\n${text}\n`); chmodSync(path, 0o755); };
  const epoch = join(dir, 'epoch');
  const hid = join(dir, 'hid-idle');
  writeFileSync(epoch, '2000000000');
  writeFileSync(hid, hidIdle);
  executable(join(bin, 'date'), `if [[ \${!#} == +%s ]]; then cat '${epoch}'; else /bin/date "$@"; fi`);
  const front = join(dir, 'front');
  writeFileSync(front, 'Terminal');
  // Appended: both process reads run ps, so a ps hang leaves two PIDs to check.
  const hangingRead = (source) => `${ignoreAlarm ? "trap '' ALRM" : ''}\necho $$ >> '${join(dir, `${source}-pid`)}'\nexec /bin/sleep 60`;
  executable(join(bin, 'ioreg'), `${hidHang ? hangingRead('ioreg') : ''}\nprintf '    | |     "HIDIdleTime" = %s\\n' "$(cat '${hid}')"; exit ${hidStatus}`);
  executable(join(bin, 'lsappinfo'), `${frontHang ? hangingRead('front') : ''}\nif [[ $1 == front ]]; then echo ASN:0x0-1:; else printf '"LSDisplayName"="%s"\\n' "$(cat '${front}')"; fi\nexit ${frontStatus}`);
  executable(join(bin, 'open'), 'exit 91'); // Already in Terminal; no real LaunchServices calls.
  writeFileSync(join(dir, 'netstat'), jobNetstat);
  // Builtin read/printf replay each table: no extra process for a loaded machine to schedule late.
  executable(join(bin, 'netstat'), `[[ $* == -an ]] || exit 92\nIFS= read -r -d '' replay < '${join(dir, 'netstat')}'; printf '%s' "$replay"; exit 0`);
  writeFileSync(join(dir, 'processes'), processes);
  writeFileSync(join(dir, 'paths'), parsecHost);
  executable(join(bin, 'ps'), `case "$*" in '-axco pid=,comm=') table=processes ;; '-axo pid=,comm=') table=paths ;; *) exit 93 ;; esac\n${psHang ? hangingRead('ps') : ''}\nIFS= read -r -d '' replay < '${dir}'/$table; printf '%s' "$replay"; exit ${psStatus}`);
  // What macOS's sysctl prints for vm.loadavg: the 1, 5 and 15 minute averages, each %.2f, in braces.
  writeFileSync(join(dir, 'loadavg'), loadavg);
  executable(join(bin, 'sysctl'), `[[ $* == '-n vm.loadavg' ]] || exit 94\n${loadHang ? hangingRead('sysctl') : ''}\nIFS= read -r -d '' replay < '${join(dir, 'loadavg')}'; printf '%s' "$replay"; exit ${loadStatus}`);
  if (parsecHang) executable(join(bin, 'awk'), `if [[ \${!#} == '${join(dir, '.parsec/log.txt')}' ]]; then\n${hangingRead('parsec')}\nfi\nexec /usr/bin/awk "$@"`);
  executable(join(bin, 'node'), 'echo "sweep $*"');
  if (!missing) executable(join(installed, 'cursor-park'), `
if [[ \${1:-} != --describe ]]; then echo cursor-parked; exit 0; fi
${hang ? `trap '' ALRM\necho $$ > '${join(dir, 'helper-pid')}'\nexec /bin/sleep 60` : `echo '${display}'; exit ${displayStatus}`}`);
  if (parsec !== undefined || parsecHang) {
    mkdirSync(join(dir, '.parsec'));
    writeFileSync(join(dir, '.parsec/log.txt'), parsec ?? '');
  }
  // Fixture-only Perl overrides, loaded into every perl the hooks start. `clock` (null: production's real clock) scales
  // each alarm. `forkDelay` holds a forked child that long before fork returns, so before a supervisor's child can take
  // its own process group; the parent records its own and the child's exact PIDs for cleanup.
  const perlLib = join(dir, 'perl');
  mkdirSync(perlLib);
  const modules = [];
  const perlModule = (name, body) => { writeFileSync(join(perlLib, `${name}.pm`), `package ${name};\n${body}\n1;\n`); modules.push(`-M${name}`); };
  if (clock) perlModule('FixtureClock', `*CORE::GLOBAL::alarm = sub (_) { CORE::alarm($_[0] > 0 ? $_[0] * ${clock} : $_[0]) };`);
  if (forkDelay) perlModule('FixtureForkDelay', `*CORE::GLOBAL::fork = sub () {
  my $pid = CORE::fork;
  if (defined $pid && !$pid) { sleep ${forkDelay}; return 0 }
  if ($pid && open(my $fh, '>>', '${join(dir, 'fork-pids')}')) { print $fh "$$ $pid\\n"; close $fh }
  return $pid;
};`);
  const log = join(dir, 'Library/Logs/ci-kit/mac-runner-hooks.log');
  if (logFailure) {
    mkdirSync(join(dir, 'Library/Logs/ci-kit'), { recursive: true });
    mkdirSync(log); // Even a failed hooks-log append cannot fail the hook or hide its stdout line.
  }
  function run(phase = 'start', sweepStatus = 0, postureOnly = false, worker, extraEnv = {}) {
    executable(join(bin, 'node'), `echo "sweep $*"; exit ${sweepStatus}`);
    const started = Date.now();
    const script = postureOnly ? 'desktop-posture.sh' : phase === 'start' ? 'job-started.sh' : 'job-completed.sh';
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', join(installed, script), ...(postureOnly ? [phase, ...(worker ? [worker] : [])] : [])], {
      encoding: 'utf8', timeout: hookTimeout,
      env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin`, GITHUB_RUN_ID: '123456', GITHUB_JOB: 'e2e', ...extraEnv, ...(modules.length ? { PERL5LIB: perlLib, PERL5OPT: modules.join(' ') } : {}) },
    });
    const survivors = [];
    const observed = [];
    const recorded = [];
    for (const source of ['helper', 'front', 'parsec', 'ps', 'sysctl', 'ioreg']) {
      const pidFile = join(dir, `${source}-pid`);
      if (!existsSync(pidFile)) continue;
      observed.push(source);
      recorded.push(readFileSync(pidFile, 'utf8'));
    }
    if (existsSync(join(dir, 'fork-pids'))) recorded.push(readFileSync(join(dir, 'fork-pids'), 'utf8'));
    for (const pid of recorded.join(' ').split(/\s+/).filter(Boolean).map(Number)) {
      try { process.kill(pid, 0); survivors.push(pid); process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return { ...result, elapsed: Date.now() - started, survivors, observed, log: !logFailure && existsSync(log) ? readFileSync(log, 'utf8') : '' };
  }
  return { run, runPosture: (phase = 'end', worker, extraEnv) => run(phase, 0, true, worker, extraEnv), front, home: dir, epoch, hid };
}

const posture = (stdout) => stdout.split('\n').filter((line) => line.startsWith('ci-kit desktop ('));

test('start reports the desktop after the cursor work; end observes drift without changing focus', () => {
  const job = fixture();
  const start = job.run();
  assert.equal(start.status, 0, start.stderr);
  assert.deepEqual(posture(start.stdout), ['ci-kit desktop (start): frontmost=Terminal display=2560x1440@2x remote=none hid_idle_s=600 load=1.52/1.37/1.29 computeruse=none']);
  assert.ok(start.stdout.indexOf('cursor-parked') < start.stdout.indexOf('ci-kit desktop (start)'));
  assert.ok(start.stdout.indexOf('ci-kit desktop (start)') < start.stdout.indexOf('sweep '));
  assert.match(start.log, /run=123456 job=e2e ci-kit desktop \(start\): frontmost=Terminal display=2560x1440@2x remote=none hid_idle_s=600 load=1\.52\/1\.37\/1\.29 computeruse=none/);
  writeFileSync(job.front, 'Google Chrome');
  const end = job.run('end');
  assert.equal(end.status, 0, end.stderr);
  assert.deepEqual(posture(end.stdout), ['ci-kit desktop (end): frontmost=Google Chrome display=2560x1440@2x remote=none hid_idle_s=600 load=1.52/1.37/1.29 computeruse=none']);
  assert.match(end.log, /ci-kit desktop \(end\): frontmost=Google Chrome/);
});

test('missing, failing and malformed display helpers leave display unknown and let the sweep run', () => {
  for (const options of [{ missing: true }, { displayStatus: 2 }, { display: 'not a display' }]) {
    const run = fixture(options).run();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /ci-kit desktop \(start\): frontmost=Terminal display=unknown remote=none hid_idle_s=600 load=1\.52\/1\.37\/1\.29 computeruse=none/);
    assert.match(run.stdout, /sweep .*job-started/);
  }
});

test('a display helper ignoring SIGALRM is killed and reaped at the probe deadline', () => {
  const run = fixture({ hang: true }).run('end');
  assert.equal(run.status, 0, run.stderr);
  withinHangs(run, 1);
  assert.deepEqual(run.survivors, []);
  assert.deepEqual(posture(run.stdout), ['ci-kit desktop (end): frontmost=Terminal display=unknown remote=none hid_idle_s=600 load=1.52/1.37/1.29 computeruse=none']);
});

const connected = '[I 2026-10-17 10:30:04] user#123 connected.';
const disconnected = '[I 2026-10-17 10:34:04] user#123 disconnected.';
const started = '[F 2026-10-20 14:54:57] ===== Parsec: Started =====';
test('Parsec uses each client’s newest host connection event, ignoring unrelated lines and older sessions', () => {
  for (const [parsec, remote] of [
    [`${connected}\n`, 'parsec'],
    [`${connected}\n${disconnected}\n[I 2026-10-17 10:35:00] unrelated event\n`, 'none'],
    [`${disconnected}\n${connected}\n[I 2026-10-17 10:35:00] relay disconnected.\n`, 'parsec'],
    [undefined, 'none'],
    ['[I 2026-10-17 10:30:04] starting\n', 'unknown'],
    // parsecd's start clears every client: a fresh log after a reboot is none, a client connected before it is gone,
    // and one connecting after it counts.
    [`${started}\n[D 2026-10-20 14:54:57] log: Parsec release15 (150-105c, Service: -1, Loader: 14)\n`, 'none'],
    [`${connected}\n${started}\n`, 'none'],
    [`${connected}\n${started}\n${connected}\n`, 'parsec'],
  ]) {
    const run = fixture({ parsec }).run();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`remote=${remote} hid_idle_s=600 load=1\\.52/1\\.37/1\\.29 computeruse=none$`, 'm'));
  }
});

test('one Parsec client disconnecting does not hide another client still connected', () => {
  const aliceConnected = '[I 2026-10-17 10:30:04] Alice Smith#123 connected.';
  const bobConnected = '[I 2026-10-17 10:31:04] Bob#456 connected.';
  const bobDisconnected = '[I 2026-10-17 10:32:04] Bob#456 disconnected.';
  const aliceDisconnected = '[I 2026-10-17 10:33:04] Alice Smith#123 disconnected.';
  const interleaved = `${aliceConnected}\n${bobConnected}\n${bobDisconnected}\n`;
  for (const [parsec, remote] of [
    [interleaved, 'parsec'],
    [`${interleaved}${aliceDisconnected}\n`, 'none'],
    [`${interleaved}${aliceDisconnected}\n${bobConnected}\n`, 'parsec'],
  ]) {
    const run = fixture({ parsec }).run('end');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`remote=${remote} hid_idle_s=600 load=1\\.52/1\\.37/1\\.29 computeruse=none$`, 'm'));
  }
});

// A hanging ps holds every process read, each to its own deadline: Screen Sharing, computer use and, when the log shows
// a client, Parsec's host process, whose stalled read keeps the log's answer.
for (const ignoreAlarm of [false, true]) {
  for (const [options, remote, computeruse, hangs, hangingSource] of [
    [{ parsec: connected, psHang: true }, 'parsec', 'unknown', 3, 'ps'],
    [{ parsecHang: true, processes: sharing }, 'screensharing', 'none', 1, 'parsec'],
  ]) {
    test(`${remote} remains positive when the other source hangs${ignoreAlarm ? ' and ignores SIGALRM' : ''}`, () => {
      const run = fixture({ ...options, ignoreAlarm }).run('end');
      assert.equal(run.status, 0, run.stderr);
      withinHangs(run, hangs);
      assert.deepEqual(run.observed, [hangingSource]);
      assert.deepEqual(run.survivors, []);
      assert.match(run.stdout, new RegExp(`remote=${remote} hid_idle_s=600 load=1\\.52/1\\.37/1\\.29 computeruse=${computeruse}$`, 'm'));
      assert.match(run.stdout, /sweep .*job-completed/);
    });
  }
}

test('all seven hanging reads stay bounded and optional under bash -e -o pipefail', () => {
  // Production's real 1 s clock, so this costs seven seconds; marker files are not asserted, because under load a fake may be
  // abandoned before it writes one.
  const run = fixture({ frontHang: true, hang: true, parsecHang: true, psHang: true, loadHang: true, hidHang: true, ignoreAlarm: true, clock: null }).runPosture();
  assert.equal(run.status, 0, run.stderr);
  withinHangs(run, 7, 1);
  assert.deepEqual(run.survivors, []);
  assert.deepEqual(posture(run.stdout), ['ci-kit desktop (end): frontmost=unknown display=unknown remote=unknown hid_idle_s=unknown load=unknown computeruse=unknown']);
});

test('a probe child held before it has its own process group is still killed at the deadline', () => {
  // Production's real 1 s clock. Each supervisor's child is held 6 s inside fork, so every alarm finds no process group to
  // kill; a supervisor that waited for the child instead took at least 42 s over the seven probes.
  const run = fixture({ clock: null, forkDelay: 6 }).runPosture();
  assert.equal(run.status, 0, run.stderr);
  withinHangs(run, 7, 1);
  assert.deepEqual(run.survivors, []);
  assert.deepEqual(posture(run.stdout), ['ci-kit desktop (end): frontmost=unknown display=unknown remote=unknown hid_idle_s=unknown load=unknown computeruse=unknown']);
});

test('load is the 1, 5 and 15 minute averages exactly as sysctl prints them (#54)', () => {
  for (const [loadavg, load] of [
    ['{ 1.52 1.37 1.29 }\n', '1.52/1.37/1.29'],
    ['{ 0.00 0.00 0.00 }\n', '0.00/0.00/0.00'],
    // A Mac far past its cores, as the MacBook read while this was written.
    ['{ 157.18 184.78 176.54 }\n', '157.18/184.78/176.54'],
  ]) {
    const run = fixture({ loadavg }).run('end');
    assert.equal(run.status, 0, run.stderr);
    const line = `ci-kit desktop (end): frontmost=Terminal display=2560x1440@2x remote=none hid_idle_s=600 load=${load} computeruse=none`;
    assert.deepEqual(posture(run.stdout), [line]);
    assert.ok(run.log.includes(line));
  }
});

test('failed, hanging or malformed load reads are unknown without touching another field or the job', () => {
  for (const options of [
    { loadStatus: 1 },
    { loadavg: '' },
    { loadavg: 'vm.loadavg: { 1.52 1.37 1.29 }\n' },
    { loadavg: '{ 1.52 1.37 }\n' },
    { loadavg: '{ 1.5 1.37 1.29 }\n' },
    { loadavg: '{ 1,52 1,37 1,29 }\n' },
    { loadavg: '{ 1.52 1.37 1.29 }\n{ 1.52 1.37 1.29 }\n' },
    { loadHang: true },
    { loadHang: true, hidHang: true, ignoreAlarm: true },
  ]) {
    const run = fixture(options).run('end');
    assert.equal(run.status, 0, run.stderr);
    withinHangs(run, options.loadHang ? 1 : 0);
    assert.deepEqual(run.survivors, []);
    assert.deepEqual(posture(run.stdout), ['ci-kit desktop (end): frontmost=Terminal display=2560x1440@2x remote=none hid_idle_s=600 load=unknown computeruse=none'], JSON.stringify(options));
    assert.match(run.stdout, /sweep .*job-completed/);
  }
});

test('Screen Sharing is screensharingd running, by its exact name, whatever the job hook’s netstat shows (#50)', () => {
  for (const [processes, remote] of [
    [sharing, 'screensharing'],
    [`${sharing}unrecognized\n`, 'screensharing'],
    [idle, 'none'],
    // Names that merely contain it, a path where `ps -c` prints names, the agent alone, and this Mac's own outgoing viewer.
    [`${idle}  690 screensharingdx\n  691 xscreensharingd\n  692 /System/Library/CoreServices/RemoteManagement/screensharingd.bundle/Contents/MacOS/screensharingd\n  693 ScreensharingAgent\n  694 Screen Sharing\n`, 'none'],
  ]) {
    const run = fixture({ processes }).runPosture();
    assert.equal(run.status, 0, run.stderr);
    assert.match(posture(run.stdout)[0], new RegExp(` remote=${remote} `), processes);
  }
});

test('a client the Parsec log still shows connected is gone once Parsec’s own parsecd is not running', () => {
  // parsecd killed by a signal writes no "disconnected." line; only a process table that answers can override the log.
  for (const [options, remote] of [
    [{ parsec: connected, parsecHost: parsecGone }, 'none'],
    [{ parsec: connected, parsecHost: parsecGone, processes: sharing }, 'screensharing'],
    [{ parsec: connected, parsecHost: '' }, 'parsec'],
    [{ parsec: connected, parsecHost: 'unrecognized output\n' }, 'parsec'],
    [{ parsec: `${connected}\n${disconnected}\n`, parsecHost: parsecGone }, 'none'],
  ]) {
    const run = fixture(options).runPosture();
    assert.equal(run.status, 0, run.stderr);
    assert.match(posture(run.stdout)[0], new RegExp(` remote=${remote} `), JSON.stringify(options));
  }
});

test('Parsec and Screen Sharing combine in either direction, and neither unknown hides the other', () => {
  const unknownParsec = '[I 2026-10-17 10:30:04] starting\n';
  for (const [options, remote] of [
    [{ parsec: connected, processes: sharing }, 'parsec,screensharing'],
    [{ parsec: connected }, 'parsec'],
    [{ parsec: `${connected}\n${disconnected}\n`, processes: sharing }, 'screensharing'],
    [{ parsec: connected, psStatus: 1 }, 'parsec'],
    [{ parsec: unknownParsec, processes: sharing }, 'screensharing'],
    [{ parsec: unknownParsec }, 'unknown'],
  ]) {
    const run = fixture(options).runPosture();
    assert.equal(run.status, 0, run.stderr);
    assert.match(posture(run.stdout)[0], new RegExp(` remote=${remote} `), JSON.stringify(options));
  }
});

test('failed or hanging frontmost reads are unknown without blocking the other fields or the job', () => {
  for (const options of [{ frontStatus: 3 }, { frontHang: true }]) {
    const run = fixture(options).run('end');
    assert.equal(run.status, 0, run.stderr);
    withinHangs(run, options.frontHang ? 1 : 0);
    assert.deepEqual(posture(run.stdout), ['ci-kit desktop (end): frontmost=unknown display=2560x1440@2x remote=none hid_idle_s=600 load=1.52/1.37/1.29 computeruse=none']);
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

test('computer-use processes are named once each, in byte order, by executable name alone', () => {
  const processes = `${idle}  612 SkyComputerUseService\n  700 cua-sandbox-golden\n  701 cua-sandbox-golden\n  702 cua-driver\n  800 com.openai.sky.CUAService\n`;
  const run = fixture({ processes }).run('end');
  assert.equal(run.status, 0, run.stderr);
  const line = 'ci-kit desktop (end): frontmost=Terminal display=2560x1440@2x remote=none hid_idle_s=600 load=1.52/1.37/1.29 computeruse=SkyComputerUseService,com.openai.sky.CUAService,cua-driver,cua-sandbox-golden';
  assert.deepEqual(posture(run.stdout), [line]);
  assert.ok(run.log.includes(line));
  assert.match(run.stdout, /sweep .*job-completed/);
});

test('a computer-use list too long for the posture read keeps whole names and ends in +N more', () => {
  const names = Array.from({ length: 40 }, (_, i) => `cua-sandbox-${String(i).padStart(3, '0')}`);
  const processes = `${idle}${names.map((name, i) => `  ${900 + i} ${name}\n`).join('')}`;
  const run = fixture({ processes }).run('end');
  assert.equal(run.status, 0, run.stderr);
  const list = `${names.slice(0, 30).join(',')},+10 more`;
  assert.equal(names.slice(0, 30).join(',').length, 479);
  assert.deepEqual(posture(run.stdout), [`ci-kit desktop (end): frontmost=Terminal display=2560x1440@2x remote=none hid_idle_s=600 load=1.52/1.37/1.29 computeruse=${list}`]);
});

test('failed, hanging, empty or unrecognized process reads leave Screen Sharing and computer use unknown, nothing else', () => {
  for (const options of [{ psStatus: 1 }, { processes: '' }, { processes: 'unrecognized output\n' }, { psHang: true }, { psHang: true, ignoreAlarm: true }]) {
    const run = fixture(options).run('end');
    assert.equal(run.status, 0, run.stderr);
    withinHangs(run, options.psHang ? 2 : 0);
    assert.deepEqual(run.survivors, []);
    assert.deepEqual(posture(run.stdout), ['ci-kit desktop (end): frontmost=Terminal display=2560x1440@2x remote=unknown hid_idle_s=600 load=1.52/1.37/1.29 computeruse=unknown']);
    assert.match(run.stdout, /sweep .*job-completed/);
  }
});

test('a computer-use name survives an unrecognized row and another read hanging', () => {
  const service = '  612 SkyComputerUseService\n';
  for (const [options, remote] of [[{ processes: `${service}unrecognized\n` }, 'unknown'], [{ processes: service, parsecHang: true }, 'unknown']]) {
    const run = fixture(options).run('end');
    assert.equal(run.status, 0, run.stderr);
    withinHangs(run, options.parsecHang ? 1 : 0);
    assert.deepEqual(run.survivors, []);
    assert.match(run.stdout, new RegExp(`remote=${remote} hid_idle_s=600 load=1\\.52/1\\.37/1\\.29 computeruse=SkyComputerUseService$`, 'm'));
  }
});

test('--read prints the same fields alone and logs nothing, for the measured-job guard (mac/settle)', () => {
  const job = fixture({ processes: sharing });
  const read = job.runPosture('--read');
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, 'frontmost=Terminal display=2560x1440@2x remote=screensharing hid_idle_s=600 load=1.52/1.37/1.29 computeruse=none\n');
  assert.equal(read.log, '');
  assert.deepEqual(posture(job.runPosture('end').stdout), [`ci-kit desktop (end): ${read.stdout.trim()}`]);
});

test('HID idle seconds are read from nanoseconds; failed, malformed and hung reads are unknown', () => {
  for (const [options, expected] of [
    [{ hidIdle: '356987654321' }, '356'], [{ hidIdle: '0' }, '0'],
    [{ hidIdle: '-1' }, 'unknown'], [{ hidIdle: 'garbage' }, 'unknown'],
    [{ hidStatus: 1 }, 'unknown'], [{ hidHang: true }, 'unknown'],
  ]) {
    const run = fixture(options).runPosture();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`hid_idle_s=${expected} `));
    assert.deepEqual(run.survivors, []);
    if (options.hidHang) withinHangs(run, 1);
  }
});

test('input during a job warns in stdout and the hooks log, without calling it human input', () => {
  for (const processes of [idle, `${idle}  702 SkyComputerUseService\n`]) {
    const job = fixture({ processes });
    assert.equal(job.run().status, 0);
    writeFileSync(job.epoch, '2000000300');
    writeFileSync(job.hid, '20000000000');
    const end = job.run('end');
    assert.equal(end.status, 0, end.stderr);
    assert.match(end.stdout, /::warning::ci-kit desktop input during this job:.*hid_idle_s=20/);
    assert.match(end.stdout, /computer-use.*job itself/);
    assert.match(end.log, /ci-kit desktop input during this job:/);
    assert.match(end.stdout, new RegExp(`computeruse=${processes === idle ? 'none' : 'SkyComputerUseService'}`));
    assert.doesNotMatch(job.run('end').stdout, /::warning::/, 'the baseline is consumed');
  }
});

test('post-park baseline excludes prior input, and missing or unreadable samples never accuse', () => {
  for (const [startIdle, endIdle] of [['0', '300000000000'], ['600000000000', '900000000000'], ['0', 'garbage']]) {
    const job = fixture({ hidIdle: startIdle });
    job.run();
    writeFileSync(job.epoch, '2000000300'); writeFileSync(job.hid, endIdle);
    assert.doesNotMatch(job.run('end').stdout, /::warning::/);
  }
  const neverStarted = fixture({ hidIdle: '0' });
  assert.doesNotMatch(neverStarted.run('end').stdout, /::warning::/);
});

test('concurrent workers keep independent boundaries and a reused PID cannot attribute another job’s input', () => {
  const job = fixture();
  job.runPosture('start', '1001');
  writeFileSync(job.epoch, '2000000250');
  job.runPosture('start', '1002');
  writeFileSync(job.epoch, '2000000300'); writeFileSync(job.hid, '100000000000');
  assert.match(job.runPosture('end', '1001').stdout, /::warning::/);
  assert.doesNotMatch(job.runPosture('end', '1002').stdout, /::warning::/);
  job.runPosture('start', '1003');
  writeFileSync(job.epoch, '2000000600'); writeFileSync(job.hid, '0');
  assert.doesNotMatch(job.runPosture('end', '1003', { GITHUB_RUN_ATTEMPT: '2' }).stdout, /::warning::/);
});
