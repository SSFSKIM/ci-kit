// A job lost to a spot preemption is rerun without a human (launcher.mjs settleReruns): the preempted row owes its run
// a rerun, which fires once the run has completed with a failure in the attempt the job ran in, and never otherwise.
// Against the shared fake of Compute Engine and GitHub (fake-world.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './fake-world.mjs';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { parseRow } from '../../gce/launcher/ledger.mjs';
import { ONE_REGION_CFG } from './config-fixtures.mjs';

const SBX = 'SSFSKIM/ci-kit-sandbox';
const CFG = { ...ONE_REGION_CFG, repos: [{ repo: SBX }] };
const T0 = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60_000;
const L = (n) => ['self-hosted', 'ci-kit-pool', `cpus-${n}`];
const COMMIT = 'c0ffee00aabbccddeeff00112233445566778899';

function setup() {
  const w = world({ start: T0 });
  let seq = 0;
  const make = () => new Launcher({
    gce: w.gce, gh: w.github, ledger: createGceLedger(w.github, CFG.ledger, { now: w.now }), cfg: CFG, config: COMMIT,
    now: w.now, random: () => (seq += 1), alert: async () => {},
  });
  return { w, launcher: make(), make };
}

const rowOf = (w, name) => w.gh.comments.map((c) => parseRow(c.body)).find((r) => r?.instance === name);
const reruns = (w) => w.log.filter((l) => l.startsWith('rerun'));
const runReads = (w) => w.log.filter((l) => l.startsWith('get run')).length;

// `job` (in its own run unless `run` is given) runs on a spot VM that is preempted: the row is finalized preempted with
// the job it held, and GitHub, after its lost-runner wait, fails the job and frees the runner.
async function lose(w, launcher, { name = 'ci / unit', run } = {}) {
  const job = w.sim.queue(SBX, L(4), { name, run });
  const before = new Set(w.g.instances.map((i) => i.name));
  await launcher.tick();
  const vm = w.g.instances.find((i) => !before.has(i.name)).name;
  w.sim.boot(SBX, vm);
  w.sim.take(SBX, vm, job);
  w.advance(MIN);
  await launcher.tick();
  w.sim.preempt(vm);
  w.sim.runner(SBX, vm).status = 'offline';
  await launcher.tick();
  Object.assign(job, { status: 'completed', conclusion: 'failure' });
  w.sim.runner(SBX, vm).busy = false;
  return { job, vm, run: w.gh.runs.find((r) => r.id === job.run_id) };
}

const complete = (run, conclusion = 'failure') => Object.assign(run, { status: 'completed', conclusion });

async function ticks(w, launcher, minutes) {
  for (let m = 0; m < minutes; m += 1) {
    w.advance(MIN);
    await launcher.tick();
  }
}

test('a preempted row that held a job owes its run a rerun; a row with no job owes none', async () => {
  const { w, launcher } = setup();
  const { vm } = await lose(w, launcher);
  const row = rowOf(w, vm);
  assert.deepEqual([row.state, row.end, row.rerun], ['final', 'preempted', { state: 'owed' }]);
  assert.match(w.gh.comments.find((c) => parseRow(c.body)?.instance === vm).body, /\| preempted, rerun owed \|$/);

  w.sim.queue(SBX, L(8)); // its VM is preempted before its runner takes the job
  await launcher.tick();
  const unclaimed = w.g.instances.find((i) => i.name !== vm).name;
  w.sim.preempt(unclaimed);
  await launcher.tick();
  assert.deepEqual([rowOf(w, unclaimed).end, rowOf(w, unclaimed).rerun], ['preempted', undefined]);
});

test('the rerun waits while the run is in progress, fires once when it completes failed, and only once', async () => {
  const { w, launcher } = setup();
  const { job, vm, run } = await lose(w, launcher);
  await ticks(w, launcher, 20);
  assert.deepEqual(reruns(w), [], 'GitHub refuses a rerun before the run completes: none is sent');
  assert.equal(rowOf(w, vm).rerun.state, 'owed');
  assert.ok(runReads(w) <= 5, `the run is read at a modest cadence, not each tick (${runReads(w)} reads in 20 ticks)`);

  complete(run);
  await ticks(w, launcher, 5);
  assert.deepEqual(reruns(w), [`rerun job ${job.id}`]);
  assert.equal(run.run_attempt, 2);
  const row = rowOf(w, vm);
  assert.deepEqual([row.state, row.end, row.rerun.state, row.rerun.attempt, row.rerun.how], ['final', 'preempted', 'fired', 1, 'job']);

  complete(run); // attempt 2 fails too, on its own
  await ticks(w, launcher, 30);
  assert.deepEqual(reruns(w), [`rerun job ${job.id}`], 'one automatic rerun per attempt owed');
});

for (const [what, change, reason] of [
  ['the run was cancelled', (run) => complete(run, 'cancelled'), /cancelled/],
  ['the run succeeded', (run) => complete(run, 'success'), /success/],
  ['a human already re-attempted it', (run) => Object.assign(complete(run), { run_attempt: 2 }), /attempt 2/],
]) {
  test(`no rerun when ${what}: the owed rerun is dropped with its reason`, async () => {
    const { w, launcher } = setup();
    const { vm, run } = await lose(w, launcher);
    change(run);
    await ticks(w, launcher, 6);
    assert.deepEqual(reruns(w), []);
    const { rerun } = rowOf(w, vm);
    assert.equal(rerun.state, 'dropped');
    assert.match(rerun.reason, reason);
    const reads = runReads(w);
    await ticks(w, launcher, 12);
    assert.equal(runReads(w), reads, 'a settled rerun is not read again');
  });
}

test('no rerun when the job itself did not fail (it ended before its VM was preempted)', async () => {
  const { w, launcher } = setup();
  const { job, vm, run } = await lose(w, launcher);
  job.conclusion = 'success';
  complete(run);
  await ticks(w, launcher, 6);
  assert.deepEqual(reruns(w), []);
  assert.deepEqual([rowOf(w, vm).rerun.state, rowOf(w, vm).rerun.reason], ['dropped', 'job success']);
});

test('an owed rerun survives a restart: a new launcher reads it from the ledger and fires it', async () => {
  const { w, launcher, make } = setup();
  const { job, vm, run } = await lose(w, launcher);
  complete(run);
  const restarted = make();
  await restarted.tick();
  assert.deepEqual(reruns(w), [`rerun job ${job.id}`]);
  assert.equal(rowOf(w, vm).rerun.state, 'fired');
  // The old process, still holding its stale view, cannot rerun the next attempt for the same loss.
  complete(run);
  await ticks(w, launcher, 6);
  assert.deepEqual(reruns(w), [`rerun job ${job.id}`]);
});

test('two jobs of one run lost to preemptions: its failed jobs are rerun once', async () => {
  const { w, launcher } = setup();
  const first = await lose(w, launcher, { name: 'ci / a' });
  const second = await lose(w, launcher, { name: 'ci / b', run: first.run.id });
  complete(first.run);
  await ticks(w, launcher, 6);
  assert.deepEqual(reruns(w), [`rerun failed jobs of run ${first.run.id}`]);
  assert.deepEqual([rowOf(w, first.vm).rerun.how, rowOf(w, second.vm).rerun.how], ['failed-jobs', 'failed-jobs']);
});

test('a rerun GitHub refuses is dropped and logged at ERROR; one that fails transiently stays owed and fires later', async () => {
  const refused = setup();
  const errors = [];
  refused.launcher.error = (m) => errors.push(m);
  const a = await lose(refused.w, refused.launcher);
  complete(a.run);
  refused.w.hooks.rerun = async () => { throw Object.assign(new Error('HTTP 403: Resource not accessible by integration'), { status: 403 }); };
  await ticks(refused.w, refused.launcher, 6);
  assert.equal(rowOf(refused.w, a.vm).rerun.state, 'dropped');
  assert.match(errors.join('\n'), /rerun of run \d+ .* refused: HTTP 403/);

  const flaky = setup();
  const b = await lose(flaky.w, flaky.launcher);
  complete(b.run);
  flaky.w.hooks.rerun = async () => { throw Object.assign(new Error('HTTP 502'), { status: 502 }); };
  await ticks(flaky.w, flaky.launcher, 6);
  assert.equal(rowOf(flaky.w, b.vm).rerun.state, 'owed');
  delete flaky.w.hooks.rerun;
  await ticks(flaky.w, flaky.launcher, 6);
  assert.deepEqual(reruns(flaky.w), [`rerun job ${b.job.id}`]);
  assert.equal(rowOf(flaky.w, b.vm).rerun.state, 'fired');
});

test('no rerun once the run is at its third attempt: the cap stops repeated preemptions chaining reruns', async () => {
  const { w, launcher } = setup();
  const first = await lose(w, launcher, { name: 'ci / a' });
  first.run.run_attempt = 3; // reruns 1 and 2 were lost too
  for (const j of w.gh.jobs) j.run_attempt = 3;
  complete(first.run);
  await ticks(w, launcher, 6);
  assert.deepEqual(reruns(w), []);
  assert.deepEqual([rowOf(w, first.vm).rerun.state, rowOf(w, first.vm).rerun.reason], ['dropped', 'attempt cap']);
});

test('attempt 2 lost to a preemption is still rerun: the cap is the third attempt', async () => {
  const { w, launcher } = setup();
  const { job, vm, run } = await lose(w, launcher);
  run.run_attempt = 2;
  job.run_attempt = 2;
  complete(run);
  await ticks(w, launcher, 6);
  assert.deepEqual(reruns(w), [`rerun job ${job.id}`]);
  assert.deepEqual([rowOf(w, vm).rerun.state, rowOf(w, vm).rerun.attempt, run.run_attempt], ['fired', 2, 3]);
});
