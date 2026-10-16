// The pool agent's decisions (spec §3 Pool agent, Heartbeat, Watchdog, Container deadline, Lifecycle) as pure
// functions over recorded API shapes: GitHub's jobs/runs/runners and the agent's view of its containers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpusOf, parseCpuset, formatCpuset, allocateCores, planStarts, reviewContainers, isIdle, poolJobs, wantOf, queuedPoolJobs,
  lifecycleAction, billedMinute, heartbeatDue, watchdogVerdict, runnerName, nextCounter,
} from '../../pool/agent/logic.mjs';

const T0 = Date.parse('2026-10-15T12:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString().replace('.000Z', 'Z');
const MIN = 60_000;
const SBX = 'SSFSKIM/ci-kit-sandbox';
const MAWS = 'SSFSKIM/MAWS';
const L4 = ['self-hosted', 'ci-kit-pool', 'cpus-4'];

// A queued job as GitHub lists it (M4: started_at equals created_at until a runner takes it).
const job = (id, { repo = SBX, labels = L4, created = 0, status = 'queued' } = {}) => ({
  id, repo, run_id: 1000 + id, status, labels, created_at: at(created), started_at: at(created), name: `ci / g${id}`,
});
const runner = (id, { busy = false, status = 'online', name = `ci-kit-pool-55-${id}` } = {}) => ({ id, name, status, busy, labels: L4.map((n) => ({ name: n })) });
const container = (name, { repo = SBX, runnerId, labels = L4, cores = [0, 1, 2, 3], created = 0, running = true } = {}) => ({
  id: `c-${name}`, name, running, created: T0 + created * 1000, repo, runnerId, labels, cpus: cores.length, cores,
});

test('cpusOf reads one cpus-N label with N in 2, 4, 8, 16', () => {
  assert.equal(cpusOf(L4), 4);
  assert.equal(cpusOf(['self-hosted', 'ci-kit-pool', 'cpus-16']), 16);
  assert.equal(cpusOf(['self-hosted', 'ci-kit-pool']), null);
  assert.equal(cpusOf(['self-hosted', 'ci-kit-pool', 'cpus-3']), null);
  assert.equal(cpusOf(['self-hosted', 'ci-kit-pool', 'cpus-4', 'cpus-8']), null);
});

test('cpusets parse and format as ranges', () => {
  assert.deepEqual(parseCpuset('0-3,8,10-11'), [0, 1, 2, 3, 8, 10, 11]);
  assert.equal(formatCpuset([0, 1, 2, 3, 8, 10, 11]), '0-3,8,10-11');
  assert.equal(formatCpuset([5]), '5');
});

test('allocateCores prefers an aligned contiguous block, falls back to any free cores, never overcommits', () => {
  assert.deepEqual(allocateCores(16, new Set(), 4), [0, 1, 2, 3]);
  assert.deepEqual(allocateCores(16, new Set([0, 1, 2, 3]), 4), [4, 5, 6, 7]);
  assert.deepEqual(allocateCores(16, new Set([1, 5, 9, 13]), 4), [0, 2, 3, 4]);
  assert.equal(allocateCores(16, new Set([...Array(13).keys()]), 4), null);
  assert.deepEqual(allocateCores(16, new Set([...Array(12).keys()]), 4), [12, 13, 14, 15]);
  assert.equal(allocateCores(2, new Set(), 4), null);
});

test('queuedPoolJobs keeps only queued jobs that carry ci-kit-pool', () => {
  const jobs = [job(1), job(2, { status: 'in_progress' }), job(3, { labels: ['ubuntu-latest'] }), job(4, { labels: ['self-hosted', 'ci-kit-pool', 'cpus-8'] })];
  assert.deepEqual(queuedPoolJobs(jobs).map((j) => j.id), [1, 4]);
});

test('admission never exceeds free cores: four cpus-4 jobs fill 16 cores and the fifth waits', () => {
  const queued = [1, 2, 3, 4, 5].map((i) => job(i, { created: i }));
  const { starts, waiting } = planStarts({ queued, idleRunners: [], totalCores: 16, usedCores: new Set() });
  assert.deepEqual(starts.map((s) => [s.job.id, formatCpuset(s.cores)]), [[1, '0-3'], [2, '4-7'], [3, '8-11'], [4, '12-15']]);
  assert.deepEqual(waiting.map((j) => j.id), [5]);
  const used = new Set(starts.flatMap((s) => s.cores));
  assert.equal(used.size, 16);
});

test('demand subtracts idle runners already started for the same repo and label set', () => {
  const queued = [job(1, { created: 1 }), job(2, { created: 2 }), job(3, { repo: MAWS, created: 3 })];
  const idleRunners = [{ repo: SBX, labels: L4 }, { repo: MAWS, labels: ['self-hosted', 'ci-kit-pool', 'cpus-8'] }];
  const { starts } = planStarts({ queued, idleRunners, totalCores: 16, usedCores: new Set([0, 1, 2, 3]) });
  // One sandbox cpus-4 job is covered by the idle sandbox runner; MAWS's cpus-8 runner does not cover a cpus-4 job.
  assert.deepEqual(starts.map((s) => s.job.id), [2, 3]);
});

test('jobs are admitted first in, first out by creation time; a job that does not fit holds the line', () => {
  const queued = [job(1, { created: 30 }), job(2, { created: 10, labels: ['self-hosted', 'ci-kit-pool', 'cpus-16'] }), job(3, { created: 20 })];
  const { starts, waiting } = planStarts({ queued, idleRunners: [], totalCores: 16, usedCores: new Set([0, 1]) });
  assert.deepEqual(starts, []);
  assert.deepEqual(waiting.map((j) => j.id), [2, 3, 1]);
});

test('a job larger than the box runs on all its cores once the box is otherwise empty, and says it was clamped', () => {
  // A cpus-16 job on a 12-core fallback box (spec Decision Log: a box smaller than a job runs it on all its cores).
  const big = job(1, { created: 1, labels: ['self-hosted', 'ci-kit-pool', 'cpus-16'] });
  const empty = planStarts({ queued: [big, job(3, { created: 3 })], idleRunners: [], totalCores: 12, usedCores: new Set() });
  assert.deepEqual(empty.starts.map((s) => [s.job.id, formatCpuset(s.cores), s.clamped]), [[1, '0-11', 16]]);
  assert.deepEqual(empty.waiting.map((j) => j.id), [3]);
  // Not empty: the big job holds the line until the box empties.
  const busy = planStarts({ queued: [big, job(3, { created: 3 })], idleRunners: [], totalCores: 12, usedCores: new Set([0, 1, 2, 3]) });
  assert.deepEqual(busy.starts, []);
  assert.deepEqual(busy.waiting.map((j) => j.id), [1, 3]);
  // A job that fits is never marked clamped.
  const fits = planStarts({ queued: [job(3)], idleRunners: [], totalCores: 12, usedCores: new Set() });
  assert.equal(fits.starts[0].clamped, undefined);
});

test('a job with no valid size is passed over rather than blocking the queue', () => {
  const queued = [job(2, { created: 2, labels: ['self-hosted', 'ci-kit-pool'] }), job(3, { created: 3 })];
  const { starts, unservable } = planStarts({ queued, idleRunners: [], totalCores: 8, usedCores: new Set() });
  assert.deepEqual(starts.map((s) => s.job.id), [3]);
  assert.deepEqual(unservable.map((u) => [u.job.id, u.reason]), [[2, 'no cpus-N label (N in 2, 4, 8, 16)']]);
});

const CFG = { idle_runner_minutes: 10 };
const index = (entries) => new Map(Object.entries(entries).map(([repo, rs]) => [repo, new Map(rs.map((r) => [r.id, r]))]));

test('an exited container is removed, and its runner unregistered if it is still registered and idle', () => {
  const { actions } = reviewContainers({
    containers: [container('a', { runnerId: 1, running: false }), container('b', { runnerId: 2, running: false })],
    runners: index({ [SBX]: [runner(1)] }), memory: new Map(), now: T0 + MIN, cfg: CFG,
  });
  assert.deepEqual(actions.map((a) => [a.container.name, a.kind, a.unregister]), [['a', 'remove', true], ['b', 'remove', false]]);
});

test('container deadline: killed 5 min after its runner left GitHub, not before', () => {
  const c = container('a', { runnerId: 1 });
  let memory = new Map();
  const step = (s) => {
    const r = reviewContainers({ containers: [c], runners: index({ [SBX]: [] }), memory, now: T0 + s * 1000, cfg: CFG });
    memory = r.memory;
    return r.actions;
  };
  assert.deepEqual(step(600), []); // first seen gone at 10:00
  assert.deepEqual(step(600 + 299), []);
  assert.deepEqual(step(600 + 300).map((a) => [a.kind, a.reason]), [['kill', 'runner-gone']]);
});

test('container deadline: killed at 6 h 15 min of age whatever its runner says', () => {
  const c = container('a', { runnerId: 1 });
  const age = (s) => reviewContainers({ containers: [c], runners: index({ [SBX]: [runner(1, { busy: true })] }), memory: new Map(), now: T0 + s * 1000, cfg: CFG }).actions;
  assert.deepEqual(age(6 * 3600 + 14 * 60), []);
  assert.deepEqual(age(6 * 3600 + 15 * 60).map((a) => [a.kind, a.reason, a.unregister]), [['kill', 'max-age', true]]);
});

test('a runner idle for 10 min is unregistered and its container stopped; a busy one resets the clock', () => {
  const c = container('a', { runnerId: 1 });
  let memory = new Map();
  const step = (s, busy) => {
    const r = reviewContainers({ containers: [c], runners: index({ [SBX]: [runner(1, { busy })] }), memory, now: T0 + s * 1000, cfg: CFG });
    memory = r.memory;
    return r.actions.map((a) => [a.kind, a.reason, a.unregister]);
  };
  assert.deepEqual(step(300, false), []);
  assert.deepEqual(step(599, false), []);
  assert.deepEqual(step(600, false), [['kill', 'idle-runner', true]]);
  memory = new Map();
  assert.deepEqual(step(590, true), []);
  assert.deepEqual(step(700, false), []); // idle from 700 now, not from the container's start
  assert.deepEqual(step(1299, false), []);
  assert.deepEqual(step(1300, false), [['kill', 'idle-runner', true]]);
});

test('memory forgets containers that are gone', () => {
  const { memory } = reviewContainers({ containers: [], runners: index({}), memory: new Map([['x', { goneSince: T0 }]]), now: T0, cfg: CFG });
  assert.equal(memory.size, 0);
});

test('pool jobs are the queued or in-progress jobs that carry ci-kit-pool, whatever workflow they are in', () => {
  const jobs = [job(1), job(2, { status: 'in_progress' }), job(3, { labels: ['ubuntu-latest'] }), job(4, { status: 'completed' }), job(5, { status: 'in_progress', labels: ['ubuntu-latest'] })];
  assert.deepEqual(poolJobs(jobs).map((j) => j.id), [1, 2]);
});

test('only pool demand keeps a box: a running container, a queued or in-progress pool job, or an ensure stamp under 15 min old', () => {
  const T = T0;
  const none = { containers: [], poolJobs: [], want: null, now: T };
  assert.equal(isIdle(none), true);
  assert.equal(isIdle({ ...none, poolJobs: [job(1)] }), false);
  assert.equal(isIdle({ ...none, poolJobs: [job(2, { status: 'in_progress' })] }), false);
  assert.equal(isIdle({ ...none, containers: [container('a', { runnerId: 1 })] }), false);
  assert.equal(isIdle({ ...none, containers: [container('a', { runnerId: 1, running: false })] }), true);
  // ensure's stamp holds the box for 15 min, then releases it
  assert.equal(isIdle({ ...none, want: T - 14 * MIN - 59_000 }), false);
  assert.equal(isIdle({ ...none, want: T - 15 * MIN }), true);
  assert.equal(wantOf({ 'ci-kit-want': String(Math.floor(T / 1000)) }), T);
  assert.equal(wantOf({ 'ci-kit-want': 'garbage' }), null);
  assert.equal(wantOf({}), null);
});

test('billedMinute counts minutes into the current billed hour from the server\'s created time', () => {
  assert.equal(billedMinute(T0, T0 + 49 * MIN + 59_000), 49);
  assert.equal(billedMinute(T0, T0 + 50 * MIN), 50);
  assert.equal(billedMinute(T0, T0 + 61 * MIN), 1);
});

test('lifecycle: ready drains when idle at minute ≥ 50; draining deletes on an idle re-check, returns to ready on work', () => {
  const step = (state, idle, minute) => lifecycleAction({ state, idle, minute, drainMinute: 50 });
  assert.equal(step('ready', true, 49), 'none');
  assert.equal(step('ready', false, 55), 'none');
  assert.equal(step('ready', true, 50), 'drain');
  assert.equal(step('draining', true, 51), 'delete');
  assert.equal(step('draining', false, 51), 'undrain');
  // The hour turned while draining (a run of failed ticks): this hour is paid, so ride it out.
  assert.equal(step('draining', true, 2), 'undrain');
  assert.equal(step('booting', true, 55), 'ready');
});

test('the heartbeat advances only after a fully successful tick, at most every 60 s', () => {
  assert.equal(heartbeatDue({ tickOk: false, lastBeat: null, now: T0 }), false);
  assert.equal(heartbeatDue({ tickOk: true, lastBeat: null, now: T0 }), true);
  assert.equal(heartbeatDue({ tickOk: true, lastBeat: T0, now: T0 + 59_000 }), false);
  assert.equal(heartbeatDue({ tickOk: true, lastBeat: T0, now: T0 + 60_000 }), true);
  assert.equal(heartbeatDue({ tickOk: false, lastBeat: T0, now: T0 + 3600_000 }), false);
});

test('watchdog: deletes after 30 min without a successful reconciliation, counting from boot until the first', () => {
  const server = { labels: { 'ci-kit': 'pool' }, created: at(-20) };
  const v = (o) => watchdogVerdict({ server, bootTime: T0, ...o });
  assert.equal(v({ lastSuccess: null, now: T0 + 29 * MIN }), null);
  assert.equal(v({ lastSuccess: null, now: T0 + 30 * MIN }), 'watchdog');
  assert.equal(v({ lastSuccess: T0 + 20 * MIN, now: T0 + 49 * MIN }), null);
  assert.equal(v({ lastSuccess: T0 + 20 * MIN, now: T0 + 50 * MIN }), 'watchdog');
});

test('watchdog: deletes a server up more than 24 h, however fresh its reconciliation', () => {
  const server = { labels: { 'ci-kit': 'pool' }, created: at(0) };
  assert.equal(watchdogVerdict({ server, bootTime: T0, lastSuccess: T0 + 24 * 3600_000, now: T0 + 24 * 3600_000 }), null);
  assert.equal(watchdogVerdict({ server, bootTime: T0, lastSuccess: T0 + 24 * 3600_000, now: T0 + 24 * 3600_000 + 1000 }), 'max-uptime');
});

test('watchdog: never deletes a server that does not carry ci-kit=pool', () => {
  for (const labels of [{}, { 'ci-kit': 'builder' }, { other: 'pool' }]) {
    assert.equal(watchdogVerdict({ server: { labels, created: at(0) }, bootTime: T0, lastSuccess: null, now: T0 + 48 * 3600_000 }), null);
  }
});

test('runner names are ci-kit-pool-<server id>-<counter>, and the counter resumes past every name already used', () => {
  assert.equal(runnerName(55, 7), 'ci-kit-pool-55-7');
  assert.equal(nextCounter(55, { label: '3', names: ['ci-kit-pool-55-9', 'ci-kit-pool-54-20', 'ci-kit-pool-55-x', 'other'] }), 10);
  assert.equal(nextCounter(55, { label: undefined, names: [] }), 1);
  assert.equal(nextCounter(55, { label: '12', names: ['ci-kit-pool-55-4'] }), 13);
});
