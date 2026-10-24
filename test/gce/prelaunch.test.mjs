// Pre-launch's decisions (gce/launcher/prelaunch.mjs, spec 2026-10-21 M5): the shape of a workflow's recent runs, read
// from the ledger's rows, and which VMs a tick launches for runs that have begun before their pool jobs are queued.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runShape, planPrelaunches, SHAPE_RUNS } from '../../gce/launcher/prelaunch.mjs';
import { NEW_CFG, ONE_REGION_CFG } from './config-fixtures.mjs';
import { planLaunches, claimedInstances, repoLabel } from '../../gce/launcher/logic.mjs';

const MAWS = 'SSFSKIM/MAWS';
const GATE = '.github/workflows/gate.yml';
let seq = 0;
// A ledger row whose VM ran a job of `run`.
const ran = (run, cpus, { repo = MAWS, workflow = GATE, end = 'done' } = {}) => ({
  alloc: `a${(seq += 1)}`, repo, cpus, state: 'final', end, job: { id: seq, name: 'gate', run, workflow },
});
// MAWS's class 1a since 2026-10-21 (run 39647845404): static cpus-16, four unit shards cpus-8, probes cpus-2.
const classOneA = (run) => [ran(run, 16), ran(run, 8), ran(run, 8), ran(run, 8), ran(run, 8), ran(run, 2)];

test('a workflow\'s shape is the median count of each size over its runs in the rows, rounded up', () => {
  const rows = [...classOneA(101), ...classOneA(102), ran(103, 4), ran(103, 8), ran(103, 2)];
  // size 16: 1, 1, 0 → 1; size 8: 4, 4, 1 → 4; size 2: 1, 1, 1 → 1; size 4: 0, 0, 1 → 0.
  assert.deepEqual(runShape(rows, MAWS, GATE), { 16: 1, 8: 4, 2: 1 });
  // Two runs: the median of 4 and 1 is 2.5, rounded up.
  assert.deepEqual(runShape([...classOneA(101), ran(102, 8)], MAWS, GATE), { 16: 1, 8: 3, 2: 1 });
});

test('the shape reads only the workflow\'s own runs in the repo, and nothing when it has none', () => {
  const rows = [...classOneA(101), ran(200, 4, { workflow: '.github/workflows/other.yml' }), ran(300, 16, { repo: 'SSFSKIM/manim-master' })];
  assert.deepEqual(runShape(rows, 'ssfskim/maws', GATE), { 16: 1, 8: 4, 2: 1 }, 'GitHub names repos case-insensitively');
  assert.equal(runShape(rows, MAWS, '.github/workflows/unit-cache.yml'), null);
  // Rows without a job's run (written before M3, or a VM that ran nothing) are no run.
  assert.equal(runShape([{ alloc: 'x', repo: MAWS, cpus: 8, state: 'final', end: 'cancelled-idle' }], MAWS, GATE), null);
});

test(`the shape is over the workflow's last ${SHAPE_RUNS} runs, newest by run id`, () => {
  const old = Array.from({ length: 6 }, (_, k) => ran(100 + k, 16)); // six old runs with one static each, nothing else
  const recent = Array.from({ length: SHAPE_RUNS }, (_, k) => [ran(200 + k, 8), ran(200 + k, 8)]).flat();
  assert.deepEqual(runShape([...old, ...recent], MAWS, GATE), { 8: 2 });
});

// A run as the launcher reads it (readRepo), and its jobs.
const run = (id, { repo = MAWS, path = GATE, attempt = 1, message } = {}) => ({ repo, id, path, attempt, message });
const job = (runId, labels, { status = 'queued', conclusion = null } = {}) => ({ id: runId * 10, run_id: runId, labels, status, conclusion, repo: MAWS });
const PLAN = ['ubuntu-slim'];
const history = [...classOneA(101), ...classOneA(102), ...classOneA(103)];
const runners = new Map([[MAWS, new Map()]]);
const plan = (over = {}) => planPrelaunches({
  runs: [run(500)], jobs: [job(500, PLAN)], rows: history, runners, inflight: 0, waiting: 0, cfg: NEW_CFG, ...over,
});
const sizes = (launches) => launches.map((l) => l.cpus);

test('a run whose first job is queued on a hosted runner gets its workflow\'s shape, largest first, each launch naming the run', () => {
  const launches = plan();
  assert.deepEqual(sizes(launches), [16, 8, 8, 8, 8, 2]);
  assert.deepEqual(launches[0], { repo: MAWS, cpus: 16, prelaunch: { run: 500, attempt: 1, workflow: GATE } });
  // The plan job running, or no job listed yet (a run is created a moment before its first jobs), is still a start.
  assert.equal(plan({ jobs: [job(500, PLAN, { status: 'in_progress' })] }).length, 6);
  assert.equal(plan({ jobs: [] }).length, 6);
});

test('a run whose pool jobs exist, or whose first job has ended, gets no pre-launch: its demand is known', () => {
  // Gates queued: the ordinary launches (and the pre-launched VMs' cover) serve them.
  assert.deepEqual(plan({ jobs: [job(500, PLAN, { status: 'completed' }), job(500, ['self-hosted', 'ci-kit-pool', 'cpus-8'])] }), []);
  // A docs-only run: the plan skipped every gate (the skipped jobs are listed, with their labels).
  assert.deepEqual(plan({ jobs: [job(500, PLAN, { status: 'completed' }), job(500, ['self-hosted', 'CI-KIT-POOL', 'cpus-8'], { status: 'completed', conclusion: 'skipped' })] }), []);
  // The plan ended and nothing of the pool followed (the class 1a gates went to the Mac): no gate will ask.
  assert.deepEqual(plan({ jobs: [job(500, PLAN, { status: 'completed' }), job(500, ['self-hosted', 'macOS', 'ARM64'])] }), []);
});

test('no pre-launch without a shape, or for a repo whose runners could not be listed', () => {
  assert.deepEqual(plan({ runs: [run(500, { path: '.github/workflows/unit-cache.yml' })] }), []);
  assert.deepEqual(plan({ runners: new Map() }), []);
});

const prelaunched = (runId, cpus, { attempt = 1, end, state = 'running' } = {}) => ({
  alloc: `p${(seq += 1)}`, repo: MAWS, cpus, state, ...(end ? { end } : {}), prelaunch: { run: runId, attempt, workflow: GATE },
});

test('the rows of VMs already pre-launched for the run and attempt are taken off its shape, whatever became of them', () => {
  // A later tick, a second launcher, a redelivered event: the rows say it was done.
  assert.deepEqual(plan({ rows: [...history, ...classOneA(0).map((r) => prelaunched(500, r.cpus))] }), []);
  // A tick that ran out of time launched part of it: the rest goes now. A VM since claimed or deleted still counts.
  const part = [prelaunched(500, 16, { state: 'final', end: 'done' }), prelaunched(500, 8, { state: 'final', end: 'cancelled-idle' }), prelaunched(500, 8)];
  assert.deepEqual(sizes(plan({ rows: [...history, ...part] })), [8, 8, 2]);
  // An abandoned launch made no VM; another attempt of the run (a re-run of all its jobs) is a new start.
  assert.deepEqual(sizes(plan({ rows: [...history, prelaunched(500, 16, { state: 'final', end: 'abandoned' })] })), [16, 8, 8, 8, 8, 2]);
  assert.equal(plan({ runs: [run(500, { attempt: 2 })], rows: [...history, prelaunched(500, 16)] }).length, 6);
});

test('pre-launches come after the queued jobs: none while a job waits, and they stop at the first that does not fit', () => {
  assert.deepEqual(plan({ waiting: 1 }), []);
  // 36 vCPUs left: 16, 8 and 8 fit, the next 8 does not, and size 2 (which reserves c3d-highcpu-4's 4) waits behind it.
  assert.deepEqual(sizes(plan({ inflight: 156 })), [16, 8, 8]);
  // Oldest run first, and a run that does not fit holds the line.
  const two = plan({ runs: [run(501), run(500)], jobs: [job(500, PLAN), job(501, PLAN)], inflight: 192 - 52 - 16 }); // run 500's 16 + 4×8 + 4, then 501's 16
  assert.deepEqual(two.map((l) => `${l.prelaunch.run}:${l.cpus}`), ['500:16', '500:8', '500:8', '500:8', '500:8', '500:2', '501:16']);
});

test('a size the placements do not name is not pre-launched', () => {
  assert.deepEqual(sizes(plan({ rows: [...history, ran(101, 32), ran(102, 32)], cfg: ONE_REGION_CFG })), [16, 8, 8, 8, 8, 2]);
});

// Spec M6: a pre-launched VM's slow insert raced by a second allocation, whose demand names the same run and attempt.
const raceOf = (original, { end, state = 'running' } = {}) => ({
  alloc: `r${(seq += 1)}`, repo: MAWS, cpus: original.cpus, state, ...(end ? { end } : {}),
  race: { of: original.alloc, demand: { run: original.prelaunch.run, attempt: original.prelaunch.attempt } },
});

test('a pre-launch and the race of its slow insert fill one slot of the run\'s shape; the race fills it when the original is abandoned', () => {
  const statics = prelaunched(500, 16);
  const rest = [8, 8, 8, 8, 2].map((cpus) => prelaunched(500, cpus));
  // Both live: still one static, not two (two live VMs for a one-VM shape was the bug).
  assert.deepEqual(plan({ rows: [...history, statics, raceOf(statics), ...rest] }), []);
  // The original refused after its race began (abandoned): the race's VM is the run's static.
  const gone = { ...statics, state: 'final', end: 'abandoned' };
  assert.deepEqual(plan({ rows: [...history, gone, raceOf(statics), ...rest] }), []);
  // Both abandoned: the slot is open again.
  assert.deepEqual(sizes(plan({ rows: [...history, gone, raceOf(statics, { state: 'final', end: 'abandoned' }), ...rest] })), [16]);
  // Another attempt's race fills nothing of this one.
  const other = { ...raceOf(statics), race: { of: 'zzz', demand: { run: 500, attempt: 2 } } };
  assert.deepEqual(sizes(plan({ rows: [...history, gone, other, ...rest] })), [16]);
});

const hinted = (message, options = {}) => run(500, { message, ...options });
test('attempt one uses the exact head-commit demand instead of history, including an unseen workflow and explicit zero', () => {
  assert.deepEqual(sizes(plan({ runs: [hinted('gate\n\nPool-Demand: 2x1 4x2 16x1 8x4')] })), [16, 8, 8, 8, 8, 4, 4, 2]);
  assert.deepEqual(sizes(plan({ runs: [hinted('Pool-Demand: 4x2', { path: 'new.yml' })], rows: [] })), [4, 4]);
  assert.deepEqual(plan({ runs: [hinted('Pool-Demand: none')] }), []);
  for (const message of ['Pool-Demand: none', 'Pool-Demand: 4x2']) {
    assert.deepEqual(sizes(plan({ runs: [hinted(message, { attempt: 2 })] })), [16, 8, 8, 8, 8, 2]);
  }
});

test('the last trailer line wins, including when its value is malformed; CRLF and surrounding spaces work', () => {
  assert.deepEqual(sizes(plan({ runs: [hinted('Pool-Demand: none\r\n\r\nPool-Demand:  4x2  2x1  \r\n')] })), [4, 4, 2]);
  assert.deepEqual(plan({ runs: [hinted('Pool-Demand: 4x2\nPool-Demand: none')] }), []);
  assert.deepEqual(sizes(plan({ runs: [hinted('Pool-Demand: none\nPool-Demand: broken')] })), [16, 8, 8, 8, 8, 2]);
  assert.deepEqual(sizes(plan({ runs: [hinted('Pool-Demand: 4x01')] })), [4]);
});

for (const value of ['', ' ', 'None', 'none 4x1', '4x1 none', '3x1', '32x1', '04x1', '4x0', '4x-1', '4x+1', '4x1.5', '4x1e2', '4x1 4x2', '4x1,8x1', '4X1', '4x1 junk', '4x1\t8x1']) {
  test(`malformed demand ${JSON.stringify(value)} falls back to history`, () => {
    assert.deepEqual(sizes(plan({ runs: [hinted(`Pool-Demand: ${value}`)] })), [16, 8, 8, 8, 8, 2]);
  });
}

test('absent, embedded and differently cased trailer names do not override history', () => {
  for (const message of [undefined, '', 'gate', 'text Pool-Demand: none', 'pool-demand: none']) {
    assert.deepEqual(sizes(plan({ runs: [hinted(message)] })), [16, 8, 8, 8, 8, 2]);
  }
});

test('hinted demand still obeys job visibility, runner-list success, admission and per-attempt dedupe', () => {
  const runs = [hinted('Pool-Demand: 16x2 4x1')];
  assert.deepEqual(plan({ runs, waiting: 1 }), []);
  assert.deepEqual(plan({ runs, runners: new Map() }), []);
  assert.deepEqual(plan({ runs, jobs: [job(500, PLAN, { status: 'completed' })] }), []);
  assert.deepEqual(plan({ runs, jobs: [job(500, ['ci-kit-pool', 'cpus-4'])] }), []);
  assert.deepEqual(sizes(plan({ runs, inflight: NEW_CFG.max_vcpus - 16 })), [16]);
  assert.deepEqual(sizes(plan({ runs, rows: [prelaunched(500, 16, { state: 'final', end: 'done' })] })), [16, 4]);
});

test('enormous positive demand stays bounded even when physical admission is deferred to the launch queue', () => {
  const launches = plan({ runs: [hinted(`Pool-Demand: 4x${'9'.repeat(400)}`)], admission: false });
  assert.equal(launches.length, Math.floor(NEW_CFG.max_vcpus / 4));
});

const NOW = Date.parse('2026-10-24T12:00:00Z');
function inventory(cpus, { repo = MAWS, provider = 'gce', status = 'online', busy = false, row = {}, age = 1000, labels } = {}) {
  const alloc = `i${seq += 1}`;
  const name = `ci-kit-${provider}-${alloc}`;
  return {
    repo,
    runner: { name, status, busy, labels: (labels ?? ['self-hosted', 'ci-kit-pool', `cpus-${cpus}`, `ci-kit-${provider}`]).map((name) => ({ name })) },
    instance: { name, alloc, repoLabel: repoLabel(repo), cpus, vcpus: cpus, provider, status: 'RUNNING', created: NOW - age, running: NOW - age },
    row: { alloc, instance: name, repo, cpus, state: 'running', at: new Date(NOW - age).toISOString(), ...row },
  };
}
function withInventory(items, over = {}) {
  const rows = [...history, ...items.map((i) => i.row), ...(over.rows ?? [])];
  const mine = new Map([[MAWS, new Map()]]);
  for (const i of items) {
    if (!mine.has(i.repo)) mine.set(i.repo, new Map());
    mine.get(i.repo).set(i.runner.name, i.runner);
  }
  const jobs = over.jobs ?? [];
  const queued = jobs.filter((j) => j.status === 'queued' && j.labels.includes('ci-kit-pool'));
  const claims = claimedInstances({ jobs, rows, reports: over.reports ?? new Map() });
  const reactive = planLaunches({ queued, instances: items.map((i) => i.instance), rows, runners: mine, now: NOW, cfg: NEW_CFG, claimed: claims });
  return plan({ ...over, rows, runners: mine, spare: reactive.spare });
}

test('shared idle online inventory covers only the same repo and size, on either provider', () => {
  const items = [inventory(4), inventory(4, { provider: 'ec2' }), inventory(8), inventory(4, { repo: 'SSFSKIM/other' })];
  assert.deepEqual(sizes(withInventory(items, { runs: [hinted('Pool-Demand: 4x3')] })), [4]);
});

test('busy, offline, expired and previously claimed JIT runners are not reusable inventory', () => {
  const report = inventory(4);
  const jobClaim = inventory(4);
  const items = [inventory(4, { busy: true }), inventory(4, { status: 'offline' }), inventory(4, { age: 11 * 60_000 }),
    inventory(4, { row: { job: { id: 1, run: 100, workflow: GATE } } }), report, jobClaim];
  assert.deepEqual(sizes(withInventory(items, { runs: [hinted('Pool-Demand: 4x1')], reports: new Map([[report.runner.name, { id: 2 }]]),
    jobs: [{ ...job(99, ['ci-kit-pool', 'cpus-4'], { status: 'completed' }), runner_name: jobClaim.runner.name }] })), [4]);
});

test('ready inventory is consumed once across pending runs, oldest first; replaying a tick is stable', () => {
  const items = [inventory(4)];
  const runs = [run(501, { message: 'Pool-Demand: 4x1' }), hinted('Pool-Demand: 4x1')];
  for (let k = 0; k < 2; k += 1) {
    assert.deepEqual(withInventory(items, { runs }).map((l) => l.prelaunch.run), [501]);
  }
});

test('a pending run keeps its own prelaunch and race inventory, without subtracting it twice from its shape', () => {
  const original = inventory(4, { row: { prelaunch: { run: 501, attempt: 1, workflow: GATE } } });
  const race = inventory(4, { row: { race: { of: original.row.alloc, demand: { run: 501, attempt: 1 } } } });
  const runs = [hinted('Pool-Demand: 4x1'), run(501, { message: 'Pool-Demand: 4x2' })];
  assert.deepEqual(withInventory([original, race], { runs }).map((l) => l.prelaunch.run), [500, 501]);
});

test('inventory from runs no longer awaiting pool jobs, and older attempts, can cover a new run', () => {
  for (const jobs of [[], [job(99, PLAN, { status: 'completed' })], [job(99, ['ci-kit-pool', 'cpus-4'], { status: 'in_progress' })]]) {
    const item = inventory(4, { row: { prelaunch: { run: 99, attempt: 1, workflow: GATE } } });
    const runs = jobs.length ? [run(99), hinted('Pool-Demand: 4x1')] : [hinted('Pool-Demand: 4x1')];
    assert.deepEqual(withInventory([item], { runs, jobs }), []);
  }
  assert.deepEqual(withInventory([inventory(4, { row: { prelaunch: { run: 500, attempt: 2 } } })], { runs: [hinted('Pool-Demand: 4x1')] }), []);
});

test('queued jobs reserve inventory first, with provider-pinned demand kept separate from generic demand', () => {
  const items = [inventory(4, { provider: 'ec2' }), inventory(4)];
  const jobs = [job(90, ['self-hosted', 'ci-kit-pool', 'cpus-4']), job(91, ['self-hosted', 'ci-kit-pool', 'cpus-4', 'ci-kit-ec2'])];
  assert.deepEqual(sizes(withInventory(items, { runs: [hinted('Pool-Demand: 4x1')], jobs })), [4]);
  assert.deepEqual(withInventory(items, { runs: [hinted('Pool-Demand: 4x1')], jobs: jobs.slice(1) }), []);
});

test('historical provider-pinned shapes are not turned into generic prelaunch demand', () => {
  const rows = [{ ...ran(200, 4), v: 2, job: { run: 200, workflow: GATE, required_provider: 'ec2' } }];
  assert.deepEqual(plan({ rows }), []);
});

test('inventory accounting also reduces historical demand, without counting a runner twice', () => {
  const item = inventory(8);
  assert.deepEqual(sizes(withInventory([item, item])), [16, 8, 8, 8, 2]);
});

test('retiring runners and labels that do not identify the same pool size are not inventory', () => {
  const items = [inventory(4, { row: { state: 'deleting' } }), inventory(4, { row: { state: 'final' } }),
    inventory(4, { labels: ['self-hosted', 'cpus-4'] }), inventory(4, { labels: ['ci-kit-pool', 'cpus-8'] }),
    inventory(4, { labels: ['ci-kit-pool', 'cpus-4', 'cpus-8'] })];
  assert.deepEqual(sizes(withInventory(items, { runs: [hinted('Pool-Demand: 4x1')] })), [4]);
});

test('a provider-pinned pending run keeps its prelaunched runner out of generic shared inventory', () => {
  const item = inventory(4, { provider: 'ec2', row: { prelaunch: { run: 501, attempt: 1, workflow: 'pinned.yml' } } });
  const rows = [{ ...ran(200, 4), v: 2, job: { run: 200, workflow: 'pinned.yml', required_provider: 'ec2' } }];
  assert.deepEqual(withInventory([item], { runs: [hinted('Pool-Demand: 4x1'), run(501, { path: 'pinned.yml' })], rows }).map((l) => l.prelaunch.run), [500]);
});
