import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

// 2026-10-20: after a reboot the episode closed before the network was up. Its clear comment and its close failed,
// nothing tried them again, and the open alert held every Mac job (MAWS's ci-gate.sh) until it was closed by hand.
// owing(): an episode open since T0 whose third clear read, at T0 + 240, could not close its alert.
const owing = (options) => clearReads(opened(options), 2).watch(terminal, { ghExit: 1 });

test('an alert whose close fails stays owed and is tried at each read until it goes through; the hold goes at once, and jobs pass', () => {
  const failed = owing();
  const cleared = iso(T0 + 240);
  assert.equal(failed.status, 0, failed.stderr);
  assert.deepEqual([failed.state.phase, failed.state.issue, failed.state.cleared, failed.state.commented], ['closed', alertURL, cleared, '']);
  assert.match(failed.log, /dialog alert clear comment failed or timed out/);
  assert.match(failed.log, /dialog alert close failed or timed out; the alert stays open until a later read closes it/);
  assert.equal(failed.marker, null, 'the hold goes with the dialog, not with its alert');
  assert.match(failed.log, /drain: released the runner: the episode closed/);
  // A job meanwhile is let through and leaves the owed close as it is.
  const job = failed.again(terminal, { at: 250 });
  assert.equal(job.status, 0, job.stderr);
  assert.equal(job.state.phase, 'closed');
  assert.equal(job.ghCalls.length, 4, 'the job hook makes no gh call for it');
  // Each read tries again. One whose comment goes through and whose close does not leaves only the close owed.
  const still = job.watch(terminal, { at: 300, ghExit: 1 });
  assert.deepEqual([still.state.phase, still.ghCalls.length], ['closed', 7]);
  const half = still.watch(terminal, { ghFail: 'close' });
  assert.deepEqual([half.state.phase, half.state.commented], ['closed', iso(T0 + 360)]);
  const done = half.watch(terminal);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stateText, null);
  // A failed close also lists the open alerts, which is what MAWS reads (below).
  const tried = [['comment', alertURL], ['close', alertURL], ['list', '--repo']];
  assert.deepEqual(done.ghCalls.map((call) => call.slice(1, 3)), [['create', '--repo'], ...tried, ...tried, ...tried, ['close', alertURL]]);
  for (const call of done.ghCalls.filter((call) => call[1] === 'comment')) {
    assert.equal(argValue(call, '--body'), `cleared at ${cleared}: no dialog in front on 3 reads in a row since ${iso(T0 + 120)}`);
  }
  assert.ok(done.log.includes(`frontmost is 터미널: the alert ${alertURL} of the episode of SecurityAgent since ${iso(T0)}, which closed at ${cleared}, is closed`), done.log);
  assert.equal(done.watch(terminal).ghCalls.length, done.ghCalls.length, 'nothing is owed after it');
});

test('a dialog while an alert close is owed: the close is tried first; once it goes through the dialog is a new episode, and while it cannot the episode reopens with the alert still open', () => {
  // GitHub unreachable: the alert can be neither closed nor joined by a second one, so the open one carries the dialog.
  const back = owing().watch(notification, { ghExit: 1 });
  assert.equal(back.status, 0, back.stderr);
  assert.deepEqual([back.state.phase, back.state.issue, back.state.name, back.state.since, back.state.clear, back.state.cleared],
    ['open', alertURL, 'SecurityAgent', iso(T0), '0', '']);
  assert.ok(back.log.includes(`frontmost is UserNotificationCenter: the alert ${alertURL} of the episode of SecurityAgent since ${iso(T0)} is still open; the episode reopens with it`), back.log);
  assert.notEqual(back.marker, null, 'the runner is held again');
  const closed = clearReads(back);
  assert.equal(closed.stateText, null);
  assert.equal(creates(closed).length, 1, 'one alert for both');
  assert.deepEqual(closed.ghCalls.slice(-2).map((call) => call.slice(1, 3)), [['comment', alertURL], ['close', alertURL]]);
  // GitHub back: the old alert closes, and the dialog starts an episode of its own, with its own time and alert.
  const fresh = owing().watch(notification);
  assert.deepEqual([fresh.state.phase, fresh.state.name, fresh.state.since], ['pending', 'UserNotificationCenter', iso(T0 + 300)]);
  assert.deepEqual(fresh.ghCalls.slice(-2).map((call) => call.slice(1, 3)), [['comment', alertURL], ['close', alertURL]]);
  assert.equal(fresh.marker, null);
  const own = fresh.watch(notification);
  assert.equal(own.state.phase, 'open');
  assert.equal(creates(own).length, 2);
  assert.equal(argValue(creates(own)[1], '--title'), `ci-kit alert: mini: UserNotificationCenter since ${minute(T0 + 300)}`);
  // A refused job follows the same rule.
  const reopened = owing().again(notification, { at: 270, ghExit: 1 });
  assert.equal(reopened.status, 1);
  assert.ok(reopened.stderr.includes(`(UserNotificationCenter: source unknown) holds focus on the mini since ${minute(T0)} — dismiss`), reopened.stderr);
  assert.deepEqual([reopened.state.phase, reopened.state.issue, reopened.state.since, creates(reopened).length], ['open', alertURL, iso(T0), 1]);
  const renewed = owing().again(notification, { at: 270 });
  assert.equal(renewed.status, 1);
  assert.ok(renewed.stderr.includes(`holds focus on the mini since ${minute(T0 + 270)} — dismiss`), renewed.stderr);
  assert.deepEqual([renewed.state.phase, renewed.state.since, creates(renewed).length], ['open', iso(T0 + 270), 2]);
  assert.match(argValue(creates(renewed)[1], '--body'), /Opened by: a refused job \(run 123456\)\n/);
});

test('an owed close is settled only by a list of the open alerts, the ones MAWS reads, that goes through without it', () => {
  // Deleted by hand, say, or its label taken off: MAWS no longer sees it, and owed for ever it would also take in every
  // later dialog, which would then alert nobody.
  const gone = owing().watch(terminal, { ghUnresolved: true, ghOpen: '17' });
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(gone.stateText, null);
  const list = gone.ghCalls.at(-1);
  assert.deepEqual(list.slice(1), ['list', '--repo', 'SSFSKIM/ci-kit-sandbox', '--label', 'ci-kit-alert', '--state', 'open', '--limit', '1000', '--json', 'number', '--jq', '.[].number']);
  assert.ok(gone.log.includes(`dialog alert close failed, and ${alertURL} is not among the open alerts; nothing is left to close`), gone.log);
  const fresh = owing().watch(notification, { ghUnresolved: true, ghOpen: '' });
  assert.deepEqual([fresh.state.phase, fresh.state.name, fresh.state.since], ['pending', 'UserNotificationCenter', iso(T0 + 300)]);
  // gh cannot resolve an issue the caller cannot see either (a token whose access changed): still listed, it stays owed.
  const hidden = owing().watch(terminal, { ghUnresolved: true });
  assert.deepEqual([hidden.state.phase, hidden.state.issue], ['closed', alertURL]);
  assert.match(hidden.log, /dialog alert close failed or timed out; the alert stays open until a later read closes it/);
  // A list that fails proves nothing either.
  const unlisted = owing().watch(terminal, { ghUnresolved: true, ghOpen: '', ghFail: 'list' });
  assert.deepEqual([unlisted.state.phase, unlisted.state.issue], ['closed', alertURL]);
  const reopened = owing().watch(notification, { ghUnresolved: true, ghOpen: '', ghFail: 'list' });
  assert.deepEqual([reopened.state.phase, reopened.state.issue, creates(reopened).length], ['open', alertURL, 1]);
});

test('a state file the version before wrote still loads: its episode closes on the clear reads it has left, and a failed close is kept', () => {
  const d = desktop();
  mkdirSync(join(d.dir, 'Library/Logs/ci-kit'), { recursive: true });
  writeFileSync(join(d.dir, 'Library/Logs/ci-kit/dialog-alert.state'),
    `phase=open\nname=loginwindow\nsince=${iso(T0 - 600)}\nat=${T0}\nsource=source unknown\nissue=${alertURL}\nclear=2\nclear_since=${iso(T0 - 60)}\n`);
  const failed = d.watch(terminal, { at: 60, ghExit: 1 });
  assert.deepEqual([failed.state.phase, failed.state.name, failed.state.since, failed.state.issue, failed.state.cleared],
    ['closed', 'loginwindow', iso(T0 - 600), alertURL, iso(T0 + 60)]);
  const done = d.watch(terminal);
  assert.equal(done.stateText, null);
  const comment = done.ghCalls.filter((call) => call[1] === 'comment').at(-1);
  assert.equal(argValue(comment, '--body'), `cleared at ${iso(T0 + 60)}: no dialog in front on 3 reads in a row since ${iso(T0 - 60)}`);
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
  assert.deepEqual(run.python, Array(2).fill(`-I ${hooks}runner-state.py ${d.dir}/actions-runner-maws`), 'idle, confirmed by a second read');
  assert.match(run.log, new RegExp(`dialog-watch .*drain: holding the runner while SecurityAgent holds the front \\(since ${iso(T0)}\\)`));
  assert.match(run.log, /drain: stopped the runner \(no job running or offered on two reads 0 s apart\); it waits for the episode to close/);
  const later = run.watch(security);
  assert.deepEqual(later.launchctl, [kill], 'a stopped runner is not signalled again');
});

test('a running job, or a runner state that cannot be read, is left running', () => {
  for (const [runner, why] of [['busy', /a job is running \(busy 4242\); the runner stops when it ends/], ['fail', /could not tell whether a job is running: failed \(2\)/], ['garbage', /could not tell whether a job is running: failed \(1\)/], ['hang', /could not tell whether a job is running: failed \(124\)/]]) {
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

test('an idle read stops the runner only when a second read the gap later matches it; a job assigned between waits a tick', () => {
  // 2026-10-18T09:59:18Z: the drain read idle in the second the mini was given a job, and stopped it; the job stayed in
  // progress on an offline runner. A job just given has no worker for its first seconds, but the listener logs it.
  const idle = 'idle Runner_20261018-071539-utc.log 812345';
  const d = desktop({ runner: `${idle}\nbusy` });
  d.watch(security, { at: 0 });
  const raced = d.watch(security, { at: 60 });
  assert.equal(raced.status, 0, raced.stderr);
  assert.deepEqual(raced.launchctl, [], 'no stop that tick');
  assert.equal(raced.python.length, 2);
  assert.ok(raced.log.includes(`drain: two reads 0 s apart differ (${idle}, then busy 4242): a job may be on its way; the runner stops at a later read`), raced.log);
  // No worker yet, but the listener logged between the reads: a job it is acquiring.
  d.runner(`${idle}\nidle Runner_20261018-071539-utc.log 813020`);
  const given = d.watch(security, { at: 120 });
  assert.deepEqual(given.launchctl, []);
  assert.ok(given.log.includes('then idle Runner_20261018-071539-utc.log 813020): a job may be on its way'), given.log);
  // A second read that fails confirms nothing either.
  d.runner(`${idle}\nfail`);
  assert.deepEqual(d.watch(security, { at: 180 }).launchctl, []);
  // Two matching reads, the gap apart, stop it.
  d.runner(idle);
  const confirmed = d.watch(security, { at: 240, extraEnv: { CI_KIT_IDLE_GAP: '1' } });
  assert.deepEqual([confirmed.launchctl, confirmed.runner], [[kill], 'stopped']);
  assert.ok(confirmed.elapsed >= 1000, `the second read waits the gap (${confirmed.elapsed} ms)`);
  assert.match(confirmed.log, /drain: stopped the runner \(no job running or offered on two reads 1 s apart\)/);
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
    // Idle carries the listener's newest diag log and its length; a listener without one is not read as idle.
    assert.deepEqual([read().stdout, read().status], ['', 2]);
    const diag = join(runner, '_diag');
    mkdirSync(diag);
    writeFileSync(join(diag, 'Runner_20261017-221759-utc.log'), 'an older listener\n');
    writeFileSync(join(diag, 'Worker_20261018-095502-utc.log'), 'a job\'s worker\n');
    const newest = join(diag, 'Runner_20261018-071539-utc.log');
    writeFileSync(newest, '[2026-10-18 09:58:58Z INFO Runner] Listening for Jobs\n');
    const quiet = `idle Runner_20261018-071539-utc.log ${statSync(newest).size}\n`;
    assert.equal(read().stdout, quiet);
    assert.equal(read().stdout, quiet, 'a listener that logs nothing reads the same');
    appendFileSync(newest, "[2026-10-18 09:58:58Z INFO BrokerMessageListener] Acknowledging runner request '500ef975'.\n");
    const given = `idle Runner_20261018-071539-utc.log ${statSync(newest).size}\n`;
    assert.notEqual(given, quiet);
    assert.equal(read().stdout, given, 'a job given to the listener changes the line');
    const job = await running(worker);
    assert.equal(read().stdout, `busy ${job.pid}\n`);
    // --wait sees the worker's exit as it happens.
    const waiting = spawn('python3', ['-I', join(hooks, 'runner-state.py'), runner, '--wait', String(job.pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let waited = '';
    waiting.stdout.on('data', (chunk) => { waited += chunk; });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(waiting.exitCode, null, 'it waits while the worker runs');
    const jobExit = once(job, 'exit');
    const waitEnd = once(waiting, 'close');
    job.kill('SIGKILL');
    const killed = Date.now();
    await waitEnd;
    assert.deepEqual([waited, waiting.exitCode], ['exited\n', 0]);
    assert.ok(Date.now() - killed < 2000, `seen at once (${Date.now() - killed} ms)`);
    await jobExit;
    assert.equal(read().stdout, given);
    const wait = (pid) => spawnSync('python3', ['-I', join(hooks, 'runner-state.py'), runner, '--wait', String(pid)], { encoding: 'utf8', timeout: 10_000 }).stdout;
    assert.equal(wait(job.pid), 'gone\n');
    assert.equal(wait(children[0].pid), 'not-worker\n', 'a process naming the worker is not it');
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

// The drain at a job's end, against real processes. A stand-in Runner.Worker (a clone of node at the runner's worker
// path) runs the installed job-completed.sh as the mini's runner did (its Worker_*.log of 2026-10-18): as its own child,
// `/bin/bash -e <hook>`, in the job's workspace, with the job's RUNNER_TRACKING_ID, its output piped and waited for. Once the hook's output closes, the
// worker takes `finishing` ms (the runner's orphan cleanup and its report of the job's result: 4 s on the mini), says it
// reported, and exits. launchctl records each call with the time, and the RUNNER_TRACKING_ID and directory of the
// process that made it. The mini's listener acquires its next job about 2 s after a worker exits (09:58:58 → 09:59:00
// and 09:59:07 → 09:59:09 on 2026-10-18), so a stop must come well within that.
const nextJobAfter = 1000;
const standInWorker = `
const { spawn } = require('node:child_process');
const [hook, workspace, finishing] = process.argv.slice(1);
const started = Date.now();
const child = spawn('/bin/bash', ['-e', hook], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
child.on('close', (code) => {
  console.log(JSON.stringify({ event: 'hook closed', after: Date.now() - started, code, output }));
  setTimeout(() => { console.log(JSON.stringify({ event: 'reported', at: Date.now() })); process.exit(0); }, Number(finishing));
});`;
// The job-end waiters of one job: [pid, process group] of each process running `dialog-watch.sh --job-end <worker> …`.
const waiters = (hooksDir, worker) => spawnSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' }).stdout.split('\n')
  .filter((line) => line.includes(` ${hooksDir}/dialog-watch.sh --job-end ${worker} `))
  .map((line) => line.trim().split(/\s+/).slice(0, 2).map(Number));

async function jobEnd({ held = true, whileFinishing = () => {}, finishing = 400, standIn = true, env = {} } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ci-kit-job-end-')));
  const runner = join(home, 'actions-runner-maws');
  const installed = join(runner, 'ci-kit/hooks');
  const workspace = join(runner, '_work/MAWS/MAWS');
  const logs = join(home, 'Library/Logs/ci-kit');
  const fakes = join(home, 'fakes');
  const temp = join(home, 'tmp');
  for (const dir of [installed, workspace, logs, fakes, temp, join(runner, 'bin')]) mkdirSync(dir, { recursive: true });
  for (const file of ['job-completed.sh', 'dialog.sh', 'dialog-watch.sh', 'runner-state.py']) copyFileSync(join(hooks, file), join(installed, file));
  const script = (path, body) => { writeFileSync(path, `#!/bin/bash\n${body}\n`); chmodSync(path, 0o755); };
  script(join(installed, 'desktop-posture.sh'), 'exit 0');
  script(join(fakes, 'node'), 'echo "sweep $*"'); // the sweep's selection is mac-strays' to test
  const calls = join(home, 'launchctl.calls');
  script(join(fakes, 'launchctl'), `printf '%s|%s|%s|%s\\n' "$(perl -MTime::HiRes=time -e 'printf "%d", time * 1000')" "$*" "\${RUNNER_TRACKING_ID-unset}" "$PWD" >> '${calls}'`);
  const marker = join(logs, 'runner-drained');
  if (held) writeFileSync(marker, 'held at 2026-10-18T09:57:17Z: UserNotificationCenter since 2026-10-18T09:56:01Z\n');
  const worker = join(runner, 'bin/Runner.Worker');
  copyFileSync(process.execPath, worker, constants.COPYFILE_FICLONE);
  const hook = join(installed, 'job-completed.sh');
  const jobEnv = { HOME: home, TMPDIR: temp, PATH: `${fakes}:/usr/bin:/bin`, RUNNER_TRACKING_ID: 'github_0f3d', GITHUB_RUN_ID: '39116987843', GITHUB_JOB: 'e2e', ...env };
  const job = standIn
    ? spawn(worker, ['-e', standInWorker, hook, workspace, String(finishing)], { stdio: ['ignore', 'pipe', 'inherit'], env: jobEnv })
    : spawn(process.execPath, ['-e', standInWorker, hook, workspace, String(finishing)], { stdio: ['ignore', 'pipe', 'inherit'], env: jobEnv });
  const events = {};
  let detached;
  let buffered = '';
  job.stdout.on('data', (chunk) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const event = JSON.parse(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      events[event.event] = event;
      if (event.event === 'hook closed') {
        detached = { waiters: waiters(installed, job.pid), group: Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(job.pid)], { encoding: 'utf8' }).stdout) };
        whileFinishing(marker);
      }
    }
  });
  const exit = once(job, 'exit');
  try {
    await exit;
    // The drain is done once its waiter is gone.
    for (let waited = 0; waiters(installed, job.pid).length > 0; waited += 50) {
      assert.ok(waited < 15_000, 'the job-end waiter exits');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const log = existsSync(join(logs, 'mac-runner-hooks.log')) ? readFileSync(join(logs, 'mac-runner-hooks.log'), 'utf8') : '';
    const stops = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((line) => {
      const [at, call, tracking, cwd] = line.split('|');
      return { at: Number(at), call, tracking, cwd };
    }) : [];
    const errors = existsSync(join(logs, 'dialog-watch.err.log')) ? readFileSync(join(logs, 'dialog-watch.err.log'), 'utf8') : '';
    return { events, detached, log, stops, errors, leftovers: readdirSync(temp) };
  } finally {
    job.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
}

test('a held runner is stopped when its job ends: after the worker reports and exits, before the next job', macOnly, async () => {
  const run = await jobEnd();
  assert.equal(run.events['hook closed'].code, 0, run.events['hook closed'].output);
  assert.ok(run.events['hook closed'].after < 6000, `the hook neither waits for the job's end nor leaves its output open (${run.events['hook closed'].after} ms)`);
  assert.deepEqual(run.leftovers, [], 'the ready file is gone');
  assert.deepEqual(run.stops.map((stop) => stop.call), [`kill SIGTERM gui/${uid}/${runnerAgent}`], run.log + run.errors);
  const [stop] = run.stops;
  const reported = run.events.reported.at;
  assert.ok(stop.at >= reported, `nothing stops the runner while the worker finishes (${stop.at - reported} ms)`);
  assert.ok(stop.at - reported < nextJobAfter, `stopped ${stop.at - reported} ms after the job reported`);
  // Detached from the job: the worker's orphan cleanup kills what carries its RUNNER_TRACKING_ID, the sweep what sits in
  // the workspace, and launchd what is left in the runner's process group.
  assert.deepEqual([stop.tracking, stop.cwd], ['unset', '/']);
  assert.ok(run.detached.waiters.length > 0, 'a waiter while the worker finishes');
  for (const [pid, group] of run.detached.waiters) assert.notEqual(group, run.detached.group, `${pid} is out of the job's process group`);
  assert.match(run.log, /dialog-watch run=39116987843 job=e2e drain: stopped the runner \(its job ended while it was held\); it waits for the episode to close/);
  // The hook returns only once the worker is watched, so even a worker that exits the moment the hook closes is seen.
  const abrupt = await jobEnd({ finishing: 0 });
  assert.deepEqual(abrupt.stops.map((stop) => stop.call), [`kill SIGTERM gui/${uid}/${runnerAgent}`], abrupt.log);
});

test('the job-end decision is the marker at the worker\'s exit: an episode opening while the job finishes stops it, one closing does not', macOnly, async () => {
  const free = await jobEnd({ held: false });
  assert.deepEqual([free.stops, free.log, free.errors], [[], '', ''], 'nothing held: nothing stopped, nothing logged');
  const opened = await jobEnd({ held: false, whileFinishing: (marker) => writeFileSync(marker, 'held at …\n') });
  assert.deepEqual(opened.stops.map((stop) => stop.call), [`kill SIGTERM gui/${uid}/${runnerAgent}`]);
  assert.ok(opened.stops[0].at >= opened.events.reported.at);
  const closed = await jobEnd({ whileFinishing: (marker) => unlinkSync(marker) });
  assert.deepEqual([closed.stops, closed.log], [[], '']);
});

test('a job end that cannot be watched stops nothing and says so; the watcher\'s confirmed idle read is left to stop it', macOnly, async () => {
  // A hook whose parent is not the runner's worker (run by hand, or by a runner that wraps its hooks).
  const unwatched = await jobEnd({ standIn: false });
  assert.deepEqual(unwatched.stops, []);
  assert.match(unwatched.log, /drain: the end of this job could not be watched \(not-worker\); the next idle read stops the runner/);
  // The wait has its deadline.
  const slow = await jobEnd({ finishing: 3000, env: { CI_KIT_JOB_END_WAIT: '1' } });
  assert.deepEqual(slow.stops, []);
  assert.match(slow.log, /drain: the end of this job could not be watched \(failed \(124\)\)/);
});
