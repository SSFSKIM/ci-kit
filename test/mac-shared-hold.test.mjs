import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asnShape, terminal } from './fake-mac-desktop.mjs';

// Admission to the desktop on a Mac with shared instances (mac/hooks/shared-hold.sh, instances.sh): each instance runs
// its own installed copy of the hooks, and each job is a stand-in Runner.Worker (worker.sh below), a real process, so
// the hooks name it by its pid and start time as they name a worker. The desktop (lsappinfo, open), the posture read,
// the sweep (node), the unified log and gh are faked; the lock, the markers and the processes are real.
const macOnly = { skip: process.platform !== 'darwin' };
const hooks = fileURLToPath(new URL('../mac/hooks/', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-kit-shared-')));
after(() => rmSync(root, { recursive: true, force: true }));
const hookFiles = ['job-started.sh', 'job-completed.sh', 'desktop-check.sh', 'desktop-posture.sh', 'dialog.sh', 'dialog-watch.sh',
  'runner-hold.sh', 'runner-state.py', 'sweep.mjs', 'strays.mjs', 'terminate.mjs', 'instances.sh', 'shared-hold.sh', 'desktop-lock.sh'];
const security = asnShape('SecurityAgent', 'com.apple.SecurityAgent', 4711);
const executable = (path, body) => { writeFileSync(path, `#!/bin/bash\n${body}\n`); chmodSync(path, 0o755); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, what, ms = 20_000) {
  for (let waited = 0; !predicate(); waited += 25) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const lstart = (pid) => spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } }).stdout.trim();

// A job's Runner.Worker, as the hooks see it: their parent. It runs the started hook, then the job until told to end,
// then the completed hook, as the runner does whatever the start's result (the completed hook's condition is always()).
const worker = join(root, 'worker.sh');
executable(worker, `job=$1 hooks=$2
bash -e -o pipefail "$hooks/job-started.sh" >"$job/started.out" 2>"$job/started.err"
echo $? >"$job/started.status"
until [[ -e $job/end ]]; do sleep 0.05; done
bash -e -o pipefail "$hooks/job-completed.sh" >"$job/completed.out" 2>"$job/completed.err"
echo $? >"$job/completed.status"`);

const children = [];
after(() => { for (const child of children) child.kill('SIGKILL'); });

function mac({ shared = [2], env = {} } = {}) {
  const home = mkdtempSync(join(root, 'home-'));
  const bin = join(home, 'bin');
  const logs = join(home, 'Library/Logs/ci-kit');
  mkdirSync(bin);
  mkdirSync(logs, { recursive: true });
  const instance = (n) => join(home, n === 1 ? 'actions-runner-maws' : `actions-runner-maws-${n}`);
  for (const n of [1, ...shared]) {
    const dir = join(instance(n), 'ci-kit/hooks');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(instance(n), '_work'));
    for (const file of hookFiles) copyFileSync(join(hooks, file), join(dir, file));
    executable(join(dir, 'desktop-posture.sh'), 'exit 0');
  }
  const front = join(home, 'front');
  writeFileSync(front, terminal);
  executable(join(bin, 'lsappinfo'), `if [[ $1 == front ]]; then echo 'ASN:0x0-0x1:'; exit 0; fi\ncat '${front}'`);
  executable(join(bin, 'open'), 'exit 0');
  // The sweep: each call recorded as the instance whose _work it sweeps (--work, else the copy's own) and its other
  // arguments; a copy that is not there fails, as node would, and so does an instance listed in sweep-fail.
  executable(join(bin, 'node'), `[[ -f $1 ]] || { echo "node: cannot find $1" >&2; exit 1; }
root=\${1%/ci-kit/hooks/sweep.mjs}; shift; args=()
while (($# > 0)); do if [[ $1 == --work ]]; then root=\${2%/_work}; shift 2; continue; fi; args+=("$1"); shift; done
printf '%s %s\\n' "\${root##*/}" "\${args[*]}" >> "$HOME/sweeps"
[[ -f $HOME/sweep-fail ]] && grep -qxF "\${root##*/}" "$HOME/sweep-fail" && exit 1
exit 0`);
  executable(join(bin, 'unified-log'), 'exit 0');
  executable(join(bin, 'gh'), `printf '%s\\0' "$@" >> "$HOME/gh-args"; printf '\\0' >> "$HOME/gh-args"
if [[ $1 == issue && $2 == create ]]; then echo https://github.com/SSFSKIM/ci-kit-sandbox/issues/77; fi
exit 0`);
  const base = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, CI_KIT_MACHINE: 'mini', CI_KIT_SHARED_POLL: '0.05', CI_KIT_LOG_BIN: join(bin, 'unified-log'), CI_KIT_GH_BIN: join(bin, 'gh'), ...env };
  const text = (path) => existsSync(path) ? readFileSync(path, 'utf8') : '';
  let runs = 40;
  const api = {
    home, logs, instance, front,
    hold: () => existsSync(join(logs, 'shared-hold')) ? readFileSync(join(logs, 'shared-hold'), 'utf8') : null,
    marker: (n) => existsSync(join(logs, `shared-running-${n}`)) ? readFileSync(join(logs, `shared-running-${n}`), 'utf8') : null,
    log: () => text(join(logs, 'mac-runner-hooks.log')),
    sweeps: () => text(join(home, 'sweeps')).trim().split('\n').filter(Boolean),
    ghCalls: () => text(join(home, 'gh-args')).split('\0\0').filter(Boolean).map((call) => call.split('\0')),
    failSweep: (...names) => writeFileSync(join(home, 'sweep-fail'), names.map((name) => `${name}\n`).join('')),
    // One job on instance n: started, then running until end(), then completed.
    job(n, { env: extra = {} } = {}) {
      const run = String(++runs);
      const dir = mkdtempSync(join(home, `job-${run}-`));
      const child = spawn('/bin/bash', [worker, dir, join(instance(n), 'ci-kit/hooks')], {
        stdio: 'ignore', env: { ...base, GITHUB_RUN_ID: run, GITHUB_JOB: 'e2e', ...extra },
      });
      children.push(child);
      const status = (phase) => existsSync(join(dir, `${phase}.status`)) ? Number(readFileSync(join(dir, `${phase}.status`), 'utf8')) : null;
      const job = {
        run, pid: child.pid,
        status: () => status('started'),
        stderr: () => text(join(dir, 'started.err')),
        started: async () => { await until(() => status('started') !== null, `run ${run}'s start`); return status('started'); },
        end: async () => { writeFileSync(join(dir, 'end'), ''); await until(() => status('completed') !== null, `run ${run}'s end`); return status('completed'); },
      };
      return job;
    },
    // The dialog watcher's run, from the exclusive instance's hooks.
    watch: () => spawnSync('/bin/bash', [join(instance(1), 'ci-kit/hooks/dialog-watch.sh')], { encoding: 'utf8', timeout: 60_000, env: { ...base, CI_KIT_IDLE_GAP: '0' } }),
  };
  return api;
}

// A worker that is not a job of the harness: a process whose pid and start time a marker names.
async function process_() {
  const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  children.push(child);
  await once(child, 'spawn');
  return { pid: child.pid, started: lstart(child.pid), kill: async () => { const gone = once(child, 'exit'); child.kill('SIGKILL'); await gone; } };
}
const markerText = (what, { pid, started }, run = '7') => `${what} since 2026-10-21T10:00:00Z: run ${run} job e2e (worker ${pid})\nrun=${run}\nattempt=1\njob=e2e\nworker=${pid}\nstarted=${started}\nsince=2026-10-21T10:00:00Z\n`;
// Holds the desktop lock from another process until the returned function is called.
async function holdLock(m) {
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', `open(my $fh, ">>", shift) or die; flock($fh, LOCK_EX) or die; $| = 1; print "locked\\n"; sleep 60`,
    join(m.logs, 'desktop.lock')], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(holder);
  await once(holder.stdout, 'data');
  return holder;
}

test('the interleaving that was a race is serialized: a shared start holding the lock between its check and its write blocks the exclusive raise', async () => {
  const m = mac();
  // A shared hook mid-admission: it holds the lock, has seen no hold, and writes its running marker.
  const holder = await holdLock(m);
  const neighbour = await process_();
  const exclusive = m.job(1);
  writeFileSync(join(m.logs, 'shared-running-2'), markerText('running', neighbour));
  await sleep(800);
  assert.equal(m.hold(), null, 'no hold while the shared start holds the lock');
  holder.kill('SIGTERM');
  await until(() => /shared-hold run=\d+ job=e2e waiting for shared runner 2: run 7 job e2e \(worker \d+\)/.test(m.log()), 'the wait');
  await sleep(500);
  assert.equal(exclusive.status(), null, 'the marker written under the lock holds the exclusive job');
  await neighbour.kill();
  assert.equal(await exclusive.started(), 0, exclusive.stderr());
  assert.equal(m.marker(2), null, 'a marker whose worker is gone is dropped');
  assert.match(m.log(), /the marker of shared runner 2, run 7 job e2e \(worker \d+\), is stale: its worker is gone/);
  assert.deepEqual(m.sweeps(), ['actions-runner-maws-2 shared-hold --spare-workers', 'actions-runner-maws job-started']);
  assert.equal(await exclusive.end(), 0);
  assert.equal(m.hold(), null);
});

test('a shared job parks while the hold is up, then is admitted once the exclusive job ends', async () => {
  const m = mac();
  const exclusive = m.job(1);
  assert.equal(await exclusive.started(), 0, exclusive.stderr());
  assert.match(m.hold(), new RegExp(`^held since .*: run ${exclusive.run} job e2e \\(worker ${exclusive.pid}\\)\\n`));
  const shared = m.job(2);
  await until(() => new RegExp(`parked: an exclusive job, run ${exclusive.run} job e2e, holds the desktop since `).test(m.log()), 'the parked job');
  await sleep(500);
  assert.equal(shared.status(), null, 'parked in its own start');
  assert.equal(await exclusive.end(), 0);
  assert.equal(await shared.started(), 0, shared.stderr());
  assert.match(m.marker(2), new RegExp(`^running since .*: run ${shared.run} job e2e \\(worker ${shared.pid}\\)\\n(.|\\n)*started=${lstart(shared.pid).replace(/ +/g, ' +')}\\n`));
  assert.match(m.log(), /admitted after \d+ s/);
  assert.equal(await shared.end(), 0);
  assert.equal(m.marker(2), null, 'its end removes it, after its own sweep');
  const sweeps = m.sweeps();
  assert.ok(sweeps.indexOf('actions-runner-maws-2 job-completed') >= 0);
});

test('a shared job parks while the dialog watcher holds the runners, and is admitted once the hold is released', async () => {
  const m = mac();
  writeFileSync(join(m.logs, 'runner-drained'), 'held at 2026-10-21T10:02:00Z: SecurityAgent since 2026-10-21T10:01:00Z\n');
  const shared = m.job(2);
  await until(() => /parked: the dialog watcher holds every runner \(held at 2026-10-21T10:02:00Z: SecurityAgent since 2026-10-21T10:01:00Z\)/.test(m.log()), 'the parked job');
  await sleep(300);
  assert.equal(shared.status(), null);
  assert.equal(m.marker(2), null);
  rmSync(join(m.logs, 'runner-drained'));
  assert.equal(await shared.started(), 0, shared.stderr());
  assert.notEqual(m.marker(2), null);
  await shared.end();
});

test('an exclusive job waits for a running shared job and is admitted after its end, which sweeps before it releases', async () => {
  const m = mac();
  const shared = m.job(2);
  assert.equal(await shared.started(), 0, shared.stderr());
  const exclusive = m.job(1);
  await until(() => new RegExp(`waiting for shared runner 2: run ${shared.run} job e2e \\(worker ${shared.pid}\\)`).test(m.log()), 'the wait');
  await sleep(500);
  assert.equal(exclusive.status(), null, 'waiting for the shared job');
  assert.equal(await shared.end(), 0);
  assert.equal(await exclusive.started(), 0, exclusive.stderr());
  const sweeps = m.sweeps();
  assert.ok(sweeps.indexOf('actions-runner-maws-2 job-completed') < sweeps.indexOf('actions-runner-maws-2 shared-hold --spare-workers'), sweeps.join('\n'));
  assert.match(m.log(), /admitted after \d+ s: no shared job runs, and the shared work directories are swept/);
  // Its end drops the hold only after its own sweep.
  assert.equal(await exclusive.end(), 0);
  assert.equal(m.hold(), null);
  assert.equal(m.sweeps().at(-1), 'actions-runner-maws job-completed');
});

test('a dead shared worker\'s marker is stale, and what it left is swept while another shared job stays parked', async () => {
  const m = mac({ shared: [2, 3] });
  const dead = await process_();
  const deadMarker = markerText('running', dead, '9');
  await dead.kill();
  writeFileSync(join(m.logs, 'shared-running-2'), deadMarker);
  const running = m.job(3);
  assert.equal(await running.started(), 0, running.stderr());
  const exclusive = m.job(1);
  await until(() => m.hold() !== null, 'the hold');
  const parked = m.job(2);
  await until(() => /parked: an exclusive job/.test(m.log()), 'the parked shared job');
  assert.equal(await running.end(), 0);
  assert.equal(await exclusive.started(), 0, exclusive.stderr());
  assert.match(m.log(), /the marker of shared runner 2, run 9 job e2e \(worker \d+\), is stale: its worker is gone/);
  const sweeps = m.sweeps();
  for (const name of ['actions-runner-maws-2', 'actions-runner-maws-3']) assert.ok(sweeps.includes(`${name} shared-hold --spare-workers`), sweeps.join('\n'));
  await sleep(500);
  assert.equal(parked.status(), null, 'still parked while the exclusive job runs');
  assert.equal(await exclusive.end(), 0);
  assert.equal(await parked.started(), 0, parked.stderr());
  assert.equal(await parked.end(), 0);
});

test('past its bound an exclusive job is refused, and its hold stays up until its own end', async () => {
  const m = mac();
  const shared = m.job(2);
  assert.equal(await shared.started(), 0, shared.stderr());
  const exclusive = m.job(1, { env: { CI_KIT_EXCLUSIVE_WAIT: '0.02' } });
  assert.equal(await exclusive.started(), 1);
  assert.match(exclusive.stderr(), new RegExp(`^ci-kit: the shared runners on the mini did not make way for an exclusive job \\(after 0\\.02 min: shared runner 2: run ${shared.run} job e2e \\(worker ${shared.pid}\\)\\); waited \\d+ s — rerun$`, 'm'));
  // Its steps that run after a failure must not meet a newly admitted shared job.
  assert.notEqual(m.hold(), null, 'the hold stays up after the refusal');
  const next = m.job(2);
  await sleep(500);
  assert.equal(next.status(), null);
  assert.equal(await exclusive.end(), 0);
  assert.equal(m.hold(), null);
  assert.match(m.log(), new RegExp(`removed the hold of run ${exclusive.run} job e2e \\(worker ${exclusive.pid}\\) \\(its job ended\\)`));
  assert.equal(await shared.end(), 0);
  assert.equal(await next.started(), 0);
  await next.end();
});

test('past its bound a parked shared job is refused, naming the hold, with no claim left behind', async () => {
  const m = mac();
  const exclusive = m.job(1);
  assert.equal(await exclusive.started(), 0, exclusive.stderr());
  const shared = m.job(2, { env: { CI_KIT_SHARED_WAIT: '0.02' } });
  assert.equal(await shared.started(), 1);
  assert.match(shared.stderr(), new RegExp(`^ci-kit: shared runner 2 on the mini waited 0\\.02 min to start \\(an exclusive job, run ${exclusive.run} job e2e, holds the desktop since \\S+\\) — rerun$`, 'm'));
  assert.equal(m.marker(2), null);
  assert.equal(await shared.end(), 0, 'its end finds nothing to release');
  assert.notEqual(m.hold(), null, "the exclusive job's hold is not its");
  await exclusive.end();
});

test('a start refused after its admission keeps its claim until its job-completed hook', async () => {
  const m = mac();
  writeFileSync(m.front, security);
  const shared = m.job(2);
  assert.equal(await shared.started(), 1);
  assert.match(shared.stderr(), /^ci-kit: a system dialog \(SecurityAgent: source unknown\) holds focus on the mini since \S+ — dismiss it there and rerun$/m);
  assert.match(m.marker(2), new RegExp(`worker=${shared.pid}\\n`), 'the marker stays: steps after a failure still run');
  assert.equal(await shared.end(), 0);
  assert.equal(m.marker(2), null);
  const exclusive = m.job(1);
  assert.equal(await exclusive.started(), 1);
  assert.notEqual(m.hold(), null, 'the hold stays too');
  assert.equal(await exclusive.end(), 0);
  assert.equal(m.hold(), null);
});

test('the watcher reconciles a crashed exclusive job\'s hold; a failed sweep keeps it up and alerts once, outside the dialog alerts\' pattern', async () => {
  const m = mac();
  const dead = await process_();
  await dead.kill();
  writeFileSync(join(m.logs, 'shared-hold'), markerText('held', dead, '5'));
  const parked = m.job(2);
  await until(() => /parked: an exclusive job, run 5 job e2e/.test(m.log()), 'the parked shared job');
  m.failSweep('actions-runner-maws');
  for (const round of [1, 2]) {
    const run = m.watch();
    assert.equal(run.status, 0, run.stderr);
    assert.notEqual(m.hold(), null, `round ${round}: the hold stays`);
    const creates = m.ghCalls().filter((call) => call[1] === 'create');
    assert.equal(creates.length, 1, `round ${round}: one alert`);
    const title = creates[0][creates[0].indexOf('--title') + 1];
    assert.match(title, /^ci-kit alert: shared hold stuck on mini since \d{4}-\d\d-\d\dT\d\d:\d\dZ: the exclusive instance's leftovers survived the sweep$/);
    // MAWS's ci-gate.sh reads an open alert with this pattern as a dialog on the machine (docs/mac-lane.md).
    assert.doesNotMatch(title, /^ci-kit alert: ([a-z0-9-]+): (\S+) since (\S+)/);
  }
  assert.equal(parked.status(), null);
  m.failSweep();
  const run = m.watch();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(m.hold(), null);
  assert.match(m.log(), /dropped the hold of run 5 job e2e \(worker \d+\): its job is over and its work directory swept/);
  const close = m.ghCalls().find((call) => call[1] === 'close');
  assert.deepEqual(close.slice(0, 3), ['issue', 'close', 'https://github.com/SSFSKIM/ci-kit-sandbox/issues/77']);
  assert.equal(existsSync(join(m.logs, 'shared-hold.alert')), false);
  assert.ok(m.sweeps().every((sweep) => sweep === 'actions-runner-maws shared-hold --spare-workers'), m.sweeps().join('\n'));
  assert.equal(await parked.started(), 0);
  await parked.end();
  // A live owner's hold is left alone.
  const exclusive = m.job(1);
  assert.equal(await exclusive.started(), 0);
  const before = m.sweeps().length;
  assert.equal(m.watch().status, 0);
  assert.notEqual(m.hold(), null);
  assert.equal(m.sweeps().length, before);
  await exclusive.end();
});

test('a holder killed mid-transition leaves no lock: the next start takes it at once', async () => {
  const m = mac();
  const holder = await holdLock(m);
  const gone = once(holder, 'exit');
  holder.kill('SIGKILL');
  await gone;
  const started = Date.now();
  const exclusive = m.job(1);
  assert.equal(await exclusive.started(), 0, exclusive.stderr());
  assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
  await exclusive.end();
});

test('after a reboot: the markers on disk name gone workers, the wrappers start every runner, and the lane recovers', async () => {
  const m = mac();
  const before = await process_();
  await before.kill();
  writeFileSync(join(m.logs, 'shared-hold'), markerText('held', before, '3'));
  writeFileSync(join(m.logs, 'shared-running-2'), markerText('running', before, '4'));
  // The wrappers wait on the dialog watcher's hold alone: a shared runner starts, and its jobs park behind the hold.
  for (const n of [1, 2]) {
    writeFileSync(join(m.instance(n), 'runsvc.sh'), '#!/bin/bash\necho runsvc\n');
    chmodSync(join(m.instance(n), 'runsvc.sh'), 0o755);
    const wrapper = spawnSync('/bin/bash', [join(m.instance(n), 'ci-kit/hooks/runner-hold.sh')], { cwd: m.instance(n), encoding: 'utf8', timeout: 10_000, env: { HOME: m.home, PATH: '/usr/bin:/bin' } });
    assert.equal(wrapper.stdout, 'runsvc\n', `instance ${n}`);
  }
  // The exclusive instance's next job finds both stale: it sweeps what its own crashed job left, then the shared _work.
  const exclusive = m.job(1);
  assert.equal(await exclusive.started(), 0, exclusive.stderr());
  assert.match(m.log(), /the hold of run 3 job e2e \(worker \d+\) outlived its job; sweeping .*\/actions-runner-maws\/_work/);
  assert.deepEqual(m.sweeps(), ['actions-runner-maws shared-hold --spare-workers', 'actions-runner-maws-2 shared-hold --spare-workers', 'actions-runner-maws job-started']);
  assert.equal(m.marker(2), null);
  await exclusive.end();
  // A stale hold whose sweep fails is still replaced, and the job refused: its end, or the watcher, owns it then.
  writeFileSync(join(m.logs, 'shared-hold'), markerText('held', before, '3'));
  m.failSweep('actions-runner-maws');
  const refused = m.job(1);
  assert.equal(await refused.started(), 1);
  assert.match(refused.stderr(), /^ci-kit: the shared runners on the mini did not make way for an exclusive job \(the work directory of run 3 job e2e \(worker \d+\) could not be swept\); waited \d+ s — rerun$/m);
  assert.match(m.hold(), new RegExp(`worker=${refused.pid}\\n`));
});

test('a shared directory an install left half-way, without its copy of the hooks, does not stop exclusive jobs', async () => {
  const m = mac();
  // Registration failed after the runner's files were laid down: no ci-kit/hooks there.
  mkdirSync(join(m.instance(3), '_work'), { recursive: true });
  const exclusive = m.job(1);
  assert.equal(await exclusive.started(), 0, exclusive.stderr());
  assert.ok(m.sweeps().includes('actions-runner-maws-3 shared-hold --spare-workers'), m.sweeps().join('\n'));
  assert.equal(await exclusive.end(), 0);
});

test('with no shared instance the hooks are today\'s: no lock, no hold, no admission line', async () => {
  const m = mac({ shared: [] });
  const exclusive = m.job(1);
  assert.equal(await exclusive.started(), 0, exclusive.stderr());
  assert.equal(await exclusive.end(), 0);
  for (const file of ['desktop.lock', 'shared-hold']) assert.equal(existsSync(join(m.logs, file)), false, file);
  assert.doesNotMatch(m.log(), /shared-hold/);
  assert.deepEqual(m.sweeps(), ['actions-runner-maws job-started', 'actions-runner-maws job-completed']);
});

// The recovery sweep against real processes (sweep.mjs reads ps and lsof): the next exclusive worker starts between the
// watcher's decision and the sweep's own process list; it and its hook survive, what the crashed job left does not.
for (const [where, prefix, link] of [['', 'real-'], [' under a path with a space', 'real home '], [' under a home that is a symlink', 'real-linked-', true]]) test(`a recovery sweep spares a worker that started after the decision, and its hook; the crashed job's leftover goes${where}`, macOnly, async () => {
  // ps prints a command line unquoted: a path with a space must not hide a worker from the sweep (the kernel's path does).
  // lsof prints a working directory's physical path: a home reached through a symlink must not hide a leftover.
  let home = realpathSync(mkdtempSync(join(root, prefix)));
  if (link) {
    const alias = `${home}-alias`;
    symlinkSync(home, alias);
    home = alias;
  }
  const lane = join(home, 'actions-runner-maws');
  const installed = join(lane, 'ci-kit/hooks');
  const workspace = join(lane, '_work/MAWS/MAWS');
  const logs = join(home, 'Library/Logs/ci-kit');
  for (const dir of [installed, workspace, logs, join(lane, 'bin')]) mkdirSync(dir, { recursive: true });
  for (const file of hookFiles) copyFileSync(join(hooks, file), join(installed, file));
  const dead = await process_();
  await dead.kill();
  writeFileSync(join(logs, 'shared-hold'), markerText('held', dead, '5'));
  // The next job's worker (a clone of node at the worker's path) and its start hook, sitting in the workspace.
  const workerPath = join(lane, 'bin/Runner.Worker');
  copyFileSync(process.execPath, workerPath, constants.COPYFILE_FICLONE);
  const next = spawn(workerPath, ['-e', `require('node:child_process').spawn('/bin/sleep', ['60'], { cwd: ${JSON.stringify(workspace)}, stdio: 'ignore' }); console.log('hooked'); setTimeout(() => {}, 60_000)`], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(next);
  await once(next.stdout, 'data');
  const hook = Number(spawnSync('/usr/bin/pgrep', ['-P', String(next.pid)], { encoding: 'utf8' }).stdout.trim());
  // What the crashed job left: a process sitting in the workspace, its parent gone (launchd reaps it).
  const leftover = { pid: Number(spawnSync('/bin/sh', ['-c', 'cd "$1" && { /bin/sleep 60 >/dev/null 2>&1 & echo $!; }', 'sh', workspace], { encoding: 'utf8' }).stdout.trim()) };
  after(() => { try { process.kill(leftover.pid, 'SIGKILL'); } catch {} });
  const run = spawnSync('/bin/bash', [join(installed, 'shared-hold.sh'), 'reconcile'], {
    encoding: 'utf8', timeout: 60_000, env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CI_KIT_MACHINE: 'mini' },
  });
  assert.equal(run.status, 0, run.stderr);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(next.pid), 'the worker');
  assert.ok(alive(hook), 'its hook');
  await until(() => !alive(leftover.pid), 'the leftover to go', 15_000);
  assert.equal(existsSync(join(logs, 'shared-hold')), false);
  const log = readFileSync(join(logs, 'mac-runner-hooks.log'), 'utf8');
  assert.match(log, new RegExp(`shared-hold run=- job=- kill pid=${leftover.pid} \\(cwd\\)`));
  assert.doesNotMatch(log, new RegExp(`kill pid=(${next.pid}|${hook}) `));
});
