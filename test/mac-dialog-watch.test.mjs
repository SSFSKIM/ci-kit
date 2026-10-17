import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { constants, copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { T0, asnShape, desktop, iso, minute, runnerAgent, terminal } from './fake-mac-desktop.mjs';

// The dialog watcher (mac/hooks/dialog-watch.sh) on a faked desktop (fake-mac-desktop.mjs). Each `watch` is one run of
// the LaunchAgent, a minute after the run before unless told `at` (seconds after T0); `hook` is a job's start.
const macOnly = { skip: process.platform !== 'darwin' };
const hooks = fileURLToPath(new URL('../mac/hooks/', import.meta.url));
const uid = String(process.getuid());
const alertURL = 'https://github.com/SSFSKIM/ci-kit-sandbox/issues/42';
const argValue = (call, flag) => call[call.indexOf(flag) + 1];
const creates = (run) => run.ghCalls.filter((call) => call[1] === 'create');
const security = asnShape('SecurityAgent', 'com.apple.SecurityAgent', 4711);
const notification = asnShape('UserNotificationCenter', 'com.apple.UserNotificationCenter', 4712);
const keychainRequest = '2026-10-17 05:12:01.000 Df security[101:201] [com.apple.security] SecKeychainCopyMatching: client request';
const clearReads = (run, n = 3) => { for (let i = 0; i < n; i++) run = run.watch(terminal); return run; };
const opened = (options) => { const d = desktop(options); d.watch(security, { at: 0 }); return d.watch(security, { at: 60 }); };

test('a quiet desktop costs the frontmost read and nothing else', () => {
  const run = desktop().watch(terminal);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.log, '');
  assert.equal(run.stateText, null);
  for (const calls of [run.ghCalls, run.logCalls, run.launchctl, run.python]) assert.deepEqual(calls, []);
});

test('one read of a dialog is not an episode; the next read that still sees it opens one, from the first read', () => {
  const d = desktop({ logOutput: keychainRequest });
  const first = d.watch(security, { at: 0 });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual([first.state.phase, first.state.name, first.state.since], ['pending', 'SecurityAgent', iso(T0)]);
  assert.deepEqual(first.ghCalls, []);
  assert.deepEqual(first.logCalls, [], 'no attribution for a single read');
  const gone = d.watch(terminal, { at: 60 });
  assert.equal(gone.stateText, null, 'a dialog dismissed within the minute opens nothing');
  assert.deepEqual(gone.ghCalls, []);
  d.watch(security, { at: 120 });
  const open = d.watch(security, { at: 180 });
  assert.deepEqual([open.state.phase, open.state.since, open.state.issue], ['open', iso(T0 + 120), alertURL]);
  assert.equal(creates(open).length, 1);
  const [create] = creates(open);
  assert.equal(argValue(create, '--title'), `ci-kit alert: mini: SecurityAgent since ${minute(T0 + 120)} (security request from security)`);
  const body = argValue(create, '--body');
  for (const line of [`First seen: ${iso(T0 + 120)}`, 'Opened by: the dialog watcher (two reads in a row)', `Source line: ${keychainRequest}`, 'Run id: -']) {
    assert.ok(body.includes(`${line}\n`), line);
  }
  assert.match(open.log, /dialog-watch run=- job=- frontmost is SecurityAgent since .*; the episode opens/);
});

test('reads more than 150 s apart are not consecutive, and another dialog starts over', () => {
  const d = desktop();
  d.watch(security, { at: 0 });
  const late = d.watch(security, { at: 151 });
  assert.deepEqual([late.state.phase, late.state.since], ['pending', iso(T0 + 151)]);
  const other = d.watch(notification, { at: 200 });
  assert.deepEqual([other.state.phase, other.state.name, other.state.since], ['pending', 'UserNotificationCenter', iso(T0 + 200)]);
  const open = d.watch(notification, { at: 260 });
  assert.deepEqual([open.state.phase, open.state.since], ['open', iso(T0 + 200)]);
  assert.equal(creates(open).length, 1);
});

test('the source is read once, when the episode opens, not every minute', () => {
  let run = opened({ logOutput: keychainRequest });
  const reads = run.logCalls.length;
  assert.ok(reads > 0);
  for (let i = 0; i < 5; i++) run = run.watch(security);
  assert.equal(run.logCalls.length, reads);
  assert.equal(creates(run).length, 1);
  assert.equal(run.state.source, 'security request from security');
});

test('three consecutive reads without a dialog close the episode; a dialog between them restarts the count', () => {
  let run = clearReads(opened(), 2);
  assert.deepEqual([run.state.phase, run.state.clear], ['open', '2']);
  assert.equal(run.ghCalls.length, 1, 'not closed on two');
  run = run.watch(security);
  assert.deepEqual([run.state.phase, run.state.clear], ['open', '0']);
  assert.match(run.log, /the dialog is back; the count of clear reads restarts/);
  run = clearReads(run, 2);
  assert.equal(run.state.phase, 'open');
  const firstClear = run.state.clear_since;
  run = run.watch(terminal);
  assert.equal(run.stateText, null);
  assert.deepEqual(run.ghCalls.map((call) => call.slice(1, 3)), [['create', '--repo'], ['comment', alertURL], ['close', alertURL]]);
  assert.equal(argValue(run.ghCalls[1], '--body'), `cleared at ${iso(T0 + 60 * 7)}: no dialog in front on 3 reads in a row since ${firstClear}`);
  assert.match(run.log, /no dialog on 3 reads in a row; the episode of SecurityAgent since .* closes/);
});

test('clear reads more than 150 s apart start the count over', () => {
  const d = desktop();
  d.watch(security, { at: 0 });
  d.watch(security, { at: 60 });
  d.watch(terminal, { at: 120 });
  d.watch(terminal, { at: 180 });
  const late = d.watch(terminal, { at: 400 });
  assert.deepEqual([late.state.phase, late.state.clear, late.state.clear_since], ['open', '1', iso(T0 + 400)]);
});

test('an unreadable frontmost app changes nothing', () => {
  const d = desktop({ status: 3 });
  const run = d.watch('', { at: 0 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stateText, null);
  assert.match(run.log, /dialog-watch .*could not read the frontmost app; nothing changes/);
});

test('the job hook and the watcher share one episode: one issue, one first-seen time, from either side', () => {
  // The watcher's first read, then a job: the job opens the episode at once, at the watcher's time.
  const d = desktop({ workers: 'busy' });
  d.watch(security, { at: 0 });
  const job = d.hook(security, { at: 20 });
  assert.equal(job.status, 1);
  assert.ok(job.stderr.includes(`holds focus on the mini since ${minute(T0)} — dismiss it there and rerun`), job.stderr);
  assert.deepEqual([job.state.phase, job.state.since], ['open', iso(T0)]);
  assert.match(argValue(creates(job)[0], '--body'), /Opened by: a refused job \(run 123456\)\n/);
  const watched = d.watch(security, { at: 60 });
  assert.equal(creates(watched).length, 1, 'the watcher adds no second issue');
  // A job first: the watcher follows the hook's episode and closes it.
  const first = desktop();
  const refused = first.hook(security, { at: 0 });
  assert.equal(creates(refused).length, 1);
  const closed = clearReads(first.watch(security, { at: 30 }));
  assert.equal(closed.stateText, null);
  assert.deepEqual(closed.ghCalls.map((call) => call[1]), ['create', 'comment', 'close']);
});

test("a job's clear read drops the watcher's pending read, and its dialog read restarts the clear count", () => {
  const d = desktop();
  d.watch(security, { at: 0 });
  const passed = d.hook(terminal, { at: 20 });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stateText, null);
  assert.deepEqual([d.watch(security, { at: 60 }).state.phase], ['pending'], 'not consecutive with the read before the job');
  const open = d.watch(security, { at: 120 });
  assert.equal(open.state.phase, 'open');
  const twoClear = clearReads(open, 2);
  assert.equal(twoClear.state.clear, '2');
  const refused = twoClear.again(security, { at: 60 * 4 + 10 });
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes(`since ${minute(T0 + 60)}`));
  assert.equal(refused.state.clear, '0');
  assert.equal(refused.logCalls.length, open.logCalls.length, "the job reuses the episode's source");
  assert.equal(clearReads(refused, 2).state.phase, 'open');
});

test('the watcher skips its read while the job hook holds the episode', () => {
  const d = desktop();
  const release = d.holdLock();
  try {
    const run = d.watch(security, { at: 0 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stateText, null);
    assert.match(run.log, /the job hook holds the dialog state; this read is skipped/);
  } finally {
    release();
  }
});

// MAWS's pre-check reads open alerts with this pattern; an older alert of another kind must never match it.
const contract = /^ci-kit alert: ([a-z0-9-]+): (\S+) since (\S+)/;
const dialogs = [
  ['UserNotificationCenter', 'com.apple.UserNotificationCenter'],
  ['CoreServicesUIAgent', 'com.apple.coreservices.uiagent'],
  ['SecurityAgent', 'com.apple.SecurityAgent'],
  ['loginwindow', 'com.apple.loginwindow'],
];

test('the alert title is the contract: the machine, the canonical dialog name whatever the display language, the minute', () => {
  for (const [canonical, bundle] of dialogs) {
    // A localized display name, with spaces, still yields the canonical token.
    const d = desktop({ env: { CI_KIT_MACHINE: 'rental-2' } });
    const job = d.hook(asnShape(`시스템 ${canonical} 대화 상자`, bundle), { at: 0 });
    assert.equal(job.status, 1);
    const title = argValue(creates(job)[0], '--title');
    assert.equal(title, `ci-kit alert: rental-2: ${canonical} since ${minute(T0)}`);
    const [, machine, dialog, since] = title.match(contract);
    assert.deepEqual([machine, dialog, since], ['rental-2', canonical, minute(T0)]);
    assert.match(since, /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
    assert.deepEqual(job.stderr.split('\n').filter(Boolean), [
      `ci-kit: a system dialog (${canonical}: source unknown) holds focus on the rental-2 since ${minute(T0)} — dismiss it there and rerun`,
    ]);
    assert.match(job.stderr.trim(), /^ci-kit: .*rerun$/, "MAWS's ci-gate.sh tells a refused job by this shape");
  }
  const sourced = opened({ logOutput: keychainRequest });
  const title = argValue(creates(sourced)[0], '--title');
  assert.equal(title, `ci-kit alert: mini: SecurityAgent since ${minute(T0)} (security request from security)`);
  assert.deepEqual(title.match(contract).slice(1), ['mini', 'SecurityAgent', minute(T0)]);
  for (const older of [
    'ci-kit alert: system dialog on the mini (loginwindow: source unknown)',
    'ci-kit alert: pool hours on 2026-10-17 above 8',
    'ci-kit alert: pool server 123 up more than 12 h',
    'ci-kit alert: pool server 123 deleted, heartbeat stale',
    'ci-kit alert: pool server 123 is a smaller cpx31 (core limit)',
    'ci-kit alert: bake builder 77 left behind',
    'ci-kit alert: the bake could not create its builder',
    'ci-kit alert: SSFSKIM/MAWS is in both gce.json and pool.json',
    'ci-kit alert: GCE VM ci-kit-gce-0a1b2c3d4e outlived its run limit',
  ]) assert.doesNotMatch(older, contract);
});

test('an app that only shares a name or a bundle prefix is not a dialog', () => {
  for (const front of [asnShape('loginwindowhelper', 'com.apple.loginwindowhelper'), asnShape('Security Agent', 'com.example.SecurityAgent')]) {
    const run = desktop().watch(front);
    assert.equal(run.stateText, null);
  }
});

// The drain.
const disable = `disable gui/${uid}/${runnerAgent}`;
const bootout = `bootout gui/${uid}/${runnerAgent}`;
const starts = (run) => run.launchctl.filter((call) => /^(enable|bootstrap) /.test(call));

test('while an episode is open and no job runs, the runner is stopped, disabled, marked, and the stop logged', () => {
  const d = desktop();
  const pending = d.watch(security, { at: 0 });
  assert.deepEqual(pending.runner, { loaded: true, disabled: false }, 'a single read drains nothing');
  assert.deepEqual(pending.python, []);
  const run = d.watch(security, { at: 60 });
  assert.deepEqual(run.runner, { loaded: false, disabled: true });
  assert.deepEqual(run.launchctl.filter((call) => call === disable || call === bootout), [disable, bootout]);
  assert.equal(run.marker, `stopped at ${iso(T0 + 60)}: SecurityAgent since ${iso(T0)}\n`);
  assert.deepEqual(run.python, [`-I ${hooks}runner-worker.py ${d.dir}/actions-runner-maws/bin/Runner.Worker`]);
  assert.match(run.log, new RegExp(`dialog-watch .*drain: stopped ${runnerAgent}: SecurityAgent in front since ${iso(T0)}, no job running`));
  const later = run.watch(security);
  assert.equal(later.launchctl.filter((call) => call === bootout).length, 1, 'a stopped runner is not stopped again');
});

test('a running job, or a process table that cannot be read, leaves the runner running', () => {
  for (const [workers, why] of [['busy', /a job is running \(busy 4242\)/], ['fail', /could not tell whether a job is running: failed \(2\)/], ['garbage', /could not tell whether a job is running: failed \(1\)/], ['hang', /could not tell whether a job is running: failed \(124\)/]]) {
    const run = opened({ workers });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.runner, { loaded: true, disabled: false }, workers);
    assert.equal(run.marker, null);
    assert.match(run.log, why);
    assert.match(run.log, new RegExp(`${runnerAgent} left running`));
    assert.deepEqual(run.ghSurvivors, []);
    if (workers === 'hang') assert.ok(run.elapsed < 25_000, `the process-table read has a deadline (${run.elapsed} ms)`);
  }
  // When the job ends, the next read stops the runner.
  const d = desktop({ workers: 'busy' });
  d.watch(security, { at: 0 });
  d.watch(security, { at: 60 });
  d.workers('idle');
  assert.deepEqual(d.watch(security, { at: 120 }).runner, { loaded: false, disabled: true });
});

test('the runner comes back only after the third clear read, and only because the watcher stopped it', () => {
  let run = clearReads(opened(), 2);
  assert.deepEqual(run.runner, { loaded: false, disabled: true }, 'not started on two clear reads');
  assert.deepEqual(starts(run), []);
  run = run.watch(terminal);
  assert.deepEqual(run.runner, { loaded: true, disabled: false });
  assert.deepEqual(starts(run), [`enable gui/${uid}/${runnerAgent}`, `bootstrap gui/${uid} ${run.desktop.dir}/Library/LaunchAgents/${runnerAgent}.plist`]);
  assert.equal(run.marker, null);
  assert.match(run.log, new RegExp(`drain: started ${runnerAgent}: the episode closed`));
});

test('a runner disabled by an operator is never stopped or started by the watcher', () => {
  for (const runner of ['disabled', 'loaded-disabled']) {
    const run = clearReads(opened({ runner }));
    assert.equal(run.stateText, null, 'the episode opened and closed');
    assert.deepEqual(run.runner, { loaded: runner === 'loaded-disabled', disabled: true }, runner);
    assert.deepEqual(run.launchctl.filter((call) => !/^print/.test(call)), [], runner);
    assert.equal(run.marker, null);
  }
  // Disabled while drained: the doc's disable removes the marker, and the runner stays off.
  const drained = opened();
  unlinkSync(join(drained.desktop.dir, 'Library/Logs/ci-kit/runner-drained'));
  const run = clearReads(drained);
  assert.deepEqual(run.runner, { loaded: false, disabled: true });
  assert.deepEqual(starts(run), []);
  // An unreadable disabled list is not taken for "enabled".
  const unknown = opened({ env: { FAKE_LISTING_FAIL: '1' } });
  assert.deepEqual(unknown.runner, { loaded: true, disabled: false });
});

test('a reboot during the episode does not bring the runner back; started by hand, it is stopped again', () => {
  const run = opened();
  run.desktop.reboot();
  let after = run.watch(security);
  assert.deepEqual(after.runner, { loaded: false, disabled: true }, 'launchd loads no disabled agent at login');
  assert.notEqual(after.marker, null);
  run.desktop.startByHand();
  after = after.watch(security);
  assert.deepEqual(after.runner, { loaded: false, disabled: true });
  assert.equal(after.launchctl.filter((call) => call === bootout).length, 2);
  assert.deepEqual(clearReads(after).runner, { loaded: true, disabled: false });
});

test('a start that fails keeps the marker and is retried at the next read', () => {
  const twoClear = clearReads(opened(), 2);
  const failed = twoClear.watch(terminal, { extraEnv: { FAKE_BOOTSTRAP_FAIL: '1' } });
  assert.equal(failed.stateText, null);
  assert.notEqual(failed.marker, null);
  assert.match(failed.log, /drain: starting .* failed or timed out; retrying at the next read/);
  const retried = failed.watch(terminal);
  assert.deepEqual(retried.runner, { loaded: true, disabled: false });
  assert.equal(retried.marker, null);
});

test('a single dialog read stops nothing, and holds back a restart that is still due', () => {
  const pending = clearReads(opened()).watch(security);
  assert.equal(pending.state.phase, 'pending');
  assert.deepEqual(pending.runner, { loaded: true, disabled: false }, 'a pending read drains nothing');
  // A restart that failed when the episode closed waits while a new dialog is pending.
  const failed = clearReads(opened(), 2).watch(terminal, { extraEnv: { FAKE_BOOTSTRAP_FAIL: '1' } });
  const held = failed.watch(security);
  assert.deepEqual([held.state.phase, held.runner.loaded], ['pending', false]);
  assert.notEqual(held.marker, null);
  assert.deepEqual(held.watch(terminal).runner, { loaded: true, disabled: false });
});

test('every launchctl call of the drain has a deadline', () => {
  const d = desktop();
  d.watch(security, { at: 0 });
  const run = d.watch(security, { at: 60, extraEnv: { FAKE_LAUNCHCTL_HANG: 'bootout' } });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.elapsed < 25_000, `bootout is cut off (${run.elapsed} ms)`);
  assert.deepEqual(run.ghSurvivors, []);
  assert.match(run.log, /drain: stopping .* failed or timed out; retrying at the next read/);
  const print = d.watch(security, { at: 120, extraEnv: { FAKE_LAUNCHCTL_HANG: 'print' } });
  assert.ok(print.elapsed < 25_000, `print is cut off (${print.elapsed} ms)`);
  assert.deepEqual(print.ghSurvivors, []);
});

test('a hung frontmost read, log query or gh call is cut off and the run still ends', () => {
  const front = desktop().watch(terminal, { extraEnv: { FAKE_FRONT_HANG: '1' } });
  assert.equal(front.status, 0, front.stderr);
  assert.ok(front.elapsed < 20_000, `both lsappinfo calls have 5 s deadlines (${front.elapsed} ms)`);
  assert.deepEqual(front.ghSurvivors, []);
  assert.match(front.log, /could not read the frontmost app/);
  const slow = desktop({ logHang: true, ghHang: true });
  slow.watch(security, { at: 0 });
  const open = slow.watch(security, { at: 60 });
  assert.equal(open.status, 0, open.stderr);
  assert.ok(open.elapsed < 35_000, `attribution and gh are cut off (${open.elapsed} ms)`);
  assert.deepEqual(open.ghSurvivors, []);
  assert.deepEqual([open.state.phase, open.state.source, open.state.issue], ['open', 'source unknown', '']);
  assert.match(open.log, /dialog alert issue creation failed or timed out; episode remembered/);
  assert.equal(creates(slow.watch(security)).length, 1, 'a failed creation is not retried');
});

test('runner-worker.py tells a job by the executable path alone, not a command line, argv[0] or working directory', macOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-kit-worker-'));
  const worker = join(dir, 'actions-runner-maws/bin/Runner.Worker');
  mkdirSync(dirname(worker), { recursive: true });
  copyFileSync(process.execPath, worker, constants.COPYFILE_FICLONE); // a Node of our own at the worker's path
  const sleeping = ['-e', 'setTimeout(() => {}, 30_000)'];
  const processes = [
    spawn(process.execPath, [...sleeping, worker]),
    spawn(process.execPath, sleeping, { argv0: worker }),
    spawn(process.execPath, sleeping, { cwd: dirname(worker) }),
  ];
  const read = () => spawnSync('python3', ['-I', join(hooks, 'runner-worker.py'), worker], { encoding: 'utf8' });
  try {
    await Promise.all(processes.map((child) => once(child, 'spawn')));
    assert.deepEqual([read().stdout, read().status], ['idle\n', 0], 'decoys only');
    const job = spawn(worker, sleeping);
    processes.push(job);
    await once(job, 'spawn');
    assert.equal(read().stdout, `busy ${job.pid}\n`);
    job.kill('SIGKILL');
    await once(job, 'exit');
    assert.equal(read().stdout, 'idle\n');
  } finally {
    for (const child of processes) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
