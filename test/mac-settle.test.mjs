import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../vendor/yaml/dist/index.js';

// The measured-job guard, run as its action runs it: action.yml's step, with its inputs' defaults, from the kit's own tree
// (the action's checkout), reading the real desktop-posture.sh --read beside it. Only the desktop's boundaries are faked,
// as in mac-desktop-posture.test.mjs, and the clock: `sleep` moves a fake clock instead of waiting, so a 15-minute bound
// runs in seconds. The desktop changes by read: read n sees world[n] (the last entry for every read after it).
const action = fileURLToPath(new URL('../mac/settle/', import.meta.url));
const step = parse(readFileSync(join(action, 'action.yml'), 'utf8'));
let root, worker;
// A job's Runner.Worker, as settle looks for it among its ancestors on a Mac with the VM lane: a copy of node under that
// name, which records its pid and runs the step as its child.
before(() => {
  root = mkdtempSync(join(tmpdir(), 'ci-kit-settle-'));
  worker = join(root, 'runner/bin/Runner.Worker');
  mkdirSync(join(root, 'runner/bin'), { recursive: true });
  copyFileSync(process.execPath, worker, constants.COPYFILE_FICLONE);
});
const asWorker = `require('node:fs').writeFileSync(process.argv[1], String(process.pid));
const run = require('node:child_process').spawnSync(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });
process.exit(run.status ?? 1);`;
// A step with no Runner.Worker above it at all: run by a grandchild that waits until its parent has exited, so it is
// reparented away from this test's own ancestors, which hold the real Runner.Worker when the suite runs as a CI job. Its
// output stays on the inherited pipes, which spawnSync reads until they close; its status goes to a file.
const orphaned = `my ($status, @command) = @ARGV;
my $child = fork; defined $child or exit 125;
if (!$child) {
  my $parent = $$;
  my $grandchild = fork; defined $grandchild or exit 125;
  exit 0 if $grandchild;
  select(undef, undef, undef, 0.02) while getppid() == $parent;
  system { $command[0] } @command;
  open(my $fh, '>', $status) or exit 125; print $fh ($? >> 8), "\\n"; close $fh;
  exit 0;
}
waitpid $child, 0;`;
after(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse('2026-10-19T05:12:34Z') / 1000;
const idle = '    1 launchd\n  410 Terminal\n  512 cursor-park\n  520 node\n  540 SSMenuAgent\n';
const quiet = { load: '1.52', display: '2560x1440@2x', processes: idle };
const connected = '[I 2026-10-19 05:00:04] user#123 connected.\n';

// hooks: where the runner's hook set is installed, the only place the compiled display helper lives (false: nowhere);
// variable: whether the runner's .env names it in ACTIONS_RUNNER_HOOK_JOB_STARTED, as mac/install.sh writes it.
// lane: whether the VM lane is installed (its launcher's LaunchAgent file); underWorker: whether the step runs under a
// Runner.Worker, as on a runner; orphan: whether it runs with no Runner.Worker among its ancestors; logsFile: the hooks' log directory is a file, so nothing can be written there. A world
// entry's reserved puts the lane's reservation (vm-reserved) up for that read.
function guard(world, { inputs = {}, hooks = 'actions-runner-maws/ci-kit/hooks', variable = true, env = {}, readSeconds = 0, logFailure = false, lane = false, underWorker = lane, orphan = false, logsFile = false } = {}) {
  const dir = mkdtempSync(join(root, 'job-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const executable = (path, text) => { writeFileSync(path, `#!/bin/bash\n${text}\n`); chmodSync(path, 0o755); };
  const file = (name) => join(dir, name);
  const now = (name) => `'${file(`now/${name}`)}'`;
  // Each read's desktop, written whole into world/<n>/ and copied into now/ for read 0 and by each sleep after it.
  world.forEach((entry, n) => {
    const { load, loadavg = `{ ${load} 6.00 5.00 }\n`, loadStatus = 0, display, displayStatus = 0, processes, psStatus = 0, parsec, reserved } = { ...quiet, ...entry };
    const at = file(`world/${n}`);
    mkdirSync(at, { recursive: true });
    for (const [name, value] of Object.entries({ loadavg, 'load-status': loadStatus, display, 'display-status': displayStatus, processes, 'ps-status': psStatus })) {
      writeFileSync(join(at, name), String(value));
    }
    if (parsec !== undefined) writeFileSync(join(at, 'parsec'), parsec);
    if (reserved) writeFileSync(join(at, 'reserved'), 'vm=maws-vm-job-vm-20261019T051000Z since 2026-10-19T05:10:00Z\n');
  });
  const logs = file('Library/Logs/ci-kit');
  const apply = `apply() {
  local n=$1 last=${world.length - 1}
  ((n <= last)) || n=$last
  rm -rf '${file('now')}' && cp -R '${file('world')}/'"$n" '${file('now')}'
  if [[ -e ${now('parsec')} ]]; then mkdir -p '${file('.parsec')}' && cp ${now('parsec')} '${file('.parsec/log.txt')}'; else rm -f '${file('.parsec/log.txt')}'; fi
  if [[ -e ${now('reserved')} ]]; then mkdir -p '${logs}' && cp ${now('reserved')} '${logs}/vm-reserved'; else rm -f '${logs}/vm-reserved'; fi
}`;
  writeFileSync(file('clock'), '0');
  writeFileSync(file('reads'), '0');
  spawnSync('bash', ['-c', `${apply}\napply 0`]);
  // The clock, in seconds since the guard's start: `date` reads it, `sleep` moves it, a read can take readSeconds of it.
  executable(join(bin, 'date'), `t=$((${T0} + $(cat '${file('clock')}')))
for a; do
  case $a in
    +%s) echo "$t"; exit 0 ;;
    +*) exec perl -MPOSIX=strftime -e 'print strftime(substr($ARGV[0], 1), gmtime $ARGV[1]), "\\n"' "$a" "$t" ;;
  esac
done
exec /bin/date "$@"`);
  executable(join(bin, 'sleep'), `${apply}
echo "$1" >> '${file('sleeps')}'
echo $(($(cat '${file('clock')}') + $1)) > '${file('clock')}'
n=$(($(cat '${file('reads')}') + 1)); echo "$n" > '${file('reads')}'
apply "$n"`);
  executable(join(bin, 'lsappinfo'), `if [[ $1 == front ]]; then echo ASN:0x0-1:; else printf '"LSDisplayName"="Terminal"\\n'; fi`);
  executable(join(bin, 'ps'), `[[ $* == '-axco pid=,comm=' ]] || exit 93\ncat ${now('processes')}; exit $(cat ${now('ps-status')})`);
  // The load read also marks each read's start on the clock (no other fake moves it), then spends readSeconds.
  executable(join(bin, 'sysctl'), `[[ $* == '-n vm.loadavg' ]] || exit 94
cat '${file('clock')}' >> '${file('read-at')}'
echo $(($(cat '${file('clock')}') + ${readSeconds})) > '${file('clock')}'
cat ${now('loadavg')}; exit $(cat ${now('load-status')})`);
  if (hooks) {
    mkdirSync(file(hooks), { recursive: true });
    executable(file(`${hooks}/cursor-park`), `[[ $1 == --describe ]] || exit 95\ncat ${now('display')}; echo; exit $(cat ${now('display-status')})`);
  }
  // Production's 1 s probe deadlines, scaled inside the fixture so a loaded test machine does not read as failed reads.
  const perlLib = join(dir, 'perl');
  mkdirSync(perlLib);
  writeFileSync(join(perlLib, 'FixtureClock.pm'), 'package FixtureClock;\n*CORE::GLOBAL::alarm = sub (_) { CORE::alarm($_[0] > 0 ? $_[0] * 5 : $_[0]) };\n1;\n');
  const log = file('Library/Logs/ci-kit/mac-runner-hooks.log');
  if (logFailure) mkdirSync(log, { recursive: true });
  if (logsFile) { mkdirSync(file('Library/Logs'), { recursive: true }); writeFileSync(logs, ''); }
  if (lane) {
    mkdirSync(file('Library/LaunchAgents'), { recursive: true });
    writeFileSync(file('Library/LaunchAgents/com.ssfskim.ci-kit.vm-lane.plist'), '<plist/>\n');
  }
  // action.yml's one step: its env with the inputs (or their defaults) substituted, and its run line, as the runner runs it.
  const [only] = step.runs.steps;
  const stepEnv = Object.fromEntries(Object.entries(only.env).map(([name, value]) =>
    [name, value.replace(/\$\{\{ inputs\.([a-z]+) \}\}/, (_, input) => String(inputs[input] ?? step.inputs[input].default))]));
  const started = Date.now();
  const command = ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', only.run];
  const [program, ...args] = underWorker ? [worker, '-e', asWorker, file('worker.pid'), ...command]
    : orphan ? ['perl', '-e', orphaned, file('orphan.status'), ...command] : command;
  const spawned = spawnSync(program, args, {
    encoding: 'utf8', timeout: 120_000,
    env: {
      HOME: dir, PATH: `${bin}:/usr/bin:/bin`, GITHUB_ACTION_PATH: action, GITHUB_RUN_ID: '123456', GITHUB_JOB: 'e2e',
      ...(variable && hooks ? { ACTIONS_RUNNER_HOOK_JOB_STARTED: file(`${hooks}/job-started.sh`) } : {}), PERL5LIB: perlLib, PERL5OPT: '-MFixtureClock',
      ...stepEnv, ...env,
    },
  });
  const text = (name) => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '';
  const result = orphan ? { ...spawned, status: text('orphan.status') === '' ? null : Number(text('orphan.status')) } : spawned;
  return {
    ...result,
    elapsed: Date.now() - started,
    sleeps: text('sleeps').split('\n').filter(Boolean).map(Number),
    readAt: text('read-at').split('\n').filter(Boolean).map(Number),
    log: logFailure ? '' : text('Library/Logs/ci-kit/mac-runner-hooks.log'),
    worker: underWorker ? Number(text('worker.pid')) : null,
    claims: existsSync(logs) && !logsFile ? readdirSync(logs).filter((name) => name.startsWith('vm-claim.')) : [],
    claim: (name) => text(`Library/Logs/ci-kit/${name}`),
    locked: existsSync(join(logs, 'desktop.lock')),
  };
}

const posture = ({ display = '2560x1440@2x', remote = 'none', load = '1.52', computeruse = 'none' } = {}) =>
  `frontmost=Terminal display=${display} remote=${remote} load=${load === 'unknown' ? load : `${load}/6.00/5.00`} computeruse=${computeruse}`;
// MAWS's scripts/ci-gate-refusals.sh counts a failed job as refused by this shape, on a line of its own.
const refusalShape = /^ci-kit: .*rerun$/;

test('a quiet desktop settles at the second read, 30 s in, with one line in the job log and the hooks log', () => {
  const run = guard([{}]);
  assert.equal(run.status, 0, run.stderr);
  const line = `ci-kit settle: settled in 30 s; start: ${posture()}; release: ${posture()}`;
  assert.equal(run.stdout, `${line}\n`);
  assert.equal(run.stderr, '');
  assert.deepEqual(run.sleeps, [30]);
  // --read logs nothing: the guard's line is the hooks log's only one.
  assert.equal(run.log, `2026-10-19T05:13:04Z settle run=123456 job=e2e ${line}\n`);
});

test('a desktop that settles during the wait releases the job at the second read that meets every condition', () => {
  for (const [world, start, release] of [
    [[{ load: '7.20' }, { load: '6.00' }, { load: '4.99' }], posture({ load: '7.20' }), posture({ load: '4.99' })],
    [[{ display: '2560x1440@1x', parsec: connected }, { display: '2560x1440@1x', parsec: connected }, {}], posture({ display: '2560x1440@1x', remote: 'parsec' }), posture()],
    [[{ processes: `${idle}  690 screensharingd\n` }, {}], posture({ remote: 'screensharing' }), posture()],
    [[{ processes: `${idle}  612 SkyComputerUseService\n` }, { processes: `${idle}  612 SkyComputerUseService\n` }, {}], posture({ computeruse: 'SkyComputerUseService' }), posture()],
  ]) {
    // The last entry is the first clean read, and the read after it the second: the guard has slept once per entry.
    const run = guard(world);
    const waited = 30 * world.length;
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `ci-kit settle: settled in ${waited} s; start: ${start}; release: ${release}\n`);
    assert.equal(run.sleeps.length, world.length);
  }
});

test('one clean read between unsettled ones is not settled: two consecutive reads must meet every condition', () => {
  const run = guard([{ load: '7.20' }, {}, { load: '7.20' }, {}, { display: '2560x1440@1x' }, {}, {}]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^ci-kit settle: settled in 180 s; start: .*load=7\.20\/.*; release: /);
});

test('at the bound the job is refused with a ci-kit: … rerun line naming each condition the last read failed and what it read', () => {
  for (const [entry, reason] of [
    [{ load: '7.20' }, 'load 7.20'],
    [{ load: '5.00' }, 'load 5.00'],
    [{ display: '2560x1440@1x' }, 'display @1x'],
    [{ parsec: connected }, 'parsec'],
    [{ processes: `${idle}  690 screensharingd\n` }, 'screensharingd'],
    [{ processes: `${idle}  612 SkyComputerUseService\n  702 cua-driver\n` }, 'computeruse SkyComputerUseService,cua-driver'],
    [{ load: '15.70', display: '2560x1440@1x', parsec: connected, processes: `${idle}  690 screensharingd\n  702 cua-driver\n` },
      'load 15.70, display @1x, parsec, screensharingd, computeruse cua-driver'],
  ]) {
    const run = guard([entry], { inputs: { bound: '1' } });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stdout, '');
    const lines = run.stderr.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, run.stderr);
    assert.match(lines[0], refusalShape);
    assert.match(lines[0], new RegExp(`^ci-kit: the mini did not settle for a measured job within 1 min \\(${reason.replace(/[.()]/g, '\\$&')}\\); waited 60 s; start: `), reason);
    assert.deepEqual(run.sleeps, [30, 30]);
    assert.equal(run.log, `2026-10-19T05:13:34Z settle run=123456 job=e2e ${lines[0]}\n`);
  }
});

test('a remote viewer alone refuses at six minutes, naming the viewer and its uninterrupted hold in both logs', () => {
  for (const [entry, remote, reason] of [
    [{ processes: `${idle}  690 screensharingd\n` }, 'screensharing', 'screensharingd'],
    [{ parsec: connected }, 'parsec', 'parsec'],
    [{ parsec: connected, processes: `${idle}  690 screensharingd\n` }, 'parsec,screensharing', 'parsec, screensharingd'],
  ]) {
    const run = guard([entry], { env: { CI_KIT_MACHINE: 'rental' } });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stdout, '');
    const line = `ci-kit: the rental did not settle for a measured job (${reason} alone for 360 s); waited 360 s; start: ${posture({ remote })}; refusal: ${posture({ remote })} — fix that there and rerun`;
    assert.equal(run.stderr, `${line}\n`);
    assert.match(line, refusalShape);
    assert.equal(run.log, `2026-10-19T05:18:34Z settle run=123456 job=e2e ${line}\n`);
    assert.deepEqual(run.sleeps, Array(12).fill(30));
  }
});

test('a viewer that clears just before six minutes still releases after two clean reads', () => {
  const viewer = { processes: `${idle}  690 screensharingd\n` };
  const run = guard([...Array(11).fill(viewer), {}]); // clears at 330 s; second clean read at 360 s
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `ci-kit settle: settled in 360 s; start: ${posture({ remote: 'screensharing' })}; release: ${posture()}\n`);
  assert.equal(run.stderr, '');
});

test('a viewer plus load waits to the bound, and any other failed condition breaks the remote-only window', () => {
  const viewer = { processes: `${idle}  690 screensharingd\n` };
  const loaded = guard([{ ...viewer, load: '7.20' }]);
  assert.equal(loaded.status, 1, loaded.stderr);
  assert.match(loaded.stderr, /within 15 min \(load 7\.20, screensharingd\); waited 900 s;/);
  for (const [other, options] of [
    [{ load: '7.20' }, {}],
    [{ display: '2560x1440@1x' }, {}],
    [{ processes: `${idle}  690 screensharingd\n  702 cua-driver\n` }, {}],
    [{ reserved: true }, { lane: true }],
    [{ loadStatus: 1 }, {}],
    [{ psStatus: 1 }, {}],
  ]) {
    // One bad read at 270 s prevents early refusal at 360 s; the fresh window cannot finish before the 9-min bound.
    const run = guard([...Array(9).fill(viewer), { ...viewer, ...other }, viewer], { ...options, inputs: { bound: '9' } });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /within 9 min \(screensharingd\); waited 540 s;/);
    assert.deepEqual(run.sleeps, Array(18).fill(30));
  }
});

test('six minutes is a continuous remote-only window, not time since the job started or a sum of separate holds', () => {
  const viewer = { processes: `${idle}  690 screensharingd\n` };
  for (const middle of [{}, { ...viewer, load: '7.20' }]) {
    const run = guard([...Array(6).fill(viewer), middle, viewer]); // interruption at 180 s, window restarts at 210 s
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /\(screensharingd alone for 360 s\); waited 570 s;/);
    assert.deepEqual(run.sleeps, Array(19).fill(30));
  }
  const slow = guard([viewer], { readSeconds: 7 });
  assert.equal(slow.status, 1, slow.stderr);
  assert.match(slow.stderr, /\(screensharingd alone for 370 s\); waited 377 s;/);
});

test('remote: any never refuses early, even with a viewer present for longer than six minutes', () => {
  const viewer = { processes: `${idle}  690 screensharingd\n` };
  const quietRun = guard([viewer], { inputs: { remote: 'any' } });
  assert.equal(quietRun.status, 0, quietRun.stderr);
  assert.deepEqual(quietRun.sleeps, [30]);
  const loaded = guard([{ ...viewer, load: '7.20' }], { inputs: { remote: 'any', bound: '7' } });
  assert.equal(loaded.status, 1, loaded.stderr);
  assert.match(loaded.stderr, /within 7 min \(load 7\.20\); waited 420 s;/);
});

test('the refusal line carries the posture at start and at refusal, and names the machine', () => {
  const run = guard([{ load: '15.70', display: '2560x1440@1x', parsec: connected }, { load: '9.40' }, { load: '7.20' }], { inputs: { bound: '1' }, env: { CI_KIT_MACHINE: 'rental' } });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, `ci-kit: the rental did not settle for a measured job within 1 min (load 7.20); waited 60 s; start: ${posture({ load: '15.70', display: '2560x1440@1x', remote: 'parsec' })}; refusal: ${posture({ load: '7.20' })} — fix that there and rerun\n`);
});

test('when the last read met every condition but the one before it did not, the refusal names what the one before failed', () => {
  const run = guard([{ display: '2560x1440@1x' }, { display: '2560x1440@1x' }, {}], { inputs: { bound: '1' } });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /within 1 min \(display @1x\); waited 60 s; .*; refusal: frontmost=Terminal display=2560x1440@2x /);
});

test('the default bound holds: no read starts after 15 minutes, and the refusal comes at the read whose next would', () => {
  const run = guard([{ load: '7.20' }]);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /^ci-kit: the mini did not settle for a measured job within 15 min \(load 7\.20\); waited 900 s; /);
  // 31 reads, 0 s to 900 s, 30 s apart.
  assert.deepEqual(run.sleeps, Array(30).fill(30));
  // Reads that take 7 s each (the most six 1 s probes and their overhead could take): every read still starts within the
  // bound, and the refusal follows the last one.
  const slow = guard([{ load: '7.20' }], { readSeconds: 7 });
  assert.equal(slow.status, 1, slow.stderr);
  assert.ok(slow.readAt.length > 0 && slow.readAt.every((at) => at <= 900), slow.readAt.join(' '));
  const waited = Number(slow.stderr.match(/; waited (\d+) s;/)[1]);
  assert.ok(waited + 30 > 900 && waited <= 907, String(waited));
});

test('a read that fails counts as not settled without stopping the guard, and the refusal says which read was unknown', () => {
  for (const [entry, reason, options = {}] of [
    [{ loadStatus: 1 }, 'load unknown'],
    [{ loadavg: 'garbage\n' }, 'load unknown'],
    [{ displayStatus: 2 }, 'display unknown'],
    [{ display: 'not a display' }, 'display unknown'],
    [{}, 'display unknown', { hooks: false }],
    [{ psStatus: 1 }, 'remote unknown, computeruse unknown'],
    [{ processes: '' }, 'remote unknown, computeruse unknown'],
    [{ parsec: '[I 2026-10-19 05:00:04] starting\n' }, 'remote unknown'],
  ]) {
    const run = guard([entry], { inputs: { bound: '1' }, ...options });
    assert.equal(run.status, 1, `${JSON.stringify(entry)}: ${run.stderr}`);
    assert.match(run.stderr, new RegExp(`^ci-kit: the mini did not settle for a measured job within 1 min \\(${reason}\\); waited 60 s; .* — fix that there and rerun\\n$`), JSON.stringify(entry));
  }
  // Every probe failing (perl itself broken here), and a posture read that cannot run at all (a checkout without the
  // hooks), are every field unknown, in the same shape.
  const checkout = join(mkdtempSync(join(root, 'checkout-')), 'mac/settle');
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, 'settle.sh'), readFileSync(join(action, 'settle.sh')));
  for (const env of [{ PERL5OPT: '-MNoSuchModule' }, { GITHUB_ACTION_PATH: checkout }]) {
    const unreadable = guard([{}], { inputs: { bound: '1' }, env });
    assert.equal(unreadable.status, 1, unreadable.stderr);
    assert.match(unreadable.stderr, /within 1 min \(load unknown, display unknown, remote unknown, computeruse unknown\); waited 60 s; start: frontmost=unknown display=unknown remote=unknown load=unknown computeruse=unknown; /);
  }
  // A failed read that recovers settles like any other.
  const recovered = guard([{ loadStatus: 1 }, {}]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /^ci-kit settle: settled in 60 s; start: frontmost=Terminal display=2560x1440@2x remote=none load=unknown computeruse=none; /);
});

test('the display helper is the runner’s installed one: where its hook variable says, else in its fixed directory', () => {
  assert.equal(guard([{}], { hooks: 'runner/hooks' }).status, 0);
  assert.equal(guard([{}], { variable: false }).status, 0);
  const unfound = guard([{}], { hooks: 'runner/hooks', variable: false, inputs: { bound: '1' } });
  assert.equal(unfound.status, 1);
  assert.match(unfound.stderr, /within 1 min \(display unknown\); /);
});

test('each condition takes its input, and any leaves it unchecked', () => {
  for (const [entry, inputs, status] of [
    [{ load: '7.20' }, { load: '10' }, 0],
    [{ load: '4.50' }, { load: '4.5' }, 1],
    [{ load: '4.49' }, { load: '4.5' }, 0],
    [{ load: '7.20' }, { load: 'any' }, 0],
    [{ load: 'x', loadavg: 'garbage\n' }, { load: 'any' }, 0],
    [{ display: '2560x1440@1x' }, { display: '@1x' }, 0],
    [{ display: '2560x1440@1x' }, { display: 'any' }, 0],
    [{ parsec: connected }, { remote: 'any' }, 0],
    [{ processes: `${idle}  612 SkyComputerUseService\n` }, { computeruse: 'any' }, 0],
  ]) {
    const run = guard([entry], { inputs: { bound: '1', ...inputs } });
    assert.equal(run.status, status, `${JSON.stringify([entry, inputs])}: ${run.stderr}`);
  }
});

test('a malformed input fails the step before any read, never in the refusal shape', () => {
  for (const [inputs, message] of [
    [{ load: 'high' }, "load takes a number with at most two decimals, or any, not 'high'"],
    [{ load: '4.125' }, "load takes a number with at most two decimals, or any, not '4.125'"],
    [{ display: '2x' }, "display takes a scale like @2x, or any, not '2x'"],
    [{ remote: 'parsec' }, "remote takes none or any, not 'parsec'"],
    [{ computeruse: 'cua' }, "computeruse takes none or any, not 'cua'"],
    [{ bound: '0' }, "bound takes a whole number of minutes, at least 1, not '0'"],
    [{ bound: '1.5' }, "bound takes a whole number of minutes, at least 1, not '1.5'"],
    [{ vm: 'guest' }, "vm takes none or any, not 'guest'"],
  ]) {
    const run = guard([{}], { inputs });
    assert.equal(run.status, 2, JSON.stringify(inputs));
    assert.equal(run.stderr, `ci-kit settle: ${message}\n`);
    assert.doesNotMatch(run.stderr.trim(), refusalShape);
    assert.deepEqual(run.readAt, []);
  }
});

test('a hooks log that cannot be written changes neither the line nor the outcome', () => {
  const settled = guard([{}], { logFailure: true });
  assert.equal(settled.status, 0, settled.stderr);
  assert.match(settled.stdout, /^ci-kit settle: settled in 30 s; /);
  const refused = guard([{ load: '7.20' }], { inputs: { bound: '1' }, logFailure: true });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr.trim(), refusalShape);
});

// The VM lane (mac/hooks/vm-claim.sh): on a Mac with the lane installed, settle keeps the guest out of a measured job.
test('on a Mac with the VM lane, settle raises the measured claim at its first read, names it, and releases only once the reservation is gone', () => {
  const run = guard([{ reserved: true }, { reserved: true }, {}], { lane: true });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.claims.length, 1);
  const [claim] = run.claims;
  assert.match(claim, new RegExp(`^vm-claim\\.${run.worker}-\\S+$`));
  // Raised at the first read, under the clock's first second, naming the job and its Runner.Worker.
  assert.match(run.claim(claim), new RegExp(`^measured claim since 2026-10-19T05:12:34Z: run 123456 job e2e \\(worker ${run.worker}\\)\\n(.|\\n)*worker=${run.worker}\\nstarted=\\S`));
  assert.equal(run.stdout, `ci-kit settle: settled in 90 s; claim: ${claim}; start: ${posture()} vm=reserved; release: ${posture()} vm=none\n`);
  assert.deepEqual(run.sleeps, [30, 30, 30]);
  assert.equal(run.stderr, '');
});

test('a reservation that stands to the bound refuses the measured job, naming the vm condition; its claim stays for the end hook', () => {
  const run = guard([{ reserved: true }], { lane: true, inputs: { bound: '1' } });
  assert.equal(run.status, 1, run.stderr);
  const [claim] = run.claims;
  assert.ok(claim, 'the claim stays');
  assert.equal(run.stderr, `ci-kit: the mini did not settle for a measured job within 1 min (vm reserved); waited 60 s; claim: ${claim}; start: ${posture()} vm=reserved; refusal: ${posture()} vm=reserved — fix that there and rerun\n`);
  assert.match(run.stderr.trim(), refusalShape);
});

test('vm: any leaves the guest unchecked: no claim, and a reservation does not hold the job', () => {
  const run = guard([{ reserved: true }], { lane: true, inputs: { vm: 'any' } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `ci-kit settle: settled in 30 s; start: ${posture()} vm=reserved; release: ${posture()} vm=reserved\n`);
  assert.deepEqual(run.claims, []);
});

test('a measured job whose claim cannot be raised is refused at once, before any read', () => {
  for (const [options, why] of [
    [{ underWorker: false, orphan: true }, /no Runner\.Worker among the ancestors of process \d+/],
    [{ logsFile: true }, /the desktop lock could not be taken within 180 s/],
  ]) {
    const run = guard([{}], { lane: true, ...options });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, new RegExp(`^ci-kit: the mini could not keep the guest out for a measured job \\(${why.source}\\) — rerun\\n$`));
    assert.match(run.stderr.trim(), refusalShape);
    assert.deepEqual(run.readAt, []);
    assert.deepEqual(run.claims, []);
  }
});

test('without the VM lane, a reservation changes nothing and settle writes nothing new', () => {
  const run = guard([{ reserved: true }], { underWorker: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `ci-kit settle: settled in 30 s; start: ${posture()}; release: ${posture()}\n`);
  assert.deepEqual(run.claims, []);
  assert.equal(run.locked, false);
});
