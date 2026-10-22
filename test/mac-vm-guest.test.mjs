import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, readdirSync, rmdirSync, unlinkSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asnShape, pairShape, terminal, windowLine, ordinaryWindows, displayplacer } from './fake-mac-desktop.mjs';

// The VM lane's guest (mac/vm/guest): kickoff.sh, which a launcher's `tart exec` runs in a fresh clone; wrapper.sh,
// which owns the clone's one runner and writes the out/ markers from its listener's diag log and processes; and the
// guest's job hooks. A guest here is a HOME with the four shares beside it (CI_KIT_VM_SHARES), a runner directory whose
// run.sh and Runner.Listener are fakes driven through a command file, and a Runner.Worker that is a real process at the
// runner's own bin/Runner.Worker path (a clone of node), so runner-state.py reads it as the kernel does. The desktop
// (lsappinfo, window-list, cursor-park, open), the unified log, gh and the power-off are fakes; gh records every call,
// and no test lets one through.
const guestDir = fileURLToPath(new URL('../mac/vm/guest/', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-kit-vm-guest-')));
const cleanups = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
  rmSync(root, { recursive: true, force: true });
});
// The worker is told apart by the kernel's path of its executable (runner-state.py, libproc): macOS only.
const macOnly = { skip: process.platform !== 'darwin' };
// An unreadable file is unreadable only to a user other than root.
const asUser = { skip: process.getuid?.() === 0 };
const macUser = { skip: process.platform !== 'darwin' || process.getuid?.() === 0 };
const executable = (path, body) => { writeFileSync(path, `#!/bin/bash\n${body}\n`); chmodSync(path, 0o755); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, what, ms = 20_000) {
  for (let waited = 0; !predicate(); waited += 25) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

// What actions/runner v2.338.0's listener writes to its diag log, _diag/Runner_<yyyyMMdd-HHmmss>-utc.log, one trace
// per line as `[{0:u} {type} {source}] {message}` (HostTraceListener.WriteHeader): {0:u} is `2026-10-21 12:00:05Z`,
// the type INFO, WARN, `ERR ` or VERB, the source the tracing class. Terminal.WriteLine traces `WRITE LINE: <line>` and
// WriteError `WRITE ERROR: <line>`.
const diag = {
  // Runner.cs RunAsync, once the session is created.
  listening: (at) => `INFO Terminal] WRITE LINE: ${at}: Listening for Jobs`,
  version: 'INFO Terminal] WRITE LINE: Current runner version: \'2.338.0\'',
  // BrokerMessageListener.cs / MessageListener.cs IsSessionCreationExceptionRetriable, on TaskAgentSessionConflictException.
  conflict: ['INFO BrokerMessageListener] The session for this runner already exists.', 'ERR  Terminal] WRITE ERROR: A session for this runner already exists.',
    'INFO BrokerMessageListener] The session conflict exception haven\'t reached retry limit.', 'INFO BrokerMessageListener] Sleeping for 30 seconds before retrying.'],
  // A broker message (BrokerMessageListener.GetNextMessageAsync), the job's acknowledgement (AcknowledgeMessageAsync),
  // and its dispatch (JobDispatcher.Run), then the console line of RunOnceAsync.
  message: 'INFO BrokerMessageListener] Message \'27\' received.',
  ack: 'INFO BrokerMessageListener] Acknowledging runner request \'7f0c4b5e-1111-4a2b-9c3d-2e6f8a9b0c1d\'.',
  dispatch: 'INFO JobDispatcher] Job request 0 for plan 3c1f7d2a-5b6e-4f80-9a1b-2c3d4e5f6a7b job 9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4 received.',
  running: (at) => `INFO Terminal] WRITE LINE: ${at}: Running job: e2e (document-app)`,
  // The legacy (non-broker) flow's receipt, Runner.cs.
  legacy: 'INFO Runner] Received job message of length 51234 from service, with hash \'abc\'',
  // Runner.cs, a RunnerRefreshMessage: the runner is about to update itself.
  update: 'INFO Runner] Refresh message received, kick-off selfupdate background process.',
  ctrlC: 'INFO Runner] Received Ctrl-C signal, stop Runner.Listener and Runner.Worker.',
};
const JOB = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
const stamp = (at) => `[${at} `;

// One fresh clone. The fake listener reads commands appended to ctl/commands, one per line:
//   listen | conflict | take (the job's lines and its worker) | worker (a worker and no line) | raw <diag line> |
//   exit <code> (the listener ends, as after its one job)
// and on SIGINT logs Ctrl-C, takes a job first when ctl/race exists (an acceptance racing the stop), and exits 0.
// path: the runner's .path, as the image's runner install writes it (null: none). mode: the guest's display mode as
// displayplacer reads it ("<res> <scaling>", null: the read fails), which the image's bake sets.
function guest({ identity = true, display = '2560x1440@2x', displayStatus = 0, worker = false, path = '/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', mode = '2560x1440 on' } = {}) {
  const home = mkdtempSync(join(root, 'guest-'));
  const bin = join(home, 'bin');
  const shares = join(home, 'shares');
  const runner = join(home, 'actions-runner-maws');
  const ctl = join(home, 'ctl');
  for (const dir of [bin, ctl, join(shares, 'out'), join(shares, 'identity'), join(shares, 'cache'), join(runner, 'bin')]) mkdirSync(dir, { recursive: true });
  if (identity) for (const file of ['.runner', '.credentials', '.credentials_rsaparams']) writeFileSync(join(shares, 'identity', file), `${file} of ci-kit-mac-mini-vm\n`);
  writeFileSync(join(ctl, 'commands'), '');
  if (path !== null) writeFileSync(join(runner, '.path'), `${path}\n`);
  executable(join(runner, 'run.sh'), `printf '%s\\n' "$*" >> '${ctl}/run.args'
"$(dirname "$0")/bin/Runner.Listener" run "$@"
exit $?`);
  executable(join(runner, 'bin/Runner.Listener'), `ctl='${ctl}'
runner=$(cd "$(dirname "$0")/.." && pwd)
env | grep '^CI_KIT_VM_\\(SLOT\\|CLONE\\)=' | sort > "$ctl/listener.env"
printf '%s\\n' "$PATH" > "$ctl/listener.path"
echo $$ > "$ctl/listener.pid"
mkdir -p "$runner/_diag"
log=$runner/_diag/Runner_$(date -u +%Y%m%d-%H%M%S)-utc.log
line() { printf '[%s %s\\n' "$(date -u '+%Y-%m-%d %H:%M:%SZ')" "$1" >> "$log"; }
now() { date -u '+%Y-%m-%d %H:%M:%SZ'; }
worker=''
spawn_worker() {
  "$runner/bin/Runner.Worker" -e 'setTimeout(() => {}, 60000)' </dev/null >/dev/null 2>&1 &
  worker=$!
  echo "$worker" > "$ctl/worker.pid"
}
# A job's lines in one append, so a reader sees all of them or none.
take() {
  local at
  at=$(now)
  printf '[%s %s\\n' "$at" ${JSON.stringify(diag.message)} "$at" ${JSON.stringify(diag.ack)} "$at" ${JSON.stringify(diag.dispatch)} \\
    "$at" "INFO Terminal] WRITE LINE: $at: Running job: e2e (document-app)" >> "$log"
  ${worker ? 'spawn_worker' : ':'}
}
interrupted=''
trap 'interrupted=1' INT
line 'INFO HostContext] Well known directory'
done_lines=0
while :; do
  if [[ -n $interrupted ]]; then
    line ${JSON.stringify(diag.ctrlC)}
    [[ ! -e $ctl/race ]] || take
    [[ -z $worker ]] || kill "$worker" 2>/dev/null
    echo interrupted > "$ctl/listener.end"
    exit 0
  fi
  total=$(grep -c '' "$ctl/commands")
  while ((done_lines < total)); do
    done_lines=$((done_lines + 1))
    command=$(sed -n "\${done_lines}p" "$ctl/commands")
    case $command in
      listen) line ${JSON.stringify(diag.version)}; line "INFO Terminal] WRITE LINE: $(now): Listening for Jobs" ;;
      conflict) ${diag.conflict.map((text) => `line ${JSON.stringify(text)}`).join('; ')} ;;
      take) take ;;
      worker) spawn_worker ;;
      raw\\ *) line "\${command#raw }" ;;
      exit\\ *) [[ -z $worker ]] || kill "$worker" 2>/dev/null; echo "exit" > "$ctl/listener.end"; exit "\${command#exit }" ;;
    esac
  done
  sleep 0.05
done`);
  if (worker) copyFileSync(process.execPath, join(runner, 'bin/Runner.Worker'), constants.COPYFILE_FICLONE);
  // The desktop: what lsappinfo says is in front (the file front, swapped for after when Terminal is opened), the
  // windows on screen, the display cursor-park describes.
  writeFileSync(join(home, 'front'), terminal);
  executable(join(bin, 'lsappinfo'), `if [[ $1 == front ]]; then echo 'ASN:0x0-0x1:'; exit 0; fi\ncat '${join(home, 'front')}'`);
  executable(join(bin, 'open'), `echo "$*" >> '${join(home, 'opened')}'\n[[ ! -f '${join(home, 'after')}' ]] || cp '${join(home, 'after')}' '${join(home, 'front')}'`);
  writeFileSync(join(home, 'windows'), ordinaryWindows);
  executable(join(bin, 'window-list'), `cat '${join(home, 'windows')}'`);
  writeFileSync(join(home, 'display'), display);
  executable(join(bin, 'cursor-park'), `if [[ \${1:-} != --describe ]]; then echo 'cursor before=1,1 after=1280,2 target=1280,2'; exit 0; fi
cat '${join(home, 'display')}'
exit ${displayStatus}`);
  executable(join(bin, 'unified-log'), 'exit 0');
  if (mode === null) writeFileSync(join(home, 'display-fail'), ''); else writeFileSync(join(home, 'display-mode'), `${mode}\n`);
  executable(join(bin, 'displayplacer'), displayplacer(home));
  // gh, everywhere a guest could find it: on the PATH and as the hooks' override. Every call is recorded.
  executable(join(bin, 'gh'), `printf '%s\\n' "$*" >> '${join(home, 'gh.calls')}'\nexit 0`);
  executable(join(bin, 'node'), `printf '%s\\n' "$*" >> '${join(home, 'node.calls')}'\nexit 0`);
  executable(join(bin, 'shutdown'), `date -u +%s > '${join(home, 'shutdown')}'`);
  // Production's deadlines are 1 to 5 s per probe; a loaded test machine scales each alarm (the posture test's way).
  const perlLib = join(home, 'perl');
  mkdirSync(perlLib);
  writeFileSync(join(perlLib, 'FixtureClock.pm'), 'package FixtureClock;\n*CORE::GLOBAL::alarm = sub (_) { CORE::alarm($_[0] > 0 ? $_[0] * 5 : $_[0]) };\n1;\n');
  const env = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, CI_KIT_VM_SHARES: shares, CI_KIT_VM_WATCH: '0.1', CI_KIT_VM_SHUTDOWN: join(bin, 'shutdown'),
    CI_KIT_MACHINE: 'mini-vm', CI_KIT_GH_BIN: join(bin, 'gh'), CI_KIT_CURSOR_PARK: join(bin, 'cursor-park'), CI_KIT_WINDOW_LIST: join(bin, 'window-list'),
    CI_KIT_LOG_BIN: join(bin, 'unified-log'), CI_KIT_VM_DISPLAYPLACER: join(bin, 'displayplacer'), PERL5LIB: perlLib, PERL5OPT: '-MFixtureClock',
  };
  const text = (path) => existsSync(path) ? readFileSync(path, 'utf8') : null;
  const out = (name) => text(join(shares, 'out', name));
  let wrapper = null;
  // A test that fails leaves nothing running: the wrapper's process group (it is its session's leader) and the runner's.
  cleanups.push(() => {
    const listener = text(join(ctl, 'listener.pid'))?.trim();
    const group = listener && spawnSync('/bin/ps', ['-o', 'pgid=', '-p', listener], { encoding: 'utf8' }).stdout.trim();
    for (const pgid of [wrapper, group]) if (pgid) try { process.kill(-Number(pgid), 'SIGKILL'); } catch {}
  });
  return {
    home, runner, shares, ctl, env, out,
    send: (command) => appendFileSync(join(ctl, 'commands'), `${command}\n`),
    kickoff(args = ['vm', 'maws-vm-job-20261021-1'], extra = {}) {
      const started = Date.now();
      const run = spawnSync('bash', [join(guestDir, 'kickoff.sh'), ...args], { encoding: 'utf8', timeout: 30_000, env: { ...env, ...extra } });
      const pid = /wrapper (\d+) started/.exec(run.stdout)?.[1];
      if (pid) wrapper = Number(pid);
      return { ...run, elapsed: Date.now() - started, wrapper: pid ? Number(pid) : null };
    },
    hook(name, extra = {}) {
      return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', join(guestDir, 'hooks', name)], {
        encoding: 'utf8', timeout: 60_000,
        env: { ...env, CI_KIT_VM_SLOT: 'vm', CI_KIT_VM_CLONE: 'maws-vm-job-20261021-1', GITHUB_RUN_ID: '18750', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'e2e', GITHUB_REPOSITORY: 'SSFSKIM/MAWS', ...extra },
      });
    },
    front: (output, afterOpen) => { writeFileSync(join(home, 'front'), output); if (afterOpen !== undefined) writeFileSync(join(home, 'after'), afterOpen); },
    windows: (list) => writeFileSync(join(home, 'windows'), list),
    ghCalls: () => (text(join(home, 'gh.calls')) ?? '').split('\n').filter(Boolean),
    nodeCalls: () => (text(join(home, 'node.calls')) ?? '').split('\n').filter(Boolean),
    opened: () => (text(join(home, 'opened')) ?? '').split('\n').filter(Boolean),
    shutdown: () => existsSync(join(home, 'shutdown')),
    hooksLog: () => text(join(home, 'Library/Logs/ci-kit/mac-runner-hooks.log')) ?? '',
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  };
}

// The listener's own record, read the way the wrapper reads it (diag.sh), from lines shaped as v2.338.0 writes them.
function scan(lines) {
  const dir = mkdtempSync(join(root, 'diag-'));
  writeFileSync(join(dir, 'Runner_20261021-120000-utc.log'), lines.map((line) => line.startsWith('[') ? line : `[2026-10-21 12:00:05Z ${line}`).join('\n') + '\n');
  const run = spawnSync('bash', ['-c', 'source "$1"; diag_scan "$2"', 'scan', join(guestDir, 'diag.sh'), dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

test('the diag patterns: listening, a session conflict, a job taken (by its id), an update; nothing else counts', () => {
  assert.equal(scan(['INFO Runner] Runner.Listener started', diag.version, diag.listening('2026-10-21 12:00:05Z')]), 'listening 2026-10-21T12:00:05Z\n');
  assert.equal(scan(diag.conflict), 'conflict 2026-10-21T12:00:05Z\n');
  assert.equal(scan(['[2026-10-21 12:00:01Z ERR  Terminal] WRITE ERROR: A session for this runner already exists.']), 'conflict 2026-10-21T12:00:01Z\n');
  // The job's id is the dispatch's, the job GUID; before the dispatch, the acknowledged request's; the earliest line's time.
  assert.equal(scan([diag.listening('2026-10-21 12:00:05Z'), `[2026-10-21 12:03:00Z ${diag.ack}`, `[2026-10-21 12:03:01Z ${diag.dispatch}`]),
    `listening 2026-10-21T12:00:05Z\njob 2026-10-21T12:03:00Z ${JOB}\n`);
  assert.equal(scan([diag.ack]), 'job 2026-10-21T12:00:05Z 7f0c4b5e-1111-4a2b-9c3d-2e6f8a9b0c1d\n');
  assert.equal(scan([diag.legacy]), 'job 2026-10-21T12:00:05Z -\n');
  assert.equal(scan([diag.running('2026-10-21 12:00:05Z')]), 'job 2026-10-21T12:00:05Z -\n');
  assert.equal(scan([diag.update]), 'update 2026-10-21T12:00:05Z\n');
  // A message of any kind (a refresh, a cancel) is not a job; nor is a line the trace header does not start, nor a
  // line that only mentions one.
  assert.equal(scan([diag.message, 'Listening for Jobs', 'INFO Runner] echo: Job request 1 for plan x job y received. (quoted)']), '');
});

test('a diag log that opens but cannot be read is unreadable, never a clean end', () => {
  const dir = mkdtempSync(join(root, 'diag-'));
  writeFileSync(join(dir, 'Runner_1.log'), `[2026-10-21 12:00:05Z ${diag.listening('2026-10-21 12:00:05Z')}\n`);
  // A directory under a log's name: open(2) succeeds, read(2) fails with EISDIR.
  mkdirSync(join(dir, 'Runner_2.log'));
  const run = spawnSync('bash', ['-c', 'source "$1"; diag_scan "$2"', 'scan', join(guestDir, 'diag.sh'), dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'listening 2026-10-21T12:00:05Z\nunreadable\n');
});

test('kickoff: the identity copied, the cache linked, the runner started once under the wrapper, which outlives the exec', async () => {
  const vm = guest();
  // What the image left: a cache directory of its own, and a diag log of its registration.
  mkdirSync(join(vm.home, 'Library/Caches/maws-e2e-build/stale'), { recursive: true });
  mkdirSync(join(vm.runner, '_diag'));
  writeFileSync(join(vm.runner, '_diag/Runner_20261001-000000-utc.log'), `[2026-10-01 00:00:00Z ${diag.dispatch}\n`);
  const kick = vm.kickoff();
  assert.equal(kick.status, 0, kick.stderr);
  assert.ok(kick.elapsed < 10_000, `kickoff returned after ${kick.elapsed} ms`);
  assert.ok(kick.wrapper, kick.stdout);
  for (const file of ['.runner', '.credentials', '.credentials_rsaparams']) {
    assert.equal(readFileSync(join(vm.runner, file), 'utf8'), `${file} of ci-kit-mac-mini-vm\n`);
    assert.equal(statSync(join(vm.runner, file)).mode & 0o777, 0o600);
  }
  const link = join(vm.home, 'Library/Caches/maws-e2e-build');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), join(vm.shares, 'cache'));
  await until(() => existsSync(join(vm.ctl, 'listener.pid')), 'the listener');
  assert.equal(readFileSync(join(vm.ctl, 'run.args'), 'utf8'), '--once\n');
  assert.equal(readFileSync(join(vm.ctl, 'listener.env'), 'utf8'), 'CI_KIT_VM_CLONE=maws-vm-job-20261021-1\nCI_KIT_VM_SLOT=vm\n');
  // The wrapper is a session of its own, so nothing the exec's end does to its process group reaches it, and it holds
  // none of the exec's output: kickoff's spawnSync returned while the runner runs.
  assert.equal(spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(kick.wrapper)], { encoding: 'utf8' }).stdout.trim(), String(kick.wrapper));
  assert.ok(vm.alive(kick.wrapper));
  // The image's old log is gone with the image's leftovers: it is no job of this clone.
  vm.send('listen');
  await until(() => vm.out('listening') !== null, 'out/listening');
  assert.equal(vm.out('assigned'), null);
  vm.send('exit 0');
  await until(() => vm.out('done') !== null, 'out/done');
  assert.deepEqual(vm.ghCalls(), []);
});

test("the runner starts on the PATH the image baked into its .path (runsvc.sh's read, which run.sh does not make), and with none the wrapper starts nothing and powers off", async () => {
  const vm = guest();
  assert.equal(vm.kickoff().status, 0);
  await until(() => existsSync(join(vm.ctl, 'listener.path')), "the listener's PATH");
  assert.equal(readFileSync(join(vm.ctl, 'listener.path'), 'utf8'), '/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin\n');
  vm.send('exit 0');
  await until(() => vm.out('done') !== null, 'out/done');

  const bare = guest({ path: null });
  assert.equal(bare.kickoff().status, 0);
  await until(() => bare.shutdown(), 'the power-off');
  assert.equal(existsSync(join(bare.ctl, 'run.args')), false, 'run.sh never started');
  assert.match(bare.out('wrapper.log'), /refused to start the runner: .*\.path is missing or empty .*; powering off/);
  assert.match(bare.out('unfit'), /^\S+\/actions-runner-maws\/\.path is missing or empty/);
  for (const marker of ['listening', 'assigned', 'job', 'done']) assert.equal(bare.out(marker), null, marker);
});

// The guest's display mode is the image's (provision.sh display): Tart's --display does not reach it, and a clone at
// another mode would run MAWS's windows on a smaller screen.
test('the wrapper reads the display mode before the runner starts: at 2560x1440 with scaling on it starts the runner', async () => {
  const vm = guest();
  assert.equal(vm.kickoff().status, 0);
  await until(() => existsSync(join(vm.ctl, 'run.args')), 'the runner');
  assert.match(vm.out('wrapper.log'), /display 2560x1440 scaling:on \(C97580C4-/);
  assert.equal(vm.out('unfit'), null);
  vm.send('exit 0');
  await until(() => vm.out('done') !== null, 'out/done');
});

for (const [what, mode, why] of [
  ['the size Tart boots a guest at', '1024x768 on', /^the display is 1024x768 scaling:on, not 2560x1440 scaling:on /],
  ['the right size without scaling', '2560x1440 off', /^the display is 2560x1440 scaling:off, not 2560x1440 scaling:on /],
  ['a read that fails', null, /^the display mode cannot be read \(\S+displayplacer list\)/],
]) {
  test(`at ${what}, the wrapper starts no runner, says why in out/unfit, and powers off`, async () => {
    const vm = guest({ mode });
    assert.equal(vm.kickoff().status, 0);
    await until(() => vm.shutdown(), 'the power-off');
    assert.equal(existsSync(join(vm.ctl, 'run.args')), false, 'run.sh never started');
    assert.match(vm.out('unfit'), why);
    assert.match(vm.out('wrapper.log'), /refused to start the runner: the display.*; powering off/);
    for (const marker of ['listening', 'assigned', 'job', 'done']) assert.equal(vm.out(marker), null, marker);
  });
}

test('kickoff refuses, starting nothing, without the identity or with an out/ that is not empty', () => {
  const missing = guest({ identity: false });
  const run = missing.kickoff();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^kickoff: the identity share lacks \.runner/m);
  assert.equal(existsSync(join(missing.ctl, 'run.args')), false);
  const used = guest();
  writeFileSync(join(used.shares, 'out/done'), '0\n');
  const again = used.kickoff();
  assert.equal(again.status, 1);
  assert.match(again.stderr, /out\/ already holds done/);
  assert.equal(existsSync(join(used.ctl, 'run.args')), false);
  assert.match(guest().kickoff(['vm']).stderr, /usage: kickoff\.sh <slot> <clone>/);
});

test('the markers follow the listener: listening, assigned from its job line, then the job, done and the power-off', async () => {
  const vm = guest();
  assert.equal(vm.kickoff().status, 0);
  vm.send('listen');
  await until(() => vm.out('listening') !== null, 'out/listening');
  assert.match(vm.out('listening'), /^at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
  assert.equal(vm.out('assigned'), null);
  vm.send('take');
  await until(() => vm.out('assigned') !== null, 'out/assigned');
  assert.match(vm.out('assigned'), new RegExp(`^job=${JOB} at=\\S+Z by=diag\\n$`));
  // The job's hook reports the job (the worker runs it; here the test does).
  const started = vm.hook('job-started.sh');
  assert.equal(started.status, 0, started.stderr);
  assert.match(vm.out('job'), /^run=18750 attempt=1 job=e2e repository=SSFSKIM\/MAWS at=\S+Z\n$/);
  assert.equal(vm.shutdown(), false);
  vm.send('exit 3');
  await until(() => vm.out('done') !== null, 'out/done');
  assert.equal(vm.out('done'), '3\n');
  assert.ok(existsSync(join(vm.shares, 'out/_diag')));
  assert.match(readFileSync(join(vm.shares, 'out/_diag', (spawnSync('ls', [join(vm.shares, 'out/_diag')], { encoding: 'utf8' }).stdout.trim().split('\n').find((name) => name.startsWith('Runner_')))), 'utf8'), /Listening for Jobs/);
  assert.match(vm.out('mac-runner-hooks.log'), /ci-kit desktop \(start\): vm=vm clone=maws-vm-job-20261021-1 /);
  await until(() => vm.shutdown(), 'the power-off');
  assert.match(vm.out('wrapper.log'), /out\/done: 3/);
  assert.deepEqual(vm.ghCalls(), []);
});

test('a session conflict, then the session recovered', async () => {
  const vm = guest();
  assert.equal(vm.kickoff().status, 0);
  vm.send('conflict');
  await until(() => vm.out('session-conflict') !== null, 'out/session-conflict');
  assert.equal(vm.out('listening'), null);
  vm.send('listen');
  await until(() => vm.out('listening') !== null, 'out/listening');
  vm.send('exit 0');
  await until(() => vm.shutdown(), 'the power-off');
});

test('the idle handshake: a stop asked of a listener that took a job is refused, naming the job, and the job goes on', async () => {
  const vm = guest();
  assert.equal(vm.kickoff().status, 0);
  vm.send('listen');
  vm.send('take');
  await until(() => vm.out('assigned') !== null, 'out/assigned');
  writeFileSync(join(vm.shares, 'out/stop-request'), '');
  await until(() => vm.out('stop-refused') !== null, 'out/stop-refused');
  assert.equal(vm.out('stop-refused'), `job=${JOB}\n`);
  await sleep(300);
  assert.equal(existsSync(join(vm.ctl, 'listener.end')), false, 'the listener was left alone');
  assert.equal(vm.out('stopped'), null);
  vm.send('exit 0');
  await until(() => vm.shutdown(), 'the power-off');
  assert.equal(vm.out('stopped'), null);
  assert.equal(vm.out('stop-raced'), null);
});

test('the idle handshake: a Runner.Worker with no job line yet is a job taken', macOnly, async () => {
  const vm = guest({ worker: true });
  assert.equal(vm.kickoff().status, 0);
  vm.send('listen');
  await until(() => vm.out('listening') !== null, 'out/listening');
  vm.send('worker');
  await until(() => vm.out('assigned') !== null, 'out/assigned');
  assert.match(vm.out('assigned'), /^job=- at=\S+Z by=worker\n$/);
  writeFileSync(join(vm.shares, 'out/stop-request'), '');
  await until(() => vm.out('stop-refused') !== null, 'out/stop-refused');
  assert.equal(vm.out('stop-refused'), 'job=-\n');
  vm.send('exit 0');
  await until(() => vm.shutdown(), 'the power-off');
});

test('the idle handshake: an idle listener is stopped gracefully (SIGINT), answered stopped, and the guest powers off', macOnly, async () => {
  const vm = guest({ worker: true });
  assert.equal(vm.kickoff().status, 0);
  vm.send('listen');
  await until(() => vm.out('listening') !== null, 'out/listening');
  writeFileSync(join(vm.shares, 'out/stop-request'), '');
  await until(() => vm.out('stopped') !== null, 'out/stopped');
  assert.match(vm.out('stopped'), /^at=\S+Z\n$/);
  assert.equal(readFileSync(join(vm.ctl, 'listener.end'), 'utf8'), 'interrupted\n');
  assert.equal(vm.out('assigned'), null);
  assert.equal(vm.out('stop-refused'), null);
  assert.equal(vm.out('stop-raced'), null);
  await until(() => vm.out('done') !== null && vm.shutdown(), 'done and the power-off');
  assert.equal(vm.out('done'), '0\n');
});

test('the idle handshake: an acceptance that raced the stop (a job line dated after the check) is answered stop-raced', macOnly, async () => {
  const vm = guest({ worker: true });
  assert.equal(vm.kickoff().status, 0);
  vm.send('listen');
  await until(() => vm.out('listening') !== null, 'out/listening');
  writeFileSync(join(vm.ctl, 'race'), '');
  writeFileSync(join(vm.shares, 'out/stop-request'), '');
  await until(() => vm.out('stop-raced') !== null, 'out/stop-raced');
  assert.equal(vm.out('stop-raced'), `job=${JOB}\n`);
  // Not stopped, and not assigned: the job was cancelled by the stop, and the launcher reports it.
  assert.equal(vm.out('stopped'), null);
  assert.equal(vm.out('assigned'), null);
  await until(() => vm.shutdown(), 'the power-off');
});

const diagLog = (vm) => join(vm.runner, '_diag', readdirSync(join(vm.runner, '_diag')).find((name) => name.startsWith('Runner_')));
const wrapperSaid = (vm, text) => (vm.out('wrapper.log') ?? '').includes(text);

test('a job once seen taken is never stopped, even when its diag log can no longer be read', asUser, async () => {
  const vm = guest();
  assert.equal(vm.kickoff().status, 0);
  vm.send('listen');
  vm.send('take');
  await until(() => vm.out('assigned') !== null, 'out/assigned');
  const log = diagLog(vm);
  chmodSync(log, 0o000);
  try {
    writeFileSync(join(vm.shares, 'out/stop-request'), '');
    await until(() => vm.out('stop-refused') !== null, 'out/stop-refused');
    assert.equal(vm.out('stop-refused'), `job=${JOB}\n`);
    assert.equal(existsSync(join(vm.ctl, 'listener.end')), false, 'the listener was left alone');
    assert.equal(vm.out('stopped'), null);
  } finally {
    chmodSync(log, 0o644);
  }
  vm.send('exit 0');
  await until(() => vm.shutdown(), 'the power-off');
  assert.equal(vm.out('stopped'), null);
});

for (const [what, blind, restore] of [
  ['a diag log it cannot read', (vm) => { const log = diagLog(vm); chmodSync(log, 0o000); return () => chmodSync(log, 0o644); }],
  ['a diag directory it cannot read', (vm) => { const dir = join(vm.runner, '_diag'); chmodSync(dir, 0o000); return () => chmodSync(dir, 0o755); }],
  ['the diag log that showed listening gone', (vm) => { unlinkSync(diagLog(vm)); return () => {}; }],
]) {
  test(`with ${what}, a stop is refused: the listener may hold a job`, asUser, async () => {
    const vm = guest();
    assert.equal(vm.kickoff().status, 0);
    vm.send('listen');
    await until(() => vm.out('listening') !== null, 'out/listening');
    const undo = blind(vm);
    try {
      writeFileSync(join(vm.shares, 'out/stop-request'), '');
      await until(() => vm.out('stop-refused') !== null, 'out/stop-refused');
      assert.equal(vm.out('stop-refused'), 'job=unknown\n');
      assert.match(vm.out('assigned'), /^job=unknown at=\S+Z by=unknown\n$/);
      assert.equal(existsSync(join(vm.ctl, 'listener.end')), false, 'the listener was left alone');
    } finally {
      undo();
    }
    vm.send('exit 0');
    await until(() => vm.shutdown(), 'the power-off');
  });
}

test('stop-refused is published only after its assigned is written', async () => {
  const vm = guest();
  // A write that fails: the marker's temporary name is taken by a directory.
  mkdirSync(join(vm.shares, 'out/.assigned.tmp'));
  assert.equal(vm.kickoff().status, 0);
  vm.send('listen');
  vm.send('take');
  await until(() => wrapperSaid(vm, 'could not write out/assigned'), 'the failed write');
  writeFileSync(join(vm.shares, 'out/stop-request'), '');
  await until(() => wrapperSaid(vm, 'stop requested'), 'the request read');
  await sleep(500);
  assert.equal(vm.out('stop-refused'), null, 'no refusal without its anchor');
  rmdirSync(join(vm.shares, 'out/.assigned.tmp'));
  await until(() => vm.out('stop-refused') !== null, 'out/stop-refused');
  assert.equal(vm.out('stop-refused'), `job=${JOB}\n`);
  assert.match(vm.out('assigned'), new RegExp(`^job=${JOB} `));
  vm.send('exit 0');
  await until(() => vm.shutdown(), 'the power-off');
});

test('a raced stop whose answer cannot be written leaves no done and no power-off: the guest stays up', macOnly, async () => {
  const vm = guest({ worker: true });
  mkdirSync(join(vm.shares, 'out/.stop-raced.tmp'));
  assert.equal(vm.kickoff(undefined, { CI_KIT_VM_WRITE_WAIT: '2' }).status, 0);
  vm.send('listen');
  await until(() => vm.out('listening') !== null, 'out/listening');
  writeFileSync(join(vm.ctl, 'race'), '');
  writeFileSync(join(vm.shares, 'out/stop-request'), '');
  await until(() => wrapperSaid(vm, 'no done, no power-off'), 'the wrapper giving up');
  assert.equal(vm.out('stop-raced'), null);
  assert.equal(vm.out('stopped'), null);
  assert.equal(vm.out('done'), null);
  assert.equal(vm.shutdown(), false);
});

test('a raced stop whose answer fails at first is retried, and recorded before done and the power-off', macOnly, async () => {
  const vm = guest({ worker: true });
  mkdirSync(join(vm.shares, 'out/.stop-raced.tmp'));
  assert.equal(vm.kickoff().status, 0);
  vm.send('listen');
  await until(() => vm.out('listening') !== null, 'out/listening');
  writeFileSync(join(vm.ctl, 'race'), '');
  writeFileSync(join(vm.shares, 'out/stop-request'), '');
  await until(() => wrapperSaid(vm, 'could not write out/stop-raced'), 'the failed write');
  assert.equal(vm.out('done'), null);
  assert.equal(vm.shutdown(), false);
  rmdirSync(join(vm.shares, 'out/.stop-raced.tmp'));
  await until(() => vm.out('done') !== null && vm.shutdown(), 'done and the power-off');
  assert.equal(vm.out('stop-raced'), `job=${JOB}\n`);
});

test('the guest hooks: a wide @2x desktop passes, Terminal in front, the posture line names the slot and the clone; no sweep, no gh', () => {
  const vm = guest();
  const started = vm.hook('job-started.sh');
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stderr, '');
  const line = started.stdout.split('\n').find((text) => text.startsWith('ci-kit desktop (start): '));
  assert.match(line, /^ci-kit desktop \(start\): vm=vm clone=maws-vm-job-20261021-1 frontmost=터미널 display=2560x1440@2x remote=\S+ load=\S+ computeruse=\S+$/);
  assert.match(started.stdout, /cursor-park run=18750 job=e2e cursor before=1,1/);
  assert.match(vm.hooksLog(), /run=18750 job=e2e ci-kit desktop \(start\): vm=vm clone=/);
  assert.equal(vm.out('refused'), null);
  const completed = vm.hook('job-completed.sh');
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(completed.stdout, /^ci-kit desktop \(end\): vm=vm clone=maws-vm-job-20261021-1 frontmost=/m);
  assert.deepEqual(vm.nodeCalls(), [], 'no sweep in a clone that is deleted after its job');
  assert.deepEqual(vm.ghCalls(), []);
});

for (const [display, why] of [['1024x768@2x', 'is 1024x768@2x'], ['2560x1440@1x', 'is 2560x1440@1x'], ['1440x900@2x', 'is 1440x900@2x'], ['2560x1440@1.5x', 'is 2560x1440@1.5x'], ['unknown', 'could not be read']]) {
  test(`the guest hooks refuse a display that ${why}, in the lane's shape, and tell the launcher`, () => {
    const vm = guest({ display });
    const run = vm.hook('job-started.sh');
    assert.equal(run.status, 1);
    const refusal = `ci-kit: the display of the guest mini-vm (vm=vm clone=maws-vm-job-20261021-1) ${why}, not at least 1600 pt wide at @2x — rerun`;
    assert.equal(run.stderr, `${refusal}\n`);
    assert.equal(vm.out('refused'), `${refusal}\n`);
    assert.notEqual(vm.out('job'), null, 'the job still reached its hook');
    assert.deepEqual(vm.ghCalls(), []);
  });
}

test('the guest hooks refuse a display read that fails', () => {
  const vm = guest({ display: '', displayStatus: 1 });
  const run = vm.hook('job-started.sh');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^ci-kit: the display of the guest mini-vm \(vm=vm clone=maws-vm-job-20261021-1\) could not be read, not at least 1600 pt wide at @2x — rerun$/m);
});

test('the guest hooks refuse a system dialog, in front or on screen, with no episode, no alert and no gh', () => {
  for (const [setup, held] of [
    [(vm) => vm.front(asnShape('UserNotificationCenter', 'com.apple.UserNotificationCenter')), 'holds focus'],
    [(vm) => vm.front(pairShape('SecurityAgent')), 'holds focus'],
    [(vm) => vm.windows(`${windowLine({ pid: 812, layer: 2002, bundle: 'com.apple.SecurityAgent', name: 'SecurityAgent' })}\n${ordinaryWindows}`), 'is on screen without focus'],
  ]) {
    const vm = guest();
    setup(vm);
    const run = vm.hook('job-started.sh');
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`^ci-kit: a system dialog \\((UserNotificationCenter|SecurityAgent): source unknown\\) ${held} in the guest mini-vm \\(vm=vm clone=maws-vm-job-20261021-1\\) — if every clone shows it, answer it in the image; rerun$`, 'm'));
    assert.equal(vm.out('refused'), run.stderr);
    assert.deepEqual(vm.opened(), []);
    assert.equal(existsSync(join(vm.home, 'Library/Logs/ci-kit/dialog-alert.state')), false);
    assert.deepEqual(vm.ghCalls(), []);
  }
});

test('the guest hooks bring Terminal over any other app, and refuse when it does not come', () => {
  const vm = guest();
  vm.front(asnShape('Finder', 'com.apple.finder'), terminal);
  const run = vm.hook('job-started.sh');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(vm.opened(), ['-a Terminal']);
  assert.match(run.stdout, /frontmost before=Finder after=터미널/);
  const stuck = guest();
  stuck.front(asnShape('Finder', 'com.apple.finder'));
  const refused = stuck.hook('job-started.sh');
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, 'ci-kit: Terminal did not come to the front in the guest mini-vm (vm=vm clone=maws-vm-job-20261021-1; Finder is) — rerun\n');
  assert.equal(stuck.out('refused'), refused.stderr);
  assert.deepEqual(stuck.ghCalls(), []);
});
