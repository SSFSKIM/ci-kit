import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
let root;
before(() => { root = mkdtempSync(join(tmpdir(), 'ci-kit-settle-')); });
after(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse('2026-10-19T05:12:34Z') / 1000;
const idle = '    1 launchd\n  410 Terminal\n  512 cursor-park\n  520 node\n  540 SSMenuAgent\n';
const quiet = { load: '1.52', display: '2560x1440@2x', processes: idle };
const connected = '[I 2026-10-19 05:00:04] user#123 connected.\n';

// hooks: where the runner's hook set is installed, the only place the compiled display helper lives (false: nowhere);
// variable: whether the runner's .env names it in ACTIONS_RUNNER_HOOK_JOB_STARTED, as mac/install.sh writes it.
function guard(world, { inputs = {}, hooks = 'actions-runner-maws/ci-kit/hooks', variable = true, env = {}, readSeconds = 0, logFailure = false } = {}) {
  const dir = mkdtempSync(join(root, 'job-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const executable = (path, text) => { writeFileSync(path, `#!/bin/bash\n${text}\n`); chmodSync(path, 0o755); };
  const file = (name) => join(dir, name);
  const now = (name) => `'${file(`now/${name}`)}'`;
  // Each read's desktop, written whole into world/<n>/ and copied into now/ for read 0 and by each sleep after it.
  world.forEach((entry, n) => {
    const { load, loadavg = `{ ${load} 6.00 5.00 }\n`, loadStatus = 0, display, displayStatus = 0, processes, psStatus = 0, parsec } = { ...quiet, ...entry };
    const at = file(`world/${n}`);
    mkdirSync(at, { recursive: true });
    for (const [name, value] of Object.entries({ loadavg, 'load-status': loadStatus, display, 'display-status': displayStatus, processes, 'ps-status': psStatus })) {
      writeFileSync(join(at, name), String(value));
    }
    if (parsec !== undefined) writeFileSync(join(at, 'parsec'), parsec);
  });
  const apply = `apply() {
  local n=$1 last=${world.length - 1}
  ((n <= last)) || n=$last
  rm -rf '${file('now')}' && cp -R '${file('world')}/'"$n" '${file('now')}'
  if [[ -e ${now('parsec')} ]]; then mkdir -p '${file('.parsec')}' && cp ${now('parsec')} '${file('.parsec/log.txt')}'; else rm -f '${file('.parsec/log.txt')}'; fi
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
  // action.yml's one step: its env with the inputs (or their defaults) substituted, and its run line, as the runner runs it.
  const [only] = step.runs.steps;
  const stepEnv = Object.fromEntries(Object.entries(only.env).map(([name, value]) =>
    [name, value.replace(/\$\{\{ inputs\.([a-z]+) \}\}/, (_, input) => String(inputs[input] ?? step.inputs[input].default))]));
  const started = Date.now();
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', only.run], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      HOME: dir, PATH: `${bin}:/usr/bin:/bin`, GITHUB_ACTION_PATH: action, GITHUB_RUN_ID: '123456', GITHUB_JOB: 'e2e',
      ...(variable && hooks ? { ACTIONS_RUNNER_HOOK_JOB_STARTED: file(`${hooks}/job-started.sh`) } : {}), PERL5LIB: perlLib, PERL5OPT: '-MFixtureClock',
      ...stepEnv, ...env,
    },
  });
  const text = (name) => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '';
  return {
    ...result,
    elapsed: Date.now() - started,
    sleeps: text('sleeps').split('\n').filter(Boolean).map(Number),
    readAt: text('read-at').split('\n').filter(Boolean).map(Number),
    log: logFailure ? '' : text('Library/Logs/ci-kit/mac-runner-hooks.log'),
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
