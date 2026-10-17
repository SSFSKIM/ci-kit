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

// Each check has an isolated desktop and HOME. `again` runs another job in that same dialog episode.
// External reads and GitHub writes are faked, including the absolute-path unified log command.
function check(output, status = 0, { afterOpen, openStatus = 0, logOutput = '', logStatus = 0, ghStatus = 0, logHang = false, ghHang = false, readOnly = false } = {}) {
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
  const log = join(dir, 'bin', 'unified-log');
  writeFileSync(join(dir, 'unified.txt'), logOutput);
  writeFileSync(log, `#!/bin/bash
printf '%s\\0' "$@" >> '${join(dir, 'log-args.txt')}'
${logHang ? 'exec /bin/sleep 60' : ''}
cat '${join(dir, 'unified.txt')}'
exit ${logStatus}
`);
  const gh = join(dir, 'bin', 'gh');
  writeFileSync(gh, `#!/bin/bash
printf '%s\\0' "$@" >> '${join(dir, 'gh-args.txt')}'
printf '\\0' >> '${join(dir, 'gh-args.txt')}'
if [[ $FAKE_GH_HANG == 1 ]]; then
  trap '' ALRM
  echo "$$" >> '${join(dir, 'hung-gh-pids.txt')}'
  exec /bin/sleep 60
fi
[[ $FAKE_GH_STATUS == 0 ]] || exit "$FAKE_GH_STATUS"
if [[ $1 == issue && $2 == create ]]; then echo https://github.com/SSFSKIM/ci-kit-sandbox/issues/42; fi
`);
  for (const executable of [stub, open, log, gh]) chmodSync(executable, 0o755);
  const text = (name) => existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '';
  const statePath = 'Library/Logs/ci-kit/dialog-alert.state';
  function run(nextOutput, { ghExit = ghStatus, ghStall = ghHang } = {}) {
    writeFileSync(front, nextOutput);
    writeFileSync(join(dir, 'hung-gh-pids.txt'), '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', script, ...(readOnly ? ['--frontmost'] : [])], {
      encoding: 'utf8',
      timeout: 25_000,
      env: {
        PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir,
        CI_KIT_LOG_BIN: log, CI_KIT_GH_BIN: gh, FAKE_GH_STATUS: String(ghExit), FAKE_GH_HANG: ghStall ? '1' : '0',
        GITHUB_RUN_ID: '123456', GITHUB_JOB: 'e2e',
      },
    });
    const ghSurvivors = [];
    for (const pid of text('hung-gh-pids.txt').trim().split('\n').filter(Boolean).map(Number)) {
      try {
        process.kill(pid, 0);
        ghSurvivors.push(pid);
        process.kill(pid, 'SIGKILL'); // Do not leak the stalled fake if the deadline regresses.
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    return {
      ghSurvivors,
      ...result,
      log: text('Library/Logs/ci-kit/mac-runner-hooks.log'),
      opened: text('opened.txt').trim().split('\n').filter(Boolean),
      ghCalls: text('gh-args.txt').split('\0\0').filter(Boolean).map((call) => call.split('\0')),
      logArgs: text('log-args.txt').split('\0').filter(Boolean),
      state: existsSync(join(dir, statePath)) ? text(statePath) : null,
      again: run,
    };
  }
  return run(output);
}
// The two shapes lsappinfo prints for `info -only name`: macOS 27 over ssh, and the LSDisplayName pair.
// With a bundle id, each also prints it: `bundleID="<id>"` and `"CFBundleIdentifier"="<id>"` (both checked live).
const asnShape = (name, bundle, pid) =>
  `"${name}" ASN:0x0-0x48b78b3: (in front) \n    bundleID=${bundle ? `"${bundle}"` : '[ NULL ]'} \n    bundle path=[ NULL ] \n${pid === undefined ? '' : `    pid = ${pid} (0xb84f)\n`}`;
const pairShape = (name, bundle, pid) => `"LSDisplayName"="${name}"\n${bundle ? `"CFBundleIdentifier"="${bundle}"\n` : ''}${pid === undefined ? '' : `"pid"=${pid}\n`}`;

for (const name of ['UserNotificationCenter', 'CoreServicesUIAgent', 'SecurityAgent', 'loginwindow']) {
  test(`a system dialog in front (${name}) fails the job at once, saying what to do`, () => {
    const run = check(asnShape(name));
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`^ci-kit: a system dialog \\(${name}: source unknown\\) holds focus on the mini — dismiss it there and rerun$`, 'm'));
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
  assert.equal(argValue(create, '--title'), 'ci-kit alert: system dialog on the mini (UserNotificationCenter: firewall prompt for Electron)');
  const body = argValue(create, '--body');
  assert.match(body, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  assert.match(body, /UserNotificationCenter/);
  assert.ok(body.includes(firewallNew), 'the evidence line is included');
  assert.match(body, /123456/);
  assert.equal(run.state.trim(), alertURL);
  assert.equal(argValue(run.logArgs, '--last'), '15m');
});

const tccFront = '2026-10-17 16:57:14.175 Df launchservicesd[151:60ee7ba] [com.apple.processmanager:front-35286506] SETFRONT: pid=47183 asn=0x-0x48b78b3 foreground=0 oldFrontPid=402 oldFrontASN=0x-0x73746';
const tccRequests = [
  '2026-10-17 16:57:13.268 A SkyComputerUseService[36230:60ee877] (TCC) TCCAccessRequest() IPC',
  '2026-10-17 16:57:13.286 A Finder[417:101d] (TCC) TCCAccessRequest() IPC',
  '2026-10-17 16:57:13.396 A CursorUIViewService[648:1948] (TCC) TCCAccessRequest() IPC',
  '2026-10-17 16:57:13.693 A SkyComputerUseService[36230:60ee7e1] (TCC) TCCAccessRequest() IPC',
];

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
  const source = 'TCC requests before it came to front: SkyComputerUseService, Finder, CursorUIViewService';
  assert.ok(run.stderr.includes(`UserNotificationCenter: ${source})`));
  assert.ok(run.log.includes(`UserNotificationCenter: ${source};`));
  assert.equal(argValue(run.ghCalls[0], '--title'), `ci-kit alert: system dialog on the mini (UserNotificationCenter: ${source})`);
  const body = argValue(run.ghCalls[0], '--body');
  assert.ok(body.includes(`Likely source: ${source}\nSource line: ${tccFront}\n`));
  assert.equal(argValue(run.logArgs, '--style'), 'compact');
  assert.ok(run.logArgs.includes('--info'));
  const predicate = argValue(run.logArgs, '--predicate');
  assert.ok(predicate.includes('process == "socketfilterfw"'));
  assert.ok(predicate.includes('eventMessage CONTAINS "TCCAccessRequest"'));
  assert.ok(predicate.includes('process == "launchservicesd" AND eventMessage CONTAINS "SETFRONT"'));
});

test('the LSDisplayName shape with a quoted pid also supports TCC attribution', () => {
  const run = check(pairShape('UserNotificationCenter', undefined, 47183), 0, {
    logOutput: [...tccRequests, tccFront].join('\n'),
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /UserNotificationCenter: TCC requests before it came to front: SkyComputerUseService, Finder, CursorUIViewService\)/);
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

test('repeated failing jobs share one alert; a passing job comments, closes, and clears the episode', () => {
  const first = check(asnShape('UserNotificationCenter'), 0, { logOutput: firewallNew });
  const second = first.again(asnShape('UserNotificationCenter'));
  assert.equal(second.status, 1);
  assert.equal(second.ghCalls.length, 1, 'no repeat issue for another job in the same episode');
  const passed = second.again(asnShape('Terminal'));
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.state, null);
  assert.deepEqual(passed.ghCalls.map((call) => call.slice(0, 2)), [['issue', 'create'], ['issue', 'comment'], ['issue', 'close']]);
  assert.equal(passed.ghCalls[1][2], alertURL);
  assert.match(argValue(passed.ghCalls[1], '--body'), /^cleared at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(passed.ghCalls[2][2], alertURL);
  const quiet = passed.again(asnShape('Terminal'));
  assert.equal(quiet.ghCalls.length, 3, 'a later passing job does nothing');
  const next = quiet.again(asnShape('loginwindow'));
  assert.equal(next.status, 1);
  assert.equal(next.ghCalls.length, 4, 'a new episode alerts again');
});

test('a non-dialog app that needs Terminal also clears the alert once the check passes', () => {
  const first = check(asnShape('loginwindow'), 0, { afterOpen: asnShape('Terminal') });
  const passed = first.again(asnShape('Finder'));
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.state, null);
  assert.equal(passed.ghCalls.at(-1)[1], 'close');
});

test('gh failure is logged, remembered without retries, and cannot change a failing or passing job', () => {
  const first = check(asnShape('SecurityAgent'), 0, { ghStatus: 1 });
  assert.equal(first.status, 1);
  assert.notEqual(first.state, null, 'a failed alert still records the episode');
  assert.match(first.log, /alert.*(failed|timed out)/);
  const second = first.again(asnShape('SecurityAgent'));
  assert.equal(second.status, 1);
  assert.equal(second.ghCalls.length, 1);
  const passed = second.again(asnShape('Terminal'));
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.state, null);
  // Also exercise failures of the comment and close calls when an issue was created successfully.
  const succeeds = check(asnShape('loginwindow'));
  const clearFails = succeeds.again(asnShape('Terminal'), { ghExit: 1 });
  assert.equal(clearFails.status, 0, clearFails.stderr);
  assert.equal(clearFails.state, null);
  assert.deepEqual(clearFails.ghCalls.map((call) => call[1]), ['create', 'comment', 'close']);
  assert.match(clearFails.log, /alert.*(failed|timed out)/);
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

test('a hung gh call that ignores SIGALRM is terminated and reaped without retrying the same episode', () => {
  const started = Date.now();
  const run = check(asnShape('loginwindow'), 0, { ghHang: true });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(Date.now() - started < 15_000, 'the gh deadline is enforced');
  assert.deepEqual(run.ghSurvivors, [], 'the timed-out gh process is terminated and reaped');
  assert.equal(run.state, '', 'a timed-out create remembers the episode without an issue URL');
  assert.match(run.log, /dialog alert issue creation failed or timed out/);
  const next = run.again(asnShape('loginwindow'));
  assert.equal(next.status, 1);
  assert.equal(next.ghCalls.length, 1);
});

test('hung gh cleanup calls that ignore SIGALRM do not block a passing job or retain the episode', () => {
  const first = check(asnShape('loginwindow'));
  assert.equal(first.state.trim(), alertURL);
  const started = Date.now();
  const passed = first.again(asnShape('Terminal'), { ghStall: true });
  assert.equal(passed.status, 0, passed.stderr);
  assert.ok(Date.now() - started < 25_000, 'comment and close each have a 10 s deadline');
  assert.deepEqual(passed.ghSurvivors, [], 'both timed-out gh processes are terminated and reaped');
  assert.equal(passed.state, null);
  assert.deepEqual(passed.ghCalls.map((call) => call[1]), ['create', 'comment', 'close']);
  assert.match(passed.log, /dialog alert clear comment failed or timed out/);
  assert.match(passed.log, /dialog alert close failed or timed out/);
  const next = passed.again(asnShape('Terminal'));
  assert.equal(next.status, 0, next.stderr);
  assert.equal(next.ghCalls.length, 3, 'a later passing job does not repeat cleanup');
});
