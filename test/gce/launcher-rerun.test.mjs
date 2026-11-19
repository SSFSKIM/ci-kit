// A job lost to a spot preemption is rerun without a human (launcher.mjs settleReruns): the preempted row owes its run
// a rerun, which fires once the run has completed with a failure in the attempt the job ran in, and the job failed
// because its runner was lost, and never otherwise.
// Against the shared fake of Compute Engine and GitHub (fake-world.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './fake-world.mjs';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { parseRow, renderRow } from '../../gce/launcher/ledger.mjs';
import { ONE_REGION_CFG } from './config-fixtures.mjs';
import { lostRunner } from '../../gce/launcher/logic.mjs';

const SBX = 'SSFSKIM/ci-kit-sandbox';
const CFG = { ...ONE_REGION_CFG, repos: [{ repo: SBX }] };
const T0 = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60_000;
const L = (n) => ['self-hosted', 'ci-kit-pool', `cpus-${n}`];
const COMMIT = 'c0ffee00aabbccddeeff00112233445566778899';

// A process as server.mjs runs one: a ledger store and the reruns' read times kept for its life, and a new Launcher
// every tick. `errors`: what it logged at ERROR.
function setup({ w = world({ start: T0 }) } = {}) {
  let seq = 0;
  const make = ({ cfg = CFG } = {}) => {
    const ledger = createGceLedger(w.github, cfg.ledger, { now: w.now });
    const rerunChecks = new Map();
    const errors = [];
    return {
      errors,
      tick: () => new Launcher({
        gce: w.gce, gh: w.github, ledger, cfg, config: COMMIT, now: w.now, random: () => (seq += 1), alert: async () => {},
        rerunChecks, error: (m) => errors.push(m),
      }).tick(),
    };
  };
  return { w, launcher: make(), make };
}

const rowOf = (w, name) => w.gh.comments.map((c) => parseRow(c.body)).find((r) => r?.instance === name);
const reruns = (w) => w.log.filter((l) => l.startsWith('rerun'));
const runReads = (w) => w.log.filter((l) => l.startsWith('get run')).length;

const iso = (ms) => new Date(ms).toISOString();
const steps = (last) => [{ name: 'Set up job', status: 'completed', conclusion: 'success' }, { name: 'test', ...last }];

// `job` (in its own run unless `run` is given) runs on a spot VM that is preempted: the row is finalized preempted with
// the job it held, and GitHub fails the job and frees the runner. `ending`: how the job ended. `lost`: its runner
// went outright (GitHub's lost-runner failure, its running step never concluded); `shutdown`: the guest's shutdown
// failed the running step as the VM went; `before`: it failed on its own and reported, and the VM was preempted
// afterwards, as it wound down; `upload`: its gate step failed, and the VM went during the upload after it.
async function lose(w, launcher, { name = 'ci / unit', run, ending = 'lost' } = {}) {
  const job = w.sim.queue(SBX, L(4), { name, run });
  const before = new Set(w.g.instances.map((i) => i.name));
  await launcher.tick();
  const vm = w.g.instances.find((i) => !before.has(i.name)).name;
  w.sim.boot(SBX, vm);
  w.sim.take(SBX, vm, job);
  w.advance(MIN);
  await launcher.tick();
  if (ending === 'before') {
    Object.assign(job, { status: 'completed', conclusion: 'failure', completed_at: iso(w.now()), steps: steps({ status: 'completed', conclusion: 'failure', completed_at: iso(w.now()) }) });
    w.advance(30_000);
  }
  w.sim.preempt(vm);
  w.sim.runner(SBX, vm).status = 'offline';
  if (ending === 'shutdown') Object.assign(job, { completed_at: iso(w.now() + 5_000), steps: steps({ status: 'completed', conclusion: 'failure', completed_at: iso(w.now() + 5_000) }) });
  if (ending === 'upload') { // the gate step failed, then the VM went during the artifact upload after it
    Object.assign(job, { completed_at: iso(w.now() + 10 * MIN), steps: [
      ...steps({ status: 'completed', conclusion: 'failure', completed_at: iso(w.now() - 20_000) }),
      { name: 'Upload artifacts', status: 'in_progress', conclusion: null },
    ] });
  }
  await launcher.tick();
  if (ending === 'lost') Object.assign(job, { completed_at: iso(w.now()), steps: steps({ status: 'in_progress', conclusion: null }) });
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

test('the rerun waits while the run is in progress (read at a cadence across per-tick launchers), fires once when it completes failed, and only once', async () => {
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
  const { errors } = refused.launcher;
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

test('a job that failed on its own before its VM was preempted is not rerun; one its guest\'s shutdown failed is', async () => {
  const red = setup();
  const a = await lose(red.w, red.launcher, { ending: 'before' });
  assert.equal(rowOf(red.w, a.vm).rerun.state, 'owed');
  complete(a.run);
  await ticks(red.w, red.launcher, 6);
  assert.deepEqual(reruns(red.w), []);
  assert.deepEqual([rowOf(red.w, a.vm).rerun.state, rowOf(red.w, a.vm).rerun.reason], ['dropped', 'not a lost runner']);

  const shutdown = setup();
  const b = await lose(shutdown.w, shutdown.launcher, { ending: 'shutdown' });
  complete(b.run);
  await ticks(shutdown.w, shutdown.launcher, 6);
  assert.deepEqual(reruns(shutdown.w), [`rerun job ${b.job.id}`]);
});

test('settling a rerun changes only the stored row\'s rerun, and only while it owes one for the same job', async () => {
  const w = world({ start: T0 });
  const ledger = createGceLedger(w.github, CFG.ledger, { now: w.now });
  const stored = {
    v: 2, provider: 'gce', account: null, alloc: 'a1', instance: 'ci-kit-gce-a1', repo: SBX, cpus: 4, at: iso(T0), config: 'c0ffee00',
    created: iso(T0), job: { id: 7, name: 'ci / unit', run: 70 }, rerun: { state: 'owed' }, deleted: iso(T0 + 5 * MIN), seconds: 300, dollars: 0.01, end: 'preempted', state: 'final',
  };
  w.gh.comments.push({ id: 1, body: renderRow(stored), updated_at: iso(T0) });
  await ledger.read();
  const stale = { ...stored, deleted: iso(T0 + 9 * MIN), seconds: 540, dollars: 0.02 };
  assert.equal(await ledger.settleRerun({ ...stale, job: { ...stale.job, id: 8 } }, { state: 'fired' }), null, 'another job: nothing written');
  assert.deepEqual(parseRow(w.gh.comments[0].body), stored);
  await ledger.settleRerun(stale, { state: 'fired', attempt: 1 });
  assert.deepEqual(parseRow(w.gh.comments[0].body), { ...stored, rerun: { state: 'fired', attempt: 1 } });
  assert.equal(await ledger.settleRerun(stale, { state: 'dropped' }), null, 'settled once');
  assert.equal(parseRow(w.gh.comments[0].body).rerun.state, 'fired');
});

test('a rerun refused because the run is running again (another launcher\'s won) stays owed, then settles from the attempt', async () => {
  const { w, launcher } = setup();
  const { vm, run } = await lose(w, launcher);
  complete(run);
  w.hooks.rerun = async () => {
    Object.assign(run, { status: 'in_progress', conclusion: null, run_attempt: 2 }); // the other launcher's rerun
    throw Object.assign(new Error('HTTP 403: This workflow is already running'), { status: 403 });
  };
  await ticks(w, launcher, 5);
  assert.equal(run.run_attempt, 2, 'the refused POST was sent');
  assert.equal(rowOf(w, vm).rerun.state, 'owed');
  delete w.hooks.rerun;
  complete(run);
  await ticks(w, launcher, 6);
  assert.deepEqual([rowOf(w, vm).rerun.state, rowOf(w, vm).rerun.reason], ['dropped', 'run 1000 is at attempt 2, the job ran in 1']);
  assert.deepEqual(launcher.errors, [], 'not a refusal');
});

test('a burst of owed reruns is read a few runs a tick, the least recently read first', async () => {
  const { w, launcher } = setup();
  const lost = [];
  for (let k = 0; k < 7; k += 1) lost.push(await lose(w, launcher, { name: `ci / ${k}` }));
  for (const l of lost) complete(l.run);
  w.advance(5 * MIN);
  const before = runReads(w);
  await launcher.tick();
  assert.equal(runReads(w) - before, 5);
  w.advance(MIN);
  await launcher.tick();
  assert.equal(runReads(w) - before, 7);
  assert.equal(reruns(w).length, 7);
});

test('no rerun for a repo the pool no longer serves, or a public repo\'s run for an event it does not serve', async () => {
  const { w, launcher, make } = setup();
  const a = await lose(w, launcher);
  complete(a.run);
  await make({ cfg: { ...CFG, repos: [] } }).tick();
  assert.deepEqual([rowOf(w, a.vm).rerun.state, rowOf(w, a.vm).rerun.reason], ['dropped', 'not served']);

  const pub = setup({ w: world({ start: T0, repos: { [SBX]: { private: false } } }) });
  const proc = pub.make({ cfg: { ...CFG, repos: [{ repo: SBX, allow_public: true }] } });
  const b = await lose(pub.w, proc);
  Object.assign(complete(b.run), { event: 'pull_request' });
  await ticks(pub.w, proc, 6);
  assert.deepEqual(reruns(pub.w), []);
  assert.deepEqual([rowOf(pub.w, b.vm).rerun.state, rowOf(pub.w, b.vm).rerun.reason], ['dropped', 'not served']);
});

test('a job whose gate step failed before the preemption is not rerun, though the preemption cut a later step short', async () => {
  const { w, launcher } = setup();
  const { vm, run } = await lose(w, launcher, { ending: 'upload' });
  complete(run);
  await ticks(w, launcher, 6);
  assert.deepEqual(reruns(w), []);
  assert.deepEqual([rowOf(w, vm).rerun.state, rowOf(w, vm).rerun.reason], ['dropped', 'not a lost runner']);
});

test('the sweep stops starting calls once its time budget is spent; what it left stays owed and goes first next tick', async () => {
  const { w, launcher } = setup();
  const lost = [];
  for (let k = 0; k < 5; k += 1) lost.push(await lose(w, launcher, { name: `ci / ${k}` }));
  for (const l of lost) complete(l.run);
  w.advance(5 * MIN);
  w.hooks.getRun = async () => w.advance(12_000); // each run read takes 12 s
  const before = runReads(w);
  await launcher.tick();
  assert.equal(runReads(w) - before, 3, 'reads start at 0, 12 and 24 s; none at 36 s');
  assert.equal(reruns(w).length, 2, 'the third read ends past the budget: its job read and POST wait');
  assert.deepEqual(lost.map((l) => rowOf(w, l.vm).rerun.state).sort(), ['fired', 'fired', 'owed', 'owed', 'owed']);
  delete w.hooks.getRun;
  w.advance(MIN);
  await launcher.tick();
  assert.equal(reruns(w).length, 5, 'the three left are read on the next tick');
});

// The two GCE preemptions of 2026-11-19 as GitHub reported them: the runner is told to stop inside the 30 s notice, so
// the running step ends `cancelled` and the job ends seconds before GCE records the preemption, and well before the
// launcher sees the VM gone (the time the row carries).
test('lostRunner: a step the shutdown cancelled is a loss, though the job ended before the launcher saw the VM gone', () => {
  const step = (conclusion, completed_at) => ({ name: 's', status: 'completed', conclusion, completed_at });
  const seen = Date.parse('2026-11-19T20:12:40Z'); // the launcher's tick after GCE's record at 20:11:50
  // MAWS run 44605433018, unit 3/4: the running step cancelled, nothing failed.
  assert.equal(lostRunner({ completed_at: '2026-11-19T20:11:39Z', steps: [step('success', '2026-11-19T20:09:25Z'), step('cancelled', '2026-11-19T20:11:37Z'), step('skipped', '2026-11-19T20:11:37Z')] }, seen), true);
  // MAWS run 44635029958, static-local: the shutdown killed setup-go's tar 13 s before the runner heard of it.
  const at = Date.parse('2026-11-19T23:11:00Z');
  const staticLocal = [step('success', '2026-11-19T23:09:35Z'), step('failure', '2026-11-19T23:09:39Z'), step('cancelled', '2026-11-19T23:09:52Z'), step('skipped', '2026-11-19T23:09:52Z')];
  assert.equal(lostRunner({ completed_at: '2026-11-19T23:09:53Z', steps: staticLocal }, at), true, 'a failure inside the notice before the cancel');
  // A gate that failed on its own, then an upload the shutdown cancelled minutes later: a red.
  const red = [step('failure', '2026-11-19T23:05:00Z'), step('cancelled', '2026-11-19T23:09:52Z')];
  assert.equal(lostRunner({ completed_at: '2026-11-19T23:09:53Z', steps: red }, at), false, 'a failure well before the cancel');
  assert.equal(lostRunner({ completed_at: '2026-11-19T23:09:53Z', steps: [step('failure', '2026-11-19T23:09:21Z'), step('cancelled', '2026-11-19T23:09:52Z')] }, at), false, '31 s before: outside the notice');
});

test('lostRunner: only a failed step timed before the preemption vetoes; one with no time leaves the loss signals to decide', () => {
  const at = T0;
  const failed = (completed_at) => ({ name: 'gate', status: 'completed', conclusion: 'failure', ...(completed_at ? { completed_at } : {}) });
  const unfinished = { name: 'upload', status: 'in_progress', conclusion: null };
  assert.equal(lostRunner({ steps: [failed(iso(at - 1000)), unfinished] }, at), false, 'a red before the preemption');
  assert.equal(lostRunner({ steps: [failed(null), unfinished] }, at), true, 'no time on the failed step: the unfinished step decides');
  assert.equal(lostRunner({ steps: [failed(null)], completed_at: iso(at + 5000) }, at), true, 'no time: the job\'s late end decides');
  assert.equal(lostRunner({ steps: [failed(null)], completed_at: iso(at - 5000) }, at), false, 'no time, and the job ended before');
  assert.equal(lostRunner({ steps: [failed(iso(at + 5000))], completed_at: iso(at + 5000) }, at), true, 'failed by the shutdown');
});
