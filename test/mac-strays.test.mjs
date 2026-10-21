import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityOf, parsePs, parseLsofCwd, selectStrays } from '../mac/hooks/strays.mjs';

const WORK = '/Users/new/actions-runner-maws/_work';
const UID = 501;

// A process table shaped like the mini's during a MAWS e2e job: launchd, the runner's service chain, the hook itself,
// an Electron app left from the job with a pty shell in /tmp, and neighbours that must survive.
const proc = (pid, ppid, command, uid = UID) => ({ pid, ppid, uid, command });
const table = [
  proc(1, 0, '/sbin/launchd', 0),
  proc(100, 1, '/bin/bash /Users/new/actions-runner-maws/runsvc.sh'),
  proc(101, 100, '/Users/new/actions-runner-maws/bin/Runner.Listener run --startuptype service'),
  proc(102, 101, '/Users/new/actions-runner-maws/bin/Runner.Worker spawnclient 115 118'),
  proc(103, 102, '/bin/bash -e /Users/new/actions-runner-maws/ci-kit/hooks/job-completed.sh'),
  proc(104, 103, '/opt/homebrew/bin/node /Users/new/actions-runner-maws/ci-kit/hooks/sweep.mjs job-completed'),
  proc(105, 104, 'ps -axo pid=,ppid=,uid=,command='),
  proc(200, 1, '/Users/new/actions-runner-maws/_work/MAWS/MAWS/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js'),
  proc(201, 200, '/Users/new/actions-runner-maws/_work/MAWS/MAWS/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer'),
  proc(202, 200, '/bin/zsh -l'),
  proc(203, 202, 'sleep 600'),
  proc(300, 1, '/Users/new/actions-runner-maws/_work/_tool/node/22.20.0/arm64/bin/node node_modules/vitest/vitest.mjs run'),
  proc(400, 1, 'node /Users/new/scratch/server.js'),
  proc(500, 1, '/Users/new/actions-runner-ida-solution/_work/ida/ida/node_modules/.bin/jest'),
  proc(501, 1, '/Users/new/actions-runner-maws/_work2/x/run.sh'),
  proc(600, 1, '/usr/sbin/someroot /Users/new/actions-runner-maws/_work/MAWS', 0),
  proc(700, 1, '/bin/zsh -i'),
  proc(701, 700, 'claude'),
];
const cwds = new Map([
  [102, '/Users/new/actions-runner-maws'],
  [103, `${WORK}/MAWS/MAWS`],
  [104, `${WORK}/MAWS/MAWS`],
  [105, `${WORK}/MAWS/MAWS`],
  [202, '/private/tmp/maws-e2e-abc'],
  [400, `${WORK}/MAWS/MAWS/e2e`],
  [700, '/Users/new/Developer/GitHub/cua'],
]);

const pids = (strays) => strays.map((s) => s.pid).sort((a, b) => a - b);

test('selects what runs from the work directory, what sits in it, and their descendants', () => {
  const strays = selectStrays({ processes: table, cwds, workDir: WORK, uid: UID, self: 104 });
  assert.deepEqual(pids(strays), [200, 201, 202, 203, 300, 400]);
  const reason = Object.fromEntries(strays.map((s) => [s.pid, s.reason]));
  assert.equal(reason[200], 'command');
  assert.equal(reason[400], 'cwd');
  assert.equal(reason[203], 'child of 202');
  assert.equal(reason[202], 'child of 200');
});

test('never selects the sweep itself, its ancestors, or its own children, though they sit in the work directory', () => {
  const strays = selectStrays({ processes: table, cwds, workDir: WORK, uid: UID, self: 104 });
  for (const pid of [1, 100, 101, 102, 103, 104, 105]) assert.ok(!pids(strays).includes(pid), `pid ${pid} selected`);
});

test('a sibling of the hook under the same runner worker is still selected', () => {
  const sibling = proc(106, 102, `${WORK}/_tool/node/22.20.0/arm64/bin/node leftover.js`);
  const strays = selectStrays({ processes: [...table, sibling], cwds, workDir: WORK, uid: UID, self: 104 });
  assert.ok(pids(strays).includes(106));
});

test('another runner, a look-alike directory, other users and unrelated sessions are left alone', () => {
  const strays = selectStrays({ processes: table, cwds, workDir: WORK, uid: UID, self: 104 });
  for (const pid of [500, 501, 600, 700, 701]) assert.ok(!pids(strays).includes(pid), `pid ${pid} selected`);
});

test('the work directory itself counts, with or without a trailing slash in the argument', () => {
  const processes = [proc(800, 1, 'tail -f /x'), proc(801, 1, `/bin/ls ${WORK}`)];
  const strays = selectStrays({ processes, cwds: new Map([[800, WORK]]), workDir: `${WORK}/`, uid: UID, self: 9999 });
  assert.deepEqual(pids(strays), [800, 801]);
});

test('a descendant of another user is not selected through its parent', () => {
  const processes = [proc(900, 1, `${WORK}/x/run`), proc(901, 900, '/usr/bin/sudo-thing', 0)];
  const strays = selectStrays({ processes, cwds: new Map(), workDir: WORK, uid: UID, self: 9999 });
  assert.deepEqual(pids(strays), [900]);
});

test('parsePs reads `ps -axo pid=,ppid=,uid=,lstart=,command=` (C locale): start time apart, a negative uid (nobody, -2), commands with spaces whole', () => {
  const text = [
    '    1     0     0 Fri Oct  9 18:53:38 2026     /sbin/launchd',
    '  338     1    -2 Fri Oct  9 18:53:52 2026     /usr/sbin/distnoted agent',
    '  201   200   501 Thu Oct 15 22:02:31 2026     /a/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer',
    '',
  ].join('\n');
  assert.deepEqual(parsePs(text), [
    { pid: 1, ppid: 0, uid: 0, started: 'Fri Oct  9 18:53:38 2026', command: '/sbin/launchd' },
    { pid: 338, ppid: 1, uid: -2, started: 'Fri Oct  9 18:53:52 2026', command: '/usr/sbin/distnoted agent' },
    { pid: 201, ppid: 200, uid: 501, started: 'Thu Oct 15 22:02:31 2026', command: '/a/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer' },
  ]);
});

test('each stray carries its birth identity, uid and start time, for revalidation before a signal', () => {
  const processes = [{ pid: 900, ppid: 1, uid: UID, started: 'Thu Oct 15 22:02:31 2026', command: `${WORK}/x/run` }];
  const [stray] = selectStrays({ processes, cwds: new Map(), workDir: WORK, uid: UID, self: 9999 });
  assert.equal(stray.identity, identityOf(processes[0]));
  assert.equal(identityOf(processes[0]), '501 Thu Oct 15 22:02:31 2026');
});

test('parseLsofCwd reads `lsof -a -d cwd -Fpn` output into pid → cwd', () => {
  const text = ['p228', 'fcwd', 'n/', 'p289', 'fcwd', `n${WORK}/MAWS/MAWS`, 'p300', 'fcwd', 'n/path with space', ''].join('\n');
  assert.deepEqual([...parseLsofCwd(text)], [
    [228, '/'],
    [289, `${WORK}/MAWS/MAWS`],
    [300, '/path with space'],
  ]);
});

// Instances (mac/hooks/instances.sh): the exclusive one in ~/actions-runner-maws, a shared one in
// ~/actions-runner-maws-2, each with its own _work and its own copy of the hooks.
const SHARED = '/Users/new/actions-runner-maws-2/_work';
const lanes = [
  proc(1, 0, '/sbin/launchd', 0),
  // The exclusive instance's job, running.
  proc(101, 1, '/Users/new/actions-runner-maws/bin/Runner.Listener run --startuptype service'),
  proc(102, 101, '/Users/new/actions-runner-maws/bin/Runner.Worker spawnclient 115 118'),
  proc(110, 102, `${WORK}/_tool/node/22.20.0/arm64/bin/node node_modules/.bin/playwright test`),
  proc(111, 110, `${WORK}/MAWS/MAWS/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js`),
  // The exclusive job's start hook, sweeping the shared _work (shared-hold.sh) before its job is admitted.
  proc(112, 102, '/bin/bash -e /Users/new/actions-runner-maws/ci-kit/hooks/job-started.sh'),
  proc(113, 112, '/opt/homebrew/bin/node /Users/new/actions-runner-maws-2/ci-kit/hooks/sweep.mjs shared-hold --spare-workers'),
  // The shared instance, updated to bin.2.339.0: one job parked in its own start hook, sitting in its workspace.
  proc(201, 1, '/Users/new/actions-runner-maws-2/bin.2.339.0/Runner.Listener run --startuptype service'),
  proc(202, 201, '/Users/new/actions-runner-maws-2/bin.2.339.0/Runner.Worker spawnclient 105 108'),
  proc(203, 202, '/bin/bash -e /Users/new/actions-runner-maws-2/ci-kit/hooks/job-started.sh'),
  proc(204, 203, 'sleep 1'),
  // What a dead shared job left: an orphaned Electron in the shared _work.
  proc(250, 1, `${SHARED}/MAWS/MAWS/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js`),
  // Not workers (runner-state.py --workers reads the kernel's paths): a process that only names one, another user's.
  proc(300, 1, 'grep Runner.Worker'),
  proc(301, 1, '/Users/other/actions-runner/bin/Runner.Worker spawnclient 1 2', 502),
];
const laneCwds = new Map([
  [102, '/Users/new/actions-runner-maws/bin'],
  [110, `${WORK}/MAWS/MAWS`],
  [112, `${WORK}/MAWS/MAWS`],
  [113, `${WORK}/MAWS/MAWS`],
  [202, '/Users/new/actions-runner-maws-2/bin.2.339.0'],
  [203, `${SHARED}/MAWS/MAWS`],
  [204, `${SHARED}/MAWS/MAWS`],
]);

test('each instance\'s sweep selects only its own leftovers while the other instance\'s job runs', () => {
  // The shared instance's own sweep, from its own job's hook: the exclusive job's processes are not under its _work.
  const shared = selectStrays({ processes: lanes, cwds: laneCwds, workDir: SHARED, uid: UID, self: 204 });
  assert.deepEqual(pids(shared), [250]);
  // The exclusive instance's: ~/actions-runner-maws/_work is not a prefix of ~/actions-runner-maws-2/_work.
  const exclusive = selectStrays({ processes: lanes, cwds: laneCwds, workDir: WORK, uid: UID, self: 999 });
  assert.deepEqual(pids(exclusive), [110, 111, 112, 113], 'by hand: the shared instance\'s processes are not its');
});

test('a sweep of another instance\'s _work spares every live worker\'s tree there, and takes what a dead job left', () => {
  // The exclusive start's sweep of the shared _work (shared-hold.sh): its own tree is the exclusive job's.
  const without = selectStrays({ processes: lanes, cwds: laneCwds, workDir: SHARED, uid: UID, self: 113 });
  assert.deepEqual(pids(without), [203, 204, 250], 'without sparing, the parked hook sits in the workspace');
  // The live workers, as runner-state.py --workers reads them from the kernel.
  const spared = selectStrays({ processes: lanes, cwds: laneCwds, workDir: SHARED, uid: UID, self: 113, spare: [102, 202] });
  assert.deepEqual(pids(spared), [250]);
});

test('a recovery sweep spares a worker that started after its caller last looked: its hook and helper survive', () => {
  // The dialog watcher reconciles a crashed exclusive job's hold. Between its decision and the sweep's own process list,
  // the exclusive instance's listener started the next job: its worker, its job-started hook in the workspace, and the
  // hook's helper. Only what the crashed job left goes.
  const next = [
    proc(1, 0, '/sbin/launchd', 0),
    proc(90, 1, '/bin/bash /Users/new/actions-runner-maws/ci-kit/hooks/dialog-watch.sh'),
    proc(91, 90, '/opt/homebrew/bin/node /Users/new/actions-runner-maws/ci-kit/hooks/sweep.mjs shared-hold --spare-workers'),
    proc(101, 1, '/Users/new/actions-runner-maws/bin/Runner.Listener run --startuptype service'),
    proc(120, 101, '/Users/new/actions-runner-maws/bin/Runner.Worker spawnclient 115 118'),
    proc(121, 120, '/bin/bash -e /Users/new/actions-runner-maws/ci-kit/hooks/job-started.sh'),
    proc(122, 121, 'perl -MFcntl=:flock -e …'),
    proc(150, 1, `${WORK}/MAWS/MAWS/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron out/main/index.js`),
  ];
  const cwdsNext = new Map([[121, `${WORK}/MAWS/MAWS`], [122, `${WORK}/MAWS/MAWS`]]);
  const strays = selectStrays({ processes: next, cwds: cwdsNext, workDir: WORK, uid: UID, self: 91, spare: [120] });
  assert.deepEqual(pids(strays), [150]);
});
