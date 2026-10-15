import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, parseLsofCwd, selectStrays } from '../mac/hooks/strays.mjs';

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

test('parsePs reads `ps -axo pid=,ppid=,uid=,command=` output, commands with spaces kept whole', () => {
  const text = [
    '    1     0     0 /sbin/launchd',
    '  201   200   501 /a/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer',
    '',
  ].join('\n');
  assert.deepEqual(parsePs(text), [
    { pid: 1, ppid: 0, uid: 0, command: '/sbin/launchd' },
    { pid: 201, ppid: 200, uid: 501, command: '/a/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer' },
  ]);
});

test('parseLsofCwd reads `lsof -a -d cwd -Fpn` output into pid → cwd', () => {
  const text = ['p228', 'fcwd', 'n/', 'p289', 'fcwd', `n${WORK}/MAWS/MAWS`, 'p300', 'fcwd', 'n/path with space', ''].join('\n');
  assert.deepEqual([...parseLsofCwd(text)], [
    [228, '/'],
    [289, `${WORK}/MAWS/MAWS`],
    [300, '/path with space'],
  ]);
});
