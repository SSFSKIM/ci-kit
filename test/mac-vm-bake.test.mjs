import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
const ENGINE = '2.1.309';
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
    [[ ! -e $t/no-agent ]] || exit 1
    [[ $1 != true ]] || exit 0
    if [[ $1 == /bin/bash && $2 == -c ]]; then
      script=$3; shift 3
      path='/Volumes/My Shared Files/maws'; script=\${script//"$path"/"$HOME/guest/share"}
      path='/Applications/LibreOffice.app'; script=\${script//"$path"/"$HOME/guest/LibreOffice.app"}
      export HOME=$HOME/guest
      export PATH=$HOME/bin:/usr/bin:/bin
      cd "$HOME" || exit 1
      if [[ -e $HOME/isolated-exec ]]; then
        # The real guest RPC owns the stream: a killed guest shell must not leave the host pipe held by its children.
        # Host descriptors cannot cross that RPC either (fd 10 is Bash's saved copy of the host lane lock).
        /bin/bash -c "$script" "$@" > "$HOME/exec.out" 2>&1 10>&- &
        guest=$!; echo "$guest" > "$HOME/exec.pid"
        wait "$guest"; status=$?
        cat "$HOME/exec.out"
        exit "$status"
      fi
      exec /bin/bash -c "$script" "$@"
    fi
    if [[ $1 == sudo ]]; then
      [[ $* == 'sudo -n /sbin/shutdown -h now' ]] || exit 64
      [[ ! -e $t/fail-shutdown ]] || exit 1
      [[ -e $t/shutdown-stays-up ]] || echo stopped > "$vms/$name/state"
      exit 0
    fi
    printf '%s\\n' "$*" >> "$vms/$name/exec"
    if [[ $1 == /bin/bash && $2 == */kit/vm/provision.sh ]]; then
      step=$3
      [[ ! -e $t/fail-$step ]] || { echo "provision: $step failed" >&2; exit 1; }
      if [[ -e $HOME/guest/real-provision ]]; then
        case $step in
          setup|runner|env)
            shift 2
            export HOME=$HOME/guest
            export CI_KIT_VM_SHARES=$HOME/shares
            exec /bin/bash "$HOME/shares/kit/vm/provision.sh" "$@" ;;
        esac
      fi
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
  */generate-jitconfig)
    cat > "$g/jit-request.json"
    echo '{"runner":{"id":71,"name":"fixture","os":"unknown","status":"offline","busy":false,"labels":[]},"encoded_jit_config":"fixture-trial-jit"}' ;;
  */actions/runners/71) exit 0 ;;
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
  mkdirSync(join(home, 'guest/.ci-kit'), { recursive: true });
  writeFileSync(join(home, 'guest/.ci-kit/quarantined-apps'), '/Applications/LibreOffice.app\n/Applications/Extra App.app\n');
  executable(join(bin, 'tart'), fakeTart);
  executable(join(bin, 'gh'), fakeGh);
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  executable(join(home, '.local/bin/claude'), `[[ $1 == --version ]] && echo '${ENGINE} (Claude Code)'`);
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
  const steps = [['--bake'], ['--first-run', CANDIDATE], ['--trial', CANDIDATE], ['--promote', CANDIDATE]];
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
    for (const args of [['--bake'], ['--trial', CANDIDATE]]) {
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
    assert.deepEqual(f.exec(CANDIDATE), [`${script} check`, `${script} disk 60`, `${script} quiet`, `${script} display`, `${script} node 11.23.0`, `${script} store`, `${script} libreoffice`, `${script} poppler`,
      `${script} engine ${ENGINE}`, `${script} setup`, `${script} runner ${installPin('RUNNER_VERSION')} ${installPin('RUNNER_SHA256')} mini-vm`, `${script} workrepo`, `${script} helpers`]);
    assert.match(result.stdout, /the seeded MAWS work repository \(workrepo\)/);
    assert.match(result.stdout, /MAWS.*declaration.*\(setup\)/);
    assert.match(result.stdout, /Open each app below/);
    assert.match(result.stdout, /\/Applications\/Extra App.app/);
    // Its end verified before the step reports done: a stop, then Tart's list.
    const calls = f.calls();
    assert.ok(calls.indexOf(`stop ${CANDIDATE} --timeout 5`) > calls.lastIndexOf(`exec ${CANDIDATE} ${script} helpers`), calls.join('\n'));
    assert.match(result.stdout, /baked: maws-vm-candidate-20261022, stopped; the lowest free space during the bake was 120 GB/);
    assert.match(result.stdout, /120 GB free on the volume of .* \(reserve 40 GB\)/);
    // The human's window step, printed for CI-opt to relay: graphics, the maws share, the notification prompt.
    assert.match(result.stdout, new RegExp(`tart run --no-clipboard --dir=maws:${f.maws}:ro ${CANDIDATE}`));
    assert.match(result.stdout, /pnpm e2e:deliverables/);
    assert.match(result.stdout, new RegExp(`ssh mini '~/ci-kit-vm/kit/vm/bake.sh --first-run ${CANDIDATE}'`));
    assert.match(result.stdout, /Electron may send notifications/);
    assert.match(result.stdout, /never VNC into the guest/);
    assert.doesNotMatch(result.stdout, /clipboard shared|In the guest.s Terminal run|export PATH=/);
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

  test('--bake: the guest\'s Claude Code is the host user\'s version, or CI_KIT_VM_ENGINE\'s; with neither, refused before a clone', () => {
    const script = '/bin/bash /Volumes/My Shared Files/kit/vm/provision.sh';
    const f = fixture();
    const result = f.run(['--bake', '--name', CANDIDATE], { extra: { CI_KIT_VM_ENGINE: '2.1.300' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(f.exec(CANDIDATE).includes(`${script} engine 2.1.300`), f.exec(CANDIDATE).join('\n'));
    assert.match(result.stdout, /Claude Code 2\.1\.300, guest machine mini-vm/);
    const g = fixture();
    rmSync(join(g.home, '.local/bin/claude'));
    const refused = g.run(['--bake', '--name', CANDIDATE]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refused: no Claude Code version for the guest: \S+\/\.local\/bin\/claude answers none/);
    assert.ok(!g.calls().some((call) => call.startsWith('clone ')), g.calls().join('\n'));
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

  test('--bake: quiet verification failure stops the candidate before the display and installs', () => {
    const f = fixture();
    f.flag('fail-quiet');
    const result = f.run(['--bake', '--name', CANDIDATE]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /background services off \(quiet\) failed/);
    assert.equal(f.state(CANDIDATE), 'stopped');
    assert.equal(f.exec(CANDIDATE).length, 3, 'check, disk, quiet; no later provisioning');
    assert.ok(f.calls().some((call) => call.startsWith(`stop ${CANDIDATE} `)));
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

  test('--register is retired without booting or touching persistent identities', () => {
    const f = fixture();
    f.identity('vm'); f.identity('vm-trial');
    const result = f.run(['--register', CANDIDATE], { input: 'unused-token\n' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--register is retired/);
    assert.deepEqual(f.calls(), []);
    assert.equal(text(join(f.vmHome, 'vm/identity/.runner')), 'vm .runner\n');
    assert.equal(text(join(f.vmHome, 'vm-trial/identity/.runner')), 'vm-trial .runner\n');
    assert.ok(!f.log().includes('unused-token'));
  });

});

// Run the real setup/applier and both .env writers within a whole bake. Only downloads and OS provisioning are
// stand-ins; the scratch clone, declaration, package inventories, script, install and records are real subprocesses.
function setupBakeFixture() {
  const f = fixture();
  const guest = join(f.home, 'guest'), kit = join(guest, 'shares/kit'), bin = join(guest, 'bin');
  mkdirSync(bin);
  cpSync(mac, kit, { recursive: true });
  for (const dir of ['setup', 'plan', 'vendor']) cpSync(join(mac, '..', dir), join(kit, dir), { recursive: true });
  symlinkSync(f.maws, join(guest, 'shares/maws'));
  writeFileSync(join(guest, 'real-provision'), '');
  symlinkSync(process.execPath, join(bin, 'node'));
  // No host Homebrew, downloads, runner tarball or system writes in this fixture.
  const runnerPath = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  const script = join(kit, 'vm/provision.sh');
  writeFileSync(script, readFileSync(script, 'utf8').replace(/^runner_path=.*$/m, `runner_path=${runnerPath}`));
  executable(join(bin, 'curl'), 'printf fake-runner > "$3"');
  executable(join(bin, 'shasum'), 'cat >/dev/null');
  executable(join(bin, 'tar'), '[[ $1 == -xzf && $3 == -C ]] || exit 64; mkdir -p "$4/bin"');
  executable(join(bin, 'brew'), `
case "$*" in
  'info --json=v2 --installed --formula') echo '{"formulae":[{"name":"poppler","full_name":"poppler","aliases":[],"oldnames":[],"tap":"homebrew/core","installed":[{"version":"1"}]}]}' ;;
  'info --json=v2 --installed --cask')
    extra=''
    [[ ! -f $HOME/brew-installs ]] || extra=',{"token":"extra-app","full_token":"extra-app","old_tokens":[],"tap":"homebrew/cask","installed":"1"}'
    printf '{"casks":[{"token":"libreoffice","full_token":"libreoffice","old_tokens":[],"tap":"homebrew/cask","installed":"1"}%s]}\\n' "$extra" ;;
  'install hello') echo hello >> "$HOME/brew-installs" ;;
  'install --cask extra-app') echo extra-app >> "$HOME/brew-installs" ;;
  'list --cask extra-app') echo '/Applications/Extra App.app (1 MB)' ;;
  'list --cask libreoffice extra-app') printf '/Applications/LibreOffice.app (1 MB)\\n/Applications/Extra App.app (1 MB)\\n' ;;
  *) echo "unexpected brew: $*" >&2; exit 64 ;;
esac`);
  executable(join(bin, 'xattr'), `if [[ $1 == -p ]]; then echo '0181;date;Homebrew;uuid'; else echo com.apple.quarantine; fi`);
  const git = (...args) => {
    const r = spawnSync('/usr/bin/git', ['-C', f.maws, ...args], { encoding: 'utf8', env: { ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
    assert.equal(r.status, 0, r.stderr);
  };
  mkdirSync(join(f.maws, '.github'));
  writeFileSync(join(f.maws, '.github/ci-kit.yml'), `version: 1
setup:
  node: "22"
  pnpm: true
  brew: [poppler]
  cask: [libreoffice, extra-app]
  script: .github/ci-setup.sh
  install: 'echo "install:$CI:$CI_KIT_SETUP_MODE" >> "$HOME/setup-calls"'
`);
  writeFileSync(join(f.maws, '.github/ci-setup.sh'), `set -eu
[ ! -e dirty ]
[ ! -e "$HOME/fail-script" ]
echo "script:$CI:$CI_KIT_SETUP_MODE" >> "$HOME/setup-calls"
`);
  git('init', '-b', 'master'); git('add', '.'); git('commit', '-qm', 'declaration');
  writeFileSync(join(f.maws, 'dirty'), 'host-only uncommitted file');
  git('config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: host-secret');
  const run = (step, ...args) => spawnSync('/bin/bash', [script, step, ...args], { encoding: 'utf8', env: {
    HOME: guest, CI_KIT_VM_SHARES: join(guest, 'shares'), PATH: runnerPath,
  } });
  return { ...f, guest, kit, git, runProvision: run };
}

describe('the declaration in a whole guest bake', macOnly, () => {
  test('the final runner .env keeps the applied hash, including after env is repeated; all quarantined apps are recorded', () => {
    const f = setupBakeFixture();
    const result = f.run(['--bake', '--name', CANDIDATE]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(text(join(f.guest, 'setup-calls')), 'script:true:bake\ninstall:true:bake\n');
    assert.equal(text(join(f.guest, 'brew-installs')), 'extra-app\n');
    const hash = text(join(f.guest, '.ci-kit/setup-hash'));
    assert.equal(hash, 'bdcec72c1fa875b3\n');
    const expected = `LANG=en_US.UTF-8
ACTIONS_RUNNER_HOOK_JOB_STARTED=${f.guest}/ci-kit/vm/guest/hooks/job-started.sh
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${f.guest}/ci-kit/vm/guest/hooks/job-completed.sh
CI_KIT_MACHINE=mini-vm
CI_KIT_VM_GUEST=1
CI_KIT_SETUP_HASH=bdcec72c1fa875b3
`;
    assert.equal(text(join(f.guest, 'actions-runner-maws/.env')), expected);
    const again = f.runProvision('env', 'mini-vm');
    assert.equal(again.status, 0, again.stderr);
    assert.equal(text(join(f.guest, 'actions-runner-maws/.env')), expected);
    assert.equal(text(join(f.guest, '.ci-kit/quarantined-apps')), '/Applications/Extra App.app\n/Applications/LibreOffice.app\n');
    assert.match(result.stdout, /\/Applications\/LibreOffice.app/);
    assert.match(result.stdout, /\/Applications\/Extra App.app/);
    assert.equal(existsSync(join(f.guest, 'maws-setup')), false, 'scratch removed after success');
    assert.equal(f.state(CANDIDATE), 'stopped');
    // A job consumes the final runner environment, not the provisioning process's transient environment.
    rmSync(join(f.maws, 'dirty'));
    const imageEnv = Object.fromEntries(expected.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    const job = () => spawnSync(process.execPath, [join(f.kit, 'setup/apply.mjs'), '--root', f.maws], {
      encoding: 'utf8', env: { ...imageEnv, HOME: f.guest, PATH: `${f.guest}/bin:/usr/bin:/bin`,
        CI_KIT_SETUP_BREW: join(f.guest, 'bin/brew'), CI_KIT_SETUP_XATTR: join(f.guest, 'bin/xattr') },
    });
    const matched = job();
    assert.equal(matched.status, 0, matched.stdout + matched.stderr);
    assert.match(matched.stdout, /image matches setup bdcec72c1fa875b3/);
    assert.match(matched.stdout, /installed nothing/);
    const config = join(f.maws, '.github/ci-kit.yml');
    writeFileSync(config, readFileSync(config, 'utf8').replace('brew: [poppler]', 'brew: [poppler, hello]'));
    const stale = job();
    assert.equal(stale.status, 0, stale.stdout + stale.stderr);
    assert.match(stale.stdout, /::notice::.*image setup bdcec72c1fa875b3 differs from commit setup [a-f0-9]{16}/);
    assert.match(stale.stdout, /installed brew:hello/);
  });

  test('a declaration-free checkout keeps the legacy bake and leaves no setup hash', () => {
    for (const config of [null, 'version: 1\ngates:\n  - name: test\n    run: echo ok\n']) {
      const f = setupBakeFixture();
      if (config === null) f.git('rm', '.github/ci-kit.yml');
      else writeFileSync(join(f.maws, '.github/ci-kit.yml'), config);
      f.git('commit', '-qam', 'no declaration');
      writeFileSync(join(f.guest, '.ci-kit/setup-hash'), 'old-setup-hash\n');
      const result = f.run(['--bake', '--name', CANDIDATE]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /no setup declaration; skipping setup/);
      assert.equal(text(join(f.guest, '.ci-kit/setup-hash')), null);
      assert.equal(text(join(f.guest, '.ci-kit/quarantined-apps')), null);
      assert.equal(text(join(f.guest, 'setup-calls')), null);
      assert.equal(text(join(f.guest, 'actions-runner-maws/.env')), `LANG=en_US.UTF-8
ACTIONS_RUNNER_HOOK_JOB_STARTED=${f.guest}/ci-kit/vm/guest/hooks/job-started.sh
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${f.guest}/ci-kit/vm/guest/hooks/job-completed.sh
CI_KIT_MACHINE=mini-vm
CI_KIT_VM_GUEST=1
`);
      assert.ok(result.stdout.includes(join(f.guest, 'LibreOffice.app')));
      assert.doesNotMatch(result.stdout, /Extra App.app/);
      assert.equal(f.state(CANDIDATE), 'stopped');
    }
  });

  test('home-relative Homebrew app artifacts are expanded before quarantine inspection and recording', () => {
    const f = setupBakeFixture();
    const brew = join(f.guest, 'bin/brew');
    writeFileSync(brew, readFileSync(brew, 'utf8').replaceAll('/Applications/Extra App.app', '~/Applications/Extra App.app'));
    executable(join(f.guest, 'bin/xattr'), `printf '%s\\n' "$*" >> "$HOME/xattr-calls"
if [[ $1 == -p ]]; then echo '0181;date;Homebrew;uuid'; else echo com.apple.quarantine; fi`);
    const result = f.runProvision('setup');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(text(join(f.guest, '.ci-kit/quarantined-apps')), `/Applications/LibreOffice.app\n${f.guest}/Applications/Extra App.app\n`);
    assert.ok(text(join(f.guest, 'xattr-calls')).split('\n').includes(`${f.guest}/Applications/Extra App.app`));
    assert.doesNotMatch(text(join(f.guest, 'xattr-calls')), /~\//);
  });

  test('a failed declaration stops the bake, cleans its clone and records no successful setup hash', () => {
    const f = setupBakeFixture();
    writeFileSync(join(f.guest, 'fail-script'), '');
    const result = f.run(['--bake', '--name', CANDIDATE]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /setup.script.*failed/);
    assert.equal(text(join(f.guest, '.ci-kit/setup-hash')), null);
    assert.equal(text(join(f.guest, 'setup-calls')), null);
    assert.equal(existsSync(join(f.guest, 'maws-setup')), false);
    assert.equal(f.state(CANDIDATE), 'stopped');
    assert.ok(!f.exec(CANDIDATE).some((call) => /provision.sh runner/.test(call)));
  });
});

// Execute the actual first-run shell in a scratch guest; only external tools and the guest's absolute paths are fake.
function firstRunFixture() {
  const f = fixture();
  const guest = join(f.home, 'guest');
  for (const dir of ['bin', 'runner-bin', 'share', 'LibreOffice.app', 'actions-runner-maws', '.ci-kit']) mkdirSync(join(guest, dir), { recursive: true });
  writeFileSync(join(guest, 'share/package.json'), '{}');
  writeFileSync(join(guest, 'share/pnpm-lock.yaml'), 'lockfileVersion: 9');
  writeFileSync(join(guest, 'actions-runner-maws/.path'), `${guest}/runner-bin:${guest}/bin:/usr/bin:/bin\n`);
  writeFileSync(join(guest, '.ci-kit/quarantined-apps'), `${guest}/LibreOffice.app\n`);
  writeFileSync(join(guest, 'quarantine'), '01c1;6718b124;Homebrew Cask;uuid\n');
  executable(join(guest, 'bin/xattr'), `if [[ $1 == -p ]]; then cat "$HOME/quarantine"; else [[ ! -f $HOME/quarantine ]] || echo com.apple.quarantine; fi`);
  executable(join(guest, 'bin/git'), `printf 'git %s\\n' "$*" >> "$HOME/commands"
[[ $1 == -c && $2 == 'safe.directory=*' && $3 == clone && $4 == "$HOME/share" && $5 == "$HOME/maws-firstrun" ]] || exit 64
if [[ -f $HOME/previous.pids ]]; then
  while IFS= read -r pid; do
    state=$(/bin/ps -p "$pid" -o stat=)
    [[ -z $state || $state == Z* ]] || { echo "previous scratch process $pid still runs before clone" >&2; exit 65; }
  done < "$HOME/previous.pids"
fi
mkdir "$5" || exit 1
if [[ -e $HOME/pause-before-cd ]]; then
  pwd > "$HOME/precd.cwd"
  echo "$PPID" > "$HOME/precd.pid"
  echo "$$" > "$HOME/precd.git.pid"
  kill -STOP "$PPID"
fi
if [[ -e $HOME/detach-group ]]; then
  cat > "$5/detached-child" <<'CHILD'
trap '' TERM
echo $$ > "$HOME/detached.pid"
while :; do sleep 1; done
CHILD
fi`);
  executable(join(guest, 'runner-bin/pnpm'), `printf 'pnpm %s NODE_OPTIONS=%s PATH=%s\\n' "$*" "\${NODE_OPTIONS-unset}" "$PATH" >> "$HOME/commands"
[[ -d $HOME/maws-firstrun ]] || exit 64
if [[ $1 == install ]]; then
  [[ $2 == --frozen-lockfile ]] || exit 64
  [[ ! -e $HOME/fail-install ]] || exit 17
else
  [[ $1 == e2e:deliverables && \${NODE_OPTIONS:-} == --max-old-space-size=3072 ]] || exit 64
  if [[ -e $HOME/detach-group ]]; then
    /usr/bin/perl -MPOSIX=setsid -e 'setsid() or die; exec "/bin/bash", @ARGV' "$HOME/maws-firstrun/detached-child" </dev/null >/dev/null 2>&1 &
    until [[ -s $HOME/detached.pid ]]; do sleep 0.05; done
  fi
  echo 'deliverables: running'
  if [[ -e $HOME/pause-group ]]; then
    touch "$HOME/group-started"
    until [[ -e $HOME/group-go ]]; do sleep 0.05; done
  fi
  [[ ! -e $HOME/fail-group ]] || exit 18
  echo 'deliverables: 12/12'
fi`);
  f.vm(CANDIDATE, 'running');
  return { ...f, guest, commands: () => text(join(guest, 'commands')) ?? '' };
}

describe('the first-run shell (bake.sh --first-run)', macOnly, () => {
  test('refuses a non-candidate, a stopped or missing VM, an unanswered agent, a missing share and unapproved LibreOffice', () => {
    const cases = [
      [() => {}, GOLDEN, /refused:.*maws-vm-candidate/],
      [(f) => f.vm(CANDIDATE, 'stopped'), CANDIDATE, /refused:.*not running.*tart run/],
      [(f) => rmSync(join(f.vms, CANDIDATE), { recursive: true }), CANDIDATE, /refused:.*not running.*tart run/],
      [(f) => f.flag('no-agent'), CANDIDATE, /refused:.*guest agent.*answer/],
      [(f) => rmSync(join(f.guest, 'share'), { recursive: true }), CANDIDATE, /refused:.*MAWS share.*mounted/],
      [(f) => writeFileSync(join(f.guest, 'quarantine'), '0181;6718b124;Homebrew Cask;uuid\n'), CANDIDATE,
        /refused:.*LibreOffice.*guest.s window.*first-run/],
      [(f) => writeFileSync(join(f.guest, 'quarantine'), 'garbled\n'), CANDIDATE, /refused:.*quarantine.*read/],
    ];
    for (const [arrange, name, message] of cases) {
      const f = firstRunFixture();
      arrange(f);
      const result = f.run(['--first-run', name]);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, message);
      assert.equal(f.commands(), '', 'no clone or pnpm before the checks');
      assert.ok(!f.calls().some((call) => /sudo|^stop /.test(call)), 'a refusal leaves the guest up');
    }
  });

  test('checks every recorded app, including spaces, before running any repository code', () => {
    const f = firstRunFixture();
    writeFileSync(join(f.guest, '.ci-kit/quarantined-apps'), `${f.guest}/LibreOffice.app\n/Applications/Extra App.app\n`);
    executable(join(f.guest, 'bin/xattr'), `
if [[ $1 != -p ]]; then echo com.apple.quarantine
elif [[ $3 == '/Applications/Extra App.app' ]]; then echo '0181;date;Homebrew;uuid'
else echo '01c1;date;Homebrew;uuid'; fi`);
    const result = f.run(['--first-run', CANDIDATE]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Extra App.app.*not user-approved/);
    assert.equal(f.commands(), '');
    assert.equal(f.state(CANDIDATE), 'running');
  });

  test('without a declaration record first-run still requires LibreOffice approval by name', () => {
    const f = firstRunFixture();
    rmSync(join(f.guest, '.ci-kit/quarantined-apps'));
    writeFileSync(join(f.guest, 'quarantine'), '0181;date;Homebrew;uuid\n');
    const blocked = f.run(['--first-run', CANDIDATE]);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stdout + blocked.stderr, /LibreOffice.app.*not user-approved/);
    assert.equal(f.commands(), '');
    writeFileSync(join(f.guest, 'quarantine'), '01c1;date;Homebrew;uuid\n');
    const approved = f.run(['--first-run', CANDIDATE]);
    assert.equal(approved.status, 0, approved.stdout + approved.stderr);
    assert.match(f.commands(), /pnpm e2e:deliverables/);
  });

  test('runs on the runner PATH with the heap raised, streams output before completion, removes the clone and verifies shutdown', async () => {
    const f = firstRunFixture();
    writeFileSync(join(f.guest, 'pause-group'), '');
    const run = f.start(['--first-run', CANDIDATE]);
    await f.until(() => run.output().includes('deliverables: running'), 'streamed group output');
    assert.ok(existsSync(join(f.guest, 'maws-firstrun')), 'the clone is present while the group runs');
    writeFileSync(join(f.guest, 'group-go'), '');
    assert.equal(await run.exited, 0, run.output());
    assert.match(f.commands(), /pnpm install --frozen-lockfile/);
    assert.match(f.commands(), /pnpm e2e:deliverables NODE_OPTIONS=--max-old-space-size=3072 PATH=.*guest\/runner-bin:/);
    assert.match(run.output(), /deliverables: 12\/12/);
    assert.equal(existsSync(join(f.guest, 'maws-firstrun')), false);
    const calls = f.calls();
    const shutdown = calls.indexOf(`exec ${CANDIDATE} sudo -n /sbin/shutdown -h now`);
    assert.ok(shutdown >= 0 && calls.slice(shutdown + 1).includes('list --format json'), calls.join('\n'));
    assert.equal(f.state(CANDIDATE), 'stopped');
    assert.match(run.output(), /its end is verified/);
    assert.match(f.log(), /deliverables: 12\/12/);
  });

  test('install and group failures remove the clone, leave the guest running and say how to retry', () => {
    for (const fail of ['fail-install', 'fail-group']) {
      const f = firstRunFixture();
      writeFileSync(join(f.guest, fail), '');
      const result = f.run(['--first-run', CANDIDATE]);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.equal(existsSync(join(f.guest, 'maws-firstrun')), false);
      assert.equal(f.state(CANDIDATE), 'running');
      assert.ok(!f.calls().some((call) => /sudo|^stop /.test(call)), f.calls().join('\n'));
      assert.match(result.stderr, /stays running.*inspect.*--first-run/);
      if (fail === 'fail-install') assert.doesNotMatch(f.commands(), /pnpm e2e/);
    }
  });

  test('a zero deadline is refused rather than leaving the guest work unbounded', () => {
    const f = firstRunFixture();
    const result = f.run(['--first-run', CANDIDATE], { extra: { CI_KIT_VM_FIRST_RUN_WAIT: '0' } });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /FIRST_RUN_WAIT.*positive/);
    assert.equal(f.commands(), '');
  });

  test('an expired guest deadline removes the clone without shutting down', () => {
    const f = firstRunFixture();
    writeFileSync(join(f.guest, 'pause-group'), '');
    const result = f.run(['--first-run', CANDIDATE], { extra: { CI_KIT_VM_FIRST_RUN_WAIT: '1' } });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /124|timed out/);
    assert.equal(existsSync(join(f.guest, 'maws-firstrun')), false);
    assert.equal(f.state(CANDIDATE), 'running');
    assert.ok(!f.calls().some((call) => /sudo|^stop /.test(call)));
  });

  test('a deadline kills a detached Electron-shaped child before removing the clone', () => {
    const f = firstRunFixture();
    writeFileSync(join(f.guest, 'detach-group'), '');
    writeFileSync(join(f.guest, 'pause-group'), '');
    let pid;
    try {
      const result = f.run(['--first-run', CANDIDATE], { extra: { CI_KIT_VM_FIRST_RUN_WAIT: '1' } });
      pid = Number(text(join(f.guest, 'detached.pid')));
      assert.ok(pid > 0, 'the group started its detached child');
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.equal(spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim().replace(/^Z.*/, ''), '', 'detached child is gone, even though it ignored TERM');
      assert.equal(existsSync(join(f.guest, 'maws-firstrun')), false, result.stdout + result.stderr);
      assert.equal(f.state(CANDIDATE), 'running');
    } finally {
      if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    }
  });

  test('a rerun removes the previous scratch and kills both argv and cwd-only survivors before cloning', async () => {
    const f = firstRunFixture();
    const work = join(f.guest, 'maws-firstrun');
    mkdirSync(work);
    writeFileSync(join(work, 'leftover'), 'old run');
    const byArgv = spawn('/bin/bash', ['-c', 'trap "" TERM; echo ready; while :; do sleep 1; done', `${work}/old-electron`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const byCwd = spawn('/bin/sleep', ['600'], { cwd: work, detached: true, stdio: 'ignore' });
    children.add(byArgv); children.add(byCwd);
    const argvExit = once(byArgv, 'exit');
    const cwdExit = once(byCwd, 'exit');
    await once(byArgv.stdout, 'data');
    writeFileSync(join(f.guest, 'previous.pids'), `${byArgv.pid}\n${byCwd.pid}\n`);
    try {
      const run = f.start(['--first-run', CANDIDATE]);
      assert.equal(await run.exited, 0, run.output());
      assert.notEqual(byArgv.exitCode === null && byArgv.signalCode === null, true, 'argv survivor stopped');
      assert.notEqual(byCwd.exitCode === null && byCwd.signalCode === null, true, 'cwd-only survivor stopped');
      await Promise.all([argvExit, cwdExit]);
      assert.match(run.output(), /cleaning.*scratch.*previous run/);
      assert.match(f.commands(), /pnpm e2e:deliverables/);
      assert.equal(existsSync(work), false);
    } finally {
      for (const child of [byArgv, byCwd]) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        children.delete(child);
      }
    }
  });

  test('a cancelled workload paused before cd is recovered while its cwd is still HOME', async () => {
    const f = firstRunFixture();
    writeFileSync(join(f.guest, 'isolated-exec'), '');
    writeFileSync(join(f.guest, 'pause-before-cd'), '');
    const stat = (pid) => spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
    let workload, supervisor, outer;
    const interrupted = f.start(['--first-run', CANDIDATE]);
    try {
      await f.until(() => {
        workload = Number(text(join(f.guest, 'precd.pid')));
        const clone = Number(text(join(f.guest, 'precd.git.pid')));
        return workload > 0 && clone > 0 && stat(workload).startsWith('T') && /^(?:Z.*)?$/.test(stat(clone));
      }, 'workload stopped after clone and before cd');
      supervisor = Number(spawnSync('/bin/ps', ['-p', String(workload), '-o', 'ppid='], { encoding: 'utf8' }).stdout.trim());
      outer = Number(text(join(f.guest, 'exec.pid')));
      assert.ok(supervisor > 0 && outer > 0);
      assert.equal(text(join(f.guest, 'precd.cwd')).trim(), f.guest, 'the clone ran from HOME, not the scratch');
      assert.ok(existsSync(join(f.guest, 'maws-firstrun')), 'clone returned with its directory created');
      // tart-guest-agent cancels the RPC by killing the outer shell, not its detached workload.
      process.kill(outer, 'SIGKILL');
      assert.notEqual(await interrupted.exited, 0, interrupted.output());
      assert.ok(stat(workload).startsWith('T'), 'the paused workload outlived its exec');
      rmSync(join(f.guest, 'pause-before-cd'));
      writeFileSync(join(f.guest, 'previous.pids'), `${workload}\n${supervisor}\n`);
      const retry = f.start(['--first-run', CANDIDATE]);
      assert.equal(await retry.exited, 0, retry.output() + '\n' + spawnSync('/usr/sbin/lsof', [join(f.logs, 'vm-lane.lock')], { encoding: 'utf8' }).stdout);
      for (const pid of [workload, supervisor]) assert.match(stat(pid), /^(?:Z.*)?$/, `prior process ${pid} is gone`);
      assert.equal(existsSync(join(f.guest, 'maws-firstrun')), false);
      assert.equal(f.state(CANDIDATE), 'stopped');
    } finally {
      if (workload > 0) { try { process.kill(-workload, 'SIGKILL'); } catch {} }
      for (const pid of [outer, supervisor]) {
        if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    }
  });

  test('no quarantine attribute is allowed; a failed verified stop is not reported as success', () => {
    const f = firstRunFixture();
    rmSync(join(f.guest, 'quarantine'));
    f.flag('shutdown-stays-up');
    f.flag('fail-stop');
    const result = f.run(['--first-run', CANDIDATE], { extra: { CI_KIT_VM_END_WAIT: '0' } });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /end cannot be verified/);
    assert.equal(existsSync(join(f.guest, 'maws-firstrun')), false);
  });
});

// The trials run one at a time: a trial clone is named after the second it starts, and Tart's VMs, like the process
// table its runs are read from, are the machine's, so two trials in one second would read each other's run.
describe('the trial (bake.sh --trial)', macOnly, () => {
  test('--trial: unfit that stays powered on is stopped at the power-off bound, not the idle bound', async () => {
    const f = fixture({ env: { CI_KIT_VM_END_WAIT: '2', CI_KIT_VM_TRIAL_IDLE: '1800' } });
    f.vm(CANDIDATE);
    f.identity('vm-trial');
    const trial = f.start(['--trial', CANDIDATE]);
    await f.until(() => trialClone(f) && existsSync(join(f.vms, trialClone(f), 'kicked')), 'the trial clone kicked off');
    const clone = trialClone(f);
    f.mark('unfit', 'the display mode cannot be read');
    await f.until(() => f.record() !== null, 'unfit trial ended at the power-off bound', 15_000);
    assert.equal(await trial.exited, 0, trial.output());
    const record = f.record();
    assert.equal(record.why, 'the guest started no runner: the display mode cannot be read');
    assert.equal(record.job, '');
    assert.equal(record.conclusion, '');
    assert.equal(f.state(clone), null, 'the stopped trial clone is deleted');
    assert.ok(f.calls().some((call) => call.startsWith(`stop ${clone} `)));
    assert.equal(existsSync(join(record.out, 'stop-request')), false, 'no wrapper can answer an idle stop');
    assert.equal(text(join(record.out, 'unfit')), 'the display mode cannot be read\n');
    assert.ok(!f.ghCalls().some((call) => call[1]?.includes('/jobs?')), 'no job result to fetch');
  });

  test('--trial: a clone of the candidate with its own JIT registration, never the production one; the job read through gh; the record binds candidate, run, job and success', async () => {
    const f = fixture();
    f.vm(CANDIDATE);
    f.identity('vm');
    f.identity('vm-trial');
    const trial = f.start(['--trial', CANDIDATE]);
    await f.until(() => trialClone(f) && existsSync(join(f.vms, trialClone(f), 'kicked')), 'the trial clone kicked off');
    const clone = trialClone(f);
    assert.match(clone, /^maws-vm-trial-\d{8}T\d{6}Z$/);
    assert.deepEqual(JSON.parse(text(join(f.home, 'gh/jit-request.json'))), {
      name: `ci-kit-mac-mini-${clone}`, runner_group_id: 1, labels: ['ci-kit-mac-vm-trial'], work_folder: '_work',
    });
    assert.equal(statSync(join(f.vmHome, 'vm-trial/jit', clone, 'config')).mode & 0o777, 0o600);
    assert.equal(text(join(f.vms, clone, 'source')).trim(), CANDIDATE);
    const args = text(join(f.vms, clone, 'run.args')).trim().split('\n');
    assert.deepEqual(args, ['--no-graphics', '--no-clipboard', `--dir=kit:${mac}:ro`, `--dir=jit:${f.vmHome}/vm-trial/jit/${clone}:ro`,
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
      { id: 4242, runner_name: `ci-kit-mac-mini-${clone}`, status: 'completed', conclusion: 'success', started_at: started },
      { id: 4100, runner_name: `ci-kit-mac-mini-${clone}`, status: 'completed', conclusion: 'failure', started_at: '2026-10-21T09:00:00Z' },
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
    assert.ok(!existsSync(join(f.vmHome, 'vm-trial/jit', clone)));
    assert.ok(f.ghCalls().some((call) => call.includes('DELETE') && call[1].endsWith('/71')));
    assert.ok(!f.log().includes('fixture-trial-jit'));
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
    f.jobs(9, 1, [{ id: 5151, runner_name: `ci-kit-mac-mini-${clone}`, status: 'completed', conclusion: 'failure', started_at: iso() }]);
    f.mark('assigned', 'job=abc at=2026-10-22T09:11:00Z by=diag');
    f.mark('job', 'run=9 attempt=1 job=e2e repository=SSFSKIM/MAWS at=2026-10-22T09:11:30Z');
    assert.equal(await trial.exited, 0, trial.output());
    assert.match(trial.output(), /its job outlived 0\.05 min/);
    assert.ok(f.calls().includes(`stop ${clone} --timeout 5`));
    assert.equal(f.record().job, '5151');
    assert.equal(f.record().conclusion, 'failure');
    assert.match(f.run(['--promote', CANDIDATE]).stderr, /refused: the trial job 5151 concluded failure, not success/);
  });

  test('--trial: refused for a running or missing candidate, and a kickoff that fails is recorded with no job', () => {
    const f = fixture();
    f.vm(CANDIDATE);
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
    if [[ -f $d/partitions ]]; then
      while read -r content device bytes; do part "$content" "$device" "$bytes"; done < "$d/partitions"
    else
      part Apple_APFS_ISC disk0s1 "$isc"
      part Apple_APFS disk0s2 "$(size apfs-size)"
      [[ ! -f $d/recovery-size ]] || part Apple_APFS_Recovery disk0s3 "$(size recovery-size)"
    fi
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

  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Bake test', GIT_AUTHOR_EMAIL: 'bake@example.invalid',
      GIT_COMMITTER_NAME: 'Bake test', GIT_COMMITTER_EMAIL: 'bake@example.invalid' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const mawsShare = (g) => {
    const source = join(g.shares, 'maws');
    mkdirSync(source);
    git(source, 'init', '-b', 'master');
    writeFileSync(join(source, 'tracked'), 'first\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'first');
    writeFileSync(join(source, 'tracked'), 'master\n');
    git(source, 'commit', '-qam', 'master');
    // Neither the host's credentials/config nor its dirty or ignored files belong in the image.
    git(source, 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: host-secret');
    git(source, 'config', 'core.hooksPath', '/host/hooks');
    writeFileSync(join(source, 'tracked'), 'host edits\n');
    writeFileSync(join(source, 'untracked'), 'host scratch\n');
    return source;
  };

  for (const configured of [null, 'custom work', 'absolute']) {
    test(`workrepo: a self-contained shallow master in the runner's ${configured ?? 'default'} work folder survives checkout v7's preparation and a repeat bake`, () => {
      const g = guest();
      const source = mawsShare(g);
      const work = configured === 'absolute' ? join(g.home, 'absolute work') : configured ?? '_work';
      if (configured) writeFileSync(join(g.runner, '.runner'), `﻿${JSON.stringify({ workFolder: work })}`);
      const repo = join(configured === 'absolute' ? work : join(g.runner, work), 'MAWS/MAWS');
      const result = g.run(['workrepo']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /MAWS work repository.*master.*KiB/);
      assert.equal(git(repo, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'master'));
      assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1');
      assert.equal(git(repo, 'rev-parse', '--is-shallow-repository'), 'true');
      assert.equal(text(join(repo, 'tracked')), 'master\n');
      assert.equal(existsSync(join(repo, 'untracked')), false);
      assert.equal(git(repo, 'status', '--porcelain'), '');
      assert.ok(statSync(join(repo, '.git')).isDirectory());
      assert.equal(git(repo, 'config', '--local', '--get', 'remote.origin.url'), 'https://github.com/SSFSKIM/MAWS');
      assert.doesNotMatch(text(join(repo, '.git/config')), /host-secret|extraheader|hooksPath|shares|file:/);
      assert.equal(existsSync(join(repo, '.git/objects/info/alternates')), false);
      for (const lock of ['index.lock', 'shallow.lock', 'config.lock']) assert.equal(existsSync(join(repo, '.git', lock)), false);
      // checkout v7 detaches, removes local branches, then cleans and resets. Keep the repository, not just its tree.
      const objectDir = statSync(join(repo, '.git/objects')).ino;
      git(repo, 'checkout', '--detach');
      git(repo, 'branch', '-D', 'master');
      git(repo, 'submodule', 'status');
      git(repo, 'clean', '-ffdx');
      git(repo, 'reset', '--hard', 'HEAD');
      assert.equal(git(repo, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'master'));
      assert.equal(statSync(join(repo, '.git/objects')).ino, objectDir);
      writeFileSync(join(repo, 'job-leftover'), 'gone on rebake\n');
      assert.equal(g.run(['workrepo']).status, 0);
      assert.equal(existsSync(join(repo, 'job-leftover')), false);
      // With the bake-only share gone, reset and fsck still need nothing from the host.
      rmSync(source, { recursive: true });
      git(repo, 'reset', '--hard', 'HEAD');
      git(repo, 'fsck', '--full');
      assert.equal(text(join(repo, 'tracked')), 'master\n');
    });
  }

  test('workrepo: a missing master or invalid runner work-folder configuration fails the bake', () => {
    const g = guest();
    const source = mawsShare(g);
    git(source, 'branch', '-m', 'other');
    assert.notEqual(g.run(['workrepo']).status, 0);
    git(source, 'branch', '-m', 'master');
    writeFileSync(join(g.runner, '.runner'), JSON.stringify({ workFolder: '' }));
    const result = g.run(['workrepo']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /workFolder/);
  });

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

  test('engine: Claude Code already at the version through the installer\'s link is left as it is; a malformed version, or another layout, fails', () => {
    const g = guest();
    const versions = join(g.home, '.local/share/claude/versions');
    for (const dir of [versions, join(g.home, '.local/bin')]) mkdirSync(dir, { recursive: true });
    executable(join(versions, '2.1.309'), "echo '2.1.309 (Claude Code)'");
    symlinkSync(join(versions, '2.1.309'), join(g.home, '.local/bin/claude'));
    const result = g.run(['engine', '2.1.309']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /provision: Claude Code 2\.1\.309 at \S+\/\.local\/bin\/claude/);
    assert.match(g.run(['engine', 'latest']).stderr, /provision: engine takes Claude Code's version \(got 'latest'\)/);
    const copied = guest();
    mkdirSync(join(copied.home, '.local/bin'), { recursive: true });
    executable(join(copied.home, '.local/bin/claude'), "echo '2.1.309 (Claude Code)'");
    const refused = copied.run(['engine', '2.1.309']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /is not the native installer's link to version 2\.1\.309 \(not a link\)/);
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

  for (const order of [
    ['Apple_APFS_ISC', 'Apple_APFS', 'Apple_HFS', 'Apple_APFS_Recovery'],
    ['Apple_APFS_ISC', 'Apple_APFS', 'Apple_APFS_Recovery', 'Apple_HFS'],
    ['Apple_APFS_ISC', 'Apple_APFS_Recovery', 'Apple_APFS'],
    ['Apple_APFS_ISC', 'Apple_APFS', 'Apple_APFS_Recovery', 'Apple_APFS_Recovery'],
  ]) {
    test(`disk: unsupported partition order ${order.join(', ')} is refused before any disk change`, () => {
      const g = guest();
      writeFileSync(join(g.home, 'partitions'), order.map((content, i) => `${content} disk0s${i + 1} ${content === 'Apple_APFS' ? 44107026944 : 524288000}`).join('\n') + '\n');
      const result = g.run(['disk', '60']);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /unsupported.*layout/i);
      for (const content of order) assert.ok(result.stderr.includes(content), result.stderr);
      assert.deepEqual(g.diskCalls(), ['list -plist physical'], 'no erase, delete, repair or resize on an unsupported layout');
      assert.ok(existsSync(join(g.home, 'recovery-size')), 'the recovery container remains');
    });
  }

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

// quiet uses only command boundaries, so these guest tests run on Linux CI too. The fake keeps launchd's persistent
// overrides separate from its loaded services: disabling alone must not stand in for bootout, or vice versa.
describe('the quiet image (provision.sh quiet)', () => {
  const gui = [
    'BiomeAgent', 'assistantd', 'biomesyncd', 'chronod', 'corespotlightd', 'duetexpertd', 'intelligencecontextd',
    'jetpackassetd', 'knowledge-agent', 'managedcorespotlightd', 'mediaanalysisd', 'passd', 'photoanalysisd',
    'remindd', 'siriinferenced', 'siriknowledged', 'spotlightknowledged', 'suggestd', 'triald',
  ].map((name) => `gui/${process.getuid()}/com.apple.${name}`);
  const system = ['AssetCacheTetheratorService', 'PerfPowerServices', 'audioanalyticsd'].map((name) => `system/com.apple.${name}`);
  const targets = [...gui, ...system];
  const indexing = '/:\n\tIndexing disabled.\n/System/Volumes/Data:\n\tIndexing disabled.\n/System/Volumes/Preboot:\n\tIndexing disabled.\n';
  function guest({ absent = [], states = 'disabled' } = {}) {
    const home = mkdtempSync(join(root, 'quiet-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(home, 'index-status'), indexing);
    for (const target of targets.filter((target) => !absent.includes(target))) writeFileSync(join(home, `loaded-${target.replaceAll('/', '_')}`), '');
    executable(join(bin, 'sudo'), `[[ $1 == -n ]] || exit 64
shift
[[ ! -e $HOME/sudo-fail ]] || exit 1
CI_TEST_ROOT=1 exec "$@"`);
    executable(join(bin, 'mdutil'), `echo "mdutil $*" >> "$HOME/calls"
case "$*" in
  '-a -i off') [[ $CI_TEST_ROOT == 1 && ! -e $HOME/mdutil-fail ]] || exit 1; touch "$HOME/index-off" ;;
  '-a -s') [[ -e $HOME/index-off && ! -e $HOME/status-fail ]] || exit 1; cat "$HOME/index-status" ;;
  *) exit 64 ;;
esac`);
    executable(join(bin, 'launchctl'), `echo "launchctl $*" >> "$HOME/calls"
command=$1 target=$2
if [[ $target == system* ]]; then [[ $CI_TEST_ROOT == 1 ]] || exit 64
else [[ -z $CI_TEST_ROOT ]] || exit 64; fi
key=$(echo "$target" | tr / _)
[[ ! -e $HOME/$command-fail ]] || exit 5
case $command in
  disable) [[ -e $HOME/disable-stuck ]] || touch "$HOME/disabled-$key" ;;
  print) [[ -e $HOME/loaded-$key ]] || exit 113; echo "$target = { state = running }" ;;
  bootout)
    [[ ! -e $HOME/bootout-race ]] || { rm -f "$HOME/loaded-$key"; exit 3; }
    [[ -e $HOME/loaded-$key ]] || exit 3
    rm "$HOME/loaded-$key" ;;
  print-disabled)
    echo 'disabled services = {'
    for file in "$HOME/disabled-$key"_*; do
      [[ -e $file ]] || continue
      label=$(basename "$file" | sed -E 's/^disabled-(system|gui_[0-9]+)_//')
      [[ ! -e $HOME/wrong-label ]] || label="$label.extra"
      printf '  "%s" => %s\\n' "$label" '${states}'
    done
    echo '}' ;;
  *) exit 64 ;;
esac`);
    const env = { HOME: home, PATH: '/usr/bin:/bin', CI_KIT_VM_SUDO: join(bin, 'sudo'),
      CI_KIT_VM_MDUTIL: join(bin, 'mdutil'), CI_KIT_VM_LAUNCHCTL: join(bin, 'launchctl') };
    return {
      home,
      run: () => spawnSync('/bin/bash', [provision, 'quiet'], { encoding: 'utf8', env }),
      flag: (name) => writeFileSync(join(home, name), ''),
      calls: () => (text(join(home, 'calls')) ?? '').trim().split('\n'),
    };
  }

  test('disables indexing and exactly the measured services in their own domains, boots them out, and is repeatable', () => {
    const g = guest();
    const first = g.run();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.deepEqual(g.calls().filter((call) => call.startsWith('mdutil ')), ['mdutil -a -i off', 'mdutil -a -s']);
    assert.deepEqual(g.calls().filter((call) => call.startsWith('launchctl disable ')), targets.map((target) => `launchctl disable ${target}`));
    assert.deepEqual(g.calls().filter((call) => call.startsWith('launchctl bootout ')), targets.map((target) => `launchctl bootout ${target}`));
    for (const target of targets) {
      const key = target.replaceAll('/', '_');
      assert.ok(existsSync(join(g.home, `disabled-${key}`)), target);
      assert.ok(!existsSync(join(g.home, `loaded-${key}`)), target);
    }
    const again = g.run();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(g.calls().filter((call) => call.startsWith('launchctl bootout ')).length, targets.length, 'no bootout of an unloaded service');
  });

  test('a missing label still gets a verified persistent override; a service disappearing during bootout is already done', () => {
    const g = guest({ absent: [gui[0], system[0]], states: 'true' });
    g.flag('bootout-race');
    const result = g.run();
    assert.equal(result.status, 0, result.stderr);
    for (const target of [gui[0], system[0]]) {
      assert.ok(g.calls().includes(`launchctl disable ${target}`));
      assert.ok(!g.calls().includes(`launchctl bootout ${target}`));
      assert.match(result.stdout, new RegExp(target.replaceAll('.', '\\.')));
    }
  });

  test('accepts a readback without Preboot, which mdutil reports only while it is mounted (the first bake read two)', () => {
    const g = guest();
    writeFileSync(join(g.home, 'index-status'), '/:\n\tIndexing disabled.\n/System/Volumes/Data:\n\tIndexing disabled.\n');
    const result = g.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(g.calls().includes(`launchctl disable ${gui[0]}`));
  });

  for (const [why, output] of [
    ['one volume still enabled', indexing.replace('Preboot:\n\tIndexing disabled.', 'Preboot:\n\tIndexing enabled.')],
    ['no volumes', ''],
    ['missing the data volume', '/:\n\tIndexing disabled.\n/System/Volumes/Preboot:\n\tIndexing disabled.\n'],
    ['missing the system volume', '/System/Volumes/Data:\n\tIndexing disabled.\n'],
    ['unknown status', indexing + '/Volumes/Other:\n\tError: unable to perform operation.\n'],
  ]) test(`refuses indexing readback with ${why}`, () => {
    const g = guest();
    writeFileSync(join(g.home, 'index-status'), output);
    const result = g.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /indexing.*disabled/i);
    assert.ok(!g.calls().some((call) => call.startsWith('launchctl disable ')), 'no launchd changes after failed indexing verification');
  });

  for (const flag of ['sudo-fail', 'mdutil-fail', 'status-fail', 'disable-fail', 'disable-stuck', 'print-fail', 'bootout-fail', 'print-disabled-fail', 'wrong-label']) {
    test(`refuses ${flag}, rather than claiming a quiet image`, () => {
      const g = guest();
      g.flag(flag);
      const result = g.run();
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /provision:/);
    });
  }
  test('an enabled launchd override does not pass the disabled readback', () => {
    const g = guest({ states: 'enabled' });
    const result = g.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /not disabled/);
  });
});
