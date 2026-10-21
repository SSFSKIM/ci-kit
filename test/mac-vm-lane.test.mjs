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
    [[ ! -e $t/fail-run ]] || { echo 'Error: Failed to generate keypair' >&2; exit 1; }
    echo $$ > "$dir/run.pid"; echo running > "$dir/state"
    until [[ -e $dir/poweroff || -e $dir/stopping ]]; do sleep 0.05; done
    echo stopped > "$dir/state"; rm -f "$dir/run.pid" ;;
  exec)
    name=$1; shift
    [[ $(state "$name") == running ]] || { echo 'Error: VM is not running' >&2; exit 1; }
    [[ ! -e $t/no-agent ]] || { echo 'Error: failed to connect to the guest agent' >&2; exit 1; }
    [[ $1 != true ]] || exit 0
    if [[ $1 == */vm/guest/kickoff.sh ]]; then
      printf '%s\\n' "$@" > "$vms/$name/kicked"
      [[ ! -e $t/fail-kickoff ]] || { echo 'kickoff: out/ already holds listening: every clone starts from an empty out/' >&2; exit 1; }
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
  case $2 in
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
    flag: (name, on = true) => on ? writeFileSync(join(home, 'tart', name), '') : rmSync(join(home, 'tart', name), { force: true }),
    ghFlag: (name, on = true) => on ? writeFileSync(join(home, 'gh', name), '') : rmSync(join(home, 'gh', name), { force: true }),
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
    const after = m.clones().filter((name) => before.has(name));
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
}

describe('the VM lane\'s launcher', { concurrency: 4, ...macOnly }, () => {
  test('a queued ci-kit-mac-vm job boots a clone of the golden image, which goes through its one job to a verified teardown', async () => {
    const m = lane({ queue: [['ci-kit-mac-vm']] });
    const a = m.start();
    const clone = await m.booted();
    assert.match(clone, new RegExp(`^maws-vm-job-${m.slot}-\\d{8}T\\d{6}Z$`));
    // The reservation, written before the clone, names it and the golden image it came from.
    assert.match(m.reserved(), new RegExp(`^reserved since \\S+: vm=${clone} slot=${m.slot} golden=${GOLDEN} \\(launcher ${a.pid}\\)\\nvm=${clone}\\n`));
    assert.match(m.log(), new RegExp(`booting ${clone} from the golden image ${GOLDEN}: 1 ci-kit-mac-vm job\\(s\\) queued; holds none; pressure 1, available 60%, swap 500 MB, swap steady over \\d+ s; free 120 GB; display 2560x1440@2x; mode always`));
    // tart run with the four shares, the kit and the identity read-only.
    assert.deepEqual(readFileSync(join(m.vms, clone, 'run.args'), 'utf8').trim().split('\n'), [
      '--no-graphics', `--dir=kit:${mac}:ro`, `--dir=identity:${m.slotDir}/identity:ro`, `--dir=out:${m.out}`, `--dir=cache:${m.slotDir}/cache`, clone]);
    assert.deepEqual(readFileSync(join(m.vms, clone, 'kicked'), 'utf8').trim().split('\n'), ['/Users/admin/ci-kit/vm/guest/kickoff.sh', m.slot, clone]);
    assert.deepEqual(readdirSync(m.out), [], 'the clone is handed an empty out/');
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
    await finish(m, a);
  });
});
