import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISPLAY_ID, displayplacer } from './fake-mac-desktop.mjs';

// The VM lane's maintenance procedure (mac/vm/bake.sh, with mac/vm/tart.sh, and mac/vm/provision.sh in the guest):
// the hold every step but --retire checks, the disk reserve, the bake, the registration of both identities, the trial
// under the trial identity and its record, the promote and its refusals, and the retire. Each test is one Mac: a HOME
// with the lane's state directory, the slots, the host's exclusive registration and a MAWS checkout. Tart is a fake
// that keeps its VMs as directories and records its calls (its `run` a real process that blocks until the VM is
// powered off or stopped, its `delete` refusing a running VM as Tart does); gh serves a run attempt's jobs; launchctl
// says whether the launcher's agent is loaded. The guest is the test, writing out/ markers as wrapper.sh does.
const macOnly = { skip: process.platform !== 'darwin' };
const asUser = { skip: process.platform !== 'darwin' || process.getuid?.() === 0 };
const mac = fileURLToPath(new URL('../mac/', import.meta.url));
const bake = join(mac, 'vm/bake.sh');
const provision = join(mac, 'vm/provision.sh');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-kit-vm-bake-')));
const children = new Set();
const homes = [];
after(() => {
  // A guest's pasteboard is never the host's: no tart run of any test went without --no-clipboard.
  const shared = homes.filter((home) => existsSync(join(home, 'tart/clipboard-shared')));
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(shared, [], 'every tart run carries --no-clipboard');
});
const executable = (path, body) => { writeFileSync(path, `#!/bin/bash\n${body}\n`); chmodSync(path, 0o755); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const iso = (date = new Date()) => date.toISOString().replace(/\.\d+Z$/, 'Z');
const BASE = 'macos-base';
const CANDIDATE = 'maws-vm-candidate-20261022';
const GOLDEN = 'maws-vm-golden-20261022';
const OLD = 'maws-vm-golden-20261020';
const identities = ['.runner', '.credentials', '.credentials_rsaparams'];
const installPin = (name) => new RegExp(`^${name}=([0-9a-f.]+)`, 'm').exec(readFileSync(join(mac, 'install.sh'), 'utf8'))[1];

// Tart, as far as the procedure uses it. Every call is a line of calls; a VM is vms/<name>/ with its state.
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
      printf '%s{"State":"%s","Disk":50,"Running":%s,"Size":20,"Name":"%s","Source":"local"}' "$sep" "$s" "$running" "$name"
      sep=,
    done
    printf '%s{"State":"stopped","Disk":50,"Running":false,"Size":41,"Name":"ghcr.io/cirruslabs/macos-golden-gate-base:latest","Source":"OCI"}]\\n' "$sep" ;;
  clone)
    [[ -d $vms/$1 ]] || { echo "Error: the specified VM \\"$1\\" does not exist" >&2; exit 1; }
    [[ ! -e $vms/$2 ]] || { echo "Error: VM \\"$2\\" already exists" >&2; exit 1; }
    mkdir "$vms/$2" && echo stopped > "$vms/$2/state"
    echo "$1" > "$vms/$2/source" ;;
  set)
    name=$1; shift
    [[ -d $vms/$name ]] || exit 1
    printf '%s\\n' "$@" > "$vms/$name/set.args" ;;
  rename)
    [[ -d $vms/$1 && ! -e $vms/$2 && $(state "$1") != running ]] || { echo "Error: cannot rename $1" >&2; exit 1; }
    mv "$vms/$1" "$vms/$2" ;;
  run)
    name=\${!#} dir=$vms/\${!#}
    [[ -d $dir && $(state "$name") != running ]] || { echo "Error: cannot run $name" >&2; exit 1; }
    printf '%s\\n' "$@" > "$dir/run.args"
    # A guest's pasteboard is never the host's: every run of the lane's carries --no-clipboard.
    [[ " $* " == *' --no-clipboard '* ]] || { echo "Error: $name run with the host's clipboard shared" >&2; echo "$name" >> "$t/clipboard-shared"; exit 64; }
    echo $$ > "$dir/run.pid"; echo running > "$dir/state"
    until [[ -e $dir/poweroff || -e $dir/stopping ]]; do sleep 0.05; done
    echo stopped > "$dir/state"; rm -f "$dir/run.pid" "$dir/poweroff" "$dir/stopping" ;;
  exec)
    interactive=''; if [[ $1 == -i ]]; then interactive=1; shift; fi
    name=$1; shift
    [[ $(state "$name") == running ]] || { echo 'Error: VM is not running' >&2; exit 1; }
    [[ $1 != true ]] || exit 0
    printf '%s\\n' "$*" >> "$vms/$name/exec"
    if [[ $1 == /bin/bash && $2 == */kit/vm/provision.sh ]]; then
      step=$3
      [[ ! -e $t/fail-$step ]] || { echo "provision: $step failed" >&2; exit 1; }
      if [[ $step == register ]]; then
        [[ -n $interactive ]] || { echo 'provision: no registration token on stdin' >&2; exit 1; }
        IFS= read -r token; printf '%s %s\\n' "$4" "$token" >> "$t/tokens"
        dest=$(sed -n "s/^--dir=identity-$4://p" "$vms/$name/run.args")
        [[ -d $dest ]] || { echo "provision: the identity-$4 share is not shown" >&2; exit 1; }
        for file in .runner .credentials .credentials_rsaparams; do printf '%s %s %s\\n' "$5" "$6" "$file" > "$dest/$file"; done
        echo "provision: $5 registered with $6"
      fi
      echo "provision: $step done"; exit 0
    fi
    if [[ $1 == */vm/guest/kickoff.sh ]]; then
      printf '%s\\n' "$@" > "$vms/$name/kicked"
      [[ ! -e $t/fail-kickoff ]] || { echo 'kickoff: no runner at /Users/admin/actions-runner-maws' >&2; exit 1; }
      out=$(sed -n 's/^--dir=out://p' "$vms/$name/run.args")
      echo 'wrapper: started' >> "$out/wrapper.log"
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
    if [[ -e $t/block-delete ]]; then touch "$t/delete-waiting"; until [[ -e $t/delete-go ]]; do sleep 0.05; done; fi
    rm -rf "\${vms:?}/$1" ;;
  *) exit 64 ;;
esac`;

// gh: a run attempt's jobs from jobs-<run>-<attempt>.json on page 1, none on any other; every call recorded with the
// token it saw.
const fakeGh = `g=$HOME/gh
printf '%s\\0' "$@" "GH_TOKEN=\${GH_TOKEN-unset}" >> "$g/calls"; printf '\\0' >> "$g/calls"
[[ $1 == api ]] || exit 0
[[ ! -e $g/fail ]] || { echo 'gh: HTTP 502: Bad Gateway' >&2; exit 1; }
case $2 in
  */actions/runs/*/attempts/*/jobs\\?*)
    rest=\${2#*/runs/}; run=\${rest%%/*}; rest=\${rest#*/attempts/}; attempt=\${rest%%/*}; page=\${2##*page=}
    file=$g/jobs-$run-$attempt.json
    if [[ $page == 1 && -f $file ]]; then cat "$file"; else echo '{"total_count":0,"jobs":[]}'; fi ;;
  *) exit 1 ;;
esac`;

let macs = 0;
function fixture({ hold = 'maintenance since 2026-10-22T09:00:00Z', disk = 120, env = {} } = {}) {
  const home = mkdtempSync(join(root, `mac${++macs}-`));
  homes.push(home);
  const bin = join(home, 'bin');
  const logs = join(home, 'Library/Logs/ci-kit');
  const vmHome = join(home, 'ci-kit-vm');
  const vms = join(home, 'tart/vms');
  const maws = join(home, 'Developer/GitHub/MAWS');
  const trialOut = join(vmHome, 'vm-trial/out');
  for (const dir of [bin, logs, vms, join(home, 'gh'), maws, join(home, 'actions-runner-maws'), join(vmHome, 'trials'),
    ...['vm', 'vm-trial'].flatMap((slot) => ['identity', 'out', 'cache'].map((part) => join(vmHome, slot, part)))]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, 'actions-runner-maws/.runner'), `\uFEFF${JSON.stringify({ agentId: 21, agentName: 'ci-kit-mac-mini' })}`);
  writeFileSync(join(maws, 'package.json'), JSON.stringify({ name: 'maws', packageManager: 'pnpm@11.23.0+sha512.abc', engines: { node: '>=22.12' } }));
  writeFileSync(join(maws, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(vmHome, 'golden'), `${OLD}\n`);
  executable(join(bin, 'tart'), fakeTart);
  executable(join(bin, 'gh'), fakeGh);
  executable(join(bin, 'launchctl'), `echo "$*" >> "$HOME/launchctl.calls"
[[ $1 == print ]] || exit 0
[[ ! -e $HOME/launchctl-fails ]] || exit 5
[[ -e $HOME/launchctl-loaded ]] || { echo "Could not find service \\"\${2##*/}\\" in domain for user gui: \${2#gui/}" >&2; exit 113; }
echo "\${2##*/} = { state = running }"`);
  executable(join(bin, 'df'), `[[ $1 == -Pk ]] || exit 64
kb=$(cat "$HOME/disk") || exit 1
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/disk3s5 971350180 1 %s 1%% /System/Volumes/Data\\n' "$kb"`);
  const perlLib = join(home, 'perl');
  mkdirSync(perlLib);
  writeFileSync(join(perlLib, 'FixtureClock.pm'), 'package FixtureClock;\n*CORE::GLOBAL::alarm = sub (_) { CORE::alarm($_[0] > 0 ? $_[0] * 5 : $_[0]) };\n1;\n');
  const base = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin`, CI_KIT_TART: join(bin, 'tart'), CI_KIT_GH_BIN: join(bin, 'gh'),
    CI_KIT_VM_DF: join(bin, 'df'), CI_KIT_VM_KIT: mac, CI_KIT_VM_BASE: BASE, CI_KIT_VM_TICK: '0.2', CI_KIT_VM_BOOT: '30',
    CI_KIT_VM_STOP_TIMEOUT: '5', GH_TOKEN: 'a-job-token', PERL5LIB: perlLib, PERL5OPT: '-MFixtureClock', ...env,
  };
  const f = {
    home, logs, vmHome, vms, maws, trialOut,
    disk(gb) { writeFileSync(join(home, 'disk'), `${Math.round(gb * 1048576)}\n`); },
    vm(name, state = 'stopped') { mkdirSync(join(vms, name), { recursive: true }); writeFileSync(join(vms, name, 'state'), `${state}\n`); },
    state: (name) => text(join(vms, name, 'state'))?.trim() ?? null,
    names: () => readdirSync(vms).sort(),
    flag: (name, on = true) => on ? writeFileSync(join(home, 'tart', name), '') : rmSync(join(home, 'tart', name), { force: true }),
    calls: () => (text(join(home, 'tart/calls')) ?? '').split('\n').filter(Boolean),
    exec: (name) => (text(join(vms, name, 'exec')) ?? '').split('\n').filter(Boolean),
    ghCalls: () => (text(join(home, 'gh/calls')) ?? '').split('\0\0').filter(Boolean).map((call) => call.split('\0')),
    log: () => text(join(logs, 'vm-bake.log')) ?? '',
    pointer: () => text(join(vmHome, 'golden'))?.trim(),
    record: (candidate = CANDIDATE) => {
      const body = text(join(vmHome, 'trials', candidate));
      return body && Object.fromEntries(body.split('\n').slice(1).filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    },
    writeRecord(fields, candidate = CANDIDATE) {
      writeFileSync(join(vmHome, 'trials', candidate), `trial of ${candidate}\n${Object.entries({ candidate, trial: 'maws-vm-trial-x', run: '7', attempt: '1', job: '4242', conclusion: 'success', ...fields }).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
    },
    hold(content) { writeFileSync(join(logs, 'vm-hold.ci-opt'), `${content}\n`); },
    // The coordinator's hold.sh, from the same kit.
    holdSh: (args) => spawnSync('/bin/bash', [join(mac, 'vm/hold.sh'), ...args], { encoding: 'utf8', timeout: 60_000, env: { ...base, CI_KIT_VM_HOLD_WAIT: '5' } }),
    identity(slot) { for (const file of identities) writeFileSync(join(vmHome, slot, 'identity', file), `${slot} ${file}\n`); },
    jobs(run, attempt, jobs) { writeFileSync(join(home, `gh/jobs-${run}-${attempt}.json`), JSON.stringify({ total_count: jobs.length, jobs })); },
    mark(name, content = '') {
      writeFileSync(join(trialOut, `.${name}.tmp`), `${content}\n`);
      renameSync(join(trialOut, `.${name}.tmp`), join(trialOut, name));
    },
    powerOff: (name) => writeFileSync(join(vms, name, 'poweroff'), ''),
    run(args, { input = '', extra = {} } = {}) {
      return spawnSync('/bin/bash', [bake, ...args], { encoding: 'utf8', input, timeout: 120_000, env: { ...base, ...extra } });
    },
    // bake.sh in the background, for the steps the test drives as the guest.
    start(args, extra = {}) {
      const child = spawn('/bin/bash', [bake, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...base, ...extra } });
      children.add(child);
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const exited = once(child, 'exit').then(([code]) => { children.delete(child); return code; });
      return { output: () => stdout + stderr, exited };
    },
    async until(predicate, what, ms = 60_000) {
      for (let waited = 0; !predicate(); waited += 50) {
        if (waited > ms) throw new Error(`timed out waiting for ${what}\n--- vm-bake.log ---\n${f.log().slice(-4000)}`);
        await sleep(50);
      }
    },
  };
  f.vm(BASE);
  f.disk(disk);
  if (hold) f.hold(hold);
  return f;
}
const trialClone = (f) => f.names().find((name) => name.startsWith('maws-vm-trial-'));

describe('the VM lane\'s maintenance procedure (bake.sh)', { concurrency: 4, ...macOnly }, () => {
  // The hold: every step but --retire refuses without it, before it calls Tart at all.
  const steps = [['--bake'], ['--register', CANDIDATE], ['--trial', CANDIDATE], ['--promote', CANDIDATE]];
  test('every step but --retire refuses outside the maintenance hold, and calls Tart for nothing', async () => {
    const cases = [
      ['no hold', (f) => rmSync(join(f.logs, 'vm-hold.ci-opt')), /refused: no maintenance hold/],
      ['a timed hold only', (f) => f.hold('timed since 2026-10-22T09:00:00Z'), /refused: no maintenance hold/],
      ['a reservation', (f) => writeFileSync(join(f.logs, 'vm-reserved'), 'reserved since 2026-10-22T09:00:00Z: vm=maws-vm-job-vm-20261022T090000Z\n'),
        /refused: a reservation stands \(reserved since .*maws-vm-job-vm-20261022T090000Z\)/],
      ['the agent loaded', (f) => writeFileSync(join(f.home, 'launchctl-loaded'), ''), /refused: the launcher's agent is loaded: launchctl bootout/],
      ['launchd unreadable', (f) => writeFileSync(join(f.home, 'launchctl-fails'), ''), /refused: whether the launcher's agent is loaded cannot be told \(launchctl print exited 5\)/],
    ];
    for (const [what, arrange, refusal] of cases) {
      for (const args of steps) {
        const f = fixture();
        arrange(f);
        const result = f.run(args, { input: 'a-token\nanother-token\n' });
        assert.equal(result.status, 1, `${what}, ${args}: ${result.stdout}${result.stderr}`);
        assert.match(result.stderr, refusal, `${what}, ${args}`);
        assert.deepEqual(f.calls(), [], `${what}, ${args}: no Tart call`);
      }
    }
  });

  test('the maintenance hold hold.sh writes is the one every step accepts; its release is a refusal again', async () => {
    const f = fixture({ hold: null });
    const held = f.holdSh(['hold', 'ci-opt', 'maintenance']);
    assert.equal(held.status, 0, held.stdout + held.stderr);
    assert.match(held.stdout, /ci-kit vm hold: held: \S+\/vm-hold\.ci-opt \(maintenance\)\nci-kit vm hold: no guest\n$/);
    const step = f.run(['--promote', CANDIDATE]);
    assert.match(step.stdout, /held for maintenance by ci-opt \(maintenance since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\); no reservation, the launcher booted out/);
    assert.equal(f.holdSh(['release', 'ci-opt']).status, 0);
    const refused = f.run(['--promote', CANDIDATE]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refused: no maintenance hold: run \S+\/hold\.sh hold <session> maintenance first/);
  });

  test('a launcher running with its agent booted out holds vm-lane.lock, and every step refuses for it', async () => {
    const f = fixture();
    const holder = spawn('perl', ['-MFcntl=:flock', '-e', '$| = 1; open(my $fh, ">>", shift) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; sleep 600',
      join(f.logs, 'vm-lane.lock')], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.add(holder);
    await once(holder.stdout, 'data');
    try {
      for (const args of steps) {
        const result = f.run(args);
        assert.equal(result.status, 1, `${args}`);
        assert.match(result.stderr, /refused: a launcher or an install holds .*vm-lane\.lock/, `${args}`);
      }
      assert.deepEqual(f.calls(), []);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  test('the reserve: under CI_KIT_VM_DISK_RESERVE free, no bake, no registration and no trial; the figure is printed', () => {
    for (const args of [['--bake'], ['--register', CANDIDATE], ['--trial', CANDIDATE]]) {
      const f = fixture({ disk: 39.5 });
      f.vm(CANDIDATE);
      f.identity('vm-trial');
      const result = f.run(args, { input: 'a-token\nanother-token\n' });
      assert.equal(result.status, 1, `${args}`);
      assert.match(result.stderr, /refused: 39 GB free on the volume of .*\.tart, under the reserve of 40 GB \(CI_KIT_VM_DISK_RESERVE\)/, `${args}`);
      assert.ok(!f.calls().some((call) => /^(clone|run|set) /.test(call)), `${args}: ${f.calls()}`);
    }
    const f = fixture({ disk: 45, env: { CI_KIT_VM_DISK_RESERVE: '50' } });
    assert.match(f.run(['--bake']).stderr, /45 GB free .* under the reserve of 50 GB/);
  });

  test('--bake: the candidate cloned from the base, set at 4 CPUs, 4096 MB, 2560x1440pt and a 60 GB disk before its first boot, provisioned through tart exec (the disk grown and the display set first), its stop verified, then the human\'s steps', () => {
    const f = fixture();
    const result = f.run(['--bake', '--name', CANDIDATE]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.state(CANDIDATE), 'stopped');
    assert.equal(text(join(f.vms, CANDIDATE, 'source')).trim(), BASE);
    assert.deepEqual(text(join(f.vms, CANDIDATE, 'set.args')).trim().split('\n'), ['--cpu', '4', '--memory', '4096', '--display', '2560x1440pt', '--disk-size', '60']);
    // The disk is grown while the candidate is stopped, before it ever boots.
    assert.ok(f.calls().findIndex((call) => call.startsWith(`set ${CANDIDATE} `)) < f.calls().findIndex((call) => call.startsWith('run ')), f.calls().join('\n'));
    assert.deepEqual(text(join(f.vms, CANDIDATE, 'run.args')).trim().split('\n'), ['--no-graphics', '--no-clipboard', `--dir=kit:${mac}:ro`, `--dir=maws:${f.maws}:ro`, CANDIDATE]);
    const script = '/bin/bash /Volumes/My Shared Files/kit/vm/provision.sh';
    assert.deepEqual(f.exec(CANDIDATE), [`${script} check`, `${script} disk 60`, `${script} display`, `${script} node 11.23.0`, `${script} store`, `${script} libreoffice`,
      `${script} runner ${installPin('RUNNER_VERSION')} ${installPin('RUNNER_SHA256')} mini-vm`, `${script} helpers`]);
    // Its end verified before the step reports done: a stop, then Tart's list.
    const calls = f.calls();
    assert.ok(calls.indexOf(`stop ${CANDIDATE} --timeout 5`) > calls.lastIndexOf(`exec ${CANDIDATE} ${script} helpers`), calls.join('\n'));
    assert.match(result.stdout, /baked: maws-vm-candidate-20261022, stopped; the lowest free space during the bake was 120 GB/);
    assert.match(result.stdout, /120 GB free on the volume of .* \(reserve 40 GB\)/);
    // The human's window step, printed for CI-opt to relay: graphics, the maws share, the notification prompt.
    assert.match(result.stdout, new RegExp(`tart run --dir=maws:${f.maws}:ro ${CANDIDATE}`));
    assert.match(result.stdout, /pnpm e2e:deliverables/);
    // The baked runtime, as jobs get it: the runner's .path before any pnpm.
    const steps = result.stdout.slice(result.stdout.indexOf("The human's first-run window step"));
    const exported = steps.indexOf('export PATH="$(cat ~/actions-runner-maws/.path)"');
    assert.ok(exported > 0 && exported < steps.indexOf('pnpm install'), steps);
    assert.match(result.stdout, /Electron may send notifications/);
    assert.match(result.stdout, /never VNC into the guest/);
    assert.match(result.stdout, /This one boot keeps the clipboard shared/);
    assert.match(f.log(), /bake held for maintenance by ci-opt \(maintenance since/);
  });

  test('--bake: --memory sets the guest\'s size, the date names the candidate, and a candidate or its golden name taken is refused', () => {
    const f = fixture();
    const result = f.run(['--bake', '--memory', '6144']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const name = f.names().find((vm) => vm.startsWith('maws-vm-candidate-'));
    assert.match(name, /^maws-vm-candidate-\d{8}$/);
    assert.equal(name, `maws-vm-candidate-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
    assert.deepEqual(text(join(f.vms, name, 'set.args')).trim().split('\n'), ['--cpu', '4', '--memory', '6144', '--display', '2560x1440pt', '--disk-size', '60']);
    const again = f.run(['--bake']);
    assert.equal(again.status, 1);
    assert.match(again.stderr, new RegExp(`refused: ${name} exists: retire it \\(bake.sh --retire ${name}\\)`));
    const g = fixture();
    g.vm(GOLDEN);
    assert.match(g.run(['--bake', '--name', CANDIDATE]).stderr, new RegExp(`refused: ${GOLDEN} exists, which ${CANDIDATE} would be promoted to`));
    assert.match(g.run(['--bake', '--memory', 'lots']).stderr, /--memory takes the guest's memory in MB/);
    assert.match(g.run(['--bake', '--name', 'maws-vm-golden-x']).stderr, /--name takes maws-vm-candidate-<id>/);
  });

  test('--bake: a --memory under the base image\'s 4 GiB is refused before anything, with the image\'s reason', () => {
    const f = fixture();
    const result = f.run(['--bake', '--memory', '3072']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--memory 3072 is under the base image's minimum of 4096 MB \(Tart refuses it: LessThanMinimalResourcesError\)/);
    assert.deepEqual(f.calls(), []);
    assert.equal(f.run(['--bake', '--memory', '4095']).status, 1);
  });

  test('--bake: a disk that does not grow in the guest fails the bake, and the candidate is stopped, verified', () => {
    const f = fixture();
    f.flag('fail-disk');
    const result = f.run(['--bake', '--name', CANDIDATE]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /maws-vm-candidate-20261022: the disk grown to 60 GB \(disk\) failed \(1: provision: disk failed\)/);
    assert.equal(f.state(CANDIDATE), 'stopped');
    assert.equal(f.exec(CANDIDATE).length, 2, 'stopped at the disk step');
  });

  test('--bake: a provision step that fails stops the candidate, verified, and leaves it; a VM of the lane running refuses the bake', () => {
    const f = fixture();
    f.flag('fail-store');
    const result = f.run(['--bake', '--name', CANDIDATE]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /maws-vm-candidate-20261022: the warm store \(store\) failed \(1: provision: store failed\)/);
    assert.equal(f.state(CANDIDATE), 'stopped');
    assert.match(result.stdout, /its end is verified/);
    const g = fixture();
    g.vm('maws-vm-trial-20261022T080000Z', 'running');
    const refused = g.run(['--bake']);
    assert.match(refused.stderr, /refused: a VM of the lane runs: maws-vm-trial-20261022T080000Z \(running\)/);
    assert.ok(!g.calls().some((call) => call.startsWith('clone')));
  });

  test('--bake: a trial record left by an earlier candidate of the same name is moved aside, so it cannot promote this one', () => {
    const f = fixture();
    f.writeRecord({});
    const result = f.run(['--bake', '--name', CANDIDATE]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /an earlier trial record of maws-vm-candidate-20261022 is kept as .*\.before-<time>; this candidate has none until its own trial/);
    assert.ok(readdirSync(join(f.vmHome, 'trials')).some((name) => name.startsWith(`${CANDIDATE}.before-`)));
    assert.match(f.run(['--promote', CANDIDATE]).stderr, /refused: no trial record for maws-vm-candidate-20261022/);
  });

  test('a machine whose name cannot be read refuses before anything', () => {
    const f = fixture();
    rmSync(join(f.home, 'actions-runner-maws/.runner'));
    const result = f.run(['--bake']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the machine's short name cannot be read/);
    assert.deepEqual(f.calls(), []);
  });

  test('--bake: under the disk floor between steps, the bake stops the candidate', () => {
    const f = fixture({ env: { CI_KIT_VM_DISK_FLOOR: '200', CI_KIT_VM_DISK_RESERVE: '40' } });
    const result = f.run(['--bake', '--name', CANDIDATE]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /120 GB free on the volume of .*, under the floor of 200 GB; the bake stopped/);
    assert.equal(f.state(CANDIDATE), 'stopped');
    assert.deepEqual(f.exec(CANDIDATE).length, 1, 'stopped after the first step');
  });

  test('--register: both identities, each token through the exec\'s stdin and never an argument, the files moved to their slots', () => {
    const f = fixture();
    f.vm(CANDIDATE);
    const result = f.run(['--register', CANDIDATE], { input: 'token-for-vm\ntoken-for-trial\n' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const [slot, name, labels] of [['vm', 'ci-kit-mac-mini-vm', 'ci-kit-mac-solo,ci-kit-mac-vm'], ['vm-trial', 'ci-kit-mac-mini-vm-trial', 'ci-kit-mac-vm-trial']]) {
      for (const file of identities) {
        const path = join(f.vmHome, slot, 'identity', file);
        assert.equal(text(path), `${name} ${labels} ${file}\n`, `${slot} ${file}`);
        assert.equal(statSync(path).mode & 0o777, 0o600, `${slot} ${file}`);
      }
    }
    assert.equal(text(join(f.home, 'tart/tokens')), 'vm token-for-vm\nvm-trial token-for-trial\n');
    assert.ok(!f.calls().some((call) => call.includes('token-for')), 'no token in any argument list');
    assert.ok(!f.log().includes('token-for'), 'no token in the log');
    assert.deepEqual(f.exec(CANDIDATE), [
      '/bin/bash /Volumes/My Shared Files/kit/vm/provision.sh register vm ci-kit-mac-mini-vm ci-kit-mac-solo,ci-kit-mac-vm https://github.com/SSFSKIM/MAWS',
      '/bin/bash /Volumes/My Shared Files/kit/vm/provision.sh register vm-trial ci-kit-mac-mini-vm-trial ci-kit-mac-vm-trial https://github.com/SSFSKIM/MAWS',
    ]);
    assert.deepEqual(text(join(f.vms, CANDIDATE, 'run.args')).trim().split('\n'), ['--no-graphics', '--no-clipboard', `--dir=kit:${mac}:ro`,
      `--dir=identity-vm:${f.vmHome}/vm/identity`, `--dir=identity-vm-trial:${f.vmHome}/vm-trial/identity`, CANDIDATE]);
    assert.equal(f.state(CANDIDATE), 'stopped');
    // Both registered: nothing left to do.
    assert.match(f.run(['--register', CANDIDATE], { input: 'x\n' }).stderr, /refused: both slots hold an identity already/);
  });

  test('--register: a slot that holds its identity is skipped, so one token serves the other; too few tokens refuse before any boot', () => {
    const f = fixture();
    f.vm(GOLDEN);
    f.identity('vm');
    const before = text(join(f.vmHome, 'vm/identity/.credentials'));
    const result = f.run(['--register', GOLDEN], { input: 'only-token\n' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(text(join(f.home, 'tart/tokens')), 'vm-trial only-token\n');
    assert.equal(text(join(f.vmHome, 'vm/identity/.credentials')), before, 'the production identity is untouched');
    const g = fixture();
    g.vm(CANDIDATE);
    const short = g.run(['--register', CANDIDATE], { input: 'one-token\n' });
    assert.equal(short.status, 1);
    assert.match(short.stderr, /2 registration token\(s\) needed on stdin, one a line \(for vm vm-trial\); fewer were given/);
    assert.ok(!g.calls().some((call) => call.startsWith('run')), 'no boot');
    g.vm('maws-vm-job-vm-20261022T090000Z', 'running');
    assert.match(g.run(['--register', CANDIDATE], { input: 'a\nb\n' }).stderr, /refused: a VM of the lane runs: maws-vm-job-vm-20261022T090000Z/);
    assert.match(g.run(['--register', 'macos-base'], { input: 'a\nb\n' }).stderr, /usage|bake\.sh --register/);
  });

});

// The trials run one at a time: a trial clone is named after the second it starts, and Tart's VMs, like the process
// table its runs are read from, are the machine's, so two trials in one second would read each other's run.
describe('the trial (bake.sh --trial)', macOnly, () => {
  test('--trial: a clone of the candidate under the trial slot\'s identity, never the production one; the job read through gh; the record binds candidate, run, job and success', async () => {
    const f = fixture();
    f.vm(CANDIDATE);
    f.identity('vm');
    f.identity('vm-trial');
    const trial = f.start(['--trial', CANDIDATE]);
    await f.until(() => trialClone(f) && existsSync(join(f.vms, trialClone(f), 'kicked')), 'the trial clone kicked off');
    const clone = trialClone(f);
    assert.match(clone, /^maws-vm-trial-\d{8}T\d{6}Z$/);
    assert.equal(text(join(f.vms, clone, 'source')).trim(), CANDIDATE);
    const args = text(join(f.vms, clone, 'run.args')).trim().split('\n');
    assert.deepEqual(args, ['--no-graphics', '--no-clipboard', `--dir=kit:${mac}:ro`, `--dir=identity:${f.vmHome}/vm-trial/identity:ro`,
      `--dir=out:${f.vmHome}/vm-trial/out`, `--dir=cache:${f.vmHome}/vm-trial/cache`, clone]);
    assert.ok(!args.some((arg) => arg.includes(`${f.vmHome}/vm/`)), 'nothing of the production slot is shown');
    assert.deepEqual(text(join(f.vms, clone, 'kicked')).trim().split('\n'), ['/Users/admin/ci-kit/vm/guest/kickoff.sh', 'vm-trial', clone]);
    // The guest, as wrapper.sh writes out/: listening, a job taken, its hook, the end.
    f.mark('listening', 'at=2026-10-22T09:10:40Z');
    f.mark('assigned', 'job=9e8d7c6b at=2026-10-22T09:11:00Z by=diag');
    f.mark('job', 'run=7 attempt=2 job=e2e repository=SSFSKIM/MAWS at=2026-10-22T09:11:30Z');
    const started = iso();
    f.jobs(7, 2, [
      { id: 4241, runner_name: 'ci-kit-mac-mini', status: 'completed', conclusion: 'failure', started_at: started },
      { id: 4242, runner_name: 'ci-kit-mac-mini-vm-trial', status: 'completed', conclusion: 'success', started_at: started },
      { id: 4100, runner_name: 'ci-kit-mac-mini-vm-trial', status: 'completed', conclusion: 'failure', started_at: '2026-10-21T09:00:00Z' },
    ]);
    await f.until(() => /out\/job: run=7/.test(f.log()), 'the job seen');
    f.mark('done', '0');
    f.powerOff(clone);
    assert.equal(await trial.exited, 0, trial.output());
    const record = f.record();
    assert.equal(record.candidate, CANDIDATE);
    assert.equal(record.trial, clone);
    assert.equal(record.run, '7');
    assert.equal(record.attempt, '2');
    assert.equal(record.job, '4242');
    assert.equal(record.conclusion, 'success');
    assert.equal(record.out, join(f.vmHome, 'trials', `${clone}.out`));
    assert.match(text(join(f.vmHome, 'trials', CANDIDATE)), /^trial of maws-vm-candidate-20261022: run 7 job 4242 success\n/);
    // Its end verified, then deleted; out/ kept beside the record, an empty one for the next trial.
    assert.equal(existsSync(join(f.vms, clone)), false);
    assert.ok(existsSync(join(record.out, 'job')));
    assert.deepEqual(readdirSync(f.trialOut), []);
    assert.equal(f.state(CANDIDATE), 'stopped');
    assert.equal(text(join(f.vmHome, 'vm/identity/.runner')), 'vm .runner\n', 'the production identity is untouched');
    // gh with the machine's own login, never the job's token.
    const reads = f.ghCalls().filter((call) => call[0] === 'api');
    assert.ok(reads.length > 0 && reads.every((call) => call.includes('GH_TOKEN=unset')), JSON.stringify(reads));
    assert.ok(reads.some((call) => call[1] === 'repos/SSFSKIM/MAWS/actions/runs/7/attempts/2/jobs?per_page=100&page=1'));
    // And promoted on it.
    const promoted = f.run(['--promote', CANDIDATE]);
    assert.equal(promoted.status, 0, promoted.stdout + promoted.stderr);
    assert.equal(f.pointer(), GOLDEN);
  });

  test('--trial: a clone that takes no job is asked to stop through the handshake, and its record carries no job id, which --promote refuses', async () => {
    const f = fixture({ env: { CI_KIT_VM_TRIAL_IDLE: '1' } });
    f.vm(CANDIDATE);
    f.identity('vm-trial');
    const trial = f.start(['--trial', CANDIDATE]);
    await f.until(() => existsSync(join(f.trialOut, 'stop-request')), 'the stop asked');
    const clone = trialClone(f);
    f.mark('listening', 'at=2026-10-22T09:10:40Z');
    f.mark('stopped', 'at=2026-10-22T09:12:00Z');
    f.mark('done', '0');
    f.powerOff(clone);
    assert.equal(await trial.exited, 0, trial.output());
    const record = f.record();
    assert.equal(record.candidate, CANDIDATE);
    assert.equal(record.job, '');
    assert.match(record.why, /no job reached the trial clone's hook \(no out\/job\): the guest powered itself off/);
    assert.match(trial.output(), /no job assigned within 1 s; asked the wrapper to stop/);
    assert.equal(existsSync(join(f.vms, clone)), false);
    assert.ok(!f.calls().includes(`stop ${clone} --timeout 5`), 'the guest powered off: no stop');
    const refused = f.run(['--promote', CANDIDATE]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refused: the trial record names no job id \(trial of maws-vm-candidate-20261022: no job\)/);
    assert.equal(f.pointer(), OLD);
  });

  test('--trial: a job past its bound is stopped, verified, and recorded with the conclusion GitHub gives', async () => {
    const f = fixture({ env: { CI_KIT_VM_JOB_BOUND: '0.05' } });
    f.vm(CANDIDATE);
    f.identity('vm-trial');
    const trial = f.start(['--trial', CANDIDATE]);
    await f.until(() => trialClone(f) && existsSync(join(f.vms, trialClone(f), 'kicked')), 'the trial clone kicked off');
    const clone = trialClone(f);
    f.jobs(9, 1, [{ id: 5151, runner_name: 'ci-kit-mac-mini-vm-trial', status: 'completed', conclusion: 'failure', started_at: iso() }]);
    f.mark('assigned', 'job=abc at=2026-10-22T09:11:00Z by=diag');
    f.mark('job', 'run=9 attempt=1 job=e2e repository=SSFSKIM/MAWS at=2026-10-22T09:11:30Z');
    assert.equal(await trial.exited, 0, trial.output());
    assert.match(trial.output(), /its job outlived 0\.05 min/);
    assert.ok(f.calls().includes(`stop ${clone} --timeout 5`));
    assert.equal(f.record().job, '5151');
    assert.equal(f.record().conclusion, 'failure');
    assert.match(f.run(['--promote', CANDIDATE]).stderr, /refused: the trial job 5151 concluded failure, not success/);
  });

  test('--trial: refused without the trial identity, for a running or missing candidate, and a kickoff that fails is recorded with no job', () => {
    const f = fixture();
    f.vm(CANDIDATE);
    assert.match(f.run(['--trial', CANDIDATE]).stderr, /refused: the trial slot has no identity .*: bake\.sh --register first/);
    f.identity('vm-trial');
    assert.match(f.run(['--trial', 'maws-vm-candidate-none']).stderr, /refused: no VM named maws-vm-candidate-none/);
    f.vm(CANDIDATE, 'running');
    assert.match(f.run(['--trial', CANDIDATE]).stderr, /refused: a VM of the lane runs: maws-vm-candidate-20261022 \(running\)/);
    f.vm(CANDIDATE, 'stopped');
    f.flag('fail-kickoff');
    const result = f.run(['--trial', CANDIDATE]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(f.record().why, /kickoff\.sh failed: kickoff: no runner at/);
    assert.equal(f.record().job, '');
    assert.equal(trialClone(f), undefined, 'the trial clone is deleted');
  });

});

describe('the promote and the retire (bake.sh)', { concurrency: 4, ...macOnly }, () => {
  test('--promote refuses without a record naming the candidate, a job id and success; with both names present; and leaves the pointer', () => {
    const f = fixture();
    f.vm(CANDIDATE);
    assert.match(f.run(['--promote', CANDIDATE]).stderr, /refused: no trial record for maws-vm-candidate-20261022/);
    for (const [fields, refusal] of [
      [{ candidate: 'maws-vm-candidate-20261021' }, /names maws-vm-candidate-20261021, not maws-vm-candidate-20261022/],
      [{ job: '' }, /names no job id/],
      [{ conclusion: 'failure' }, /the trial job 4242 concluded failure, not success/],
      [{ conclusion: '' }, /concluded nothing, not success/],
    ]) {
      f.writeRecord(fields);
      const result = f.run(['--promote', CANDIDATE]);
      assert.equal(result.status, 1, JSON.stringify(fields));
      assert.match(result.stderr, refusal);
    }
    assert.ok(!f.calls().some((call) => call.startsWith('rename')));
    f.writeRecord({});
    f.vm(GOLDEN);
    assert.match(f.run(['--promote', CANDIDATE]).stderr, /refused: both maws-vm-candidate-20261022 and maws-vm-golden-20261022 exist/);
    rmSync(join(f.vms, GOLDEN), { recursive: true });
    f.vm(CANDIDATE, 'running');
    assert.match(f.run(['--promote', CANDIDATE]).stderr, /refused: maws-vm-candidate-20261022 is not verified stopped/);
    assert.equal(f.pointer(), OLD);
    assert.equal(f.state(CANDIDATE), 'running');
  });

  test('--promote interrupted between the rename and the pointer: the old golden stays named, and a second run finishes; a third is a no-op', asUser, () => {
    const f = fixture({ env: {} });
    const pointerDir = join(f.home, 'pointer');
    mkdirSync(pointerDir);
    writeFileSync(join(pointerDir, 'golden'), `${OLD}\n`);
    f.vm(CANDIDATE);
    f.vm(OLD);
    f.writeRecord({});
    const extra = { CI_KIT_VM_GOLDEN: join(pointerDir, 'golden') };
    chmodSync(pointerDir, 0o555);
    try {
      const first = f.run(['--promote', CANDIDATE], { extra });
      assert.equal(first.status, 1);
      assert.match(first.stdout, /renamed maws-vm-candidate-20261022 to maws-vm-golden-20261022/);
      assert.match(first.stderr, /the pointer .* cannot be written; it still names maws-vm-golden-20261020, which stays valid: run --promote maws-vm-candidate-20261022 again/);
      assert.equal(text(join(pointerDir, 'golden')), `${OLD}\n`);
      assert.deepEqual(f.names(), [BASE, OLD, GOLDEN].sort());
    } finally {
      chmodSync(pointerDir, 0o755);
    }
    const second = f.run(['--promote', CANDIDATE], { extra });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /maws-vm-candidate-20261022 is maws-vm-golden-20261022 already; the pointer is next/);
    assert.match(second.stdout, /promoted: the pointer names maws-vm-golden-20261022 \(it named maws-vm-golden-20261020\)/);
    assert.match(second.stdout, /bake\.sh --retire maws-vm-golden-20261020/);
    assert.equal(text(join(pointerDir, 'golden')), `${GOLDEN}\n`);
    const third = f.run(['--promote', CANDIDATE], { extra });
    assert.equal(third.status, 0);
    assert.match(third.stdout, /promoted already: the pointer names maws-vm-golden-20261022/);
    assert.equal(f.calls().filter((call) => call.startsWith('rename')).length, 1);
  });

  test('a retire paused at its delete holds the pointer lock: a promote resuming from the renamed golden waits, then finds it gone, and the pointer never names a deleted VM', async () => {
    const f = fixture();
    // A promote interrupted after its rename: the golden exists under its new name, the pointer still names the old.
    f.vm(OLD);
    f.vm(GOLDEN);
    f.writeRecord({});
    f.flag('block-delete');
    const retire = f.start(['--retire', GOLDEN]);
    await f.until(() => existsSync(join(f.home, 'tart/delete-waiting')), 'the retire at its delete');
    const promote = f.start(['--promote', CANDIDATE]);
    await sleep(1500);
    assert.equal(f.pointer(), OLD, 'the promote waits for the retire');
    f.flag('delete-go');
    assert.equal(await retire.exited, 0, retire.output());
    assert.equal(await promote.exited, 1, promote.output());
    assert.match(promote.output(), /refused: neither maws-vm-candidate-20261022 nor maws-vm-golden-20261022 is among Tart's VMs/);
    assert.equal(f.pointer(), OLD);
    assert.equal(existsSync(join(f.vms, GOLDEN)), false);
    // A pointer lock that stays taken refuses at its bound.
    const holder = spawn('perl', ['-MFcntl=:flock', '-e', '$| = 1; open(my $fh, ">>", shift) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; sleep 600',
      join(f.vmHome, 'golden.lock')], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.add(holder);
    await once(holder.stdout, 'data');
    try {
      const waited = f.run(['--retire', OLD], { extra: { CI_KIT_VM_POINTER_WAIT: '1' } });
      assert.equal(waited.status, 1);
      assert.match(waited.stderr, /golden\.lock stayed taken for 1 s: another promote or retire runs/);
      assert.ok(existsSync(join(f.vms, OLD)));
    } finally {
      holder.kill('SIGKILL');
    }
  });

  test('--retire needs no hold; it refuses the pointer\'s VM, a running VM, and anything not a golden, a candidate or a trial clone; a VM gone is done', () => {
    const f = fixture({ hold: null });
    writeFileSync(join(f.home, 'launchctl-loaded'), '');
    writeFileSync(join(f.logs, 'vm-reserved'), 'reserved since 2026-10-22T09:00:00Z: vm=maws-vm-job-vm-20261022T090000Z\n');
    f.vm(OLD);
    f.vm(GOLDEN);
    f.vm('maws-vm-candidate-20261021', 'running');
    f.vm('maws-vm-job-vm-20261022T090000Z');
    writeFileSync(join(f.vmHome, 'golden'), `${GOLDEN}\n`);
    for (const [vm, refusal] of [
      [GOLDEN, /refused: maws-vm-golden-20261022 is the golden image the pointer names/],
      ['maws-vm-candidate-20261021', /refused: maws-vm-candidate-20261021 runs \(Tart lists maws-vm-candidate-20261021 as running\)/],
      ['maws-vm-job-vm-20261022T090000Z', /refused: maws-vm-job-vm-20261022T090000Z is not a golden, a candidate or a trial clone/],
      [BASE, /refused: macos-base is not a golden, a candidate or a trial clone/],
    ]) {
      const result = f.run(['--retire', vm]);
      assert.equal(result.status, 1, vm);
      assert.match(result.stderr, refusal, vm);
    }
    assert.ok(!f.calls().some((call) => call.startsWith('delete')));
    const retired = f.run(['--retire', OLD]);
    assert.equal(retired.status, 0, retired.stdout + retired.stderr);
    assert.match(retired.stdout, /retired: maws-vm-golden-20261020 deleted \(the pointer names maws-vm-golden-20261022\)/);
    assert.equal(existsSync(join(f.vms, OLD)), false);
    const again = f.run(['--retire', OLD]);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /retired already: maws-vm-golden-20261020 is not among Tart's VMs/);
    // A golden whose stop cannot be told is never deleted either.
    f.flag('fail-list');
    assert.match(f.run(['--retire', 'maws-vm-candidate-20261021']).stderr, /refused: Tart cannot list its VMs/);
  });
});

// The guest's disk, through diskutil as the base image's layout has it: disk0 holds the iBoot system container
// (disk0s1), the APFS container macOS runs from (disk0s2) and the recovery container after it (disk0s3). Its sizes are
// files of <dir>: disk-size (what `tart set --disk-size` made), apfs-size, recovery-size (gone once removed). Flags:
// erase-refused (eraseVolume fails, deleteContainer works), keep-recovery (both fail), no-grow (a resize that takes
// nothing). Every call is a line of <dir>/diskutil.calls; repairDisk's answer on stdin is kept in repair-answer.
const ISC = 524288000;
const fakeDiskutil = (dir) => `d='${dir}'
printf '%s\\n' "$*" >> "$d/diskutil.calls"
isc=${ISC}
size() { cat "$d/$1"; }
part() { printf '<dict><key>Content</key><string>%s</string><key>DeviceIdentifier</key><string>%s</string><key>Size</key><integer>%s</integer></dict>' "$@"; }
case "$*" in
  'list -plist physical')
    printf '<?xml version="1.0" encoding="UTF-8"?>\\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\\n'
    printf '<plist version="1.0"><dict><key>AllDisks</key><array><string>disk0</string></array><key>AllDisksAndPartitions</key><array><dict>'
    printf '<key>Content</key><string>GUID_partition_scheme</string><key>DeviceIdentifier</key><string>disk0</string><key>OSInternal</key><false/><key>Partitions</key><array>'
    part Apple_APFS_ISC disk0s1 "$isc"
    part Apple_APFS disk0s2 "$(size apfs-size)"
    [[ ! -f $d/recovery-size ]] || part Apple_APFS_Recovery disk0s3 "$(size recovery-size)"
    printf '</array><key>Size</key><integer>%s</integer></dict></array></dict></plist>\\n' "$(size disk-size)" ;;
  'eraseVolume free free disk0s3')
    [[ -f $d/recovery-size && ! -e $d/erase-refused && ! -e $d/keep-recovery ]] || { echo 'Error: -69888: Could not unmount disk' >&2; exit 1; }
    rm "$d/recovery-size" ;;
  'apfs deleteContainer disk0s3')
    [[ -f $d/recovery-size && ! -e $d/keep-recovery ]] || { echo 'Error: -69624: Unable to delete the container' >&2; exit 1; }
    rm "$d/recovery-size" ;;
  'repairDisk disk0')
    IFS= read -r answer; printf '%s\\n' "$answer" > "$d/repair-answer" ;;
  'apfs resizeContainer disk0s2 0')
    [[ ! -e $d/no-grow ]] || exit 0
    [[ ! -f $d/recovery-size ]] || { echo 'Error: -69519: The target disk is too small for this operation' >&2; exit 1; }
    echo "$(($(size disk-size) - isc - 40960))" > "$d/apfs-size" ;;
  *) exit 64 ;;
esac`;

// provision.sh's steps that run nothing of Homebrew's or GitHub's: the runner's environment, the registration, the
// display and the disk.
describe('the bake\'s provisioning in the guest (provision.sh)', macOnly, () => {
  function guest({ mode = '1024x768 on', disk = 60e9, apfs = 44107026944, recovery = 5368664064 } = {}) {
    const home = mkdtempSync(join(root, 'guest-'));
    const shares = join(home, 'shares');
    const runner = join(home, 'actions-runner-maws');
    const bin = join(home, 'bin');
    for (const dir of [join(shares, 'kit'), join(shares, 'identity-vm'), runner, bin]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, 'display-mode'), `${mode}\n`);
    executable(join(bin, 'displayplacer'), displayplacer(home));
    for (const [file, bytes] of [['disk-size', disk], ['apfs-size', apfs], ['recovery-size', recovery]]) if (bytes) writeFileSync(join(home, file), `${bytes}\n`);
    executable(join(bin, 'diskutil'), fakeDiskutil(home));
    const env = { HOME: home, PATH: '/usr/bin:/bin', CI_KIT_VM_SHARES: shares, CI_KIT_VM_DISPLAYPLACER: join(bin, 'displayplacer'),
      CI_KIT_VM_DISKUTIL: join(bin, 'diskutil'), CI_KIT_VM_DAEMON_LOG: join(home, 'tart-guest-daemon.log') };
    const run = (args, input = '') => spawnSync('/bin/bash', [provision, ...args], { encoding: 'utf8', input, env });
    const lines = (name) => (text(join(home, name)) ?? '').split('\n').filter(Boolean);
    const flag = (name) => writeFileSync(join(home, name), '');
    return { home, shares, runner, env, run, flag, displayCalls: () => lines('displayplacer.calls'), diskCalls: () => lines('diskutil.calls') };
  }

  test('display: the guest\'s mode set to 2560x1440 with scaling on through displayplacer, and read back; set already, nothing is set', () => {
    const g = guest();
    const result = g.run(['display']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(g.displayCalls(), ['list', `id:${DISPLAY_ID} res:2560x1440 scaling:on`, 'list']);
    assert.match(result.stdout, /the display is 1024x768 scaling:on; setting 2560x1440 scaling:on/);
    assert.match(result.stdout, new RegExp(`display ${DISPLAY_ID}: 2560x1440 scaling:on`));
    const again = g.run(['display']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(g.displayCalls().slice(3), ['list'], 'read, and nothing set');
  });

  test('display: a set that does not take, or a mode that cannot be read, fails the step', () => {
    const stuck = guest();
    stuck.flag('display-stuck');
    const result = stuck.run(['display']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /provision: the display is 1024x768 scaling:on after displayplacer set 2560x1440 scaling:on/);
    const unreadable = guest();
    unreadable.flag('display-fail');
    assert.match(unreadable.run(['display']).stderr, /provision: the display mode cannot be read \(\S+displayplacer list\)/);
  });

  test('disk: the recovery container after the APFS one removed, the disk repaired, the container grown to the disk tart set made, and verified; a second run changes nothing', () => {
    const g = guest();
    const result = g.run(['disk', '60']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(g.diskCalls(), ['list -plist physical', 'eraseVolume free free disk0s3', 'repairDisk disk0', 'apfs resizeContainer disk0s2 0', 'list -plist physical']);
    assert.equal(text(join(g.home, 'repair-answer')), 'yes\n');
    assert.match(result.stdout, /the container disk0s2 is 44\.1 GB of the 60\.0 GB disk disk0; growing it/);
    assert.match(result.stdout, /removing the recovery container disk0s3/);
    assert.match(result.stdout, /the container disk0s2 is 59\.5 GB of the 60\.0 GB disk disk0; \/ has \d+ GiB free/);
    const again = g.run(['disk', '60']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(g.diskCalls().slice(5), ['list -plist physical'], 'read, and nothing changed');
  });

  test('disk: a recovery container eraseVolume refuses is deleted as a container', () => {
    const g = guest();
    g.flag('erase-refused');
    const result = g.run(['disk', '60']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(g.diskCalls().slice(1, 3), ['eraseVolume free free disk0s3', 'apfs deleteContainer disk0s3']);
  });

  test('disk: refused when tart set did not grow the disk, when the recovery container stays, and when the container does not grow', () => {
    const small = guest({ disk: 50e9 });
    const result = small.run(['disk', '60']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /provision: the disk disk0 is 50\.0 GB, under the 60 GB bake\.sh set \(tart set --disk-size did not take\)/);
    assert.deepEqual(small.diskCalls(), ['list -plist physical']);
    const kept = guest();
    kept.flag('keep-recovery');
    assert.match(kept.run(['disk', '60']).stderr, /provision: the recovery container disk0s3 could not be removed/);
    const stuck = guest();
    stuck.flag('no-grow');
    assert.match(stuck.run(['disk', '60']).stderr, /provision: the container disk0s2 is 44\.1 GB of the 60\.0 GB disk disk0 after the resize: it did not grow into the disk/);
    assert.match(guest().run(['disk', 'big']).stderr, /disk takes the disk's size in GB/);
  });

  test('disk: the guest agent\'s own resize, under way at boot, is let finish before the step touches the disk', () => {
    const g = guest();
    const log = join(g.home, 'tart-guest-daemon.log');
    writeFileSync(log, 'INFO\trunning on Tart 2.40.1, proceeding...\nINFO\tattempting to resize disk...\n');
    const started = Date.now();
    const result = spawnSync('/bin/bash', ['-c', `(sleep 1.5; printf 'WARN\\tfailed to resize disk: no space\\n' >> "$1") & exec /bin/bash "$2" disk 60`, 'x', log, provision],
      { encoding: 'utf8', env: g.env });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Date.now() - started >= 1500, 'waited for the agent');
    assert.match(result.stdout, /waiting for the guest agent's own disk resize/);
    assert.equal(g.diskCalls()[0], 'list -plist physical');
  });

  test('env: the runner\'s .env carries the hooks through ~/ci-kit, the guest\'s machine and flag, and English; .path gives Node 22 first', () => {
    const g = guest();
    const result = g.run(['env', 'mini-vm']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(text(join(g.runner, '.env')), [
      'LANG=en_US.UTF-8',
      `ACTIONS_RUNNER_HOOK_JOB_STARTED=${g.home}/ci-kit/vm/guest/hooks/job-started.sh`,
      `ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${g.home}/ci-kit/vm/guest/hooks/job-completed.sh`,
      'CI_KIT_MACHINE=mini-vm', 'CI_KIT_VM_GUEST=1', '',
    ].join('\n'));
    assert.ok(!text(join(g.runner, '.env')).includes(' '), 'no space in a hook path');
    assert.equal(text(join(g.runner, '.path')), '/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\n');
    assert.equal(realpathSync(join(g.home, 'ci-kit')), realpathSync(join(g.shares, 'kit')));
    assert.match(g.run(['env', 'Mini VM']).stderr, /env takes the guest's machine name/);
  });

  test('register: config.sh gets the token in its environment only, the bake\'s .env and .path survive it, and the identity leaves the image for the share', () => {
    const g = guest();
    assert.equal(g.run(['env', 'mini-vm']).status, 0);
    const before = { env: text(join(g.runner, '.env')), path: text(join(g.runner, '.path')) };
    executable(join(g.runner, 'config.sh'), `printf '%s\\n' "$@" > "$HOME/config.args"
printf '%s' "\${ACTIONS_RUNNER_INPUT_TOKEN-}" > "$HOME/config.token"
echo "$PATH" > .path; echo 'JAVA_HOME=/somewhere' >> .env
mkdir -p _diag; echo registered > _diag/Runner_1.log
for file in .runner .credentials .credentials_rsaparams; do echo "$file of $3" > "$file"; done`);
    const result = g.run(['register', 'vm', 'ci-kit-mac-mini-vm', 'ci-kit-mac-solo,ci-kit-mac-vm', 'https://github.com/SSFSKIM/MAWS'], 'the-token\n');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(text(join(g.home, 'config.args')).trim().split('\n'), ['--unattended', '--url', 'https://github.com/SSFSKIM/MAWS', '--name', 'ci-kit-mac-mini-vm',
      '--labels', 'ci-kit-mac-solo,ci-kit-mac-vm', '--no-default-labels', '--work', '_work', '--replace']);
    assert.equal(text(join(g.home, 'config.token')), 'the-token');
    assert.equal(text(join(g.runner, '.env')), before.env);
    assert.equal(text(join(g.runner, '.path')), before.path);
    for (const file of identities) {
      assert.equal(text(join(g.shares, 'identity-vm', file)), `${file} of https://github.com/SSFSKIM/MAWS\n`);
      assert.equal(existsSync(join(g.runner, file)), false, `${file} left the image`);
    }
    assert.equal(existsSync(join(g.runner, '_diag')), false, 'the registration\'s diag log is not left for the wrapper');
    const none = g.run(['register', 'vm', 'ci-kit-mac-mini-vm', 'ci-kit-mac-solo', 'https://github.com/SSFSKIM/MAWS'], '');
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no registration token on stdin/);
    assert.match(g.run(['register', 'vm-trial', 'x', 'y', 'https://github.com/SSFSKIM/MAWS'], 't\n').stderr, /the identity-vm-trial share is not shown read-write/);
  });
});
