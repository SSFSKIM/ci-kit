import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminal } from './fake-mac-desktop.mjs';

// The VM lane's host side in the job hooks (mac/hooks/vm-claim.sh, job-started.sh, job-completed.sh): on a Mac with
// the lane installed, the exclusive instance's job is classified by its workflow's contract line, and a job of unknown
// kind raises a claim that keeps the guest from booting, waits until no guest runs, and keeps the claim to its end hook.
// Each job is a stand-in Runner.Worker (worker.sh below), a real process, so the hooks name it by its pid and start
// time; the desktop, the posture read, the sweep and gh are faked, the lock, the markers and the processes are real.
const hooks = fileURLToPath(new URL('../mac/hooks/', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-kit-vm-claim-')));
after(() => rmSync(root, { recursive: true, force: true }));
const hookFiles = ['job-started.sh', 'job-completed.sh', 'desktop-check.sh', 'desktop-posture.sh', 'dialog.sh', 'dialog-watch.sh',
  'runner-hold.sh', 'runner-state.py', 'sweep.mjs', 'strays.mjs', 'terminate.mjs', 'instances.sh', 'shared-hold.sh', 'desktop-lock.sh',
  'vm-claim.sh'];
const executable = (path, body) => { writeFileSync(path, `#!/bin/bash\n${body}\n`); chmodSync(path, 0o755); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, what, ms = 20_000) {
  for (let waited = 0; !predicate(); waited += 25) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const lstart = (pid) => spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } }).stdout.trim();
const claimName = (pid) => `vm-claim.${pid}-${lstart(pid).replace(/ +/g, '-')}`;

const worker = join(root, 'worker.sh');
executable(worker, `job=$1 hooks=$2
bash -e -o pipefail "$hooks/job-started.sh" >"$job/started.out" 2>"$job/started.err"
echo $? >"$job/started.status"
until [[ -e $job/end ]]; do sleep 0.05; done
bash -e -o pipefail "$hooks/job-completed.sh" >"$job/completed.out" 2>"$job/completed.err"
echo $? >"$job/completed.status"`);

const children = [];
after(() => { for (const child of children) child.kill('SIGKILL'); });

const SHA = '0b7c31a12c0b7c31a12c0b7c31a12c0b7c31a12c';
const contract = (line) => `name: gate\n${line}\non: push\njobs:\n  e2e:\n    runs-on: [self-hosted, macOS, ARM64, ci-kit-mac]\n`;
const workflows = {
  present: contract('# ci-kit-vm-contract: 1'),
  absent: 'name: gate\non: push\njobs: {}\n',
  older: contract('# ci-kit-vm-contract: 0'),
};

// lane: whether the VM lane's LaunchAgent file is there (a Mac with the lane installed); workflow: what gh serves for
// the job's workflow file, or null for a read that fails.
function mac({ shared = [], lane = true, workflow = workflows.present } = {}) {
  const home = mkdtempSync(join(root, 'home-'));
  const bin = join(home, 'bin');
  const logs = join(home, 'Library/Logs/ci-kit');
  mkdirSync(bin);
  mkdirSync(logs, { recursive: true });
  if (lane) {
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(join(home, 'Library/LaunchAgents/com.ssfskim.ci-kit.vm-lane.plist'), '<plist/>\n');
  }
  const instance = (n) => join(home, n === 1 ? 'actions-runner-maws' : `actions-runner-maws-${n}`);
  for (const n of [1, ...shared]) {
    const dir = join(instance(n), 'ci-kit/hooks');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(instance(n), '_work'));
    for (const file of hookFiles) copyFileSync(join(hooks, file), join(dir, file));
    executable(join(dir, 'desktop-posture.sh'), 'exit 0');
  }
  writeFileSync(join(home, 'front'), terminal);
  executable(join(bin, 'lsappinfo'), `if [[ $1 == front ]]; then echo 'ASN:0x0-0x1:'; exit 0; fi\ncat '${join(home, 'front')}'`);
  executable(join(bin, 'open'), 'exit 0');
  executable(join(bin, 'node'), `[[ -f $1 ]] || { echo "node: cannot find $1" >&2; exit 1; }
root=\${1%/ci-kit/hooks/sweep.mjs}; shift; args=()
while (($# > 0)); do if [[ $1 == --work ]]; then root=\${2%/_work}; shift 2; continue; fi; args+=("$1"); shift; done
printf '%s %s\\n' "\${root##*/}" "\${args[*]}" >> "$HOME/sweeps"
exit 0`);
  executable(join(bin, 'unified-log'), 'exit 0');
  // gh, as the machine user's own login: the call and the token variables it saw are recorded; a contents read serves
  // the workflow file, or fails as a 404 does.
  executable(join(bin, 'gh'), `printf '%s\\0' "$@" "GH_TOKEN=\${GH_TOKEN-unset}" >> "$HOME/gh-args"; printf '\\0' >> "$HOME/gh-args"
[[ -f $HOME/workflow ]] || { echo 'gh: Not Found (HTTP 404)' >&2; exit 1; }
cat "$HOME/workflow"`);
  if (workflow !== null) writeFileSync(join(home, 'workflow'), workflow);
  const base = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, CI_KIT_MACHINE: 'mini', CI_KIT_SHARED_POLL: '0.05', CI_KIT_LOG_BIN: join(bin, 'unified-log'),
    CI_KIT_GH_BIN: join(bin, 'gh'), GITHUB_REPOSITORY: 'SSFSKIM/MAWS', GITHUB_WORKFLOW_REF: 'SSFSKIM/MAWS/.github/workflows/gate.yml@refs/heads/master',
    GITHUB_WORKFLOW_SHA: SHA, GH_TOKEN: 'a-job-token',
  };
  const text = (path) => existsSync(path) ? readFileSync(path, 'utf8') : '';
  let runs = 40;
  return {
    home, logs, instance,
    reserve: () => writeFileSync(join(logs, 'vm-reserved'), 'vm=maws-vm-job-vm-20261021T120000Z since 2026-10-21T12:00:00Z\n'),
    release: () => rmSync(join(logs, 'vm-reserved'), { force: true }),
    claims: () => readdirSync(logs).filter((name) => name.startsWith('vm-claim.')),
    claim: (name) => text(join(logs, name)),
    log: () => text(join(logs, 'mac-runner-hooks.log')),
    sweeps: () => text(join(home, 'sweeps')).trim().split('\n').filter(Boolean),
    ghCalls: () => text(join(home, 'gh-args')).split('\0\0').filter(Boolean).map((call) => call.split('\0')),
    job(n, { env: extra = {} } = {}) {
      const run = String(++runs);
      const dir = mkdtempSync(join(home, `job-${run}-`));
      const child = spawn('/bin/bash', [worker, dir, join(instance(n), 'ci-kit/hooks')], {
        stdio: 'ignore', env: { ...base, GITHUB_RUN_ID: run, GITHUB_JOB: 'e2e', ...extra },
      });
      children.push(child);
      const status = (phase) => existsSync(join(dir, `${phase}.status`)) ? Number(readFileSync(join(dir, `${phase}.status`), 'utf8')) : null;
      return {
        run, pid: child.pid,
        status: () => status('started'),
        stdout: () => text(join(dir, 'started.out')),
        stderr: () => text(join(dir, 'started.err')),
        started: async () => { await until(() => status('started') !== null, `run ${run}'s start`); return status('started'); },
        end: async () => { writeFileSync(join(dir, 'end'), ''); await until(() => status('completed') !== null, `run ${run}'s end`); return status('completed'); },
      };
    },
    // vm-claim.sh run as another caller runs it (the launcher, under its own lock).
    run: (...args) => spawnSync('/bin/bash', [join(instance(1), 'ci-kit/hooks/vm-claim.sh'), ...args], { encoding: 'utf8', timeout: 30_000, env: base }),
  };
}

// A process whose pid and start time a claim names, not a job of the harness.
async function process_() {
  const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  children.push(child);
  await once(child, 'spawn');
  return { pid: child.pid, started: lstart(child.pid), kill: async () => { const gone = once(child, 'exit'); child.kill('SIGKILL'); await gone; } };
}
const claimText = ({ pid, started }, run = '7') => `measured claim since 2026-10-21T10:00:00Z: run ${run} job e2e (worker ${pid})\nrun=${run}\nattempt=1\njob=e2e\nworker=${pid}\nstarted=${started}\nsince=2026-10-21T10:00:00Z\n`;

test('a job whose workflow carries the contract line is VM-safe: it says so, reads the workflow once with the machine\'s own login, claims nothing and runs beside a guest', async () => {
  const m = mac();
  m.reserve();
  const job = m.job(1);
  assert.equal(await job.started(), 0, job.stderr());
  assert.match(job.stdout(), /^\S+ vm-claim run=\d+ job=e2e vm-safe: yes \(contract 1\)$/m);
  assert.match(m.log(), /vm-claim run=\d+ job=e2e vm-safe: yes \(contract 1\)\n/);
  assert.deepEqual(m.claims(), []);
  const calls = m.ghCalls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/SSFSKIM/MAWS/contents/.github/workflows/gate.yml?ref=${SHA}`, 'GH_TOKEN=unset']);
  assert.equal(await job.end(), 0);
  assert.deepEqual(m.sweeps(), ['actions-runner-maws job-started', 'actions-runner-maws job-completed']);
});

for (const [kind, options, env, why] of [
  ['no contract line', { workflow: workflows.absent }, {}, `no contract line in .github/workflows/gate.yml at ${SHA.slice(0, 12)}`],
  ['an older contract number', { workflow: workflows.older }, {}, `contract 0 in .github/workflows/gate.yml at ${SHA.slice(0, 12)}, not 1`],
  ['a workflow read that fails', { workflow: null }, {}, 'the read of .github/workflows/gate.yml failed: gh: Not Found (HTTP 404)'],
  ['an empty GITHUB_WORKFLOW_SHA', {}, { GITHUB_WORKFLOW_SHA: '' }, 'GITHUB_WORKFLOW_SHA is empty'],
  ['a GITHUB_WORKFLOW_REF that names no workflow file', {}, { GITHUB_WORKFLOW_REF: '' }, "GITHUB_WORKFLOW_REF '' names no workflow of SSFSKIM/MAWS"],
]) test(`a job of unknown kind (${kind}) raises its claim, waits for the guest to go, and keeps the claim to its end hook`, async () => {
  const m = mac(options);
  m.reserve();
  const job = m.job(1, { env });
  await until(() => /waiting for the guest/.test(m.log()), 'the wait');
  assert.match(job.stdout(), new RegExp(`vm-safe: unknown \\(${why.replace(/[.()?]/g, '\\$&')}\\)$`, 'm'));
  assert.deepEqual(m.claims(), [claimName(job.pid)]);
  assert.match(m.claim(claimName(job.pid)), new RegExp(`^unknown-kind claim since \\S+: run ${job.run} job e2e \\(worker ${job.pid}\\)\\n(.|\\n)*started=${lstart(job.pid)}\\n`));
  assert.match(m.log(), new RegExp(`raised ${claimName(job.pid)}: no guest boots until this job ends`));
  assert.match(m.log(), /waiting for the guest \(at most 10 min\): the reservation stands, vm=maws-vm-job-vm-20261021T120000Z since 2026-10-21T12:00:00Z\n/);
  await sleep(400);
  assert.equal(job.status(), null, 'held while the guest runs');
  m.release();
  assert.equal(await job.started(), 0, job.stderr());
  assert.match(m.log(), /no guest runs after \d+ s/);
  assert.deepEqual(m.claims(), [claimName(job.pid)], 'the claim stays while the job runs');
  assert.equal(await job.end(), 0);
  assert.deepEqual(m.claims(), []);
  assert.match(m.log(), new RegExp(`removed the claim of run ${job.run} job e2e \\(worker ${job.pid}\\) \\(its job ended\\)`));
});

test('a job of unknown kind with no guest running is admitted at once, its claim held', async () => {
  const m = mac({ workflow: workflows.absent });
  const job = m.job(1);
  assert.equal(await job.started(), 0, job.stderr());
  assert.doesNotMatch(m.log(), /waiting for the guest/);
  assert.deepEqual(m.claims(), [claimName(job.pid)]);
  assert.equal(await job.end(), 0);
  assert.deepEqual(m.claims(), []);
});

test('past the exclusive bound a job of unknown kind is refused in the lane\'s shape, and its claim stays until its end hook', async () => {
  const m = mac({ workflow: workflows.absent });
  m.reserve();
  const job = m.job(1, { env: { CI_KIT_EXCLUSIVE_WAIT: '0.02' } });
  assert.equal(await job.started(), 1);
  assert.match(job.stderr(), /^ci-kit: the guest on the mini did not make way for a job of unknown kind \(after 0\.02 min: the reservation stands, vm=maws-vm-job-vm-20261021T120000Z since 2026-10-21T12:00:00Z\); waited \d+ s — rerun$/m);
  assert.deepEqual(m.claims(), [claimName(job.pid)], 'the steps after a failure still run: no guest beside them');
  assert.equal(await job.end(), 0);
  assert.deepEqual(m.claims(), []);
});

test('an end hook removes only the claim naming its own worker; a stale claim of another is ignored and dropped by the claims read', async () => {
  const m = mac({ workflow: workflows.absent });
  const dead = await process_();
  await dead.kill();
  const live = await process_();
  const deadName = `vm-claim.${dead.pid}-${dead.started.replace(/ +/g, '-')}`;
  const liveName = `vm-claim.${live.pid}-${live.started.replace(/ +/g, '-')}`;
  writeFileSync(join(m.logs, deadName), claimText(dead, '8'));
  writeFileSync(join(m.logs, liveName), claimText(live, '9'));
  const job = m.job(1);
  assert.equal(await job.started(), 0, job.stderr());
  assert.equal(await job.end(), 0);
  assert.deepEqual(m.claims().sort(), [deadName, liveName].sort(), 'another job\'s claims are not this end\'s');
  const read = m.run('claims');
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, `${liveName}: run 9 job e2e (worker ${live.pid})\n`);
  assert.deepEqual(m.claims(), [liveName]);
  assert.match(m.log(), new RegExp(`${deadName.replace(/[.()]/g, '\\$&')} is stale: its worker is gone`));
});

test('a shared instance\'s job is not classified, and an exclusive job of unknown kind holds both its claim and the shared hold', async () => {
  const m = mac({ shared: [2], workflow: workflows.absent });
  const shared = m.job(2);
  assert.equal(await shared.started(), 0, shared.stderr());
  assert.equal(m.ghCalls().length, 0, 'only a contract workflow can ask for the shared label');
  assert.deepEqual(m.claims(), []);
  assert.equal(await shared.end(), 0);
  const exclusive = m.job(1);
  assert.equal(await exclusive.started(), 0, exclusive.stderr());
  assert.deepEqual(m.claims(), [claimName(exclusive.pid)]);
  assert.ok(existsSync(join(m.logs, 'shared-hold')));
  assert.equal(await exclusive.end(), 0);
  assert.deepEqual(m.claims(), []);
  assert.equal(existsSync(join(m.logs, 'shared-hold')), false);
});

test('without the lane installed the hooks are today\'s: no workflow read, no claim, no lock, no new line', async () => {
  const m = mac({ lane: false, workflow: workflows.absent });
  m.reserve();
  const job = m.job(1);
  assert.equal(await job.started(), 0, job.stderr());
  assert.equal(await job.end(), 0);
  assert.equal(m.ghCalls().length, 0);
  assert.deepEqual(m.claims(), []);
  assert.equal(existsSync(join(m.logs, 'desktop.lock')), false);
  assert.doesNotMatch(m.log(), /vm-claim|vm-safe|guest/);
  assert.deepEqual(m.sweeps(), ['actions-runner-maws job-started', 'actions-runner-maws job-completed']);
});
