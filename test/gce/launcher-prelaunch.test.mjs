// Pre-launch in the launcher's tick (spec 2026-10-21 M5) against the shared fake of Compute Engine and GitHub: a run
// shaped like MAWS's gate workflow (its plan on hosted ubuntu-slim, then static cpus-16, four unit shards cpus-8 and
// probes cpus-2, created when the plan ends), its VMs launched while the plan runs and claimed by its gates; a
// docs-only run whose plan skips the gates; and what keeps one run from being pre-launched twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './fake-world.mjs';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { parseRow, renderRow } from '../../gce/launcher/ledger.mjs';
import { instanceName } from '../../gce/launcher/logic.mjs';
import { NEW_CFG } from './config-fixtures.mjs';
import { GceError } from '../../lib/gce.mjs';

const SBX = 'SSFSKIM/ci-kit-sandbox';
const CFG = { ...NEW_CFG, repos: [{ repo: SBX }] };
const T0 = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60_000;
const GATE = '.github/workflows/gate.yml';
const COMMIT = 'c0ffee00aabbccddeeff00112233445566778899';
const L = (n) => ['self-hosted', 'ci-kit-pool', `cpus-${n}`];
const GATES = [['static', 16], ['unit 1/4', 8], ['unit 2/4', 8], ['unit 3/4', 8], ['unit 4/4', 8], ['probes', 2]];

// history: the repo whose earlier runs are on the ledger, and the gates each of them ran.
function setup({ cfg = CFG, history = { repo: SBX, gates: GATES }, repos } = {}) {
  const w = world({ start: T0, ...(repos ? { repos } : {}) });
  let seq = 0;
  const make = () => new Launcher({
    gce: w.gce, gh: w.github, ledger: createGceLedger(w.github, cfg.ledger, { now: w.now }), cfg, config: COMMIT, poolRepos: [],
    now: w.now, random: () => (seq += 1), alert: async () => {}, log: (m) => w.log.push(`log ${m}`),
  });
  // Three earlier runs of the workflow on the ledger, each a VM per gate.
  let id = 1_000_000;
  for (const run of [11, 12, 13]) {
    for (const [name, cpus] of history.gates) {
      id += 1;
      const alloc = `zz${String(id).padStart(8, '0')}`;
      const row = {
        alloc, instance: instanceName(alloc), repo: history.repo, cpus, at: new Date(T0 - 3 * 3600_000).toISOString(), config: 'c0ffee00',
        state: 'final', end: 'done', job: { id, name, run, workflow: GATE },
      };
      w.gh.comments.push({ id, issue: 1, body: renderRow(row), updated_at: new Date(T0 - 3 * 3600_000).toISOString() });
    }
  }
  return { w, launcher: make(), make };
}

const forRun = (w, run) => w.gh.comments.map((c) => parseRow(c.body)).filter((r) => r?.prelaunch?.run === run);
const sizes = (list) => list.map((r) => r.cpus).sort((a, b) => a - b);
const vmsOf = (w, cpus) => w.g.instances.filter((i) => i.labels['ci-kit-cpus'] === String(cpus)).map((i) => i.name);

// The run's start: its plan job queued on a hosted runner.
const startRun = (w) => w.sim.queue(SBX, ['ubuntu-slim'], { name: 'plan' });
// The plan ends: its gates are created (queued) at once, or skipped.
function endPlan(w, plan, { skipped = false } = {}) {
  plan.status = 'completed';
  return GATES.map(([name, cpus]) => {
    const job = w.sim.queue(SBX, L(cpus), { name, run: plan.run_id });
    if (skipped) Object.assign(job, { status: 'completed', conclusion: 'skipped' });
    return job;
  });
}

test('a run\'s gate VMs are launched while its plan runs, and its gates, once queued, are served by them and launch nothing', async () => {
  const { w, launcher, make } = setup();
  const plan = startRun(w);
  const first = await launcher.tick();
  assert.equal(first.launched.length, 6);
  assert.deepEqual(first.prelaunched, first.launched);
  assert.deepEqual(sizes(forRun(w, plan.run_id)), [2, 8, 8, 8, 8, 16]);
  assert.ok(forRun(w, plan.run_id).every((r) => r.state === 'running' && r.prelaunch.workflow === GATE && r.prelaunch.attempt === 1));
  assert.ok(w.log.some((l) => l.startsWith(`log pre-launched ${first.launched[0]} `) && l.includes(`for run ${plan.run_id} (${GATE})`)));
  // The plan runs on: a tick a redelivered event asks for, and a second launcher, launch nothing more.
  w.advance(10_000);
  assert.deepEqual((await launcher.tick()).launched, []);
  w.gh.runs.find((r) => r.id === plan.run_id).status = 'in_progress';
  plan.status = 'in_progress';
  assert.deepEqual((await make().tick()).launched, [], 'a second launcher, with a ledger store of its own');

  // The plan ends 15 s after it was queued; every insert went before its gates were queued.
  w.advance(5_000);
  const gates = endPlan(w, plan);
  assert.ok(forRun(w, plan.run_id).every((r) => Date.parse(r.created) < Date.parse(gates[0].created_at)));
  const served = await launcher.tick();
  assert.deepEqual(served.launched, [], 'each gate is covered by a pre-launched VM of its size');
  assert.equal(served.waiting, 0);

  // The VMs boot and take the gates; each row records the gate its VM ran.
  w.advance(20_000);
  for (const [k, job] of gates.entries()) {
    const cpus = GATES[k][1];
    const name = vmsOf(w, cpus).find((n) => !w.sim.runner(SBX, n).busy);
    w.sim.boot(SBX, name);
    w.sim.take(SBX, name, job);
  }
  await launcher.tick();
  assert.ok(forRun(w, plan.run_id).every((r) => r.job?.run === plan.run_id));
  for (const job of gates) w.sim.finish(SBX, job.runner_name, job);
  w.advance(MIN);
  await launcher.tick();
  w.advance(MIN);
  await launcher.tick();
  assert.equal(w.g.instances.length, 0);

  // The next day's line: six pre-launched VMs, none unclaimed.
  w.advance(Date.parse('2026-10-17T00:30:00Z') - w.now());
  await launcher.tick();
  const daily = w.gh.comments.find((c) => c.body.includes('ci-kit-gce-daily'));
  assert.match(daily.body, /Pre-launched: 6 VMs, 0 unclaimed \(\$0\.0000\)\./);
});

test('a docs-only run (its plan skips the gates) costs its pre-launched VMs one idle window, and the line shows them unclaimed', async () => {
  const { w, launcher } = setup();
  const plan = startRun(w);
  await launcher.tick();
  const names = w.g.instances.map((i) => i.name);
  assert.equal(names.length, 6);
  w.advance(15_000);
  endPlan(w, plan, { skipped: true });
  w.gh.runs.find((r) => r.id === plan.run_id).status = 'completed';
  for (const name of names) w.sim.boot(SBX, name);
  // Nothing more is launched for the run, and nothing is deleted before the idle rule's window.
  for (let t = 0; t < 9; t += 1) {
    w.advance(MIN);
    assert.deepEqual((await launcher.tick()).launched, []);
  }
  assert.equal(w.g.instances.length, 6);
  w.advance(MIN);
  await launcher.tick();
  assert.equal(w.g.instances.length, 0, 'gone at idle_runner_minutes');
  w.advance(MIN);
  await launcher.tick();
  assert.ok(forRun(w, plan.run_id).every((r) => r.state === 'final' && r.end === 'cancelled-idle' && r.dollars > 0));
  w.advance(Date.parse('2026-10-17T00:30:00Z') - w.now());
  await launcher.tick();
  const daily = w.gh.comments.find((c) => c.body.includes('ci-kit-gce-daily'));
  assert.match(daily.body, /Pre-launched: 6 VMs, 6 unclaimed \(\$0\.\d{4}\)\./);
});

test('a run first seen after its plan ended with no pool job, or a workflow with no runs on the ledger, gets nothing', async () => {
  const { w, launcher } = setup();
  const plan = startRun(w);
  endPlan(w, plan, { skipped: true });
  w.sim.queue(SBX, ['ubuntu-slim'], { name: 'lint' });
  w.gh.runs.at(-1).path = '.github/workflows/lint.yml'; // another workflow's run, which never ran on the pool
  assert.deepEqual((await launcher.tick()).launched, []);
  assert.equal(w.g.instances.length, 0);
});

test('queued pool jobs launch first; a run\'s pre-launch takes only the vCPUs they leave', async () => {
  const { w, launcher } = setup({ cfg: { ...CFG, max_vcpus: 16 + 16 + 8 } });
  w.sim.queue(SBX, L(16), { name: 'other static' }); // another run's gate, queued now
  const plan = startRun(w);
  const out = await launcher.tick();
  // The job's 16, then the run's static 16 and one unit 8; the next unit does not fit, and the rest wait.
  assert.equal(out.launched.length, 3);
  assert.deepEqual(sizes(forRun(w, plan.run_id)), [8, 16]);
  // Once the job's VM is gone, a tick launches more of the run's shape as far as the room goes, not the whole again.
  w.advance(10_000);
  const job = w.gh.jobs.find((j) => j.name === 'other static');
  const vm = w.g.instances.find((i) => !forRun(w, plan.run_id).some((r) => r.instance === i.name));
  w.sim.boot(SBX, vm.name);
  w.sim.take(SBX, vm.name, job);
  w.sim.finish(SBX, vm.name, job);
  await launcher.tick(); // the finished VM is deleted (its vCPUs still count this tick)
  w.advance(10_000);
  await launcher.tick();
  assert.deepEqual(sizes(forRun(w, plan.run_id)), [8, 8, 8, 16], 'two more 8s in the 16 freed; the third 8 waits');
});

// Review (M5, reviewer-medium P2): pre-launches shared the queued jobs' launch queue, whose 16 workers mint and insert
// at once, so a pre-launch could take the quota a queued job needed. A queued sandbox cpus-16 gate, a MAWS run that
// pre-launches one cpus-8, and 16 vCPUs of quota in all: the sandbox's JIT answered late, the pre-launch inserted
// first, and the gate was refused for quota, tick after tick, while the speculative VM (another repo's) idled.
const MAWS = 'SSFSKIM/MAWS';
function quotaWorld({ vcpus }) {
  const { w, make } = setup({
    cfg: { ...NEW_CFG, repos: [{ repo: SBX }, { repo: MAWS }] },
    history: { repo: MAWS, gates: [['unit', 8]] },
    repos: { [SBX]: { private: true }, [MAWS]: { private: true } },
  });
  const used = () => w.g.instances.reduce((sum, i) => sum + Number(i.machineType.split('-').pop()), 0);
  const insert = w.gce.insertInstance;
  const inserts = [];
  w.gce.insertInstance = async (zone, body, opts) => {
    inserts.push(`${body.labels['ci-kit-repo']} ${body.labels['ci-kit-cpus']}`);
    if (used() + Number(body.machineType.split('-').pop()) > vcpus) {
      throw new GceError(200, `operation failed: Quota 'CPUS_ALL_REGIONS' exceeded.  Limit: ${vcpus}.0 globally.`, ['QUOTA_EXCEEDED'], { accepted: true, finished: true });
    }
    return insert(zone, body, opts);
  };
  const jit = w.github.jitConfig;
  w.github.jitConfig = async (repo, spec) => {
    if (repo === SBX) for (let k = 0; k < 20; k += 1) await new Promise((r) => setImmediate(r)); // GitHub answers it late
    return jit(repo, spec);
  };
  w.sim.queue(SBX, L(16), { name: 'static' });
  w.sim.queue(MAWS, ['ubuntu-slim'], { name: 'plan' });
  return { w, launcher: make(), inserts };
}
const repoOf = (w, i) => (i.labels['ci-kit-repo'] === 'ssfskim--maws' ? MAWS : SBX);

test('a queued job\'s launch is done before any pre-launch starts, so a pre-launch never takes its quota', async () => {
  const { w, launcher } = quotaWorld({ vcpus: 16 });
  const out = await launcher.tick();
  assert.deepEqual(w.g.instances.map((i) => `${repoOf(w, i)} ${i.labels['ci-kit-cpus']}`), [`${SBX} 16`], 'the gate has its VM');
  assert.deepEqual(out.prelaunched, [], 'the pre-launch found no quota left, and made nothing');
});

test('a tick in which a queued job stayed unserved pre-launches nothing: it has no spare quota to speculate with', async () => {
  const { w, launcher, inserts } = quotaWorld({ vcpus: 8 });
  const out = await launcher.tick();
  assert.deepEqual(out.launched, []);
  assert.deepEqual(inserts, ['ssfskim--ci-kit-sandbox 16'], 'the gate\'s insert, refused for quota; no pre-launch tried');
  assert.ok(!w.gh.comments.some((c) => parseRow(c.body)?.prelaunch), 'no pre-launch row');
});
