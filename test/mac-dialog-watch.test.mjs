import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
  const d = desktop({ runner: 'busy' });
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

test('another dialog during an open episode keeps the episode and reads no second source', () => {
  const d = desktop({ logOutput: keychainRequest });
  const first = d.hook(security, { at: 0 });
  const reads = first.logCalls.length;
  let run = first;
  for (let i = 0; i < 3; i++) run = run.again(notification);
  assert.equal(run.logCalls.length, reads, 'attribution runs once per episode');
  assert.equal(creates(run).length, 1);
  assert.ok(run.stderr.includes(`(UserNotificationCenter: source unknown) holds focus on the mini since ${minute(T0)}`), run.stderr);
  assert.equal(run.again(security).stderr.includes('(SecurityAgent: security request from security)'), true);
});

test('a state file from before the watcher, the issue URL alone, is adopted as the open episode and closed in turn', () => {
  const legacy = (d) => {
    mkdirSync(join(d.dir, 'Library/Logs/ci-kit'), { recursive: true });
    writeFileSync(join(d.dir, 'Library/Logs/ci-kit/dialog-alert.state'), `${alertURL}\n`);
    return d;
  };
  const d = legacy(desktop());
  const still = d.watch(security, { at: 0 });
  assert.equal(creates(still).length, 0, 'no second issue for the same episode');
  assert.deepEqual([still.state.phase, still.state.issue, still.state.name], ['open', alertURL, 'SecurityAgent']);
  assert.match(still.state.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, 'first seen when the old hook wrote it');
  const closed = clearReads(still);
  assert.equal(closed.stateText, null);
  assert.deepEqual(closed.ghCalls.map((call) => call.slice(1, 3)), [['comment', alertURL], ['close', alertURL]]);
  const job = legacy(desktop()).hook(security, { at: 0 });
  assert.equal(job.status, 1);
  assert.equal(creates(job).length, 0);
  assert.match(job.stderr, /since \d{4}-\d\d-\d\dT\d\d:\d\dZ — dismiss it there and rerun$/m);
  const cleared = legacy(desktop()).watch(terminal, { at: 0 });
  assert.equal(cleared.state.phase, 'open', 'a clear read counts towards closing it, it does not drop it');
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

// The drain. The marker holds the runner (runner-hold.sh waits on it); SIGTERM stops an idle one.
const marker = (run) => join(run.desktop.dir, 'Library/Logs/ci-kit/runner-drained');
const kill = `kill SIGTERM gui/${uid}/${runnerAgent}`;

test('while an episode is open the runner is held, an idle runner is stopped, and both are logged', () => {
  const d = desktop();
  const pending = d.watch(security, { at: 0 });
  assert.equal(pending.marker, null, 'a single read holds nothing');
  assert.deepEqual(pending.python, []);
  const run = d.watch(security, { at: 60 });
  assert.equal(run.marker, `held at ${iso(T0 + 60)}: SecurityAgent since ${iso(T0)}\n`);
  assert.deepEqual(run.launchctl, [kill], 'never load, unload, enable or disable');
  assert.equal(run.runner, 'stopped');
  assert.deepEqual(run.python, [`-I ${hooks}runner-state.py ${d.dir}/actions-runner-maws`]);
  assert.match(run.log, new RegExp(`dialog-watch .*drain: holding the runner while SecurityAgent holds the front \\(since ${iso(T0)}\\)`));
  assert.match(run.log, /drain: stopped the runner \(no job running\); it waits for the episode to close/);
  const later = run.watch(security);
  assert.deepEqual(later.launchctl, [kill], 'a stopped runner is not signalled again');
});

test('a running job, or a runner state that cannot be read, is left running', () => {
  for (const [runner, why] of [['busy', /a job is running \(busy 4242\); the runner stops once it is idle/], ['fail', /could not tell whether a job is running: failed \(2\)/], ['garbage', /could not tell whether a job is running: failed \(1\)/], ['hang', /could not tell whether a job is running: failed \(124\)/]]) {
    const run = opened({ runner });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.launchctl, [], runner);
    assert.notEqual(run.marker, null, 'still held: the runner waits once it stops');
    assert.match(run.log, why);
    assert.deepEqual(run.ghSurvivors, []);
    if (runner === 'hang') assert.ok(run.elapsed < 25_000, `the runner-state read has a deadline (${run.elapsed} ms)`);
  }
  // When the job ends, the next read stops the runner.
  const d = desktop({ runner: 'busy' });
  d.watch(security, { at: 0 });
  d.watch(security, { at: 60 });
  d.runner('idle');
  const idle = d.watch(security, { at: 120 });
  assert.deepEqual([idle.launchctl, idle.runner], [[kill], 'stopped']);
});

test('the hold is released only after the third clear read', () => {
  let run = clearReads(opened(), 2);
  assert.notEqual(run.marker, null, 'still held on two clear reads');
  run = run.watch(terminal);
  assert.equal(run.stateText, null);
  assert.equal(run.marker, null);
  assert.match(run.log, /drain: released the runner: the episode closed/);
  assert.deepEqual(run.launchctl, [kill], 'the wrapper starts the runner; the watcher calls nothing');
  // A single dialog read after that holds nothing.
  const pending = run.watch(security);
  assert.equal(pending.state.phase, 'pending');
  assert.equal(pending.marker, null);
});

test('a hold that could not be released stays until no episode is pending or open', () => {
  const d = desktop({ runner: 'stopped' });
  mkdirSync(join(d.dir, 'Library/Logs/ci-kit'), { recursive: true });
  // A marker left from before, with a dialog pending: kept; with nothing pending: released.
  const held = d.watch(security, { at: 0 });
  writeFileSync(marker(held), 'held at …\n');
  const kept = d.watch(security, { at: 400 });
  assert.deepEqual([kept.state.phase, kept.marker === null], ['pending', false], 'kept while a dialog is pending');
  const released = d.watch(terminal, { at: 460 });
  assert.equal(released.stateText, null);
  assert.equal(released.marker, null);
});

test('a release happens under the episode lock: an episode a job hook publishes meanwhile keeps its hold', () => {
  const d = desktop();
  const logs = join(d.dir, 'Library/Logs/ci-kit');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'runner-drained'), 'held at 2026-10-17T05:10:00Z: SecurityAgent since 2026-10-17T05:09:00Z\n');
  // A job hook holds the lock, about to publish an episode: the state the watcher could read still has none.
  const release = d.holdLock();
  try {
    const raced = d.watch(terminal, { at: 0 });
    assert.notEqual(raced.marker, null, 'no release while the hook holds the lock');
    assert.match(raced.log, /the job hook holds the dialog state; this read is skipped/);
    writeFileSync(join(logs, 'dialog-alert.state'),
      `phase=open\nname=SecurityAgent\nsince=${iso(T0)}\nat=${T0}\nsource=source unknown\nissue=${alertURL}\nclear=0\nclear_since=\n`);
  } finally {
    release();
  }
  const next = d.watch(security, { at: 60 });
  assert.deepEqual([next.state.phase, next.marker === null], ['open', false], "the new episode's hold stands");
  assert.deepEqual(next.launchctl, [kill]);
  assert.equal(creates(next).length, 0, "the hook's episode, not a second one");
});

test('the SIGTERM has a deadline, and a failed one is retried at the next read', () => {
  const d = desktop();
  d.watch(security, { at: 0 });
  const run = d.watch(security, { at: 60, extraEnv: { FAKE_LAUNCHCTL_HANG: 'kill' } });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.elapsed < 25_000, `launchctl kill is cut off (${run.elapsed} ms)`);
  assert.deepEqual(run.ghSurvivors, []);
  assert.match(run.log, /drain: SIGTERM to .* failed or timed out; retrying at the next read/);
  const retried = d.watch(security, { at: 120 });
  assert.equal(retried.runner, 'stopped');
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

// The runner's program and runner-state.py, against real processes.
const hold = join(hooks, 'runner-hold.sh');

test('runner-hold.sh waits while the marker exists, after a reboot as after a stop, and starts the runner once it is gone', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ci-kit-hold-'));
  const runner = join(home, 'actions-runner-maws');
  mkdirSync(runner, { recursive: true });
  mkdirSync(join(home, 'Library/Logs/ci-kit'), { recursive: true });
  const markerFile = join(home, 'Library/Logs/ci-kit/runner-drained');
  writeFileSync(markerFile, 'held at 2026-10-17T05:13:34Z: SecurityAgent since 2026-10-17T05:12:34Z\n');
  writeFileSync(join(runner, 'runsvc.sh'), `#!/bin/bash\necho "runsvc $PWD" > '${join(home, 'started')}'\n`);
  chmodSync(join(runner, 'runsvc.sh'), 0o755);
  const child = spawn('/bin/bash', [hold], { cwd: runner, env: { HOME: home, PATH: '/usr/bin:/bin', CI_KIT_HOLD_POLL: '0.2' } });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(existsSync(join(home, 'started')), false, 'held: runsvc.sh does not start');
    assert.match(output, /runner-hold: held by the dialog watcher \(held at .*SecurityAgent.*\); waiting/);
    unlinkSync(markerFile);
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(readFileSync(join(home, 'started'), 'utf8'), `runsvc ${realpathSync(runner)}\n`);
    assert.match(output, /runner-hold: released; starting the runner/);
  } finally {
    child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
  // Without a marker, or without its directory, it starts at once, and says nothing.
  const free = mkdtempSync(join(tmpdir(), 'ci-kit-hold-'));
  writeFileSync(join(free, 'runsvc.sh'), '#!/bin/bash\necho runsvc\n');
  chmodSync(join(free, 'runsvc.sh'), 0o755);
  const started = spawnSync('/bin/bash', [hold], { cwd: free, env: { HOME: free, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(started.stdout, 'runsvc\n');
  rmSync(free, { recursive: true, force: true });
});

test('runner-hold.sh holds while the marker cannot be looked up, says why, and starts only once the marker is absent', { skip: process.getuid?.() === 0 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ci-kit-hold-'));
  const logs = join(home, 'Library/Logs/ci-kit');
  mkdirSync(logs, { recursive: true });
  const markerFile = join(logs, 'runner-drained');
  writeFileSync(markerFile, 'held at 2026-10-17T05:13:34Z: SecurityAgent since 2026-10-17T05:12:34Z\n');
  writeFileSync(join(home, 'runsvc.sh'), `#!/bin/bash\necho runsvc > '${join(home, 'started')}'\n`);
  chmodSync(join(home, 'runsvc.sh'), 0o755);
  chmodSync(logs, 0o600); // not searchable: the marker is there, and cannot be looked up
  const child = spawn('/bin/bash', [hold], { cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin', CI_KIT_HOLD_POLL: '0.1' } });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const until = async (pattern) => {
    for (let waited = 0; !pattern.test(output); waited += 50) {
      assert.ok(waited < 10_000, `waiting for ${pattern}: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    await until(/cannot tell whether the dialog watcher holds it \(.*runner-drained: Permission denied\), so held as if it does; waiting/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(existsSync(join(home, 'started')), false, 'held: runsvc.sh does not start');
    chmodSync(logs, 0o700);
    await until(/runner-hold: held by the dialog watcher \(held at .*\); waiting/);
    assert.equal(existsSync(join(home, 'started')), false);
    unlinkSync(markerFile);
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(readFileSync(join(home, 'started'), 'utf8'), 'runsvc\n');
    assert.equal(output.match(/; waiting$/gm).length, 2, 'each reason is logged once');
  } finally {
    child.kill('SIGKILL');
    chmodSync(logs, 0o700);
    rmSync(home, { recursive: true, force: true });
  }
});

test('runner-state.py reads the kernel\'s executable paths: decoys never count, and an unreadable worker is busy', macOnly, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ci-kit-runner-')));
  const runner = join(dir, 'actions-runner-maws');
  const bin = join(runner, 'bin');
  mkdirSync(bin, { recursive: true });
  // Node copies of our own at the worker's and the listener's paths (a clone: instant on APFS).
  const copy = (path) => { mkdirSync(dirname(path), { recursive: true }); copyFileSync(process.execPath, path, constants.COPYFILE_FICLONE); return path; };
  const worker = copy(join(bin, 'Runner.Worker'));
  const listener = copy(join(bin, 'Runner.Listener'));
  const sleeping = ['-e', 'setTimeout(() => {}, 30_000)'];
  const children = [];
  const start = async (file, args = sleeping, options = {}) => {
    const child = spawn(file, args, options);
    children.push(child);
    await once(child, 'spawn');
    return child;
  };
  // A process that says it runs has exec'd: a read cannot see its parent's image instead.
  const running = async (file) => {
    const child = await start(file, ['-e', "console.log('running'); setTimeout(() => {}, 30_000)"]);
    await once(child.stdout, 'data');
    return child;
  };
  const read = (path = runner) => spawnSync('python3', ['-I', join(hooks, 'runner-state.py'), path], { encoding: 'utf8' });
  try {
    // A command line, argv[0] or working directory naming the worker is not the worker.
    await start(process.execPath, [...sleeping, worker]);
    await start(process.execPath, sleeping, { argv0: worker });
    await start(process.execPath, sleeping, { cwd: bin });
    assert.deepEqual([read().stdout, read().status], ['stopped\n', 0]);
    await running(listener);
    assert.equal(read().stdout, 'idle\n');
    const job = await running(worker);
    assert.equal(read().stdout, `busy ${job.pid}\n`);
    job.kill('SIGKILL');
    await once(job, 'exit');
    assert.equal(read().stdout, 'idle\n');
    // A runner that updated itself: bin is a symlink to bin.<version>, and the kernel reports the resolved path.
    const updated = join(dir, 'updated');
    const versioned = join(updated, 'bin.2.339.0');
    copy(join(versioned, 'Runner.Worker'));
    symlinkSync(versioned, join(updated, 'bin'));
    const updatedJob = await running(join(updated, 'bin', 'Runner.Worker'));
    assert.equal(read(updated).stdout, `busy ${updatedJob.pid}\n`);
    // A worker whose file is gone (its path unreadable) still counts, by the name the kernel keeps; another such
    // process does not.
    const gone = await running(copy(join(dir, 'elsewhere/Runner.Worker')));
    const other = await running(copy(join(dir, 'elsewhere/other-tool')));
    unlinkSync(join(dir, 'elsewhere/Runner.Worker'));
    unlinkSync(join(dir, 'elsewhere/other-tool'));
    assert.equal(read().stdout, `busy ${gone.pid}\n`, `${other.pid} is not a worker`);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
