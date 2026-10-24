import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The VM lane's launcher (mac/vm/lane.sh, with mac/vm/tart.sh): its lifecycle, its boot rule and the locked boot,
// recovery, the idle handshake, the memory guard, the disk reserve, the failures and the alerts. Each test is one Mac:
// a HOME with the slot's directories, the golden pointer and the host's exclusive instance. Tart is a fake that keeps
// its VMs as directories and records its calls: its `run` is a real process (`tart run … <name>` in the process
// table, as the launcher reads it) that blocks until the VM is powered off or stopped, its `list --format json`
// reports each VM's state, or the state the test sets, and its `delete` refuses a running VM as Tart does. gh serves
// the queue and records the alerts; the memory, disk and display reads are fakes the test sets. The guest is the test,
// writing out/ markers as wrapper.sh does. The desktop lock, the markers, the claims (vm-claim.sh) and the processes
// are real, and runner-state.py reads the host instance's processes by the kernel's paths.
const macOnly = { skip: process.platform !== 'darwin' };
const asUser = { skip: process.platform !== 'darwin' || process.getuid?.() === 0 };
const mac = fileURLToPath(new URL('../mac/', import.meta.url));
const launcher = join(mac, 'vm/lane.sh');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-kit-vm-lane-')));
const cleanups = [];
after(() => {
  for (const cleanup of cleanups.splice(0)) try { cleanup(); } catch {}
  rmSync(root, { recursive: true, force: true });
});
const executable = (path, body) => { writeFileSync(path, `#!/bin/bash\n${body}\n`); chmodSync(path, 0o755); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, what, ms = 60_000) {
  for (let waited = 0; !predicate(); waited += 50) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const lstart = (pid) => spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } }).stdout.trim();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GOLDEN = 'maws-vm-golden-20261020';
const CLONE = /^maws-vm-job-[a-z0-9-]+-\d{8}T\d{6}Z$/;

// Tart, as far as the launcher uses it. Every call is a line of calls; a VM is vms/<name>/ with its state.
const fakeTart = `t=$HOME/tart vms=$HOME/tart/vms
printf '%s\\n' "$*" >> "$t/calls"
command=$1; shift
state() { cat "$vms/$1/state" 2>/dev/null; }
case $command in
  list)
    [[ $* == '--format json' ]] || exit 64
    [[ ! -e $t/fail-list ]] || { echo 'Error: list failed' >&2; exit 1; }
    # Undo reads once to verify the stop, then again to decide whether it must delete. Fail only the latter onward.
    if [[ -e $t/fail-undo-list && -e $t/run-failed ]]; then
      n=$(( $(cat "$t/undo-lists" 2>/dev/null || echo 0) + 1 )); echo $n > "$t/undo-lists"
      ((n < 2)) || { echo 'Error: list failed after the verified stop' >&2; exit 1; }
    fi
    # block-locked-list <n>: the n-th list made while desktop.lock is held (the launcher's recovery, then its boots)
    # waits for list-go.
    if [[ -e $t/block-locked-list ]] && ! perl -MFcntl=:flock -e 'open(my $f, ">>", shift) or exit 0; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)' "$HOME/Library/Logs/ci-kit/desktop.lock"; then
      n=$(( $(cat "$t/locked-lists" 2>/dev/null || echo 0) + 1 )); echo $n > "$t/locked-lists"
      if ((n == $(cat "$t/block-locked-list"))); then touch "$t/list-waiting"; until [[ -e $t/list-go ]]; do sleep 0.05; done; fi
    fi
    sep=''; printf '['
    for dir in "$vms"/*/; do
      [[ -d $dir ]] || continue
      name=$(basename "$dir"); s=$(state "$name"); [[ ! -f $dir/listed ]] || s=$(cat "$dir/listed")
      running=false; [[ $s != running ]] || running=true
      printf '%s{"State":"%s","Accessed":"2026-10-21T12:00:00Z","Disk":50,"Running":%s,"Size":20,"Name":"%s","Source":"local"}' "$sep" "$s" "$running" "$name"
      sep=,
    done
    printf '%s{"State":"stopped","Disk":50,"Running":false,"Size":41,"Name":"ghcr.io/cirruslabs/macos-golden-gate-base:latest","Source":"OCI"}]\\n' "$sep" ;;
  clone)
    [[ ! -e $t/fail-clone ]] || { echo 'Error: no space left on device' >&2; exit 1; }
    [[ -d $vms/$1 ]] || { echo "Error: the specified VM \\"$1\\" does not exist" >&2; exit 1; }
    if [[ -e $t/block-clone ]]; then touch "$t/clone-waiting"; until [[ -e $t/clone-go ]]; do sleep 0.05; done; fi
    mkdir "$vms/$2" || exit 1
    echo stopped > "$vms/$2/state" ;;
  run)
    name=\${!#} dir=$vms/\${!#}
    [[ -d $dir && $(state "$name") != running ]] || { echo "Error: cannot run $name" >&2; exit 1; }
    printf '%s\\n' "$@" > "$dir/run.args"
    # A guest's pasteboard is never the host's: every run of the lane's carries --no-clipboard.
    [[ " $* " == *' --no-clipboard '* ]] || { echo "Error: $name run with the host's clipboard shared" >&2; echo "$name" >> "$t/clipboard-shared"; exit 64; }
    [[ ! -e $t/fail-run ]] || { touch "$t/run-failed"; echo 'Error: Failed to generate keypair' >&2; exit 1; }
    echo $$ > "$dir/run.pid"; echo running > "$dir/state"
    until [[ -e $dir/poweroff || -e $dir/stopping ]]; do sleep 0.05; done
    echo stopped > "$dir/state"; rm -f "$dir/run.pid" ;;
  exec)
    name=$1; shift
    [[ $(state "$name") == running ]] || { echo 'Error: VM is not running' >&2; exit 1; }
    [[ ! -e $t/no-agent ]] || { echo 'Error: failed to connect to the guest agent' >&2; exit 1; }
    [[ $1 != true ]] || exit 0
    if [[ $1 == */vm/guest/kickoff.sh ]]; then
      # As kickoff.sh, it refuses an out/ that holds a marker, and otherwise opens out/wrapper.log as it starts the
      # wrapper. With block-kickoff it waits before that, with block-kickoff-return after it (the wrapper started, the
      # exec not yet returned), until kickoff-go or its VM's run ends; with fail-kickoff-late the exec then fails though
      # the wrapper started (a gRPC error or a timeout on the way back). kicked (its arguments) is written as it
      # returns, so a guest marker a test writes after it comes after the wrapper's start.
      kicked() { printf '%s\\n' "$@" > "$vms/$name/kicked"; }
      block() {
        [[ -e $t/$1 ]] || return 0
        touch "$t/kickoff-waiting"
        until [[ -e $t/kickoff-go ]] || ! kill -0 "$(cat "$vms/$name/run.pid" 2>/dev/null)" 2>/dev/null; do sleep 0.05; done
      }
      block block-kickoff
      [[ ! -e $t/fail-kickoff ]] || { kicked "$@"; echo 'kickoff: out/ already holds listening: every clone starts from an empty out/' >&2; exit 1; }
      out=$(sed -n 's/^--dir=out://p' "$vms/$name/run.args")
      for marker in listening session-conflict assigned job refused stop-request stop-refused stop-raced stopped done; do
        [[ ! -e $out/$marker ]] || { kicked "$@"; echo "kickoff: out/ already holds $marker: every clone starts from an empty out/" >&2; exit 1; }
      done
      echo 'wrapper: started' >> "$out/wrapper.log"
      block block-kickoff-return
      kicked "$@"
      [[ ! -e $t/fail-kickoff-late ]] || { echo 'Error: rpc error: code = DeadlineExceeded' >&2; exit 1; }
      echo "kickoff: $2 $3: identity copied, cache linked, wrapper 4242 started"; exit 0
    fi
    exit 1 ;;
  stop)
    [[ ! -e $t/fail-stop ]] || { echo 'Error: stop failed' >&2; exit 1; }
    [[ -d $vms/$1 ]] || exit 1
    touch "$vms/$1/stopping"
    for _ in $(seq 200); do [[ -f $vms/$1/run.pid ]] || break; sleep 0.05; done
    [[ -f $vms/$1/run.pid ]] || echo stopped > "$vms/$1/state" ;;
  delete)
    [[ -d $vms/$1 ]] || { echo "Error: the specified VM \\"$1\\" does not exist" >&2; exit 1; }
    [[ $(state "$1") != running ]] || { echo "Error: VM \\"$1\\" is running" >&2; exit 1; }
    [[ ! -e $t/fail-delete ]] || { echo 'Error: delete failed' >&2; exit 1; }
    rm -rf "\${vms:?}/$1" ;;
  *) exit 64 ;;
esac`;

// gh: the queue from files (an empty queue when none), alerts numbered; every call recorded with the token it saw.
const fakeGh = `g=$HOME/gh
printf '%s\\0' "$@" "GH_TOKEN=\${GH_TOKEN-unset}" >> "$g/calls"; printf '\\0' >> "$g/calls"
if [[ $1 == api ]]; then
  [[ ! -e $g/fail ]] || { echo 'gh: HTTP 502: Bad Gateway' >&2; exit 1; }
  # slow: each API call answers after the seconds the file names (3 when it names none).
  if [[ -e $g/slow ]]; then touch "$g/slow-waiting"; read -r seconds < "$g/slow"; sleep "\${seconds:-3}"; fi
  case $2 in
    */generate-jitconfig)
      [[ ! -e $g/fail-mint ]] || { echo 'gh: Resource not accessible (HTTP 403)' >&2; exit 1; }
      n=$(( $(cat "$g/mints" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$g/mints"
      cat > "$g/request-$n.json"
      printf '{"runner":{"id":%s,"name":"fixture","os":"unknown","status":"offline","busy":false,"labels":[]},"encoded_jit_config":"fixture-jit-secret-%s"}\\n' "$n" "$n"
      exit 0 ;;
    */actions/runners/[0-9]*)
      [[ ! -e $g/fail-delete ]] || { echo 'gh: Bad Gateway (HTTP 502)' >&2; exit 1; }
      [[ ! -e $g/delete-404 ]] || { echo 'gh: Not Found (HTTP 404)' >&2; exit 1; }
      exit 0 ;;
    *'/actions/runners?'*) if [[ -f $g/runners.json ]]; then cat "$g/runners.json"; else echo '{"total_count":0,"runners":[]}'; fi; exit 0 ;;
    *'runs?status=queued'*) file=$g/runs-queued.json ;;
    *'runs?status=in_progress'*) file=$g/runs-in_progress.json ;;
    */jobs\\?*) id=\${2#*/runs/}; file=$g/jobs-\${id%%/*}.json ;;
    *) exit 1 ;;
  esac
  if [[ -f $file ]]; then cat "$file"; else echo '{"total_count":0,"workflow_runs":[],"jobs":[]}'; fi
  exit 0
fi
if [[ $1 == issue && $2 == create ]]; then
  n=$(( $(cat "$g/issues" 2>/dev/null || echo 0) + 1 )); echo $n > "$g/issues"
  echo "https://github.com/SSFSKIM/ci-kit-sandbox/issues/$n"
fi
exit 0`;

let slots = 0;
const launchers = new Set();
cleanups.push(() => { for (const child of launchers) child.kill('SIGKILL'); });

// One Mac with the lane. queue: the labels of each queued job (one run each); memory, disk (GB free) and display as
// the reads give them; env: the launcher's inputs beyond the tests' short bounds.
function lane({ queue = [], memory = {}, disk = 120, display = '2560x1440@2x', env = {} } = {}) {
  const slot = `vm${++slots}`;
  const home = mkdtempSync(join(root, `${slot}-`));
  const bin = join(home, 'bin');
  const logs = join(home, 'Library/Logs/ci-kit');
  const vmHome = join(home, 'ci-kit-vm');
  const slotDir = join(vmHome, slot);
  const out = join(slotDir, 'out');
  const vms = join(home, 'tart/vms');
  for (const dir of [bin, logs, vms, join(home, 'gh'), join(slotDir, 'identity'), join(home, 'actions-runner-maws')]) mkdirSync(dir, { recursive: true });
  for (const file of ['.runner', '.credentials', '.credentials_rsaparams']) writeFileSync(join(slotDir, 'identity', file), `${file}\n`);
  writeFileSync(join(vmHome, 'golden'), `${GOLDEN}\n`);
  mkdirSync(join(vms, GOLDEN));
  writeFileSync(join(vms, GOLDEN, 'state'), 'stopped\n');
  executable(join(bin, 'tart'), fakeTart);
  executable(join(bin, 'gh'), fakeGh);
  // sysctl -n of the three memory reads, from the memory file; with swap-grow, swap grows 10 MB a read.
  executable(join(bin, 'sysctl'), `[[ $* == '-n kern.memorystatus_vm_pressure_level kern.memorystatus_level vm.swapusage' ]] || exit 64
read -r pressure available swap < "$HOME/memory" || exit 1
[[ $pressure != fail ]] || exit 1
if [[ -e $HOME/swap-grow ]]; then swap=$(( $(cat "$HOME/swap-grow") + 10 )); echo $swap > "$HOME/swap-grow"; fi
printf '%s\\n%s\\ntotal = 2048.00M  used = %s.25M  free = 1000.00M  (encrypted)\\n' "$pressure" "$available" "$swap"`);
  executable(join(bin, 'df'), `[[ $1 == -Pk ]] || exit 64
kb=$(cat "$HOME/disk") || exit 1
[[ $kb != fail ]] || exit 1
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/disk3s5 971350180 1 %s 1%% /System/Volumes/Data\\n' "$kb"`);
  executable(join(bin, 'cursor-park'), `[[ \${1:-} == --describe ]] || exit 0\ncat "$HOME/display"`);
  // Production's deadlines are seconds; a loaded test machine scales each alarm (the guest test's way).
  const perlLib = join(home, 'perl');
  mkdirSync(perlLib);
  writeFileSync(join(perlLib, 'FixtureClock.pm'), 'package FixtureClock;\n*CORE::GLOBAL::alarm = sub (_) { CORE::alarm($_[0] > 0 ? $_[0] * 5 : $_[0]) };\n1;\n');
  const text = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  const base = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin`, CI_KIT_MACHINE: 'mini', CI_KIT_TART: join(bin, 'tart'), CI_KIT_GH_BIN: join(bin, 'gh'),
    CI_KIT_VM_SYSCTL: join(bin, 'sysctl'), CI_KIT_VM_DF: join(bin, 'df'), CI_KIT_CURSOR_PARK: join(bin, 'cursor-park'), CI_KIT_VM_KIT: mac,
    CI_KIT_VM_SLOT: slot, CI_KIT_VM_TICK: '0.2', CI_KIT_VM_POLL: '1', CI_KIT_VM_SAMPLE: '1', CI_KIT_VM_SWAP_GAP: '1', CI_KIT_VM_SPAWN_CHECK: '1',
    GH_TOKEN: 'a-job-token', PERL5LIB: perlLib, PERL5OPT: '-MFixtureClock',
  };
  const host = [];
  const stderrs = new Set();
  // Job clones a test leaves with no reservation (what a failed write leaves), until recovery reserves one.
  const orphans = new Set();
  const m = {
    slot, home, logs, out, vms, vmHome, slotDir,
    memory({ pressure = 1, available = 60, swap = 500 } = {}) { writeFileSync(join(home, 'memory'), `${pressure} ${available} ${swap}\n`); },
    disk(gb) { writeFileSync(join(home, 'disk'), gb === 'fail' ? 'fail\n' : `${Math.round(gb * 1048576)}\n`); },
    display(value) { writeFileSync(join(home, 'display'), `${value}\n`); },
    // Each job is a run of its own: runs 101, 102, … in the queued list.
    queue(...jobs) {
      const runs = jobs.map((_, i) => 101 + i);
      writeFileSync(join(home, 'gh/runs-queued.json'), JSON.stringify({ total_count: runs.length, workflow_runs: runs.map((id) => ({ id, status: 'queued' })) }));
      jobs.forEach((labels, i) => writeFileSync(join(home, `gh/jobs-${runs[i]}.json`),
        JSON.stringify({ total_count: 1, jobs: [{ id: 9000 + i, run_id: runs[i], status: 'queued', labels }] })));
    },
    flag: (name, on = true) => on === false ? rmSync(join(home, 'tart', name), { force: true }) : writeFileSync(join(home, 'tart', name), on === true ? '' : `${on}\n`),
    // The coordinator's hold.sh, as run over ssh: its output so far, and its exit.
    holdCommand(args, extra = {}) {
      const child = spawn('/bin/bash', [join(mac, 'vm/hold.sh'), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...base, CI_KIT_VM_TICK: '0.2', ...extra },
      });
      host.push(child);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const exited = once(child, 'exit').then(([code]) => code);
      return { output: () => output, exited };
    },
    ghFlag: (name, on = true) => on === false ? rmSync(join(home, 'gh', name), { force: true }) : writeFileSync(join(home, 'gh', name), on === true ? '' : `${on}\n`),
    log: () => text(join(logs, 'vm-lane.log')) ?? '',
    hooksLog: () => text(join(logs, 'mac-runner-hooks.log')) ?? '',
    calls: () => (text(join(home, 'tart/calls')) ?? '').split('\n').filter(Boolean),
    ghCalls: () => (text(join(home, 'gh/calls')) ?? '').split('\0\0').filter(Boolean).map((call) => call.split('\0')),
    alerts: () => m.ghCalls().filter((call) => call[0] === 'issue' && call[1] === 'create').map((call) => call[call.indexOf('--title') + 1]),
    closed: () => m.ghCalls().filter((call) => call[0] === 'issue' && call[1] === 'close').map((call) => call[2]),
    clones: () => readdirSync(vms).filter((name) => CLONE.test(name)),
    state: (name) => text(join(vms, name, 'state'))?.trim() ?? null,
    reserved: () => text(join(logs, 'vm-reserved')),
    pause: () => text(join(logs, 'vm-pause')),
    failures: () => Object.fromEntries((text(join(logs, 'vm-failures')) ?? '').split('\n').filter(Boolean).map((line) => line.split('='))),
    mark(name, content = '') {
      writeFileSync(join(out, `.${name}.tmp`), `${content}\n`);
      renameSync(join(out, `.${name}.tmp`), join(out, name));
    },
    powerOff: (name) => writeFileSync(join(vms, name, 'poweroff'), ''),
    // A VM of the maintenance procedure's, as Tart lists it: running, with no tart run of this launcher's.
    orphan(name) { orphans.add(name); m.vm(name, 'stopped'); },
    vm(name, state = 'stopped') { mkdirSync(join(vms, name), { recursive: true }); writeFileSync(join(vms, name, 'state'), `${state}\n`); },
    // A wait whose failure shows the launcher's log and stderr.
    async until(predicate, what, ms) {
      try { await until(predicate, what, ms); } catch (error) {
        const log = m.log();
        error.message += `\n--- vm-lane.log ---\n${log.length > 6000 ? `${log.slice(0, 2000)}\n…\n${log.slice(-4000)}` : log}\n--- stderr ---\n${[...stderrs].map((read) => read()).join('').slice(-2000)}`;
        throw error;
      }
    },
    async waitLog(pattern, what = String(pattern)) { await m.until(() => pattern.test(m.log()), what); },
    // A hold, and the poll that reads it: no boot is under way once it is logged.
    async quiet() {
      writeFileSync(join(logs, 'vm-hold.test'), 'the test reads the lane\n');
      await m.waitLog(/no boot: test: the test reads the lane$/m);
    },
    // The launcher, as its LaunchAgent starts it.
    start(extra = {}) {
      const child = spawn('/bin/bash', [launcher], {
        stdio: ['ignore', 'ignore', 'pipe'], env: { ...base, ...env, ...extra },
      });
      launchers.add(child);
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      stderrs.add(() => stderr);
      const exited = once(child, 'exit');
      return {
        pid: child.pid, stderr: () => stderr,
        kill: async () => { child.kill('SIGKILL'); await exited; launchers.delete(child); },
      };
    },
    // The host's exclusive instance doing something, by the kernel's path: a listener (with its diag log) or a worker.
    async instance(kind) {
      const bin = join(home, 'actions-runner-maws/bin');
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(home, 'actions-runner-maws/_diag'), { recursive: true });
      writeFileSync(join(home, 'actions-runner-maws/_diag/Runner_20261021-120000-utc.log'), 'listening\n');
      const exe = join(bin, kind === 'idle' ? 'Runner.Listener' : 'Runner.Worker');
      if (!existsSync(exe)) copyFileSync(process.execPath, exe, constants.COPYFILE_FICLONE);
      const child = spawn(exe, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
      host.push(child);
      await once(child, 'spawn');
      return { kill: async () => { const gone = once(child, 'exit'); child.kill('SIGKILL'); await gone; } };
    },
    // A host job's claim (vm-claim.sh's shape), naming a live process standing in for its worker.
    async claim() {
      const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
      host.push(child);
      await once(child, 'spawn');
      const started = lstart(child.pid);
      const name = `vm-claim.${child.pid}-${started.replace(/ +/g, '-')}`;
      writeFileSync(join(logs, name), `measured claim since 2026-10-21T12:00:00Z: run 7 job e2e (worker ${child.pid})\nrun=7\nattempt=1\njob=e2e\nworker=${child.pid}\nstarted=${started}\nsince=2026-10-21T12:00:00Z\n`);
      return { name, kill: async () => { const gone = once(child, 'exit'); child.kill('SIGKILL'); await gone; } };
    },
    // Holds the desktop lock from another process (a host hook mid-admission) until released.
    async holdLock() {
      const holder = spawn('perl', ['-MFcntl=:flock', '-e', '$| = 1; open(my $fh, ">>", shift) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; sleep 600',
        join(logs, 'desktop.lock')], { stdio: ['ignore', 'pipe', 'inherit'] });
      host.push(holder);
      await once(holder.stdout, 'data');
      return { release: async () => { const gone = once(holder, 'exit'); holder.kill('SIGKILL'); await gone; } };
    },
    lockFree: () => spawnSync('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", shift) or exit 2; exit(flock($fh, LOCK_EX | LOCK_NB) ? 0 : 1)', join(logs, 'desktop.lock')]).status === 0,
    // A clone whose kickoff (with block-kickoff) has started and not returned.
    async kickoffBlocked() {
      await m.until(() => existsSync(join(home, 'tart/kickoff-waiting')), 'the kickoff blocked');
      return m.clones()[0];
    },
    // Boots one clone for a queued job and returns its name once its kickoff ran.
    async booted() {
      await m.until(() => m.clones().some((name) => existsSync(join(vms, name, 'kicked'))), 'a clone kicked off');
      return m.clones().find((name) => existsSync(join(vms, name, 'kicked')));
    },
    // The guest writing out/ as wrapper.sh does, up to a state.
    async listening(clone) { m.mark('listening', 'at=2026-10-21T12:00:40Z'); await m.waitLog(new RegExp(`${clone}: listening`)); },
    async assigned(clone) { m.mark('assigned', 'job=9e8d7c6b at=2026-10-21T12:01:00Z by=diag'); await m.waitLog(new RegExp(`${clone}: the listener took a job`)); },
    async job(clone, run = 7) {
      m.mark('job', `run=${run} attempt=1 job=e2e repository=SSFSKIM/MAWS at=2026-10-21T12:01:30Z`);
      await m.waitLog(new RegExp(`${clone} took run ${run} job e2e`));
    },
    async finished(clone) {
      m.mark('done', '0');
      m.powerOff(clone);
      await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`), `${clone}'s teardown`);
    },
    // Every launcher and process of this Mac.
    async stop() {
      clearInterval(monitor);
      for (const child of host) child.kill('SIGKILL');
      for (const name of readdirSync(vms)) {
        const pid = Number(text(join(vms, name, 'run.pid')));
        if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    },
    violations: [],
  };
  m.memory(memory);
  m.disk(disk);
  m.display(display);
  if (queue.length) m.queue(...queue);
  // The reservation's invariant, read all through the test: a job clone that exists across a read of the reservation
  // was reserved at that read. The reservation is written before the clone exists and removed after it is deleted.
  const monitor = setInterval(() => {
    const before = new Set(m.clones());
    const reserved = existsSync(join(logs, 'vm-reserved'));
    if (reserved) orphans.clear();
    const after = m.clones().filter((name) => before.has(name) && !orphans.has(name));
    if (!reserved && after.length) m.violations.push(`${after.join(', ')} existed while nothing was reserved`);
  }, 20);
  cleanups.push(() => clearInterval(monitor));
  cleanups.push(() => m.stop());
  return m;
}
// The launchers of one Mac, killed at the end of its test.
async function finish(m, ...running) {
  for (const launcherProcess of running) await launcherProcess.kill();
  await m.stop();
  assert.deepEqual(m.violations, [], 'a job clone existed without the reservation');
  assert.equal(readFileSync(join(m.home, 'tart/clipboard-shared'), { encoding: 'utf8', flag: 'a+' }), '', 'every tart run carries --no-clipboard');
}

// Observe the real release at the filesystem boundary, not by polling after it. The shim records what a reader
// could see immediately BEFORE unlink, then delegates to the real rm. Moving the stamp after rm fails this check.
function observeRelease(m) {
  const earliest = Math.floor(Date.now() / 1000);
  executable(join(m.home, 'bin/rm'), `for arg in "$@"; do
  [[ $arg == "$HOME/Library/Logs/ci-kit/vm-reserved" ]] || continue
  present=no; [[ ! -e $arg ]] || present=yes
  clones=none; for dir in "$HOME/tart/vms"/maws-vm-job-*; do [[ ! -d $dir ]] || clones=present; done
  printf '%s\\t%s\\t%s\\t%s\\n' "$present" "$(cat "$HOME/Library/Logs/ci-kit/vm-released" 2>/dev/null)" "$clones" "$(date +%s)" >> "$HOME/releases"
done
exec /bin/rm "$@"`);
  return {
    reads: () => existsSync(join(m.home, 'releases')) ? readFileSync(join(m.home, 'releases'), 'utf8').trimEnd().split('\n').map((line) => line.split('\t')) : [],
    assertStamped() {
      const reads = this.reads();
      assert.ok(reads.length, 'the release must have reached unlink');
      for (const [present, stamp, clones, at] of reads) {
        assert.equal(present, 'yes', 'the reservation still stands when the stamp is visible');
        assert.match(stamp, /^\d+$/, 'a complete epoch stamp is published before unlink');
        assert.ok(Number(stamp) >= earliest && Number(stamp) <= Number(at), 'the stamp is from this release, not a prior guest');
        assert.equal(clones, 'none', 'the reservation outlives the clone');
      }
      assert.match(readFileSync(join(m.logs, 'vm-released'), 'utf8'), /^\d+\n$/, 'one epoch-second line');
    },
  };
}

describe('the VM lane\'s launcher', { concurrency: 4, ...macOnly }, () => {
  for (const state of ['stopped', 'absent', 'orphan', 'unnamed']) {
    test(`recovery stamps before removing the reservation: ${state}`, async () => {
      const m = lane();
      const observed = observeRelease(m);
      const clone = `maws-vm-job-${m.slot}-20261021T120000Z`;
      if (state === 'orphan') m.orphan(clone);
      else {
        if (state === 'stopped') m.vm(clone);
        writeFileSync(join(m.logs, 'vm-reserved'), state === 'unnamed' ? 'incomplete reservation\n' : `vm=${clone}\n`);
      }
      const a = m.start();
      await m.waitLog(/recovery: no job clone and no reservation; idle/);
      observed.assertStamped();
      assert.equal(m.reserved(), null);
      await finish(m, a);
    });
  }

  test('the release stamp replaces the old one atomically while still reserved', async () => {
    const m = lane();
    const observed = observeRelease(m);
    writeFileSync(join(m.logs, 'vm-reserved'), 'incomplete reservation\n');
    writeFileSync(join(m.logs, 'vm-released'), '1\n');
    executable(join(m.home, 'bin/mv'), `if [[ \${!#} == "$HOME/Library/Logs/ci-kit/vm-released" ]]; then
  printf '%s\\n' "$1" > "$HOME/release-staged"
  until [[ -e $HOME/release-go ]]; do sleep 0.05; done
fi
exec /bin/mv "$@"`);
    const a = m.start();
    await m.until(() => existsSync(join(m.home, 'release-staged')) || observed.reads().length, 'the stamp rename or premature unlink');
    assert.equal(observed.reads().length, 0, 'no unlink before the atomic stamp publication');
    assert.ok(m.reserved());
    assert.equal(readFileSync(join(m.logs, 'vm-released'), 'utf8'), '1\n', 'readers still see the whole old stamp');
    writeFileSync(join(m.home, 'release-go'), '');
    await m.waitLog(/recovery: no job clone and no reservation; idle/);
    observed.assertStamped();
    await finish(m, a);
  });

  for (const failure of ['write', 'rename']) {
    test(`a failed release stamp ${failure} is logged but does not retain the reservation`, async () => {
      const m = lane();
      const observed = observeRelease(m);
      writeFileSync(join(m.logs, 'vm-reserved'), 'incomplete reservation\n');
      writeFileSync(join(m.logs, 'vm-released'), '1\n');
      if (failure === 'write') mkdirSync(join(m.logs, 'vm-released.tmp'));
      else executable(join(m.home, 'bin/mv'), `[[ \${!#} != "$HOME/Library/Logs/ci-kit/vm-released" ]] || exit 1
exec /bin/mv "$@"`);
      const a = m.start();
      await m.waitLog(/recovery: no job clone and no reservation; idle/);
      assert.equal(m.reserved(), null);
      assert.match(m.log(), /vm-released.*could not be written.*releasing/);
      assert.equal(observed.reads()[0][1], '1', 'a failed publication keeps the old complete stamp');
      if (failure === 'rename') assert.equal(existsSync(join(m.logs, 'vm-released.tmp')), false);
      await finish(m, a);
    });
  }

  test('a queued ci-kit-mac-vm job boots a clone of the golden image, which goes through its one job to a verified teardown', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const observed = observeRelease(m);
    const a = m.start();
    const clone = await m.booted();
    assert.match(clone, new RegExp(`^maws-vm-job-${m.slot}-\\d{8}T\\d{6}Z$`));
    // The reservation, written before the clone, names it and the golden image it came from.
    assert.match(m.reserved(), new RegExp(`^reserved since \\S+: vm=${clone} slot=${m.slot} golden=${GOLDEN} \\(launcher ${a.pid}\\)\\nvm=${clone}\\n`));
    assert.match(m.log(), new RegExp(`booting ${clone} from the golden image ${GOLDEN}: 1 ci-kit-mac-vm job\\(s\\) queued; holds none; pressure 1, available 60%, swap 500 MB, swap steady over \\d+ s; free 120 GB; display 2560x1440@2x; mode always`));
    // tart run with the four shares, the kit and this clone's JIT read-only.
    assert.deepEqual(readFileSync(join(m.vms, clone, 'run.args'), 'utf8').trim().split('\n'), [
      '--no-graphics', '--no-clipboard', `--dir=kit:${mac}:ro`, `--dir=jit:${m.slotDir}/jit/${clone}:ro`, `--dir=out:${m.out}`, `--dir=cache:${m.slotDir}/cache`, clone]);
    assert.deepEqual(readFileSync(join(m.vms, clone, 'kicked'), 'utf8').trim().split('\n'), ['/Users/admin/ci-kit/vm/guest/kickoff.sh', m.slot, clone]);
    assert.deepEqual(readdirSync(m.out).filter((name) => name !== 'wrapper.log'), [], 'the clone is handed an empty out/ (the wrapper.log its kickoff opens aside)');
    await m.listening(clone);
    await m.assigned(clone);
    await m.job(clone);
    assert.match(m.reserved(), new RegExp(`vm=${clone} slot=${m.slot} golden=${GOLDEN} job=run 7 job e2e`));
    // What the wrapper leaves in out/ at the end: its log, the guest's hooks log, _diag (with a self-update).
    writeFileSync(join(m.out, 'wrapper.log'), '2026-10-21T12:05:00Z wrapper vm maws: the runner exited (0)\n');
    writeFileSync(join(m.out, 'mac-runner-hooks.log'), '2026-10-21T12:02:00Z run=7 job=e2e ci-kit desktop (start): vm=vm clone=x display=2560x1440@2x\n');
    mkdirSync(join(m.out, '_diag'));
    writeFileSync(join(m.out, '_diag/Runner_20261021-120040-utc.log'), '[2026-10-21 12:00:41Z INFO Runner] Refresh message received, kick-off selfupdate background process.\n');
    m.queue();
    await m.finished(clone);
    assert.equal(m.reserved(), null);
    assert.deepEqual(m.clones(), []);
    // Powered off by itself: no stop; deleted only after its end.
    const calls = m.calls().filter((call) => !call.startsWith('list') && call.includes(clone));
    assert.deepEqual(calls.map((call) => call.split(' ')[0]).filter((verb, i, all) => verb !== all[i - 1]), ['clone', 'run', 'exec', 'delete']);
    // out/ folded into the logs and kept; a fresh out/ for the next clone.
    assert.match(m.log(), new RegExp(`${clone} out/job: run=7 attempt=1 job=e2e`));
    assert.match(m.log(), new RegExp(`${clone} wrapper.log: 2026-10-21T12:05:00Z wrapper vm maws: the runner exited \\(0\\)`));
    assert.match(m.log(), new RegExp(`${clone}: refresh trigger: the runner updated itself at 2026-10-21T12:00:41Z`));
    assert.match(m.log(), new RegExp(`${clone}: run 7 job e2e ran; the runner exited 0`));
    assert.match(m.hooksLog(), /ci-kit desktop \(start\): vm=vm clone=x/);
    assert.deepEqual(readdirSync(join(m.logs, 'vm-out', clone)).sort(), ['_diag', 'assigned', 'done', 'job', 'listening', 'mac-runner-hooks.log', 'wrapper.log']);
    assert.deepEqual(readdirSync(m.out), []);
    // The queue was read with the machine's own login, never the job's token.
    const reads = m.ghCalls().filter((call) => call[0] === 'api');
    assert.ok(reads.length >= 3);
    for (const call of reads) assert.equal(call.at(-1), 'GH_TOKEN=unset');
    assert.ok(reads.some((call) => call[1] === 'repos/SSFSKIM/MAWS/actions/runs?status=queued&per_page=100'));
    assert.ok(reads.some((call) => call[1] === 'repos/SSFSKIM/MAWS/actions/runs/101/jobs?filter=latest&per_page=100'));
    assert.deepEqual(m.alerts(), []);
    observed.assertStamped();
    await finish(m, a);
  });

  // The boot rule (lane.sh's header): each condition failing alone keeps the lane down, logged once with what was read;
  // the same lane boots once the condition holds. Every case has a ci-kit-mac-vm job queued unless it says otherwise.
  const idleRead = (m) => m.waitLog(/recovery: no job clone and no reservation; idle/);
  for (const { name, options = {}, before, after: afterStart, refusal, lift } of [
    { name: '1, no queued job', options: { queue: [] }, refusal: /no boot: no queued job for the guest$/m, lift: (m) => m.queue(['ci-kit-mac-vm']) },
    { name: '1, only jobs another runner takes', options: { queue: [['self-hosted', 'macOS', 'ARM64', 'ci-kit-mac'], ['ci-kit-mac-shared'], ['ci-kit-mac-vm-trial']] },
      refusal: /no boot: no queued job for the guest$/m, lift: (m) => m.queue(['ci-kit-mac-shared'], ['ci-kit-mac-solo', 'ci-kit-mac-vm']) },
    { name: '2, a solo job the idle exclusive instance takes first', options: { queue: [['ci-kit-mac-solo']] }, before: (m) => m.instance('idle'),
      refusal: /no boot: a ci-kit-mac-solo job queued, but the host's exclusive instance is idle and takes it first$/m, lift: (m, listener) => listener.kill() },
    { name: '3, a coordinator\'s hold', before: (m) => writeFileSync(join(m.logs, 'vm-hold.CI-opt-a45b97a3'), 'timed since 2026-10-21T12:00:00Z\n'),
      refusal: /no boot: CI-opt-a45b97a3: timed since 2026-10-21T12:00:00Z$/m, lift: (m) => rmSync(join(m.logs, 'vm-hold.CI-opt-a45b97a3')) },
    { name: '3, a pause in force', before: (m) => writeFileSync(join(m.logs, 'vm-pause'), 'paused\nreason=failures\nuntil=none\nwhy=three image failures\n'),
      refusal: /no boot: paused \(failures\) until an operator removes vm-pause: three image failures$/m, lift: (m) => rmSync(join(m.logs, 'vm-pause')) },
    { name: '3 (and 8), a live host job\'s claim', before: (m) => m.claim(),
      refusal: /no boot: a claim holds the lane \(vm-claim\.\d+-\S+: run 7 job e2e \(worker \d+\); vm-claims exit 0\)$/m, lift: (m, claim) => claim.kill() },
    { name: '4, a reservation', after: (m) => writeFileSync(join(m.logs, 'vm-reserved'), 'reserved since 2026-10-21T12:00:00Z: vm=maws-vm-job-x\nvm=maws-vm-job-x\n'),
      refusal: /no boot: the reservation stands \(reserved since 2026-10-21T12:00:00Z: vm=maws-vm-job-x\)$/m, lift: (m) => rmSync(join(m.logs, 'vm-reserved')) },
    { name: '4, a maintenance VM running', before: (m) => m.vm('maws-vm-candidate-20261021', 'running'),
      refusal: /no boot: maws-vm-candidate-20261021 runs$/m, lift: (m) => m.vm('maws-vm-candidate-20261021', 'stopped') },
    { name: '5, memory pressure', options: { memory: { pressure: 2 } }, refusal: /no boot: memory pressure 2, not 1 \(pressure 2, available 60%, swap 500 MB\)$/m, lift: (m) => m.memory() },
    { name: '5, available memory under the floor (60 by default: V1\'s)', options: { memory: { available: 59 } }, refusal: /no boot: memory available 59%, under the floor of 60%$/m, lift: (m) => m.memory({ available: 60 }) },
    { name: '5, swap growing', before: (m) => writeFileSync(join(m.home, 'swap-grow'), '500\n'), refusal: /no boot: swap grew from \d+ MB to \d+ MB in \d+ s$/m,
      lift: (m) => rmSync(join(m.home, 'swap-grow')) },
    { name: '5, a memory read that fails', options: { memory: { pressure: 'fail' } }, refusal: /no boot: memory unknown \(the read failed\)$/m, lift: (m) => m.memory() },
    { name: '5, free disk under the reserve', options: { disk: 39.5 }, refusal: /no boot: 39 GB free on the volume of \S+, under the reserve of 40 GB$/m, lift: (m) => m.disk(40) },
    { name: '5, a disk read that fails', options: { disk: 'fail' }, refusal: /no boot: the free space of \S+ cannot be read$/m, lift: (m) => m.disk(120) },
    { name: '6, the host\'s display at @1x', options: { display: '2560x1440@1x' }, refusal: /no boot: the host's display is 2560x1440@1x, not @2x$/m, lift: (m) => m.display('2560x1440@2x') },
    { name: '6, a display that cannot be read', options: { display: '' }, refusal: /no boot: the host's display is unreadable, not @2x$/m, lift: (m) => m.display('3008x1692@2x') },
    { name: '7, hold-only while a host instance runs', options: { env: { CI_KIT_VM_LANE_MODE: 'hold-only' } }, before: (m) => m.instance('idle'),
      refusal: /no boot: mode hold-only, and actions-runner-maws is not held$/m, lift: (m, listener) => listener.kill() },
    { name: 'the lane\'s parts, a golden pointer naming no VM', before: (m) => writeFileSync(join(m.vmHome, 'golden'), 'maws-vm-golden-gone\n'),
      refusal: /no boot: the golden image maws-vm-golden-gone is not among Tart's VMs$/m, lift: (m) => writeFileSync(join(m.vmHome, 'golden'), `${GOLDEN}\n`) },
  ]) test(`the boot rule, ${name}: no boot while it fails alone, and a boot once it holds`, async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], ...options });
    const held = before ? await before(m) : undefined;
    const a = m.start();
    if (afterStart) { await idleRead(m); afterStart(m); }
    await m.waitLog(refusal);
    await sleep(2500);
    assert.equal(m.calls().filter((call) => /^(clone|run) /.test(call)).length, 0, 'nothing cloned or run');
    assert.equal(m.log().split('\n').filter((line) => refusal.test(line)).length, 1, 'logged once, not at every poll');
    await lift(m, held);
    await m.waitLog(/booting maws-vm-job-\S+ from the golden image/);
    await finish(m, a);
  });

  test('the boot rule, a pause window: nothing boots inside it', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_PAUSE_WINDOWS: '00:00-00:00,23:59-23:58' } });
    const a = m.start();
    await m.waitLog(/no boot: inside the pause window 23:59-23:58 \(UTC\)$/m);
    await sleep(2000);
    assert.equal(m.calls().filter((call) => call.startsWith('clone ')).length, 0);
    await finish(m, a);
  });

  for (const { name, queue, host, reads } of [
    { name: 'busy with a job', queue: [['ci-kit-mac-solo']], host: 'busy', reads: /a ci-kit-mac-solo job queued, and the host's exclusive instance is busy/ },
    { name: 'held by the dialog watcher', queue: [['ci-kit-mac-solo']], host: 'held', reads: /a ci-kit-mac-solo job queued, and the host's exclusive instance is held/ },
    { name: 'offline', queue: [['ci-kit-mac-solo']], host: null, reads: /a ci-kit-mac-solo job queued, and the host's exclusive instance is offline/ },
    { name: 'idle, with two solo jobs queued', queue: [['ci-kit-mac-solo'], ['CI-KIT-MAC-SOLO']], host: 'idle', reads: /2 ci-kit-mac-solo jobs queued, more than the host's exclusive instance takes/ },
  ]) test(`a solo job boots a clone when the host's exclusive instance is ${name}, and the boot's line says so`, async () => {
    const m = lane({ queue });
    if (host === 'busy' || host === 'idle') await m.instance(host);
    if (host === 'held') writeFileSync(join(m.logs, 'runner-drained'), 'held at 2026-10-21T12:00:00Z: SecurityAgent\n');
    const a = m.start();
    await m.waitLog(/booting maws-vm-job-/);
    assert.match(m.log(), new RegExp(`booting maws-vm-job-\\S+ from the golden image ${GOLDEN}: ${reads.source}`));
    await finish(m, a);
  });

  test('a claim whose worker is gone is stale: it holds nothing, and the claims read removes it', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const claim = await m.claim();
    await claim.kill();
    const a = m.start();
    await m.waitLog(/booting maws-vm-job-/);
    assert.equal(existsSync(join(m.logs, claim.name)), false);
    assert.doesNotMatch(m.log(), /a claim holds the lane/);
    await finish(m, a);
  });

  // THE FENCE: the reservation, the clone and the spawn are one step under the desktop lock.
  test('the job boot holds the desktop lock from the reservation\'s write to the spawn: a host hook taking it meanwhile gets it only after tart run is started', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    m.flag('block-clone');
    const a = m.start();
    await m.until(() => existsSync(join(m.home, 'tart/clone-waiting')), 'the clone under way');
    assert.match(m.reserved(), new RegExp(`^reserved since \\S+: vm=maws-vm-job-${m.slot}-`), 'reserved before the clone exists');
    assert.equal(m.lockFree(), false, 'the desktop lock is held');
    // A host hook (settle raising its claim, an exclusive start) waits for the lock, and reads the process table once
    // it has it.
    const hook = spawn('perl', ['-MFcntl=:flock', '-e', '$| = 1; open(my $fh, ">>", shift) or die; flock($fh, LOCK_EX) or die; print `/bin/ps -axww -o command=`; print "locked\\n"; sleep 600',
      join(m.logs, 'desktop.lock')], { stdio: ['ignore', 'pipe', 'inherit'] });
    let seen = '';
    hook.stdout.on('data', (chunk) => { seen += chunk; });
    await sleep(500);
    assert.equal(seen, '', 'the hook waits for the boot');
    m.flag('clone-go');
    await m.until(() => seen.includes('locked\n'), 'the hook\'s lock');
    assert.match(seen, new RegExp(`tart run --no-graphics --no-clipboard .* maws-vm-job-${m.slot}-\\d{8}T\\d{6}Z$`, 'm'), 'tart run was started before the lock was let go');
    hook.kill('SIGKILL');
    await m.booted();
    await finish(m, a);
  });

  test('a clone that fails is released under the same lock, as an image failure, and nothing is left of it', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const observed = observeRelease(m);
    m.flag('fail-clone');
    const a = m.start();
    await m.waitLog(/no boot: tart clone maws-vm-golden-20261020 (maws-vm-job-\S+) failed: Error: no space left on device; nothing of \1 is left, and the reservation is released/);
    await m.quiet();
    assert.equal(m.reserved(), null);
    assert.deepEqual(m.clones(), []);
    assert.equal(m.calls().filter((call) => call.startsWith('run ')).length, 0);
    assert.match(m.log(), /failure \(image\): tart clone .* failed: .*; 1 in a row/);
    observed.assertStamped();
    await finish(m, a);
  });

  test('a tart run that exits at once has its stopped clone deleted, then the reservation released, under the same lock', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const observed = observeRelease(m);
    m.flag('fail-run');
    const a = m.start();
    await m.waitLog(/no boot: tart run (maws-vm-job-\S+) exited at once \(1\); nothing of \1 is left, and the reservation is released/);
    await m.quiet();
    const clone = /no boot: tart run (\S+) exited/.exec(m.log())[1];
    assert.deepEqual(m.calls().filter((call) => call.includes(clone) && !call.startsWith('list')).map((call) => call.split(' ')[0]), ['clone', 'run', 'delete']);
    assert.equal(m.reserved(), null);
    assert.deepEqual(m.clones(), []);
    assert.ok(m.lockFree());
    observed.assertStamped();
    await finish(m, a);
  });

  test('boot undo cannot release when the post-stop list fails: teardown deletes first, then stamps and releases', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const observed = observeRelease(m);
    m.flag('fail-run');
    m.flag('fail-undo-list');
    const a = m.start();
    await m.until(() => m.log().includes('its end cannot be verified here') || observed.reads().length, 'undo defers or releases');
    assert.deepEqual(observed.reads(), [], 'an unreadable list is not proof the clone is absent');
    assert.ok(m.reserved());
    assert.equal(m.clones().length, 1);
    const clone = m.clones()[0];
    m.queue();
    m.flag('fail-undo-list', false);
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    observed.assertStamped();
    await finish(m, a);
  });

  // THE COORDINATOR'S HOLD (hold.sh), under desktop.lock as the boot's read of the holds is.
  test('a hold written while a boot sits between its hold read and its reservation write waits for that boot\'s guest: it is never reported clear with a guest coming', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    m.flag('block-locked-list', 2);
    const a = m.start();
    await m.until(() => existsSync(join(m.home, 'tart/list-waiting')), 'the boot paused in its locked list');
    assert.equal(m.reserved(), null, 'no reservation yet');
    const hold = m.holdCommand(['hold', 'bench-1', 'timed'], { CI_KIT_VM_HOLD_WAIT: '600' });
    await sleep(1500);
    assert.equal(existsSync(join(m.logs, 'vm-hold.bench-1')), false, 'the hold waits for the boot\'s lock');
    assert.doesNotMatch(hold.output(), /no guest/);
    m.flag('list-go');
    const clone = await m.booted();
    await m.until(() => /waiting: a reservation stands/.test(hold.output()), 'the hold waiting on the reservation');
    assert.match(readFileSync(join(m.logs, 'vm-hold.bench-1'), 'utf8'), /^timed since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
    await m.listening(clone);
    await m.assigned(clone);
    await m.job(clone);
    assert.doesNotMatch(hold.output(), /no guest/, 'not clear while the guest runs');
    await m.finished(clone);
    assert.equal(await hold.exited, 0);
    assert.match(hold.output(), /ci-kit vm hold: no guest\n$/);
    await m.waitLog(/no boot: bench-1: timed since /);
    await finish(m, a);
  });

  test('hold.sh: a wait past its bound reports the guest still there and keeps the hold; a release removes its owner\'s hold alone; an owner that is not a name is refused', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    const hold = m.holdCommand(['hold', 'bench-1', 'timed'], { CI_KIT_VM_HOLD_WAIT: '1' });
    assert.equal(await hold.exited, 1);
    assert.match(hold.output(), /not clear after 1 s: a reservation stands \(reserved since \S+: vm=maws-vm-job-/);
    assert.ok(existsSync(join(m.logs, 'vm-hold.bench-1')), 'the hold stays');
    writeFileSync(join(m.logs, 'vm-hold.cua-2'), 'untimed since 2026-10-21T12:00:00Z\n');
    assert.equal(await m.holdCommand(['release', 'bench-1']).exited, 0);
    assert.equal(existsSync(join(m.logs, 'vm-hold.bench-1')), false);
    assert.ok(existsSync(join(m.logs, 'vm-hold.cua-2')), 'another owner\'s hold stays');
    const bad = m.holdCommand(['hold', 'x;touch $HOME/owned', 'timed']);
    assert.equal(await bad.exited, 2);
    assert.match(bad.output(), /refused: the owner 'x;touch \$HOME\/owned' is not a name/);
    assert.equal(readdirSync(m.logs).filter((name) => name.startsWith('vm-hold.') && name !== 'vm-hold.cua-2').length, 0);
    assert.equal(existsSync(join(m.home, 'owned')), false);
    assert.equal(await m.holdCommand(['hold', 'bench-1', 'forever']).exited, 2);
    // Every reader of the holds skips vm-hold.*.tmp as a write under way: such an owner would hold nothing.
    const staging = m.holdCommand(['hold', 'bench.tmp', 'timed']);
    assert.equal(await staging.exited, 2);
    assert.match(staging.output(), /refused: the owner 'bench\.tmp' is not a name \(.*not ending in \.tmp\)/);
    assert.equal(existsSync(join(m.logs, 'vm-hold.bench.tmp')), false);
    assert.deepEqual(readdirSync(m.logs).filter((name) => name.startsWith('.vm-hold.')), [], 'no staging left');
    await finish(m, a);
  });

  test('the docs\' vm_hold helper checks the owner before ssh, and quotes every argument into the remote command', () => {
    const docs = readFileSync(join(mac, '../docs/mac-lane.md'), 'utf8');
    const helper = /```bash\n(# vm_hold [\s\S]*?)```/.exec(docs)?.[1];
    assert.ok(helper, 'the helper is in docs/mac-lane.md');
    const home = mkdtempSync(join(root, 'vm-hold-'));
    const bin = join(home, 'bin');
    mkdirSync(join(home, 'ci-kit-vm/kit/vm'), { recursive: true });
    mkdirSync(bin);
    // ssh: the remote command run by a shell, as sshd runs it; hold.sh: its arguments, one a line.
    executable(join(bin, 'ssh'), `printf '%s\\n' "$1" >> "$HOME/ssh.calls"\nexec /bin/bash -c "$2"`);
    executable(join(home, 'ci-kit-vm/kit/vm/hold.sh'), `printf '%s\\n' "$@" > "$HOME/hold.args"`);
    const run = (...args) => {
      rmSync(join(home, 'hold.args'), { force: true });
      const result = spawnSync('/bin/bash', ['-c', `${helper}\nvm_hold "$@"`, 'vm_hold', ...args], { encoding: 'utf8', env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
      const held = existsSync(join(home, 'hold.args')) ? readFileSync(join(home, 'hold.args'), 'utf8').split('\n').slice(0, -1) : null;
      return { status: result.status, stderr: result.stderr, held };
    };
    assert.deepEqual(run('hold', 'bench-1', 'timed'), { status: 0, stderr: '', held: ['hold', 'bench-1', 'timed'] });
    assert.deepEqual(run('release', 'bench-1').held, ['release', 'bench-1']);
    assert.deepEqual(run('wait').held, ['wait']);
    const calls = readFileSync(join(home, 'ssh.calls'), 'utf8');
    for (const owner of ['x;touch $HOME/owned', '$(touch $HOME/owned)', 'bench.tmp', '']) {
      const refused = run('hold', owner, 'timed');
      assert.equal(refused.status, 2, owner);
      assert.match(refused.stderr, /vm_hold: not an owner/, owner);
      assert.equal(refused.held, null, owner);
    }
    assert.equal(readFileSync(join(home, 'ssh.calls'), 'utf8'), calls, 'no ssh for a refused owner');
    // What the local check does not cover still reaches the remote shell as one word.
    assert.deepEqual(run('hold', 'bench-1', 'timed; touch $HOME/owned').held, ['hold', 'bench-1', 'timed; touch $HOME/owned']);
    assert.equal(existsSync(join(home, 'owned')), false);
  });

  test('holds have owners: two overlap, one is removed, the lane stays held; with both gone a clone boots', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    writeFileSync(join(m.logs, 'vm-hold.CI-opt-a45b97a3'), 'timed since 2026-10-21T12:00:00Z\n');
    writeFileSync(join(m.logs, 'vm-hold.cua-bench'), 'timed since 2026-10-21T12:05:00Z\n');
    const a = m.start();
    await m.waitLog(/held: CI-opt-a45b97a3: timed since 2026-10-21T12:00:00Z; cua-bench: timed since 2026-10-21T12:05:00Z$/m);
    rmSync(join(m.logs, 'vm-hold.CI-opt-a45b97a3'));
    await m.waitLog(/held: cua-bench: timed since 2026-10-21T12:05:00Z$/m);
    await m.waitLog(/no boot: cua-bench: timed since 2026-10-21T12:05:00Z$/m);
    await sleep(1500);
    assert.equal(m.calls().filter((call) => call.startsWith('clone ')).length, 0);
    rmSync(join(m.logs, 'vm-hold.cua-bench'));
    await m.waitLog(/no hold any more/);
    await m.booted();
    await finish(m, a);
  });

  test('a hold kept past its bound opens one alert per owner, closed when that owner removes it', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_HOLD_ALERT: '1' } });
    writeFileSync(join(m.logs, 'vm-hold.CI-opt-a45b97a3'), 'timed since 2026-10-21T12:00:00Z\n');
    const a = m.start();
    await m.until(() => m.alerts().length === 1, 'the hold alert');
    assert.match(m.alerts()[0], /^ci-kit alert: vm lane on mini held by CI-opt-a45b97a3 since \d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
    await sleep(1500);
    assert.equal(m.alerts().length, 1, 'one issue, not one a poll');
    // With the queue empty while the hold goes, no boot can take the lane out of idle, where the close is read.
    m.queue();
    rmSync(join(m.logs, 'vm-hold.CI-opt-a45b97a3'));
    await m.until(() => m.closed().length === 1, 'the close');
    assert.deepEqual(m.closed(), ['https://github.com/SSFSKIM/ci-kit-sandbox/issues/1']);
    m.queue(['ci-kit-mac-vm']);
    await m.booted();
    await finish(m, a);
  });

  // RECOVERY, at the start only, over job clones only.
  test('recovery touches job clones alone: a running candidate, golden and trial clone are left as they are, nothing boots while they run, and an alert follows', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_MAINTENANCE_ALERT: '1' } });
    for (const name of ['maws-vm-candidate-20261021', 'maws-vm-golden-20261019', 'maws-vm-trial-20261021T120000Z']) m.vm(name, 'running');
    // A job clone of this slot nothing reserved (a reservation write that failed): reserved first, then torn down.
    const orphan = `maws-vm-job-${m.slot}-20261021T110000Z`;
    m.orphan(orphan);
    const a = m.start();
    await m.waitLog(new RegExp(`recovery: ${orphan} is a job clone with no reservation; reserved it before its teardown`));
    await m.waitLog(new RegExp(`${orphan}: deleted, and the reservation released`));
    await m.waitLog(/recovery: no job clone and no reservation; idle/);
    await m.waitLog(/a maws-vm-\* VM runs that this launcher did not boot \(maws-vm-candidate-20261021 maws-vm-golden-20261019 maws-vm-trial-20261021T120000Z\); nothing boots while it does/);
    await m.until(() => m.alerts().length === 1, 'the alert');
    assert.match(m.alerts()[0], /^ci-kit alert: vm lane on mini found maws-vm-candidate-20261021 maws-vm-golden-20261019 maws-vm-trial-20261021T120000Z running since /);
    await sleep(1500);
    assert.deepEqual(m.calls().filter((call) => /^(stop|delete|clone|run) /.test(call)), [`delete ${orphan}`]);
    for (const name of ['maws-vm-candidate-20261021', 'maws-vm-golden-20261019', 'maws-vm-trial-20261021T120000Z']) assert.equal(m.state(name), 'running');
    for (const name of ['maws-vm-candidate-20261021', 'maws-vm-golden-20261019', 'maws-vm-trial-20261021T120000Z']) m.vm(name, 'stopped');
    await m.waitLog(/no maws-vm-\* VM runs any more/);
    await m.until(() => m.closed().length === 1, 'the close');
    await m.booted();
    await finish(m, a);
  });

  // THE DEAD LAUNCHER. A measured job waits at settle (its claim live), reading the reservation as settle does.
  const settleRead = (m) => spawnSync('/bin/bash', [join(mac, 'hooks/vm-claim.sh'), 'reservation'], { encoding: 'utf8', env: { HOME: m.home, PATH: '/usr/bin:/bin' } }).stdout.trim();

  test('a launcher killed during a boot: the reservation stands and settle stays parked; the next launcher, after waiting for the lock, finds the guest running with no wrapper and stops it; settle is released only after Tart shows it stopped', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const observed = observeRelease(m);
    m.flag('no-agent');
    const a = m.start();
    await m.waitLog(/runs \(tart run, pid \d+\); waiting for its guest agent/);
    const clone = m.clones()[0];
    const claim = await m.claim();
    await a.kill();
    assert.equal(m.state(clone), 'running', 'the guest outlives its launcher');
    assert.equal(settleRead(m), 'reserved');
    // A host hook holds the lock as the next launcher starts: its recovery waits for it.
    const hook = await m.holdLock();
    const b = m.start();
    await m.waitLog(new RegExp(`starting \\(pid ${b.pid}`));
    await sleep(1500);
    assert.doesNotMatch(m.log().split(`starting (pid ${b.pid}`)[1], /recovery:/, 'recovery waits for the lock');
    await hook.release();
    await m.waitLog(new RegExp(`recovery: ${clone} runs, and its wrapper has not started; stopping it`));
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.equal(settleRead(m), 'none');
    assert.ok(m.calls().indexOf(`stop ${clone} --timeout 30`) < m.calls().indexOf(`delete ${clone}`));
    await m.waitLog(/no boot: a claim holds the lane/);
    await claim.kill();
    await m.waitLog(/booting maws-vm-job-/);
    observed.assertStamped();
    await finish(m, b);
  });

  test('a launcher killed during a job: the reservation stands and settle stays parked; the next launcher adopts the job, never stops it, and releases only after the guest powered off and was deleted', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const observed = observeRelease(m);
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    await m.assigned(clone);
    await m.job(clone);
    // The measured job starts on the host while the guest runs: its claim waits on the reservation.
    const claim = await m.claim();
    await a.kill();
    assert.equal(settleRead(m), 'reserved');
    const b = m.start();
    await m.waitLog(new RegExp(`recovery: ${clone} runs its job \\(job=9e8d7c6b at=2026-10-21T12:01:00Z by=diag\\); adopted \\(running\\), the bound counted from out/assigned`));
    await sleep(1500);
    assert.equal(settleRead(m), 'reserved');
    assert.equal(m.state(clone), 'running');
    await m.finished(clone);
    assert.equal(settleRead(m), 'none');
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0, 'the adopted job is never stopped');
    assert.match(m.log(), new RegExp(`${clone}: run 7 job e2e ran; the runner exited 0`));
    await m.waitLog(/no boot: a claim holds the lane/);
    await claim.kill();
    await m.waitLog(/booting maws-vm-job-/);
    observed.assertStamped();
    await finish(m, b);
  });

  test('a launcher killed while its guest listens: the next one asks the wrapper to stop, and the stopped guest is torn down', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    await a.kill();
    m.queue();
    const b = m.start();
    await m.waitLog(new RegExp(`recovery: ${clone} runs with no job assigned; the idle handshake`));
    await m.until(() => existsSync(join(m.out, 'stop-request')), 'the stop request');
    m.mark('stopped', 'at=2026-10-21T12:04:00Z');
    m.mark('done', '0');
    m.powerOff(clone);
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    await finish(m, b);
  });

  test('recovery that cannot list Tart, with a reserved guest running: the guard samples it, and critical pressure stops it by name; released only once its end is verified', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    await a.kill();
    m.flag('fail-list');
    const b = m.start();
    await m.waitLog(/recovery waits: Tart cannot list its VMs/);
    await m.waitLog(new RegExp(`sample recover ${clone}: pressure 1`));
    m.memory({ pressure: 4, available: 8 });
    await m.waitLog(new RegExp(`${clone}: stopped for memory: memory pressure critical`));
    await m.until(() => m.calls().includes(`stop ${clone} --timeout 30`), 'the stop by name');
    await m.until(() => m.state(clone) === 'stopped', 'the guest stopped');
    assert.match(m.alerts()[0], /^ci-kit alert: vm lane on mini stopped a job for memory at /);
    await sleep(1500);
    assert.ok(m.reserved(), 'the reservation stands while the end cannot be verified');
    assert.equal(m.calls().filter((call) => call.startsWith('delete ')).length, 0);
    m.memory();
    m.flag('fail-list', false);
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.equal(m.failures().total_memory, '1');
    await finish(m, b);
  });

  test('recovery that cannot list Tart: a stop by name that fails is tried again at each poll until one goes through, and the reservation stays until the end is verified', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    await a.kill();
    m.flag('fail-list');
    m.flag('fail-stop');
    const b = m.start();
    await m.waitLog(/recovery waits: Tart cannot list its VMs/);
    m.memory({ pressure: 4, available: 8 });
    await m.waitLog(new RegExp(`${clone}: its end cannot be told \\(Tart cannot list its VMs\\), and tart stop by name failed; tried again each poll`));
    const stops = () => m.calls().filter((call) => call === `stop ${clone} --timeout 30`).length;
    await m.until(() => stops() >= 2, 'the stop tried again');
    assert.equal(m.state(clone), 'running');
    m.flag('fail-stop', false);
    await m.waitLog(new RegExp(`${clone}: its end cannot be told \\(Tart cannot list its VMs\\); stopped by name \\(tart stop\\)`));
    await m.until(() => m.state(clone) === 'stopped', 'the guest stopped');
    const after = stops();
    await sleep(2000);
    assert.equal(stops(), after, 'no stop once one went through');
    assert.ok(m.reserved(), 'the reservation stands while the end cannot be verified');
    m.memory();
    m.flag('fail-list', false);
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    await finish(m, b);
  });

  test('a delete Tart refuses keeps the reservation, is tried each poll and alerts after its bound; once Tart lets go it is released and the alert closed', async () => {
    const m = lane({ env: { CI_KIT_VM_STOP_ALERT: '2' } });
    const observed = observeRelease(m);
    const clone = `maws-vm-job-${m.slot}-20261021T120000Z`;
    // Tart lists it stopped, but it is not (the list the test sets), so the delete is refused as on a running VM.
    m.vm(clone, 'running');
    writeFileSync(join(m.vms, clone, 'listed'), 'stopped\n');
    writeFileSync(join(m.logs, 'vm-reserved'), `reserved since 2026-10-21T12:00:00Z: vm=${clone}\nvm=${clone}\n`);
    const a = m.start();
    await m.waitLog(new RegExp(`${clone} cannot be torn down yet \\(tart delete failed: Error: VM "${clone}" is running\\); the reservation stays`));
    await m.until(() => m.alerts().length === 1, 'the alert');
    assert.equal(m.alerts()[0], `ci-kit alert: vm lane on mini cannot stop ${clone} since ${/(\d{4}-\d\d-\d\dT\d\d:\d\d)/.exec(m.alerts()[0])[1]}Z`);
    assert.ok(m.reserved());
    assert.ok(m.calls().filter((call) => call === `delete ${clone}`).length >= 2, 'tried again');
    m.vm(clone, 'stopped');
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    await m.until(() => m.closed().length === 1, 'the close');
    observed.assertStamped();
    await finish(m, a);
  });

  // THE IDLE HANDSHAKE.
  test('idle past its bound with nothing queued, the guest is asked to stop, never forced; stopped, it powers off and is torn down with no failure', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_IDLE: '2' } });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    m.queue();
    await m.waitLog(new RegExp(`${clone}: no job taken in \\d+ s and none queued for it; asked the wrapper to stop \\(out/stop-request\\), answer within 180 s`));
    assert.equal(readFileSync(join(m.out, 'stop-request'), 'utf8'), '');
    m.mark('stopped', 'at=2026-10-21T12:04:00Z');
    await m.waitLog(new RegExp(`${clone}: the listener stopped with no job`));
    m.mark('done', '0');
    m.powerOff(clone);
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    assert.equal(m.failures().total_raced, '0');
    assert.equal(m.failures().image_run, '0');
    await finish(m, a);
  });

  test('idle past its bound while a job it can take is queued, the guest listens on; the stop is asked once the queue is empty', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_IDLE: '1' } });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    await m.waitLog(new RegExp(`${clone}: idle past 1 s, but 1 job\\(s\\) queued it can take; listening on`));
    await sleep(2000);
    assert.equal(existsSync(join(m.out, 'stop-request')), false);
    m.queue();
    await m.until(() => existsSync(join(m.out, 'stop-request')), 'the stop request');
    await finish(m, a);
  });

  test('a job the listener took before the job\'s hook, older than the idle bound, is never stopped', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_IDLE: '1' } });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    await m.assigned(clone);
    m.queue();
    await sleep(3000);
    assert.equal(existsSync(join(m.out, 'stop-request')), false);
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    await m.job(clone);
    await m.finished(clone);
    await finish(m, a);
  });

  test('a stop the wrapper refuses (a job taken meanwhile) moves the guest to preparing, and its job runs to its end', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_IDLE: '1' } });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    m.queue();
    await m.until(() => existsSync(join(m.out, 'stop-request')), 'the stop request');
    m.mark('assigned', 'job=9e8d7c6b at=2026-10-21T12:03:00Z by=diag');
    m.mark('stop-refused', 'job=9e8d7c6b');
    await m.waitLog(new RegExp(`${clone}: the wrapper refused the stop \\(job=9e8d7c6b\\): the listener took a job; preparing`));
    await m.job(clone);
    await m.finished(clone);
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    await finish(m, a);
  });

  test('an acceptance that raced the stop is logged, alerted with its job, and counted as raced', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_IDLE: '1' } });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    m.queue();
    await m.until(() => existsSync(join(m.out, 'stop-request')), 'the stop request');
    m.mark('stop-raced', 'job=9e8d7c6b');
    await m.waitLog(new RegExp(`${clone}: a job \\(9e8d7c6b\\) was accepted as the listener stopped, and the stop cancelled it at GitHub; rerun it`));
    await m.until(() => m.alerts().length === 1, 'the alert');
    assert.match(m.alerts()[0], /^ci-kit alert: vm lane on mini cancelled job 9e8d7c6b at \S+ \(an acceptance raced the idle stop\)$/);
    m.mark('done', '0');
    m.powerOff(clone);
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.equal(m.failures().total_raced, '1');
    assert.equal(m.failures().image_run, '0');
    await finish(m, a);
  });

  test('a stop the wrapper does not answer is bounded on the launcher\'s own clock: the guest is stopped, counted as raced and alerted', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_IDLE: '1', CI_KIT_VM_STOP_ANSWER: '2' } });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    m.queue();
    await m.waitLog(new RegExp(`${clone}: the stop was not answered within 2 s; stopping it; teardown`));
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.ok(m.calls().includes(`stop ${clone} --timeout 30`));
    assert.equal(m.failures().total_raced, '1');
    assert.match(m.alerts()[0], new RegExp(`^ci-kit alert: vm lane on mini stopped ${clone} with its idle stop unanswered at `));
    await finish(m, a);
  });

  // THE GUARD THROUGH BLOCKING WORK. A kickoff that has not returned, and a queue read that is slow.
  test('a kickoff that has not returned: critical pressure meanwhile stops the guest at the next sample', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    m.flag('block-kickoff');
    const a = m.start();
    const clone = await m.kickoffBlocked();
    m.memory({ pressure: 4, available: 8 });
    await m.waitLog(new RegExp(`${clone}: stopped for memory: memory pressure critical`));
    assert.equal(existsSync(join(m.home, 'tart/kickoff-go')), false, 'the kickoff never returned');
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.equal(m.failures().total_memory, '1');
    m.memory();
    await finish(m, a);
  });

  test('a kickoff that has not returned, while the guest takes a job: a warning leaves the job to finish, never a stop', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_WARN_PAUSE: '600' } });
    m.flag('block-kickoff-return');
    const a = m.start();
    const clone = await m.kickoffBlocked();
    // The guest's wrapper writes out/ as the exec that started it has yet to return (the reviewer's probe).
    m.mark('listening', 'at=2026-10-21T12:00:40Z');
    m.mark('assigned', 'job=9e8d7c6b at=2026-10-21T12:01:00Z by=diag');
    m.mark('job', 'run=7 attempt=1 job=e2e repository=SSFSKIM/MAWS at=2026-10-21T12:01:30Z');
    m.memory({ pressure: 2 });
    await m.waitLog(new RegExp(`${clone}: memory pressure warned on two samples; its job is left to finish`));
    await sleep(1500);
    assert.equal(existsSync(join(m.out, 'stop-request')), false);
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    m.memory();
    m.flag('kickoff-go');
    await m.finished(clone);
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    assert.equal(m.failures().total_memory ?? '0', '0');
    await finish(m, a);
  });

  test('a kickoff that has not returned, with nothing in out/ yet: a warning asks through the handshake; the kickoff then refuses, so no wrapper runs and the guest is stopped, with no race', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    m.flag('block-kickoff');
    const a = m.start();
    const clone = await m.kickoffBlocked();
    m.memory({ pressure: 2 });
    await m.waitLog(new RegExp(`${clone}: given up for memory; asked the wrapper to stop`));
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0, 'the kickoff may yet start the wrapper');
    m.memory();
    m.flag('kickoff-go');
    await m.waitLog(new RegExp(`${clone}: kickoff.sh failed: kickoff: out/ already holds stop-request`));
    await m.waitLog(new RegExp(`${clone}: no wrapper was started in it, so no answer comes and no job can be in it; stopping it; teardown`));
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.equal(m.failures().total_memory, '1');
    assert.equal(m.failures().total_raced, '0');
    assert.equal(m.alerts().length, 0);
    await finish(m, a);
  });

  test('a slow queue read is bounded as a whole: past its deadline it reads as unknown (no stop asked), and critical pressure meanwhile stops the guest', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_IDLE: '1', CI_KIT_VM_QUEUE_WAIT: '2' } });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    await m.waitLog(new RegExp(`${clone}: idle past 1 s, but 1 job\\(s\\) queued it can take; listening on`));
    m.ghFlag('slow');
    await m.until(() => existsSync(join(m.home, 'gh/slow-waiting')), 'a slow read');
    m.memory({ pressure: 4, available: 8 });
    await m.waitLog(new RegExp(`${clone}: stopped for memory: memory pressure critical`));
    const log = m.log();
    assert.match(log, new RegExp(`${clone}: idle past 1 s, but the queue cannot be read \\(the queue read passed its 2 s deadline\\); listening on`));
    assert.ok(log.indexOf('passed its 2 s deadline') < log.indexOf(`${clone}: stopped for memory`));
    assert.equal(existsSync(join(m.out, 'stop-request')), false);
    m.ghFlag('slow', false);
    m.memory();
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    await finish(m, a);
  });

  // A kickoff whose exec fails after kickoff.sh started the wrapper: out/ decides, not the exec's status.
  test('a kickoff that fails after the wrapper took a job: the job goes on, and the clone is never stopped', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    m.flag('block-kickoff-return');
    m.flag('fail-kickoff-late');
    const a = m.start();
    const clone = await m.kickoffBlocked();
    m.mark('listening', 'at=2026-10-21T12:00:40Z');
    m.mark('assigned', 'job=9e8d7c6b at=2026-10-21T12:01:00Z by=diag');
    m.mark('job', 'run=7 attempt=1 job=e2e repository=SSFSKIM/MAWS at=2026-10-21T12:01:30Z');
    m.flag('kickoff-go');
    await m.waitLog(new RegExp(`${clone}: kickoff.sh failed: Error: rpc error: code = DeadlineExceeded, but its wrapper runs`));
    await m.waitLog(new RegExp(`${clone} took run 7 job e2e`));
    await sleep(1500);
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    assert.equal(existsSync(join(m.out, 'stop-request')), false);
    await m.finished(clone);
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    assert.equal(m.failures().total_image ?? '0', '0');
    await finish(m, a);
  });

  test('a kickoff that fails after the wrapper started, with nothing assigned: the guest is given up through the handshake, never a plain stop', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    m.flag('fail-kickoff-late');
    const a = m.start();
    const clone = await m.booted();
    await m.waitLog(new RegExp(`${clone}: kickoff.sh failed: Error: rpc error: code = DeadlineExceeded; asked the wrapper to stop`));
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    assert.equal(m.failures().total_image, '1');
    m.mark('stopped', 'at=2026-10-21T12:04:00Z');
    m.mark('done', '0');
    m.powerOff(clone);
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    assert.equal(m.failures().total_image, '1');
    assert.equal(m.failures().total_raced, '0');
    await finish(m, a);
  });

  // The reviewer's shape: production's sample and queue bounds, a read every 9 s past an idle bound of 0, 1 s ticks, and
  // an API that answers in 6 s, so each read is longer than the time left to the next sample. Critical pressure from the
  // start of the first read is stopped within one sample interval plus one read bound.
  test('slow queue reads back to back: critical pressure is stopped within one sample interval plus one read bound', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_SAMPLE: '15', CI_KIT_VM_POLL: '9', CI_KIT_VM_IDLE: '0', CI_KIT_VM_TICK: '1' } });
    const a = m.start();
    const clone = await m.booted();
    m.ghFlag('slow', 6);
    m.mark('listening', 'at=2026-10-21T12:00:40Z');
    await m.until(() => existsSync(join(m.home, 'gh/slow-waiting')), 'the first slow read');
    const injected = Date.now();
    m.memory({ pressure: 4, available: 8 });
    await m.waitLog(new RegExp(`${clone}: stopped for memory: memory pressure critical`));
    const elapsed = (Date.now() - injected) / 1000;
    assert.ok(elapsed <= 15 + 15, `critical pressure was stopped ${elapsed} s after it began, past 30 s`);
    m.ghFlag('slow', false);
    m.memory();
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    await finish(m, a);
  });

  // THE HANDSHAKE'S RECORD. An answer is read before the done after it, and counted once whichever launcher meets it.
  test('a raced stop with out/done after it, met by recovery: counted and alerted once, though the next launcher meets it again', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_END_WAIT: '600' } });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    await a.kill();
    m.queue();
    m.mark('stop-request');
    m.mark('stop-raced', 'job=9e8d7c6b');
    m.mark('done', '143');
    const b = m.start();
    await m.waitLog(new RegExp(`recovery: ${clone} was asked to stop; its answer is read before anything after it`));
    await m.waitLog(new RegExp(`${clone}: a job \\(9e8d7c6b\\) was accepted as the listener stopped`));
    await m.until(() => m.alerts().length === 1, 'the alert');
    assert.equal(m.failures().total_raced, '1');
    await b.kill();
    const c = m.start();
    await m.waitLog(new RegExp(`${clone}: an acceptance raced the idle stop \\(job 9e8d7c6b\\) \\(counted and alerted already\\)`));
    m.powerOff(clone);
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    await sleep(1000);
    assert.equal(m.failures().total_raced, '1');
    assert.equal(m.alerts().length, 1);
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    await finish(m, c);
  });

  test('a reservation naming a VM that is not a job clone of the slot: recovery keeps it, stops and deletes nothing, boots nothing, and alerts', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_STOP_ALERT: '1' } });
    const candidate = 'maws-vm-candidate-20261021';
    m.vm(candidate, 'running');
    const reservation = `reserved since 2026-10-21T12:00:00Z: vm=${candidate} slot=${m.slot} golden=- (launcher 1)\nvm=${candidate}\nslot=${m.slot}\ngolden=-\nsince=2026-10-21T12:00:00Z\nlauncher=1\nstarted=-\njob=\n`;
    writeFileSync(join(m.logs, 'vm-reserved'), reservation);
    const a = m.start();
    await m.waitLog(new RegExp(`recovery waits: the reservation names ${candidate}, which is not a job clone of slot ${m.slot}; it stays, and nothing is stopped or deleted; nothing boots`));
    await m.until(() => m.alerts().length === 1, 'the alert');
    assert.match(m.alerts()[0], /^ci-kit alert: vm lane on mini cannot recover since /);
    await sleep(1500);
    assert.deepEqual(m.calls().filter((call) => /^(stop|delete|clone|run|exec) /.test(call)), []);
    assert.equal(m.state(candidate), 'running');
    assert.equal(m.reserved(), reservation);
    await finish(m, a);
  });

  // THE MEMORY GUARD, in every state. reach brings a lane's guest to the state.
  const states = {
    booting: { before: (m) => m.flag('no-agent'), reach: async (m) => { await m.waitLog(/runs \(tart run, pid \d+\); waiting for its guest agent/); return m.clones()[0]; } },
    kicking: { reach: async (m) => { const clone = await m.booted(); await m.waitLog(new RegExp(`${clone}: kickoff: `)); return clone; } },
    session: { reach: async (m) => { const clone = await m.booted(); m.mark('session-conflict', 'at=2026-10-21T12:00:40Z'); await m.waitLog(/session recovery/); return clone; } },
    listening: { reach: async (m) => { const clone = await m.booted(); await m.listening(clone); return clone; } },
    preparing: { reach: async (m) => { const clone = await m.booted(); await m.listening(clone); await m.assigned(clone); return clone; } },
    running: { reach: async (m) => { const clone = await m.booted(); await m.listening(clone); await m.assigned(clone); await m.job(clone); return clone; } },
  };
  for (const [name, { before, reach }] of Object.entries(states)) {
    test(`memory warning on two samples, ${name}: ${['preparing', 'running'].includes(name) ? 'the job is left to finish, and the next boot waits the pause' : 'the guest, holding no job, is given up at once'}`, async () => {
      const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_WARN_PAUSE: '600' } });
      if (before) before(m);
      const a = m.start();
      const clone = await reach(m);
      m.memory({ pressure: 2 });
      if (['preparing', 'running'].includes(name)) {
        await m.waitLog(new RegExp(`${clone}: memory pressure warned on two samples; its job is left to finish, and nothing boots for 600 s after it`));
        await sleep(1500);
        assert.equal(existsSync(join(m.out, 'stop-request')), false);
        assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
        m.memory();
        await m.finished(clone);
        await m.waitLog(/paused \(memory\) until \S+: memory pressure warned during/);
        assert.match(m.pause(), /\nreason=memory\nuntil=\d+\n/);
        const until = Number(/until=(\d+)/.exec(m.pause())[1]);
        assert.ok(Math.abs(until - (Date.now() / 1000 + 600)) < 60, 'the pause ends 600 s after the teardown');
        await m.waitLog(/no boot: paused \(memory\) until \S+: memory pressure warned during/);
        assert.equal(m.failures().total_memory ?? '0', '0');
      } else if (['kicking', 'session', 'listening'].includes(name)) {
        // Its wrapper started: the handshake, whose answer keeps a job it may have taken meanwhile.
        await m.waitLog(new RegExp(`${clone}: given up for memory; asked the wrapper to stop`));
        assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
        assert.equal(m.failures().total_memory, '1');
      } else {
        await m.waitLog(new RegExp(`${clone}: given up for memory: no wrapper runs in it, so it holds no job; teardown`));
        await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
        assert.ok(m.calls().includes(`stop ${clone} --timeout 30`));
        assert.equal(m.failures().total_memory, '1');
      }
      assert.match(m.log(), new RegExp(`sample ${name} ${clone}: pressure 2, available 60%, swap 500 MB; free 120 GB`));
      await finish(m, a);
    });

    test(`memory critical on one sample, ${name}: the guest is stopped, alerted, counted, and the lane pauses`, async () => {
      const m = lane({ queue: [['ci-kit-mac-vm']] });
      if (before) before(m);
      const a = m.start();
      const clone = await reach(m);
      m.memory({ pressure: 4, available: 8 });
      await m.waitLog(new RegExp(`${clone}: stopped for memory: memory pressure critical \\(pressure 4, available 8%, swap 500 MB\\)`));
      await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
      assert.ok(m.calls().includes(`stop ${clone} --timeout 30`));
      assert.match(m.alerts()[0], /^ci-kit alert: vm lane on mini stopped a job for memory at \d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
      assert.match(m.pause(), /\nreason=memory\nuntil=\d+\n/);
      assert.equal(m.failures().total_memory, '1');
      m.memory();
      await m.waitLog(/no boot: paused \(memory\)/);
      await finish(m, a);
    });
  }

  test('the guard through recovery: an adopted job is left to finish under a warning, and stopped at critical', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const clone = await states.running.reach(m);
    await a.kill();
    const b = m.start();
    await m.waitLog(/adopted \(running\)/);
    m.memory({ pressure: 2 });
    await m.waitLog(new RegExp(`sample running ${clone}: pressure 2`));
    await m.waitLog(new RegExp(`${clone}: memory pressure warned on two samples; its job is left to finish`));
    m.memory({ pressure: 4 });
    await m.waitLog(new RegExp(`${clone}: stopped for memory`));
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    await finish(m, b);
  });

  // SESSION RECOVERY AND THE FAILURE KINDS.
  test('session recovery: out/session-conflict enters it, out/listening leaves it', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const clone = await states.session.reach(m);
    await m.listening(clone);
    assert.match(m.log(), new RegExp(`${clone}: listening after \\d+ s of session recovery`));
    await finish(m, a);
  });

  test('session failures are counted apart: three in a row pause nothing, while three image failures in a row pause the lane with one alert, until an operator removes the pause', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_SESSION: '1', CI_KIT_VM_BOOT: '1' } });
    const a = m.start();
    for (let n = 1; n <= 3; n++) {
      const clone = await m.booted();
      m.mark('session-conflict', 'at=2026-10-21T12:00:40Z');
      // Its wrapper runs: the bound asks it to stop, and its answer ends the guest.
      await m.waitLog(new RegExp(`${clone}: the slot's session was not let go within 1 s; asked the wrapper to stop`));
      m.mark('stopped', 'at=2026-10-21T12:04:00Z');
      m.mark('done', '0');
      m.powerOff(clone);
      await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    }
    assert.equal(m.failures().total_session, '3');
    assert.equal(m.failures().image_run, '0');
    assert.equal(m.pause(), null);
    m.flag('no-agent');
    await m.waitLog(/paused \(failures\) until an operator removes vm-pause: 3 image failures in a row, the last: its guest agent did not answer within 1 s/);
    assert.match(m.log(), /failure \(image\): its guest agent did not answer within 1 s; 2 in a row/);
    await m.until(() => m.alerts().length === 1, 'the alert');
    assert.match(m.alerts()[0], /^ci-kit alert: vm lane on mini paused after 3 image failures since /);
    await m.waitLog(/no boot: paused \(failures\)/);
    assert.equal(m.failures().total_image, '3');
    m.flag('no-agent', false);
    rmSync(join(m.logs, 'vm-pause'));
    await m.until(() => m.closed().length === 1, 'the close');
    await m.waitLog(/booting maws-vm-job-\S+ from the golden image/);
    await finish(m, a);
  });

  test('two refusals in a row by the guest\'s hook pause the lane with an alert naming the refusal; a job that runs ends the run of them', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const refusal = 'ci-kit: a system dialog (UserNotificationCenter: source unknown) holds focus in the guest mini-vm (vm=vm clone=x) — if every clone shows it, answer it in the image; rerun';
    const job = async (refused) => {
      const clone = await m.booted();
      await m.listening(clone);
      await m.assigned(clone);
      await m.job(clone);
      if (refused) m.mark('refused', refusal);
      await m.finished(clone);
      return clone;
    };
    const first = await job(true);
    assert.match(m.log(), new RegExp(`${first}: the guest refused run 7 job e2e: ${escape(refusal)} \\(1 in a row; the lane pauses at 2\\)`));
    await job(false);
    assert.equal(m.failures().refused_run, '0');
    await job(true);
    await job(true);
    await m.waitLog(/paused \(failures\) until an operator removes vm-pause: 2 refusals in a row by the guest's hook/);
    await m.until(() => m.alerts().length === 1, 'the alert');
    assert.match(m.alerts()[0], /^ci-kit alert: vm lane on mini paused after 2 refusals since /);
    assert.match(m.ghCalls().find((call) => call[1] === 'create').join(' '), new RegExp(escape(refusal)));
    await m.waitLog(/no boot: paused \(failures\)/);
    await finish(m, a);
  });

  // EVERY BOUND ends in a verified teardown and a counted failure.
  for (const { name, env, before, reach, line, kind } of [
    { name: 'the boot', env: { CI_KIT_VM_BOOT: '2' }, before: (m) => m.flag('no-agent'), reach: states.booting.reach, line: 'its guest agent did not answer within 2 s', kind: 'image' },
    { name: 'a kickoff that fails', before: (m) => m.flag('fail-kickoff'), reach: (m) => m.booted(), line: 'kickoff.sh failed: kickoff: out/ already holds listening: every clone starts from an empty out/', kind: 'image' },
    { name: 'the running bound', env: { CI_KIT_VM_JOB_BOUND: '0.05' }, reach: states.running.reach, line: 'the job outlived the running bound (0.05 min from out/assigned); stopping it', kind: 'image' },
  ]) test(`the bound of ${name} ends in a verified teardown and a counted ${kind} failure`, async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env });
    if (before) before(m);
    const a = m.start();
    const clone = await reach(m);
    await m.waitLog(new RegExp(`${clone}: ${escape(line)}; teardown`));
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.ok(m.calls().includes(`stop ${clone} --timeout 30`), 'stopped');
    assert.ok(m.calls().indexOf(`stop ${clone} --timeout 30`) < m.calls().indexOf(`delete ${clone}`));
    assert.match(m.log(), new RegExp(`${clone}: its end is verified`));
    assert.equal(m.failures()[`total_${kind}`], '1');
    await finish(m, a);
  });

  // A runner done in a guest that never powers off (on the mini, a halt that stalled until the guest's kernel panicked
  // and rebooted): the power-off wait applies, not the running bound, and the job's end is no failure.
  test('a runner done in a guest that does not power off: stopped after the power-off wait, no failure counted', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_END_WAIT: '2' } });
    const a = m.start();
    const clone = await states.running.reach(m);
    m.mark('done', '0');
    await m.waitLog(new RegExp(`${clone}: its runner is done \\(0\\); waiting for its power-off`));
    await m.waitLog(new RegExp(`${clone}: the guest did not power off within 2 s; stopping it; teardown`));
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.ok(m.calls().includes(`stop ${clone} --timeout 30`), 'stopped');
    assert.doesNotMatch(m.log(), /outlived the running bound/);
    assert.equal(m.failures().total_image ?? '0', '0');
    await finish(m, a);
  });

  // A bound passed by a guest whose wrapper runs: counted, and given up through the handshake, never a plain stop.
  for (const { name, env, reach, line, kind } of [
    { name: 'the kickoff', env: { CI_KIT_VM_KICKOFF: '2' }, reach: states.kicking.reach, line: 'neither out/listening nor out/session-conflict within 2 s', kind: 'image' },
    { name: 'session recovery', env: { CI_KIT_VM_SESSION: '2' }, reach: states.session.reach, line: 'the slot\'s session was not let go within 2 s', kind: 'session' },
  ]) test(`the bound of ${name}, with the wrapper started: a counted ${kind} failure, and the guest asked to stop through the handshake`, async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env });
    const a = m.start();
    const clone = await reach(m);
    await m.waitLog(new RegExp(`${clone}: ${escape(line)}; asked the wrapper to stop`));
    assert.equal(m.failures()[`total_${kind}`], '1');
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    m.mark('stopped', 'at=2026-10-21T12:04:00Z');
    m.mark('done', '0');
    m.powerOff(clone);
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    assert.equal(m.failures()[`total_${kind}`], '1');
    assert.equal(m.failures().total_raced, '0');
    await finish(m, a);
  });

  test('a job taken during session recovery, out/listening never written: the job goes on past the session bound', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_SESSION: '2' } });
    const a = m.start();
    const clone = await states.session.reach(m);
    m.mark('assigned', 'job=9e8d7c6b at=2026-10-21T12:01:00Z by=diag');
    m.mark('job', 'run=7 attempt=1 job=e2e repository=SSFSKIM/MAWS at=2026-10-21T12:01:30Z');
    await m.waitLog(new RegExp(`${clone}: the listener took a job`));
    await sleep(4000);
    assert.doesNotMatch(m.log(), /session was not let go/);
    assert.equal(existsSync(join(m.out, 'stop-request')), false);
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    await m.finished(clone);
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    assert.equal(m.failures().total_session ?? '0', '0');
    await finish(m, a);
  });

  test('a stop that fails keeps the reservation, is retried each poll, and alerts after its bound; the alert closes once the clone is gone', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_BOOT: '1', CI_KIT_VM_STOP_ALERT: '2' } });
    m.flag('no-agent');
    m.flag('fail-stop');
    const a = m.start();
    const clone = await states.booting.reach(m);
    await m.waitLog(new RegExp(`${clone} cannot be torn down yet \\(tart stop failed; a tart run of ${clone} runs \\(pid \\d+\\)\\); the reservation stays`));
    await m.until(() => m.alerts().length === 1, 'the alert');
    assert.match(m.alerts()[0], new RegExp(`^ci-kit alert: vm lane on mini cannot stop ${clone} since `));
    assert.ok(m.reserved());
    assert.equal(m.state(clone), 'running');
    m.flag('fail-stop', false);
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    await m.until(() => m.closed().length === 1, 'the close');
    await finish(m, a);
  });

  // THE GOLDEN POINTER, read at each boot.
  test('each boot reads the golden pointer: a promote between two jobs moves the next clone to the new golden image', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const first = await m.booted();
    m.vm('maws-vm-golden-20261021', 'stopped');
    writeFileSync(join(m.vmHome, 'golden.tmp'), 'maws-vm-golden-20261021\n');
    renameSync(join(m.vmHome, 'golden.tmp'), join(m.vmHome, 'golden'));
    await m.listening(first);
    await m.assigned(first);
    await m.job(first);
    await m.finished(first);
    await m.waitLog(/booting maws-vm-job-\S+ from the golden image maws-vm-golden-20261021/);
    await m.until(() => m.calls().some((call) => /^clone maws-vm-golden-20261021 maws-vm-job-/.test(call)), 'the clone of the new golden image');
    assert.ok(m.calls().includes(`clone ${GOLDEN} ${first}`));
    await finish(m, a);
  });

  test('a golden image that is missing while a job waits opens one alert after its bound, closed once the lane has its parts', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_GOLDEN_ALERT: '1' } });
    rmSync(join(m.vmHome, 'golden'));
    const a = m.start();
    await m.waitLog(new RegExp(`no boot: no golden pointer at ${escape(join(m.vmHome, 'golden'))}$`, 'm'));
    await m.until(() => m.alerts().length === 1, 'the alert');
    assert.match(m.alerts()[0], /^ci-kit alert: vm lane on mini cannot boot since \S+: no golden pointer at /);
    writeFileSync(join(m.vmHome, 'golden'), `${GOLDEN}\n`);
    await m.booted();
    assert.equal(m.closed().length, 1);
    await finish(m, a);
  });

  // DISK.
  test('free disk under half the reserve while a job runs: the job goes on, and the disk pause holds the next boot until the space is back', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const clone = await states.running.reach(m);
    m.disk(15);
    await m.waitLog(/paused \(disk\) until an operator removes vm-pause: 15 GB free on the volume of \S+, under half the reserve of 40 GB/);
    assert.equal(m.calls().filter((call) => call.startsWith('stop ')).length, 0);
    await m.finished(clone);
    await m.waitLog(/no boot: paused \(disk\)/);
    m.disk(30);
    await m.waitLog(/the disk pause is lifted: 30 GB free, at least half the reserve of 40 GB/);
    await m.waitLog(/no boot: 30 GB free on the volume of \S+, under the reserve of 40 GB/);
    m.disk(120);
    await m.waitLog(/booting maws-vm-job-\S+ from the golden image/);
    await finish(m, a);
  });

  test('free disk under the floor while a job runs: the guest is stopped, alerted for disk and counted', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const observed = observeRelease(m);
    const a = m.start();
    const clone = await states.running.reach(m);
    m.disk(4);
    await m.waitLog(new RegExp(`${clone}: stopped for disk: 4 GB free on the volume of \\S+, under the floor of 5 GB`));
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.ok(m.calls().includes(`stop ${clone} --timeout 30`));
    assert.match(m.alerts()[0], /^ci-kit alert: vm lane on mini stopped a job for disk at /);
    assert.equal(m.failures().total_disk, '1');
    observed.assertStamped();
    await finish(m, a);
  });

  test('a release that cannot be written leaves the lane reserved, and is tried again until it goes through', asUser, async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const clone = await states.running.reach(m);
    chmodSync(m.logs, 0o555);
    try {
      m.mark('done', '0');
      m.powerOff(clone);
      await m.waitLog(new RegExp(`${clone} cannot be torn down yet \\(\\S+/vm-reserved could not be removed\\); the reservation stays`));
      assert.ok(m.reserved());
      assert.deepEqual(m.clones(), [], 'the clone itself is gone');
    } finally {
      chmodSync(m.logs, 0o755);
    }
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    await finish(m, a);
  });

  test('a reservation write on a full volume (a small disk image mounted for the state directory) is no boot; with space back the clone boots', { skip: !existsSync('/usr/bin/hdiutil') }, async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const image = join(m.home, 'state.dmg');
    assert.equal(spawnSync('/usr/bin/hdiutil', ['create', '-size', '2m', '-fs', 'HFS+', '-volname', 'cikitstate', '-type', 'UDIF', image], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('/usr/bin/hdiutil', ['attach', image, '-nobrowse', '-mountpoint', m.logs], { encoding: 'utf8' }).status, 0);
    cleanups.push(() => spawnSync('/usr/bin/hdiutil', ['detach', m.logs, '-force']));
    try {
      for (const file of ['desktop.lock', 'vm-lane.lock', 'vm-lane.log']) writeFileSync(join(m.logs, file), '');
      spawnSync('/bin/dd', ['if=/dev/zero', `of=${join(m.logs, 'fill')}`, 'bs=4k'], { stdio: 'ignore' });
      const a = m.start();
      await m.until(() => /no boot: \S+\/vm-reserved could not be written/.test(a.stderr() + m.log()), 'the refused write');
      assert.equal(m.reserved(), null);
      assert.equal(m.calls().filter((call) => call.startsWith('clone ')).length, 0, 'nothing cloned without a reservation');
      rmSync(join(m.logs, 'fill'));
      await m.booted();
      assert.ok(m.reserved());
      await finish(m, a);
    } finally {
      spawnSync('/usr/bin/hdiutil', ['detach', m.logs, '-force']);
    }
  });

  test('two launchers cannot run: the second waits for the first\'s lock, and starts with recovery once it is gone', async () => {
    const m = lane({ queue: [] });
    const a = m.start();
    await m.waitLog(/recovery: no job clone and no reservation; idle/);
    const b = m.start();
    await m.waitLog(/another launcher holds \S+\/vm-lane\.lock; waiting for it/);
    await sleep(1000);
    assert.doesNotMatch(m.log(), new RegExp(`starting \\(pid ${b.pid}`));
    await a.kill();
    await m.waitLog(new RegExp(`starting \\(pid ${b.pid}, slot ${m.slot}, mode always\\); recovery first`));
    await finish(m, b);
  });

  test('Tart that cannot list its VMs: recovery waits and alerts after its bound, and the boot rule waits with the lane\'s parts alert while a job waits; both close once Tart answers', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_STOP_ALERT: '1', CI_KIT_VM_GOLDEN_ALERT: '1' } });
    m.flag('fail-list');
    const a = m.start();
    await m.waitLog(/recovery waits: Tart cannot list its VMs \(\S+ list failed\); nothing boots/);
    await m.until(() => m.alerts().length === 1, 'the recovery alert');
    assert.match(m.alerts()[0], /^ci-kit alert: vm lane on mini cannot recover since /);
    m.flag('fail-list', false);
    await m.waitLog(/recovery: no job clone and no reservation; idle/);
    m.flag('fail-list');
    await m.waitLog(/no boot: Tart cannot list its VMs \(\S+ list failed\)$/m);
    await m.until(() => m.alerts().length === 2, 'the parts alert');
    assert.match(m.alerts()[1], /^ci-kit alert: vm lane on mini cannot boot since \S+: Tart cannot list its VMs/);
    m.flag('fail-list', false);
    await m.booted();
    assert.deepEqual(m.closed().sort(), ['https://github.com/SSFSKIM/ci-kit-sandbox/issues/1', 'https://github.com/SSFSKIM/ci-kit-sandbox/issues/2']);
    await finish(m, a);
  });

  test('a guest whose wrapper started no runner (out/unfit) is an image failure, and the failure says why', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const clone = await m.booted();
    m.mark('unfit', 'the display is 1024x768 scaling:on, not 2560x1440 scaling:on (the image\'s bake sets it: provision.sh display)');
    m.powerOff(clone);
    await m.waitLog(new RegExp(`${clone}: the guest started no runner: the display is 1024x768 scaling:on, not 2560x1440 scaling:on \\(the image's bake sets it: provision\\.sh display\\); teardown`));
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.equal(m.failures().total_image, '1');
    assert.equal(m.failures().image_run, '1');
    await finish(m, a);
  });

  for (const poweredOff of [true, false]) {
    test(`unfit recovery counts an image failure and deletes the clone (${poweredOff ? 'powered off' : 'still running with a queued job'})`, async () => {
      const m = lane({ queue: [['ci-kit-mac-vm']] });
      const a = m.start();
      const clone = await m.booted();
      await a.kill();
      m.mark('unfit', 'the display mode cannot be read');
      // Two earlier image failures: recovery must count the third and pause, not silently discard it.
      writeFileSync(join(m.logs, 'vm-failures'), 'total_image=2\nimage_run=2\n');
      if (poweredOff) {
        m.powerOff(clone);
        await m.until(() => m.state(clone) === 'stopped', 'the guest powered off');
      }
      const b = m.start();
      await m.until(() => m.reserved() === null && !m.clones().includes(clone), 'unfit recovery teardown', 15_000);
      assert.equal(m.failures().total_image, '3');
      assert.match(m.pause(), /3 image failures in a row/);
      assert.match(m.log(), /the guest started no runner: the display mode cannot be read/);
      assert.equal(m.failures().total_raced, '0');
      assert.equal(m.alerts().length, 1);
      assert.match(m.alerts()[0], /paused after 3 image failures/);
      await finish(m, b);
    });
  }

  for (const firstSeen of ['kicking', 'recovery', 'stopping']) {
    test(`unfit in ${firstSeen} counts once across a failed stop and a launcher restart`, async () => {
      const m = lane({ queue: [['ci-kit-mac-vm']], env: { CI_KIT_VM_STOP_ANSWER: '60' } });
      m.flag('fail-stop');
      if (firstSeen === 'stopping') m.flag('fail-kickoff-late');
      const a = m.start();
      const clone = await m.booted();
      if (firstSeen === 'stopping') {
        await m.until(() => existsSync(join(m.out, 'stop-request')), 'the failed kickoff requested a stop');
        assert.equal(m.failures().total_image, '1', 'the kickoff failure is already counted');
      }
      let current = a;
      if (firstSeen === 'recovery') await a.kill();
      m.mark('unfit', 'the display mode cannot be read');
      if (firstSeen === 'recovery') current = m.start();
      await m.until(() => m.calls().some((call) => call.startsWith(`stop ${clone} `)), 'unfit stops promptly', 15_000);
      await m.until(() => m.failures().total_image === '1', 'one image failure');
      await current.kill();
      assert.ok(m.reserved(), 'a failed stop keeps the reservation');
      m.flag('fail-stop', false);
      const b = m.start();
      await m.until(() => !m.clones().includes(clone), 'unfit deleted after restart', 15_000);
      assert.equal(m.failures().total_image, '1', 'the same clone is not counted a second time');
      assert.equal(m.failures().image_run, '1');
      assert.equal(m.failures().total_raced, '0');
      assert.deepEqual(m.alerts(), [], 'unfit cannot hide a cancelled job');
      assert.match(m.log(), /the guest started no runner: the display mode cannot be read/);
      await finish(m, b);
    });
  }

  test('a runner that exits while listening, with no job, is an image failure', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const clone = await m.booted();
    await m.listening(clone);
    m.mark('done', '0');
    m.powerOff(clone);
    await m.waitLog(new RegExp(`${clone}: the runner exited without a job \\(out/done: 0\\); teardown`));
    await m.waitLog(new RegExp(`${clone}: deleted, and the reservation released`));
    assert.equal(m.failures().total_image, '1');
    assert.equal(m.failures().image_run, '1', 'a clone that failed does not end the run of image failures');
    await finish(m, a);
  });
});


describe('clone-scoped JIT credentials', macOnly, () => {
  test('each clone mints one private config, shares only it, and deletes its registration on teardown', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    rmSync(join(m.slotDir, 'identity'), { recursive: true }); // no persistent registration is needed
    const a = m.start();
    try {
      for (let n = 1; n <= 2; n++) {
        const clone = await m.booted();
        const request = JSON.parse(readFileSync(join(m.home, `gh/request-${n}.json`), 'utf8'));
        assert.deepEqual(request, { name: `ci-kit-mac-mini-${clone}`, runner_group_id: 1,
          labels: ['ci-kit-mac-solo', 'ci-kit-mac-vm'], work_folder: '_work' });
        const credential = join(m.slotDir, 'jit', clone, 'config');
        assert.equal(statSync(credential).mode & 0o777, 0o600);
        assert.equal(statSync(join(m.slotDir, 'jit', clone)).mode & 0o777, 0o700);
        assert.equal(readFileSync(credential, 'utf8').trim(), `fixture-jit-secret-${n}`);
        const args = readFileSync(join(m.vms, clone, 'run.args'), 'utf8');
        assert.ok(args.includes(`--dir=jit:${m.slotDir}/jit/${clone}:ro`));
        assert.ok(!args.includes('identity'));
        assert.equal(m.ghCalls().filter((c) => c.includes('repos/SSFSKIM/MAWS/actions/runners/generate-jitconfig')).length, n);
        m.queue();
        if (n === 2) m.ghFlag('delete-404');
        await m.finished(clone);
        assert.ok(!existsSync(credential), 'the credential must not survive teardown');
        await m.until(() => m.ghCalls().some((c) => c.includes(`repos/SSFSKIM/MAWS/actions/runners/${n}`) && c.includes('DELETE')), 'the asynchronous registration cleanup');
        await m.until(() => !existsSync(join(m.slotDir, 'jit-pending', clone)), 'the registration deleted (including 404)');
        if (n === 1) m.queue(['ci-kit-mac-vm']);
      }
      for (const call of m.ghCalls().filter((c) => c[0] === 'api')) assert.ok(call.includes('GH_TOKEN=unset'));
      const check = (dir) => {
        if (!existsSync(dir)) return;
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) check(path);
          else assert.ok(!readFileSync(path, 'utf8').includes('fixture-jit-secret-'), `credential leaked to ${path}`);
        }
      };
      check(m.logs); check(m.out);
      assert.ok(!a.stderr().includes('fixture-jit-secret-'));
    } finally { await finish(m, a); }
  });

  test('a failed runner delete revokes the config and releases the reservation; another clone boots while cleanup retries', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    try {
      const clone = await m.booted();
      m.ghFlag('fail-delete');
      await m.finished(clone);
      await m.waitLog(/registration cleanup pending: JIT reap: DELETE failed \(HTTP 502\)/);
      assert.ok(!existsSync(join(m.slotDir, 'jit', clone)));
      const pending = join(m.slotDir, 'jit-pending', clone);
      assert.deepEqual(readdirSync(pending), ['runner.json'], 'only nonsecret metadata remains');
      const next = await m.booted();
      assert.notEqual(next, clone, 'failed cleanup must not hold admission');
      m.queue();
      m.ghFlag('fail-delete', false);
      await m.until(() => !existsSync(pending), 'the pending cleanup retried while another clone runs');
      await m.finished(next);
    } finally { await finish(m, a); }
  });

  test('recovery cleans a mint whose response was lost before a VM or reservation remained, by exact clone name', async () => {
    const m = lane();
    const clone = `maws-vm-job-${m.slot}-20261021T120000Z`;
    const name = `ci-kit-mac-mini-${clone}`;
    const dir = join(m.slotDir, 'jit', clone);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'runner.json'), JSON.stringify({ repo: 'SSFSKIM/MAWS', name }), { mode: 0o600 });
    writeFileSync(join(m.home, 'gh/runners.json'), JSON.stringify({ total_count: 2, runners: [
      { id: 41, name, os: 'unknown', status: 'offline', busy: false, labels: [] },
      { id: 42, name: 'ci-kit-mac-mini-vm', os: 'osx', status: 'offline', busy: false, labels: [] },
    ] }));
    const a = m.start();
    try {
      await m.waitLog(/recovery: no job clone and no reservation; idle/);
      await m.until(() => m.ghCalls().some((c) => c.includes('DELETE')), 'the orphan cleanup');
      const deletes = m.ghCalls().filter((c) => c.includes('DELETE'));
      assert.deepEqual(deletes.map((c) => c[1]), ['repos/SSFSKIM/MAWS/actions/runners/41']);
      assert.ok(!existsSync(dir));
      assert.equal(m.reserved(), null);
    } finally { await finish(m, a); }
  });

  test('the trial slot mints only its trial label; failed gh output cannot leak credential bytes', () => {
    const m = lane();
    const helper = join(mac, 'vm/jit.py');
    const env = { ...process.env, HOME: m.home, CI_KIT_GH_BIN: join(m.home, 'bin/gh'), GH_TOKEN: 'job-token' };
    const clone = 'maws-vm-trial-20261021T120000Z';
    const dir = join(m.vmHome, 'vm-trial');
    const minted = spawnSync('python3', ['-I', helper, 'mint', 'SSFSKIM/MAWS', 'mini', dir, 'vm-trial', clone], { env, encoding: 'utf8' });
    assert.equal(minted.status, 0, minted.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(m.home, 'gh/request-1.json'), 'utf8')), {
      name: `ci-kit-mac-mini-${clone}`, runner_group_id: 1, labels: ['ci-kit-mac-vm-trial'], work_folder: '_work',
    });
    const removed = spawnSync('python3', ['-I', helper, 'retire', dir, clone], { env, encoding: 'utf8' });
    assert.equal(removed.status, 0, removed.stderr);
    const reaped = spawnSync('python3', ['-I', helper, 'reap', dir], { env, encoding: 'utf8' });
    assert.equal(reaped.status, 0, reaped.stderr);
    executable(join(m.home, 'bin/gh'), 'echo "fixture-jit-secret-on-stdout"; echo "fixture-jit-secret-on-stderr (HTTP 403)" >&2; exit 1');
    const failed = spawnSync('python3', ['-I', helper, 'mint', 'SSFSKIM/MAWS', 'mini', dir, 'vm-trial', clone], { env, encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /JIT mint: POST failed \(HTTP 403\)/);
    assert.ok(!(failed.stdout + failed.stderr).includes('fixture-jit-secret'));
    assert.ok(!existsSync(join(dir, 'jit', clone, 'config')));
  });

  test('a mint failure refuses the boot with its reason and retries without an image pause', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    m.ghFlag('fail-mint');
    const a = m.start();
    try {
      await m.waitLog(/no boot:.*JIT.*HTTP 403/);
      assert.equal(m.calls().filter((c) => c.startsWith('clone ') || c.startsWith('run ')).length, 0);
      await m.until(() => m.ghCalls().filter((c) => c[1]?.endsWith('/generate-jitconfig')).length >= 4, 'four refused mints');
      assert.equal(m.pause(), null);
      assert.equal(Number(m.failures().image || 0), 0);
      m.ghFlag('fail-mint', false);
      const clone = await m.booted();
      m.queue();
      await m.finished(clone);
    } finally { await finish(m, a); }
  });
});
