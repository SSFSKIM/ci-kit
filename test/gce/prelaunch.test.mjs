// Pre-launch's decisions (gce/launcher/prelaunch.mjs, spec 2026-10-21 M5): the shape of a workflow's recent runs, read
// from the ledger's rows, and which VMs a tick launches for runs that have begun before their pool jobs are queued.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runShape, planPrelaunches, SHAPE_RUNS } from '../../gce/launcher/prelaunch.mjs';
import { NEW_CFG, ONE_REGION_CFG } from './config-fixtures.mjs';

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
const run = (id, { repo = MAWS, path = GATE, attempt = 1 } = {}) => ({ repo, id, path, attempt });
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
