import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { T0, asnShape, check, minute, ordinaryWindows, pairShape, terminal, windowLine, withWindow } from './fake-mac-desktop.mjs';

// Each check has an isolated desktop and HOME (fake-mac-desktop.mjs). `again` runs another job in that same desktop,
// and `watch` the dialog watcher, a minute after the run before unless told `at`.
const since = minute(T0); // the first read of every check below is at T0

for (const name of ['UserNotificationCenter', 'CoreServicesUIAgent', 'SecurityAgent', 'loginwindow']) {
  test(`a system dialog in front (${name}) fails the job at once, saying what to do`, () => {
    const run = check(asnShape(name));
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`^ci-kit: a system dialog \\(${name}: source unknown\\) holds focus on the mini since ${since} — dismiss it there and rerun$`, 'm'));
    assert.match(run.log, new RegExp(`desktop-check .*${name}`));
  });
}

test('the posture read-only entry point reports even a dialog without focus changes, alerts or log writes', () => {
  for (const output of [asnShape('SecurityAgent'), pairShape('SecurityAgent')]) {
    const run = check(output, 0, { readOnly: true });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'SecurityAgent\n');
    assert.deepEqual(run.opened, []);
    assert.deepEqual(run.ghCalls, []);
    assert.equal(run.log, '');
    assert.equal(run.state, null);
  }
  assert.equal(check('', 3, { readOnly: true }).stdout, 'unknown\n');
});

test('the LSDisplayName shape is read too', () => {
  const run = check(pairShape('SecurityAgent'));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /\(SecurityAgent: source unknown\) holds focus/);
});

test('an ordinary app in front passes once Terminal is brought over it', () => {
  for (const output of [asnShape('Terminal'), pairShape('Google Chrome'), asnShape('Electron')]) {
    const run = check(output, 0, { afterOpen: asnShape('Terminal') });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
  }
});

test('a name that only contains a listed one passes', () => {
  assert.equal(check(asnShape('loginwindowhelper'), 0, { afterOpen: asnShape('Terminal') }).status, 0);
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

test('Terminal already in front, by name or by bundle id under a localized name, is left alone: nothing opened', () => {
  for (const output of [asnShape('Terminal'), pairShape('Terminal'), asnShape('터미널', 'com.apple.Terminal'), pairShape('터미널', 'com.apple.Terminal')]) {
    const run = check(output, 0, { afterOpen: asnShape('Finder') });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.opened, []);
    assert.match(run.stdout, /desktop-check .*frontmost is (Terminal|터미널)$/m);
  }
});

test('any other app in front (Chrome, Electron, Finder) gets Terminal brought over it, before and after logged', () => {
  for (const [output, before] of [
    [asnShape('Google Chrome', 'com.google.Chrome'), 'Google Chrome'],
    [pairShape('Electron', 'com.github.Electron'), 'Electron'],
    [asnShape('Finder', 'com.apple.finder'), 'Finder'],
  ]) {
    const run = check(output, 0, { afterOpen: asnShape('터미널', 'com.apple.Terminal') });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.opened, ['-a Terminal']);
    assert.match(run.stdout, new RegExp(`frontmost before=${before} after=터미널`));
  }
});

test('Chrome staying in front fails the job fast, naming it', () => {
  const run = check(asnShape('Google Chrome', 'com.google.Chrome'));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^ci-kit: Terminal did not come to the front on the mini \(Google Chrome is\) — check its desktop and rerun$/m);
});

test('an unreadable frontmost app still lets the job run, and nothing is opened', () => {
  const run = check('', 0, { afterOpen: asnShape('Terminal') });
  assert.equal(run.status, 0);
  assert.deepEqual(run.opened, []);
});

test('names are localized: Finder and Terminal are told by bundle id (the mini shows Terminal as 터미널)', () => {
  for (const shape of [asnShape, pairShape]) {
    const run = check(shape('Finder', 'com.apple.finder'), 0, { afterOpen: shape('터미널', 'com.apple.Terminal') });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.opened, ['-a Terminal']);
    assert.match(run.stdout, /frontmost before=Finder after=터미널/);
  }
});

test('an app merely named Terminal under another bundle id is brought Terminal over it, and is not taken for it after', () => {
  const run = check(asnShape('Terminal', 'com.example.fake'), 0, { afterOpen: asnShape('Terminal', 'com.example.fake') });
  assert.equal(run.status, 1);
  assert.deepEqual(run.opened, ['-a Terminal']);
  assert.match(run.stderr, /Terminal did not come to the front on the mini \(Terminal is\)/);
});

const firewallOld = '2026-10-16 10:00:00.000 Df socketfilterfw[100:200] [com.apple.alf] doask: sending prompt for a filtering decision on: Old App';
const firewallNew = '2026-10-16 10:01:00.000 Df socketfilterfw[100:200] [com.apple.alf] doask: sending prompt for a filtering decision on: Electron';
const alertURL = 'https://github.com/SSFSKIM/ci-kit-sandbox/issues/42';
const argValue = (call, flag) => call[call.indexOf(flag) + 1];

test('the first dialog failure names the newest firewall source and creates one issue with job context', () => {
  const run = check(asnShape('UserNotificationCenter'), 0, {
    logOutput: `${firewallOld}\n${firewallNew}\n2026-10-16 10:02:00.000 Df other[1:2] doask: sending prompt for a filtering decision on: Not the Firewall\n`,
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.log, /frontmost is UserNotificationCenter: firewall prompt for Electron/);
  assert.match(run.stderr, /UserNotificationCenter: firewall prompt for Electron/);
  assert.equal(run.ghCalls.length, 1);
  const [create] = run.ghCalls;
  assert.deepEqual(create.slice(0, 2), ['issue', 'create']);
  assert.equal(argValue(create, '--repo'), 'SSFSKIM/ci-kit-sandbox');
  assert.equal(argValue(create, '--label'), 'ci-kit-alert');
  assert.equal(argValue(create, '--title'), `ci-kit alert: mini: UserNotificationCenter since ${since} (firewall prompt for Electron)`);
  const body = argValue(create, '--body');
  assert.match(body, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  assert.match(body, /UserNotificationCenter/);
  assert.ok(body.includes(firewallNew), 'the evidence line is included');
  assert.match(body, /123456/);
  assert.equal(run.state.issue, alertURL);
  assert.equal(argValue(run.logArgs, '--last'), '15m');
});

const tccFront = '2026-10-17 16:57:14.175 Df launchservicesd[151:60ee7ba] [com.apple.processmanager:front-35286506] SETFRONT: pid=47183 asn=0x-0x48b78b3 foreground=0 oldFrontPid=402 oldFrontASN=0x-0x73746';
const tccRequests = [
  '2026-10-17 16:57:13.268 A SkyComputerUseService[36230:60ee877] (TCC) TCCAccessRequest() IPC',
  '2026-10-17 16:57:13.286 A Finder[417:101d] (TCC) TCCAccessRequest() IPC',
  '2026-10-17 16:57:13.396 A CursorUIViewService[648:1948] (TCC) TCCAccessRequest() IPC',
  '2026-10-17 16:57:13.693 A SkyComputerUseService[36230:60ee7e1] (TCC) TCCAccessRequest() IPC',
];

test('the 2026-10-17 mini log ranks each TCC caller by its latest request, preserving names with spaces', () => {
  const logOutput = readFileSync(new URL('./fixtures/unc-tcc-2026-10-17.log', import.meta.url), 'utf8');
  const run = check(asnShape('UserNotificationCenter', undefined, 47183), 0, { logOutput });
  assert.equal(run.status, 1, run.stderr);
  const source = 'TCC requests before it came to front: SkyComputerUseService, CursorUIViewService, Finder, Electron Helper, syspolicyd, Electron';
  assert.equal(argValue(run.ghCalls[0], '--title'), `ci-kit alert: mini: UserNotificationCenter since ${since} (${source})`);
  assert.ok(argValue(run.ghCalls[0], '--body').includes(`Likely source: ${source}\nSource line: ${tccFront}\n`));
});

test('UserNotificationCenter names deduplicated TCC callers just before its own front transition, not background noise', () => {
  const run = check(asnShape('UserNotificationCenter', undefined, 47183), 0, { logOutput: [
    '2026-10-17 16:57:09.174 A OldClient[10:20] (TCC) TCCAccessRequest() IPC',
    ...tccRequests,
    '2026-10-17 16:57:14.000 A mds[11:21] (TCC) TCCAccessRequest() IPC',
    '2026-10-17 16:57:14.001 A coreaudiod[12:22] (TCC) TCCAccessRequest() IPC',
    '2026-10-17 16:57:14.002 A WindowServer[13:23] (TCC) TCCAccessRequest() IPC',
    tccFront,
    '2026-10-17 16:57:14.176 A LaterClient[14:24] (TCC) TCCAccessRequest() IPC',
    tccFront.replace('16:57:14.175', '16:57:15.000').replace('pid=47183 ', 'pid=471830 '),
  ].join('\n') });
  assert.equal(run.status, 1, run.stderr);
  const source = 'TCC requests before it came to front: SkyComputerUseService, CursorUIViewService, Finder';
  assert.ok(run.stderr.includes(`UserNotificationCenter: ${source})`));
  assert.ok(run.log.includes(`UserNotificationCenter: ${source};`));
  assert.equal(argValue(run.ghCalls[0], '--title'), `ci-kit alert: mini: UserNotificationCenter since ${since} (${source})`);
  const body = argValue(run.ghCalls[0], '--body');
  assert.ok(body.includes(`Likely source: ${source}\nSource line: ${tccFront}\n`));
  assert.equal(argValue(run.logArgs, '--style'), 'compact');
  assert.ok(run.logArgs.includes('--info'));
  const predicates = run.logCalls.map((call) => argValue(call, '--predicate'));
  assert.equal(predicates.length, 3);
  assert.equal(predicates[0], 'process == "socketfilterfw" AND eventMessage CONTAINS "doask: sending prompt for a filtering decision on:"');
  assert.equal(predicates[1], 'process == "launchservicesd" AND eventMessage CONTAINS "SETFRONT: pid=47183 "');
  assert.ok(predicates[2].includes('eventMessage CONTAINS "TCCAccessRequest"'));
  assert.ok(!predicates[1].includes('TCCAccessRequest'), 'the long query stays narrow');
});

test('a dialog first checked 20 minutes later uses a long, pid-only lookup then a five-second request window', () => {
  const front = tccFront.replace('16:57:14.175', '10:27:45.504');
  const request = '2026-10-17 10:27:45.381 A Electron Helper[22936:62f0aba] (TCC) TCCAccessRequest() IPC';
  const run = check(asnShape('UserNotificationCenter', undefined, 47183), 0, {
    now: '2026-10-17T10:47:37Z',
    logResponses: { firewall: { output: '' }, front: { output: front }, requests: { output: request } },
  });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(argValue(run.ghCalls[0], '--body').includes(`Likely source: TCC requests before it came to front: Electron Helper\nSource line: ${front}\n`));
  assert.match(run.log, /^2026-10-17T10:47:37Z /);
  assert.equal(run.logCalls.length, 3);
  const [, lookup, requests] = run.logCalls;
  assert.equal(argValue(lookup, '--last'), '3h');
  assert.equal(argValue(lookup, '--predicate'), 'process == "launchservicesd" AND eventMessage CONTAINS "SETFRONT: pid=47183 "');
  assert.ok(!requests.includes('--last'), 'frequent requests are never read over the long lookback');
  assert.equal(argValue(requests, '--start'), '2026-10-17 10:27:40+0000');
  assert.equal(argValue(requests, '--end'), '2026-10-17 10:27:46+0000');
  for (const call of run.logCalls) assert.equal(argValue(call, '--timezone'), 'UTC');
});

const sandboxFront = tccFront.replace('16:57:14.175', '19:27:45.504').replace('60ee7ba', '62ed779');
const sandboxRequests = [
  '2026-10-17 19:27:45.360 A  sandboxd[22936:62f0ac4] request approval',
  '2026-10-17 19:27:45.360 A  sandboxd[22936:62f0ac4] (TCC) tcc_send_request_authorization() IPC',
  '2026-10-17 19:27:45.381 A  sandboxd[22936:62f0aba] request approval',
  '2026-10-17 19:27:45.381 A  sandboxd[22936:62f0aba] (TCC) tcc_send_request_authorization() IPC',
];
const sandboxDenial = '2026-10-17 19:27:45.401 Df sandboxd[22936:62f0ac4] [com.apple.sandbox:sandcastle] checking kTCCServiceSystemPolicyAppDataDetailed on path "<private>", user interaction not allowed';

test('the captured sandboxd approval burst identifies data-from-other-apps prompts, ranked with other requesters', () => {
  const run = check(asnShape('UserNotificationCenter', undefined, 47183), 0, { logResponses: {
    front: { output: sandboxFront },
    requests: { output: [
      ...sandboxRequests.slice(0, 2),
      '2026-10-17 19:27:45.370 A Electron Helper[10:20] (TCC) TCCAccessRequest() IPC',
      ...sandboxRequests.slice(2),
      // Rejection on one thread cannot invalidate the other thread's approval.
      sandboxDenial,
      '2026-10-17 19:27:45.450 A Finder[11:21] (TCC) TCCAccessRequest() IPC',
    ].join('\n') },
  } });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(argValue(run.ghCalls[0], '--body').includes(`Likely source: TCC requests before it came to front: Finder, sandboxd (data from other apps), Electron Helper\nSource line: ${sandboxFront}\n`));
  const requests = run.logCalls[2];
  assert.ok(argValue(requests, '--predicate').includes('process == "sandboxd"'));
  assert.ok(argValue(requests, '--predicate').includes('user interaction not allowed'));
  assert.ok(requests.includes('--debug'), 'include the sandbox rejection diagnostics');
});

test('non-interactive sandbox checks and rejected approvals do not become dialog sources', () => {
  for (const lines of [
    [sandboxDenial],
    [...sandboxRequests.slice(0, 2), sandboxDenial],
    [...sandboxRequests.slice(0, 2), sandboxDenial.replace('22936:', '99999:'), sandboxDenial],
  ]) {
    const run = check(asnShape('UserNotificationCenter', undefined, 47183), 0, { logResponses: {
      front: { output: sandboxFront }, requests: { output: lines.join('\n') },
    } });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /UserNotificationCenter: source unknown/);
  }
});

test('sandbox approval rejection is correlated by both pid and thread, not by process name alone', () => {
  for (const denial of [sandboxDenial.replace('22936:', '99999:'), sandboxDenial.replace(':62f0ac4]', ':different]')]) {
    const run = check(asnShape('UserNotificationCenter', undefined, 47183), 0, { logResponses: {
      front: { output: sandboxFront }, requests: { output: [...sandboxRequests.slice(0, 2), denial].join('\n') },
    } });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /TCC requests before it came to front: sandboxd \(data from other apps\)\)/);
  }
});

test('a later rejected sandbox approval does not erase an earlier prompting one on the same thread', () => {
  const run = check(asnShape('UserNotificationCenter', undefined, 47183), 0, { logResponses: {
    front: { output: sandboxFront }, requests: { output: [
      ...sandboxRequests.slice(0, 2),
      '2026-10-17 19:27:45.370 A Finder[10:20] (TCC) TCCAccessRequest() IPC',
      sandboxRequests[0].replace('.360', '.400'), sandboxDenial,
    ].join('\n') },
  } });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /TCC requests before it came to front: Finder, sandboxd \(data from other apps\)\)/);
});

test('the LSDisplayName shape with a quoted pid also supports TCC attribution', () => {
  const run = check(pairShape('UserNotificationCenter', undefined, 47183), 0, {
    logOutput: [...tccRequests, tccFront].join('\n'),
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /UserNotificationCenter: TCC requests before it came to front: SkyComputerUseService, CursorUIViewService, Finder\)/);
});

test('the five-second TCC window includes its boundary across midnight but not older or later requests', () => {
  const front = tccFront.replace('2026-10-17 16:57:14.175', '2026-10-18 00:00:02.175');
  const run = check(asnShape('UserNotificationCenter', undefined, 47183), 0, { logOutput: [
    '2026-10-17 23:59:57.174 A TooOld[10:20] (TCC) TCCAccessRequest() IPC',
    '2026-10-17 23:59:57.175 A BoundaryClient[11:21] (TCC) TCCAccessRequest() IPC',
    front,
    '2026-10-18 00:00:02.175 A AfterFront[12:22] (TCC) TCCAccessRequest() IPC',
  ].join('\n') });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(argValue(run.ghCalls[0], '--body').includes(`Likely source: TCC requests before it came to front: BoundaryClient\nSource line: ${front}\n`));
});

test('the newest front transition for the dialog pid anchors the TCC window', () => {
  const latestFront = tccFront.replace('16:57:14.175', '16:58:00.000');
  const run = check(asnShape('UserNotificationCenter', undefined, 47183), 0, { logOutput: [
    ...tccRequests, tccFront,
    '2026-10-17 16:57:59.000 A NewClient[15:25] (TCC) TCCAccessRequest() IPC',
    latestFront,
  ].join('\n') });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(argValue(run.ghCalls[0], '--body').includes(`Likely source: TCC requests before it came to front: NewClient\nSource line: ${latestFront}\n`));
});

test('TCC attribution stays unknown without a readable pid, its SETFRONT, or nearby non-daemon requests', () => {
  for (const [pid, lines] of [
    [undefined, [...tccRequests, tccFront]],
    ['unreadable', [...tccRequests, tccFront]],
    [47183, tccRequests],
    [47183, [...tccRequests, tccFront.replace('pid=47183 ', 'pid=471830 ')]],
    [47183, [tccFront]],
    [47183, [tccRequests[0].replace('16:57:13.268', '16:57:09.174'), tccFront]],
    [47183, [tccRequests[0].replace('SkyComputerUseService', 'mds'), tccFront]],
    [47183, [...tccRequests, tccFront, tccFront.replace('16:57:14.175', '16:58:00.000')]],
  ]) {
    const run = check(asnShape('UserNotificationCenter', undefined, pid), 0, { logOutput: lines.join('\n') });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /UserNotificationCenter: source unknown/);
    assert.ok(argValue(run.ghCalls[0], '--body').includes('Likely source: source unknown\nSource line: source unknown\n'));
  }
});

test('firewall attribution wins even when TCC requests precede UserNotificationCenter coming to front', () => {
  const run = check(asnShape('UserNotificationCenter', undefined, 47183), 0, {
    logOutput: [firewallNew, ...tccRequests, tccFront].join('\n'),
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /UserNotificationCenter: firewall prompt for Electron/);
  assert.ok(argValue(run.ghCalls[0], '--body').includes(`Source line: ${firewallNew}\n`));
});

test('repeated failing jobs share one alert; a passing job leaves it to the watcher, whose clear reads close it', () => {
  const first = check(asnShape('UserNotificationCenter'), 0, { logOutput: firewallNew });
  const second = first.again(asnShape('UserNotificationCenter'));
  assert.equal(second.status, 1);
  assert.equal(second.ghCalls.length, 1, 'no repeat issue for another job in the same episode');
  assert.match(second.stderr, new RegExp(`since ${since} — dismiss it there and rerun$`, 'm'), 'later refusals keep the first-seen time');
  assert.match(second.stderr, /\(UserNotificationCenter: firewall prompt for Electron\)/, "and the episode's source");
  assert.equal(second.logCalls.length, first.logCalls.length, 'the source is read once, when the episode opens');
  const passed = second.again(asnShape('Terminal'));
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.state.phase, 'open', 'a job is not the clock the episode closes on');
  assert.equal(passed.ghCalls.length, 1);
  const cleared = passed.watch(asnShape('Terminal')).watch(asnShape('Terminal')).watch(asnShape('Terminal'));
  assert.equal(cleared.state, null);
  assert.deepEqual(cleared.ghCalls.map((call) => call.slice(0, 2)), [['issue', 'create'], ['issue', 'comment'], ['issue', 'close']]);
  assert.equal(cleared.ghCalls[1][2], alertURL);
  assert.match(argValue(cleared.ghCalls[1], '--body'), /^cleared at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z: no dialog on 3 reads in a row since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(cleared.ghCalls[2][2], alertURL);
  const quiet = cleared.again(asnShape('Terminal'));
  assert.equal(quiet.ghCalls.length, 3, 'a later passing job does nothing');
  const next = quiet.again(asnShape('loginwindow'));
  assert.equal(next.status, 1);
  assert.equal(next.ghCalls.length, 4, 'a new episode alerts again');
});

test('gh failure is logged and cannot change a failing or passing job; a failed creation is not retried, a failed close is', () => {
  const first = check(asnShape('SecurityAgent'), 0, { ghStatus: 1 });
  assert.equal(first.status, 1);
  assert.equal(first.state.phase, 'open', 'a failed alert still records the episode');
  assert.equal(first.state.issue, '');
  assert.match(first.log, /alert.*(failed|timed out)/);
  const second = first.again(asnShape('SecurityAgent'));
  assert.equal(second.status, 1);
  assert.equal(second.ghCalls.length, 1);
  const passed = second.again(asnShape('Terminal'));
  assert.equal(passed.status, 0, passed.stderr);
  const cleared = passed.watch(asnShape('Terminal')).watch(asnShape('Terminal')).watch(asnShape('Terminal'));
  assert.equal(cleared.state, null);
  assert.equal(cleared.ghCalls.length, 1, 'no issue to comment on or close');
  // Also exercise failures of the comment and close calls when an issue was created successfully.
  const succeeds = check(asnShape('loginwindow'));
  const twoClear = succeeds.watch(asnShape('Terminal')).watch(asnShape('Terminal'));
  const clearFails = twoClear.watch(asnShape('Terminal'), { ghExit: 1 });
  assert.equal(clearFails.status, 0, clearFails.stderr);
  assert.equal(clearFails.state.phase, 'closed', 'the close is owed, not forgotten');
  assert.deepEqual(clearFails.ghCalls.map((call) => call[1]), ['create', 'comment', 'close', 'repos/SSFSKIM/ci-kit-sandbox/issues/42']);
  assert.match(clearFails.log, /alert.*(failed|timed out)/);
  const retried = clearFails.watch(asnShape('Terminal'));
  assert.equal(retried.state, null);
  assert.deepEqual(retried.ghCalls.map((call) => call[1]), ['create', 'comment', 'close', 'repos/SSFSKIM/ci-kit-sandbox/issues/42', 'comment', 'close']);
});

test('SecurityAgent names the latest requesting process before its launch, not a later request', () => {
  const source = '2026-10-16 10:00:01.000 Df security[101:201] [com.apple.security] SecKeychainCopyMatching: client request';
  const run = check(asnShape('SecurityAgent'), 0, { logOutput: [
    '2026-10-16 10:00:00.000 Df codesign[100:200] [com.apple.security] SecKeychainOpen: client request',
    source,
    '2026-10-16 10:00:02.000 Df launchd[1:2] spawning SecurityAgent',
    '2026-10-16 10:00:03.000 Df unrelated[102:202] [com.apple.security] SecKeychainOpen: client request',
  ].join('\n') });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /SecurityAgent: security request from security/);
  assert.ok(argValue(run.ghCalls[0], '--body').includes(source));
});

test('failed unified-log reads discard partial output and leave the source unknown', () => {
  const run = check(asnShape('UserNotificationCenter'), 0, { logOutput: firewallNew, logStatus: 1 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /UserNotificationCenter: source unknown/);
  assert.equal(run.ghCalls.length, 1);
});

test('a hung unified-log read is cut off at the deadline and still alerts and fails the job', () => {
  const started = Date.now();
  const run = check(asnShape('UserNotificationCenter'), 0, { logHang: true });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(Date.now() - started < 15_000, 'the 10 s read deadline is enforced');
  assert.match(run.stderr, /UserNotificationCenter: source unknown/);
  assert.equal(run.ghCalls.length, 1);
});

test('failed front-transition or bounded-request reads discard partial output and still fail and alert', () => {
  for (const kind of ['front', 'requests']) {
    const logResponses = { front: { output: tccFront }, requests: { output: tccRequests.join('\n') } };
    logResponses[kind].status = 1;
    const run = check(asnShape('UserNotificationCenter', undefined, 47183), 0, { logResponses });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /UserNotificationCenter: source unknown/);
    assert.equal(run.ghCalls.length, 1);
  }
});

test('each new unified-log query has its own 10-second alarm', () => {
  for (const kind of ['front', 'requests']) {
    const logResponses = { front: { output: tccFront }, requests: { output: tccRequests.join('\n') } };
    logResponses[kind].hang = true;
    const started = Date.now();
    const run = check(asnShape('UserNotificationCenter', undefined, 47183), 0, { logResponses });
    assert.equal(run.status, 1, run.stderr);
    assert.ok(Date.now() - started < 15_000, `${kind} read deadline is enforced`);
    assert.match(run.stderr, /UserNotificationCenter: source unknown/);
    assert.equal(run.ghCalls.length, 1);
  }
});

test('a hung gh call that ignores SIGALRM is terminated and reaped without retrying the same episode', () => {
  const started = Date.now();
  const run = check(asnShape('loginwindow'), 0, { ghHang: true });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(Date.now() - started < 15_000, 'the gh deadline is enforced');
  assert.deepEqual(run.ghSurvivors, [], 'the timed-out gh process is terminated and reaped');
  assert.equal(run.state.issue, '', 'a timed-out create remembers the episode without an issue URL');
  assert.match(run.log, /dialog alert issue creation failed or timed out/);
  const next = run.again(asnShape('loginwindow'));
  assert.equal(next.status, 1);
  assert.equal(next.ghCalls.length, 1);
});

test('hung gh cleanup calls that ignore SIGALRM do not block the watcher, and the close they owe is tried at the next read', () => {
  const first = check(asnShape('loginwindow'));
  assert.equal(first.state.issue, alertURL);
  const twoClear = first.watch(asnShape('Terminal')).watch(asnShape('Terminal'));
  const cleared = twoClear.watch(asnShape('Terminal'), { ghStall: true });
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.ok(cleared.elapsed < 35_000, 'comment, close and the issue\'s read each have a 10 s deadline');
  assert.deepEqual(cleared.ghSurvivors, [], 'every timed-out gh process is terminated and reaped');
  assert.equal(cleared.state.phase, 'closed');
  assert.deepEqual(cleared.ghCalls.map((call) => call[1]), ['create', 'comment', 'close', 'repos/SSFSKIM/ci-kit-sandbox/issues/42']);
  assert.match(cleared.log, /dialog alert clear comment failed or timed out/);
  assert.match(cleared.log, /dialog alert close failed or timed out/);
  const next = cleared.watch(asnShape('Terminal'));
  assert.equal(next.status, 0, next.stderr);
  assert.equal(next.state, null);
  assert.equal(next.ghCalls.length, 6, 'the next clear read makes both calls again');
  assert.equal(next.watch(asnShape('Terminal')).ghCalls.length, 6, 'and then nothing is owed');
});

test('another machine is named in every refusal line and the alert title, and the lines keep their ci-kit: … rerun shape', () => {
  const env = { CI_KIT_MACHINE: 'rental' };
  for (const [run, line] of [
    [check(asnShape('loginwindow'), 0, { env }), `ci-kit: a system dialog (loginwindow: source unknown) holds focus on the rental since ${since} — dismiss it there and rerun`],
    [check(asnShape('Finder'), 0, { env, openStatus: 1 }), 'ci-kit: could not open Terminal on the rental (Finder is in front) — check its desktop and rerun'],
    [check(asnShape('Finder'), 0, { env }), 'ci-kit: Terminal did not come to the front on the rental (Finder is) — check its desktop and rerun'],
  ]) {
    assert.equal(run.status, 1);
    // MAWS's ci-gate.sh tells a refused job by this shape: the line starts with `ci-kit: ` and ends with `rerun`.
    assert.deepEqual(run.stderr.split('\n').filter(Boolean), [line]);
    assert.match(line, /^ci-kit: .*rerun$/);
  }
  const alerted = check(asnShape('loginwindow'), 0, { env });
  assert.equal(argValue(alerted.ghCalls[0], '--title'), `ci-kit alert: rental: loginwindow since ${since}`);
});

test('with a token file, every gh call gets the token in its environment, never in an argument or any output', () => {
  const secret = 'github_pat_11FAKE0secret0value';
  const failed = check(asnShape('loginwindow'), 0, { alertToken: `${secret}\n` });
  const passed = failed.again(asnShape('Terminal')).watch(asnShape('Terminal')).watch(asnShape('Terminal')).watch(asnShape('Terminal'));
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(passed.ghCalls.map((call) => call[1]), ['create', 'comment', 'close']);
  assert.deepEqual(passed.ghTokens, [secret, secret, secret]);
  for (const run of [failed, passed]) {
    assert.ok(!run.ghCalls.flat().some((arg) => arg.includes(secret)), 'not an argument');
    for (const output of [run.stdout, run.stderr, run.log]) assert.ok(!output.includes(secret), 'not printed or logged');
  }
});

test('without a token file gh keeps its own login; an empty one is logged and changes nothing', () => {
  const plain = check(asnShape('loginwindow'));
  assert.deepEqual(plain.ghTokens, ['<unset>']);
  const empty = check(asnShape('loginwindow'), 0, { alertToken: '' });
  assert.equal(empty.status, 1);
  assert.deepEqual(empty.ghTokens, ['<unset>']);
  assert.match(empty.log, /alert-token is empty or unreadable; gh uses its own login/);
  assert.equal(empty.state.issue, alertURL, 'the alert is still created');
});

// A dialog on screen without focus (2026-10-21: a SecurityAgent keychain prompt sat on the mini's screen for hours with
// Terminal in front, and the frontmost read alone admitted every job under it).
const keychainPrompt = { pid: 4711, layer: 2002, x: 1020, y: 400, width: 520, height: 260, bundle: 'com.apple.SecurityAgent', name: 'SecurityAgent' };

test('a system dialog on screen without focus fails the job at once, naming it and the app in front', () => {
  const run = check(terminal, 0, { windows: withWindow(keychainPrompt) });
  assert.equal(run.status, 1);
  assert.deepEqual(run.stderr.split('\n').filter(Boolean), [
    `ci-kit: a system dialog (SecurityAgent: source unknown) is on screen without focus on the mini since ${since} — dismiss it there and rerun`,
  ]);
  assert.match(run.log, /desktop-check .*frontmost is 터미널; on screen: SecurityAgent \(pid 4711, layer 2002, 520x260 at 1020,400\): source unknown; a system dialog is on screen without focus since /);
  assert.deepEqual(run.opened, [], 'nothing is brought over it');
  assert.equal(run.state.name, 'SecurityAgent');
  const [create] = run.ghCalls;
  assert.equal(argValue(create, '--title'), `ci-kit alert: mini: SecurityAgent since ${since}`, 'the title keeps its contract');
  assert.ok(argValue(create, '--body').includes('Dialog: SecurityAgent is on screen without focus (pid 4711, layer 2002, 520x260 at 1020,400)\nFrontmost app: 터미널\n'));
  // The same dialog in front reads as before.
  const front = check(asnShape('SecurityAgent', 'com.apple.SecurityAgent'), 0, { windows: withWindow(keychainPrompt) });
  assert.match(front.stderr, /\(SecurityAgent: source unknown\) holds focus on the mini since/);
  assert.ok(argValue(front.ghCalls[0], '--body').includes('Dialog: SecurityAgent holds focus\nFrontmost app: SecurityAgent\n'));
});

test('every listed dialog is seen on screen, by its bundle id under a localized name or by its name alone; the topmost is named', () => {
  for (const [name, bundle] of [['UserNotificationCenter', 'com.apple.UserNotificationCenter'], ['CoreServicesUIAgent', 'com.apple.coreservices.uiagent'], ['SecurityAgent', 'com.apple.SecurityAgent'], ['loginwindow', 'com.apple.loginwindow']]) {
    for (const window of [{ pid: 900, bundle, name: `현지화된 ${name}` }, { pid: 900, name }]) {
      const run = check(terminal, 0, { windows: withWindow(window) });
      assert.equal(run.status, 1, `${name} ${JSON.stringify(window)}`);
      assert.match(run.stderr, new RegExp(`^ci-kit: a system dialog \\(${name}: source unknown\\) is on screen without focus on the mini`, 'm'));
    }
  }
  const two = check(terminal, 0, { windows: `${windowLine({ pid: 901, bundle: 'com.apple.UserNotificationCenter', name: 'UserNotificationCenter' })}\n${withWindow(keychainPrompt)}` });
  assert.match(two.stderr, /\(UserNotificationCenter: source unknown\)/);
});

test('a dialog process with no window that shows passes: none on screen, one with no alpha or no area, or an app that only shares a name', () => {
  for (const windows of [
    ordinaryWindows,
    withWindow({ ...keychainPrompt, alpha: '0.0' }),
    withWindow({ ...keychainPrompt, width: 0 }),
    withWindow({ ...keychainPrompt, height: 0 }),
    withWindow({ pid: 902, bundle: 'com.example.SecurityAgentHelper', name: 'SecurityAgentHelper' }),
    withWindow({ pid: 903, bundle: 'com.apple.loginwindowhelper', name: 'loginwindowhelper' }),
  ]) {
    const run = check(terminal, 0, { windows });
    assert.equal(run.status, 0, `${windows}\n${run.stderr}`);
    assert.equal(run.stderr, '');
    assert.equal(run.state, null);
    assert.equal(run.windowReads, 1);
  }
});

test('a window list that is missing, fails or hangs leaves the frontmost read alone deciding, and is logged', () => {
  for (const [windowList, why] of [['missing', 'window-list is missing'], [1, 'window-list failed (1)'], ['hang', 'window-list timed out']]) {
    const started = Date.now();
    const passed = check(terminal, 0, { windowList, windows: withWindow(keychainPrompt) });
    assert.equal(passed.status, 0, passed.stderr);
    assert.ok(passed.log.includes(`desktop-check run=123456 job=e2e could not read the windows on screen (${why}); a dialog is seen only in front\n`), passed.log);
    assert.match(passed.log, /frontmost is 터미널$/m);
    assert.deepEqual(passed.ghSurvivors, [], 'a hung helper is killed and reaped');
    assert.ok(Date.now() - started < 15_000, 'the 5 s deadline is enforced');
    const refused = check(asnShape('SecurityAgent'), 0, { windowList });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /\(SecurityAgent: source unknown\) holds focus on the mini/);
  }
});

test('an unreadable frontmost app does not let a job run under a dialog on screen', () => {
  const run = check('', 0, { windows: withWindow(keychainPrompt) });
  assert.equal(run.status, 1);
  assert.match(run.stderr, new RegExp(`^ci-kit: a system dialog \\(SecurityAgent: source unknown\\) is on screen on the mini since ${since} — dismiss it there and rerun$`, 'm'));
  assert.match(run.log, /frontmost is unreadable; on screen: SecurityAgent \(pid 4711/);
});

test('the read-only posture entry point reads no windows', () => {
  const run = check(terminal, 0, { readOnly: true, windows: withWindow(keychainPrompt) });
  assert.equal(run.stdout, '터미널\n');
  assert.equal(run.windowReads, 0);
});

test("UserNotificationCenter on screen without focus is attributed through its own pid's front transition, not the app in front's", () => {
  const run = check(asnShape('터미널', 'com.apple.Terminal', 431), 0, {
    windows: withWindow({ pid: 47183, layer: 8, bundle: 'com.apple.UserNotificationCenter', name: 'UserNotificationCenter' }),
    logOutput: [...tccRequests, tccFront].join('\n'),
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /\(UserNotificationCenter: TCC requests before it came to front: SkyComputerUseService, CursorUIViewService, Finder\) is on screen without focus/);
  assert.equal(argValue(run.logCalls[1], '--predicate'), 'process == "launchservicesd" AND eventMessage CONTAINS "SETFRONT: pid=47183 "');
});

const expectedDisplay = { CI_KIT_DISPLAY: '2560x1440@2x' };

test('without a display setting the hook does not probe or enforce the display', () => {
  const d = check(terminal).desktop;
  d.display('1920x1080@1x');
  const run = d.hook(terminal);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.displayCalls, []);
});

test('the expected display passes; either a wrong size or backing scale refuses before focus changes', () => {
  const initial = check(terminal, 0, { env: expectedDisplay });
  assert.equal(initial.status, 0, initial.stderr);
  assert.deepEqual(initial.displayCalls, ['--describe']);
  for (const value of ['1920x1080@2x', '2560x1440@1x']) {
    const d = check(terminal, 0, { env: expectedDisplay }).desktop;
    d.display(value);
    const run = d.hook(asnShape('Finder'));
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, new RegExp(`display ${value}, expected 2560x1440@2x`));
    assert.deepEqual(run.opened, []);
    assert.equal(run.state.phase, 'open');
    assert.equal(run.state.name, 'Display');
    const title = run.ghCalls.find((call) => call[1] === 'create');
    assert.match(title[title.indexOf('--title') + 1], /^ci-kit alert: mini: Display since \S+ \(display /);
    assert.deepEqual(run.logCalls, [], 'display faults need no dialog attribution');
  }
});

test('a transient unreadable display retries before passing, without an episode', () => {
  const d = check(terminal, 0, { env: expectedDisplay }).desktop;
  d.display('fail\nunknown\n2560x1440@2.0x');
  const run = d.hook(terminal);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.displayCalls.length, 4); // the initial check, then three reads
  assert.equal(run.state, null);
  assert.deepEqual(run.ghCalls, []);
});

test('a persistently unreadable display fails closed, including when the frontmost app cannot be read', () => {
  for (const value of ['fail', 'unknown', '0x1440@2x', '2560x1440@0x']) {
    const d = check(terminal, 0, { env: expectedDisplay }).desktop;
    d.display(value);
    const run = d.hook('');
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /display unreadable.*expected 2560x1440@2x/);
    assert.equal(run.state.phase, 'open');
    assert.equal(run.displayCalls.length, 4);
  }
});

test('display deadlines kill a stuck probe and refuse instead of running blind', () => {
  const d = check(terminal, 0, { env: expectedDisplay }).desktop;
  d.display('hang');
  const run = d.hook(terminal);
  assert.equal(run.status, 1, run.stderr);
  assert.ok(run.elapsed < 6000, `took ${run.elapsed} ms`);
  assert.deepEqual(run.ghSurvivors, []);
  assert.equal(run.state.phase, 'open');
});

test('a missing display helper refuses a configured machine, but the read-only posture entry point never checks it', () => {
  const env = { ...expectedDisplay, CI_KIT_CURSOR_PARK: '/no-such-ci-kit-display-helper' };
  const blocked = check(terminal, 0, { env });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /display unreadable/);
  const read = check(terminal, 0, { env, readOnly: true });
  assert.equal(read.status, 0);
  assert.equal(read.stdout, '터미널\n');
  assert.equal(read.state, null);
  assert.deepEqual(read.ghCalls, []);
});
