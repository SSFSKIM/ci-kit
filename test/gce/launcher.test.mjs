// The GCE launcher's orchestration (gce/launcher/launcher.mjs) against one shared fake of Compute Engine and GitHub
// (fake-world.mjs): a job's whole lifecycle, the idle rule and its race, two launchers at once, the crash windows,
// preemption, and a repo leaving gce.json (the move between backends, reversed). Spec §3a, M10 "Tests beyond the
// pure functions".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { world, gceErr } from './fake-world.mjs';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { parseRow, launchRow, renderRow, finalRow, runningRow } from '../../gce/launcher/ledger.mjs';
import { parseGceConfig } from '../../gce/launcher/config.mjs';
import { allocationId, instanceName, jobInstance, jitRequest } from '../../gce/launcher/logic.mjs';
import { GceError } from '../../lib/gce.mjs';

const SBX = 'SSFSKIM/ci-kit-sandbox';
const BASE_CFG = parseGceConfig(readFileSync(new URL('../../pool/config/gce.json', import.meta.url), 'utf8'));
const CFG = { ...BASE_CFG, repos: [{ repo: SBX }] };
const T0 = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60_000;
const L = (n) => ['self-hosted', 'ci-kit-pool', `cpus-${n}`];
const COMMIT = 'c0ffee00aabbccddeeff00112233445566778899';

function setup({ cfg = CFG, poolRepos = [], start = T0, w = world({ start }), random } = {}) {
  let seq = 0;
  const make = (overrides = {}) => new Launcher({
    gce: w.gce, gh: w.github, ledger: createGceLedger(w.github, cfg.ledger, { now: w.now }), cfg, config: COMMIT, poolRepos,
    now: w.now, random: random ?? (() => (seq += 1)), alert: async (a) => w.log.push(`alert ${a.title}`), ...overrides,
  });
  return { w, launcher: make(), make };
}

const rows = (w) => {
  const byAlloc = new Map();
  for (const c of w.gh.comments) {
    const r = parseRow(c.body);
    if (r) byAlloc.set(r.alloc, [...(byAlloc.get(r.alloc) ?? []), r]);
  }
  return byAlloc;
};
const only = (map) => {
  assert.equal(map.size, 1, `one allocation: ${[...map.keys()]}`);
  const [list] = map.values();
  assert.equal(list.length, 1, 'one comment for it');
  return list[0];
};
const vms = (w) => w.g.instances.map((i) => i.name);
const leftovers = (w) => ({ instances: w.g.instances.length, disks: w.g.disks.length, runners: [...w.gh.runners.values()].flat().length });

test('a job\'s whole life: launch, run, power off, delete, one final row with the job it ran; nothing left', async () => {
  const { w, launcher } = setup();
  const job = w.sim.queue(SBX, L(4), { name: 'ci / nproc' });
  const first = await launcher.tick();
  assert.equal(first.launched.length, 1);
  const [name] = vms(w);
  const vm = w.sim.vm(name);
  assert.equal(vm.machineType.split('/').pop(), 'c3d-highcpu-4');
  assert.equal(vm.labels['ci-kit'], 'gce');
  assert.equal(vm.labels['ci-kit-config'], 'c0ffee00');
  assert.equal(vm.scheduling.provisioningModel, 'SPOT');
  assert.deepEqual(w.sim.runner(SBX, name).labels.map((l) => l.name), ['self-hosted', 'ci-kit-pool', 'cpus-4', 'ci-kit-gce']);
  assert.equal(only(rows(w)).state, 'running');

  // A second tick while it boots launches nothing more: its unclaimed runner covers the job.
  w.advance(30_000);
  assert.deepEqual((await launcher.tick()).launched, []);

  w.sim.boot(SBX, name);
  w.sim.take(SBX, name, job);
  w.advance(MIN);
  await launcher.tick();
  assert.deepEqual(only(rows(w)).job, { id: job.id, name: 'ci / nproc' }, 'the job goes on the row while it runs');

  w.advance(2 * MIN);
  w.sim.finish(SBX, name, job);
  await launcher.tick();
  assert.equal(only(rows(w)).state, 'deleting');
  assert.deepEqual(vms(w), []);
  w.advance(MIN);
  await launcher.tick();
  const row = only(rows(w));
  assert.equal(row.state, 'final');
  assert.equal(row.end, 'done');
  assert.equal(row.seconds, 210);
  assert.ok(row.dollars > 0);
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
});

test('an idle VM (its job went elsewhere) is unregistered first, then deleted, and finalized cancelled-idle', async () => {
  const { w, launcher } = setup();
  const job = w.sim.queue(SBX, L(2));
  await launcher.tick();
  const [name] = vms(w);
  w.sim.boot(SBX, name);
  job.status = 'completed'; // cancelled before pickup
  w.gh.runs[0].status = 'completed';
  w.advance(9 * MIN);
  await launcher.tick();
  assert.deepEqual(vms(w), [name], 'younger than idle_runner_minutes');
  w.advance(MIN);
  await launcher.tick();
  const order = w.log.filter((l) => l.includes(name) && /^(unregister|delete)/.test(l));
  assert.deepEqual(order, [`unregister ${name}`, `delete ${name}`]);
  w.advance(MIN);
  await launcher.tick();
  assert.equal(only(rows(w)).end, 'cancelled-idle');
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
});

test('the idle race: a runner takes a job between the idle read and the unregister call, and its VM survives', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  await launcher.tick();
  const [name] = vms(w);
  w.sim.boot(SBX, name);
  const late = w.sim.queue(SBX, L(4)); // a second job; nobody launched for it yet, as if its run had just been queued
  w.hooks.beforeUnregister = (repo, r) => {
    if (r?.name === name) w.sim.take(repo, name, late); // GitHub assigns the job first
  };
  w.advance(10 * MIN);
  await launcher.tick();
  assert.ok(vms(w).includes(name), 'the VM is still there');
  assert.equal(w.sim.runner(SBX, name).busy, true);
  const row = [...rows(w).values()].flat().find((r) => r.instance === name);
  assert.equal(row.state, 'running', 'no deleting row was written');
});

test('a failed runner listing is never read as idleness, and launches nothing for that repo', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  await launcher.tick();
  const [name] = vms(w);
  w.sim.boot(SBX, name);
  w.advance(20 * MIN);
  w.sim.queue(SBX, L(4));
  w.hooks.runnersFail = () => true;
  const out = await launcher.tick();
  assert.deepEqual(vms(w), [name]);
  assert.deepEqual(out.launched, []);
});

test('two launchers with different demand snapshots: rows unique per allocation, no double delete or unregister beyond a 404, over-launch healed by the idle rule', async () => {
  const { w, launcher, make } = setup();
  const jobs = [w.sim.queue(SBX, L(4)), w.sim.queue(SBX, L(8))];
  // The second launcher's view of GCE and its runners is from before the first one launched (a stale snapshot).
  const staleInstances = await w.gce.instances();
  const staleRunners = await w.github.runners(SBX);
  const stale = make({
    gce: { ...w.gce, instances: async () => staleInstances.map((i) => structuredClone(i)) },
    gh: { ...w.github, runners: async (repo) => (repo === SBX ? staleRunners.map((r) => ({ ...r })) : w.github.runners(repo)) },
  });
  await launcher.tick();
  await stale.tick();
  assert.equal(vms(w).length, 4, 'both launched for the same two jobs');
  const names = vms(w);
  // Two runners take the jobs; the other two stay idle.
  for (const [i, job] of jobs.entries()) {
    const name = names.find((n) => w.sim.vm(n).labels['ci-kit-cpus'] === String(job.labels[2].slice(5)) && !w.sim.runner(SBX, n).busy);
    w.sim.boot(SBX, name);
    w.sim.take(SBX, name, job);
    assert.ok(i < 2);
  }
  for (const n of names) if (!w.sim.runner(SBX, n).busy) w.sim.boot(SBX, n);
  w.advance(10 * MIN);
  const both = await Promise.all([launcher.tick(), make().tick()]);
  assert.equal(both.flatMap((o) => o.launched).length, 0);
  w.advance(MIN);
  await Promise.all([launcher.tick(), make().tick()]);
  assert.equal(vms(w).length, 2, 'the two idle VMs are gone, the busy two stay');
  for (const [key, n] of w.counts) assert.equal(n, 1, `${key} deleted or unregistered once`);
  const all = rows(w);
  assert.equal(all.size, 4);
  for (const [alloc, list] of all) assert.equal(list.length, 1, `one comment for ${alloc}`);
  assert.deepEqual([...all.values()].flat().filter((r) => r.state === 'final').map((r) => r.end), ['cancelled-idle', 'cancelled-idle']);
});

test('a quota refusal is a wait: nothing left behind, the row abandoned, the job still queued for a later tick', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  w.g.insertErrors.push({ match: () => true, error: () => new GceError(403, "Quota 'C3D_CPUS' exceeded", ['quotaExceeded']) });
  const out = await launcher.tick();
  assert.deepEqual(out.launched, []);
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
  assert.equal(only(rows(w)).end, 'abandoned');
  w.advance(MIN);
  assert.equal((await launcher.tick()).launched.length, 1, 'the next tick launches once quota allows');
});

test('spot refused in every zone: the same machine on demand, recorded on the row', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(8));
  for (const z of BASE_CFG.zones) w.g.insertErrors.push({ match: (zone, body) => zone === z && body.scheduling.provisioningModel === 'SPOT', error: gceErr(['ZONE_RESOURCE_POOL_EXHAUSTED']) });
  await launcher.tick();
  const [name] = vms(w);
  assert.equal(w.sim.vm(name).labels['ci-kit-provisioning'], 'standard');
  assert.equal(w.sim.vm(name).zone.split('/').pop(), 'us-central1-a');
  const row = only(rows(w));
  assert.deepEqual([row.provisioning, row.machine], ['standard', 'c3d-highcpu-8']);
});

test('an insert whose call timed out but which GCE accepted is found through its zone operation; no second zone is tried', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  w.g.insertErrors.push({ match: () => true, accepted: true, error: () => new Error('The operation was aborted due to timeout') });
  await launcher.tick();
  assert.equal(vms(w).length, 1);
  assert.equal(w.log.filter((l) => l.startsWith('insert ')).length, 1);
  assert.equal(only(rows(w)).state, 'running');
});

// Crash windows: the state a launcher that died at each point leaves, and what the next ticks make of it.
async function crashed({ state, runner = false, instance = null, at = T0 - 2 * MIN }) {
  const { w, launcher } = setup();
  const alloc = allocationId(at, () => 7);
  const name = instanceName(alloc);
  let row = launchRow({ alloc, repo: SBX, cpus: 4, at, config: COMMIT });
  if (runner) await w.github.jitConfig(SBX, jitRequest(alloc, 4));
  if (instance) {
    await w.gce.insertInstance('us-central1-a', jobInstance({ alloc, zone: 'us-central1-a', machine: 'c3d-highcpu-4', provisioning: 'spot', repo: SBX, cpus: 4, image: 'i', jit: 'j', cfg: CFG, config: COMMIT }));
    w.sim.vm(name).status = instance;
    w.sim.vm(name).creationTimestamp = new Date(at + 5_000).toISOString();
  }
  if (state !== 'launching') row = runningRow(row, { zone: 'us-central1-a', machine: 'c3d-highcpu-4', provisioning: 'spot', created: at + 5_000 });
  if (state === 'deleting') row = finalRow(row, { end: 'done', deleted: T0 - MIN, diskGb: 50, state: 'deleting' });
  w.gh.comments.push({ id: 1, body: renderRow(row), updated_at: new Date(at).toISOString() });
  return { w, launcher, name };
}
async function settle(w, launcher, minutes = 12) {
  for (let m = 0; m < minutes; m += 1) {
    await launcher.tick();
    w.advance(MIN);
  }
}

test('crash after the provisional row (before the mint): abandoned after 10 min, nothing left', async () => {
  const { w, launcher } = await crashed({ state: 'launching' });
  await settle(w, launcher);
  assert.equal(only(rows(w)).end, 'abandoned');
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
});

test('crash after the JIT mint (before the insert): the runner is unregistered after 5 min, the row abandoned', async () => {
  const { w, launcher, name } = await crashed({ state: 'launching', runner: true });
  await settle(w, launcher);
  assert.ok(w.log.includes(`unregister ${name}`));
  assert.equal(only(rows(w)).end, 'abandoned');
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
});

test('crash after an accepted insert (before the row said running): the VM is adopted and runs its course', async () => {
  const { w, launcher, name } = await crashed({ state: 'launching', runner: true, instance: 'RUNNING' });
  await launcher.tick();
  assert.equal(only(rows(w)).state, 'running');
  const job = w.sim.queue(SBX, L(4));
  w.sim.take(SBX, name, job);
  w.sim.finish(SBX, name, job);
  await settle(w, launcher, 2);
  const row = only(rows(w));
  assert.deepEqual([row.state, row.end, row.job?.id], ['final', 'done', job.id]);
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
});

test('crash between the deleting row and the delete call: the next tick deletes and keeps the row\'s end', async () => {
  const { w, launcher } = await crashed({ state: 'deleting', instance: 'TERMINATED' });
  await settle(w, launcher, 2);
  const row = only(rows(w));
  assert.deepEqual([row.state, row.end], ['final', 'done']);
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
});

test('crash after the delete call (before finalizing): the next tick finalizes', async () => {
  const { w, launcher } = await crashed({ state: 'deleting' });
  await launcher.tick();
  const row = only(rows(w));
  assert.deepEqual([row.state, row.end, row.deleted], ['final', 'done', new Date(T0 - MIN).toISOString()]);
});

test('a preempted spot VM: the row is finalized preempted with the job it held; its runner is cleaned once GitHub lets go', async () => {
  const { w, launcher } = setup();
  const job = w.sim.queue(SBX, L(8), { name: 'ci / unit' });
  await launcher.tick();
  const [name] = vms(w);
  w.sim.boot(SBX, name);
  w.sim.take(SBX, name, job);
  w.advance(MIN);
  await launcher.tick();
  w.advance(MIN);
  w.sim.preempt(name);
  w.sim.runner(SBX, name).status = 'offline'; // runner lost; GitHub still shows it busy until it fails the job
  await launcher.tick();
  const row = only(rows(w));
  assert.deepEqual([row.state, row.end, row.job], ['final', 'preempted', { id: job.id, name: 'ci / unit' }]);
  job.status = 'completed';
  w.sim.runner(SBX, name).busy = false;
  await settle(w, launcher, 6);
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
});

test('a VM Compute Engine deleted at its run limit is finalized max-run', async () => {
  const at = T0 - 121 * MIN;
  const { w, launcher } = await crashed({ state: 'running', at });
  await launcher.tick();
  const row = only(rows(w));
  assert.deepEqual([row.end, row.seconds], ['max-run', 120 * 60], 'billed from creation to the run limit');
});

test('a ci-kit=gce instance with no row is still cleaned, and gets an orphan row; orphan disks and old builders go', async () => {
  const { w, launcher } = setup();
  const alloc = allocationId(T0 - 30 * MIN, () => 3);
  await w.gce.insertInstance('us-central1-b', jobInstance({ alloc, zone: 'us-central1-b', machine: 'e2-highcpu-2', provisioning: 'spot', repo: SBX, cpus: 2, image: 'i', jit: 'j', cfg: CFG, config: COMMIT }));
  w.sim.vm(instanceName(alloc)).status = 'TERMINATED';
  w.g.disks.push({ name: 'stray', zone: 'zones/us-central1-c', users: [], labels: { 'ci-kit': 'gce' }, creationTimestamp: new Date(T0 - 20 * MIN).toISOString() });
  w.g.instances.push({ name: 'ci-kit-gce-builder-old', status: 'RUNNING', zone: 'zones/us-central1-a', labels: { 'ci-kit': 'gce-builder' }, creationTimestamp: new Date(T0 - 3 * 60 * MIN).toISOString(), machineType: 'x/e2-standard-4' });
  await settle(w, launcher, 2);
  assert.equal(only(rows(w)).end, 'orphan');
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
  assert.ok(!w.log.includes('delete devbox'), 'a foreign instance is never touched');
});

test('the bake\'s real job is not the launcher\'s: its job, its runner and its check VM in the sandbox are never served or swept', async () => {
  // As the bake leaves them (gce/bake/bake.mjs, spec §3a Image step 5): a job queued for the check runner's one label,
  // that runner registered and then taking the job, and the check VM labelled as the bake's, all within the bake's
  // 10 min bound and past the launcher's 5 min orphan and 10 min idle rules.
  const { w, launcher } = setup();
  const name = 'ci-kit-bake-20261016-115500-k3x9';
  const job = w.sim.queue(SBX, [name], { name: 'bake-check / candidate' });
  w.gh.runners.set(SBX, [{ id: 77, name, status: 'offline', busy: false, labels: [{ name }] }]);
  w.g.instances.push({
    name: 'ci-kit-gce-builder-20261016-115500-k3x9-check', status: 'RUNNING', zone: 'https://www.googleapis.com/compute/v1/projects/ssfskim-ci-kit/zones/us-central1-a',
    labels: { 'ci-kit': 'gce-builder', 'ci-kit-run': '20261016-115500-k3x9', 'ci-kit-role': 'check' }, creationTimestamp: new Date(T0 - MIN).toISOString(),
    machineType: 'https://www.googleapis.com/compute/v1/projects/ssfskim-ci-kit/zones/us-central1-a/machineTypes/e2-highcpu-2',
  });
  for (let i = 0; i < 12; i += 1) {
    if (i === 6) w.sim.take(SBX, name, job);
    const out = await launcher.tick();
    assert.deepEqual([out.launched, out.deleted, out.unregistered], [[], [], []], `tick ${i}`);
    w.advance(MIN);
  }
  assert.equal(w.gh.runners.get(SBX).length, 1);
  assert.equal(w.g.instances.length, 1);
  assert.equal(w.gh.comments.length, 0, 'no ledger row for it');
});

// The move between backends, reversed for gce.json (spec §3a, M10 Tests: "The same checks run in reverse").
test('a repo removed from gce.json drains: its busy VM (a job over 5 min) finishes, its idle runner goes at once, its queued jobs wait', async () => {
  const { w, launcher, make } = setup();
  const long = w.sim.queue(SBX, L(4));
  const spare = w.sim.queue(SBX, L(2));
  await launcher.tick();
  const [busy, idle] = vms(w).sort((a, b) => (w.sim.vm(a).labels['ci-kit-cpus'] === '4' ? -1 : 1));
  w.sim.boot(SBX, busy);
  w.sim.take(SBX, busy, long);
  w.sim.boot(SBX, idle);
  spare.status = 'completed';
  // Step 1 of the reverse move: the repo leaves gce.json (and is in neither file while it moves).
  const removed = make({ cfg: { ...CFG, repos: [] } });
  w.sim.queue(SBX, L(4)); // queued during the move
  for (let m = 0; m < 7; m += 1) {
    const out = await removed.tick();
    assert.deepEqual(out.launched, [], 'nothing launches for a repo in neither file');
    w.advance(MIN);
  }
  assert.deepEqual(vms(w), [busy], 'the idle runner went at once; the busy VM is still running its job after 7 min');
  assert.ok(w.log.indexOf(`unregister ${idle}`) < w.log.indexOf(`delete ${idle}`));
  w.sim.finish(SBX, busy, long);
  await removed.tick();
  w.advance(MIN);
  await removed.tick();
  const ends = [...rows(w).values()].flat().map((r) => [r.instance, r.state, r.end]);
  assert.deepEqual(ends.sort(), [[busy, 'final', 'done'], [idle, 'final', 'cancelled-idle']].sort());
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
});

test('a repo in both files is served by neither, and alerted', async () => {
  const { w, launcher } = setup({ poolRepos: [SBX] });
  w.sim.queue(SBX, L(4));
  const out = await launcher.tick();
  assert.deepEqual(out.launched, []);
  assert.ok(w.log.some((l) => l.startsWith(`alert ci-kit alert: ${SBX} is in both`)));
});

test('a public repo is refused', async () => {
  const w = world({ start: T0, repos: { [SBX]: { private: false } } });
  const { launcher } = setup({ w });
  w.sim.queue(SBX, L(4));
  assert.deepEqual((await launcher.tick()).launched, []);
});

test('the daily line is written once, early in the UTC day, from yesterday\'s final rows', async () => {
  const start = Date.parse('2026-10-17T00:30:00Z');
  const { w, launcher } = setup({ start, w: world({ start }) });
  const alloc = allocationId(Date.parse('2026-10-16T20:00:00Z'), () => 1);
  const row = finalRow(runningRow(launchRow({ alloc, repo: SBX, cpus: 4, at: Date.parse('2026-10-16T20:00:00Z'), config: COMMIT }),
    { zone: 'us-central1-a', machine: 'c3d-highcpu-4', provisioning: 'spot', created: Date.parse('2026-10-16T20:00:05Z') }), { end: 'done', deleted: Date.parse('2026-10-16T20:05:05Z'), diskGb: 50 });
  w.gh.comments.push({ id: 1, body: renderRow(row), updated_at: '2026-10-16T20:05:05Z' });
  await launcher.tick();
  w.advance(MIN);
  await launcher.tick();
  const daily = w.gh.comments.filter((c) => c.body.includes('ci-kit-gce-daily'));
  assert.equal(daily.length, 1);
  assert.match(daily[0].body, /GCE pool, 2026-10-16 \(UTC\):\*\* 1 VMs, 300 VM-seconds/);
  assert.match(daily[0].body, /gce\.json\) c0ffee00/);
  w.advance(2 * 3600_000);
  await launcher.tick();
  assert.equal(w.gh.comments.filter((c) => c.body.includes('ci-kit-gce-daily')).length, 1);
});

// Fix wave 1 (high-rung review): orchestration regressions.
test('review 3: while a zone is unreachable, nothing launches and nothing is finalized or unregistered for being absent', async () => {
  const { w, launcher } = setup();
  const job = w.sim.queue(SBX, L(4));
  await launcher.tick();
  const [name] = vms(w);
  w.sim.boot(SBX, name);
  w.sim.take(SBX, name, job);
  w.sim.queue(SBX, L(4));
  w.hooks.unreachable = w.sim.vm(name).zone.split('/').pop();
  for (let m = 0; m < 6; m += 1) {
    w.advance(MIN);
    assert.deepEqual((await launcher.tick()).launched, []);
  }
  assert.equal(only(rows(w)).state, 'running');
  assert.ok(!w.log.includes(`unregister ${name}`));
  delete w.hooks.unreachable;
  assert.equal((await launcher.tick()).launched.length, 1, 'once the listing is whole, the waiting job launches');
});

test('review 4: a draining repo whose busy VM is preempted keeps being listed until its runner is unregistered', async () => {
  const { w, launcher, make } = setup();
  const job = w.sim.queue(SBX, L(4));
  await launcher.tick();
  const [name] = vms(w);
  w.sim.boot(SBX, name);
  w.sim.take(SBX, name, job);
  const removed = make({ cfg: { ...CFG, repos: [] } });
  w.advance(MIN);
  await removed.tick();
  w.sim.preempt(name);
  w.sim.runner(SBX, name).status = 'offline';
  await removed.tick();
  assert.equal(only(rows(w)).end, 'preempted');
  w.advance(5 * MIN);
  job.status = 'completed';
  w.sim.runner(SBX, name).busy = false; // GitHub failed the job; its runner is free
  for (let m = 0; m < 6; m += 1) {
    await removed.tick();
    w.advance(MIN);
  }
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
});

test('review 6: the job a runner held is found when its run began long before the allocation', async () => {
  const { w, launcher } = setup();
  const job = w.sim.queue(SBX, L(4), { name: 'ci / late' }); // its run was created now
  w.advance(40 * MIN); // the job waited 40 min (a slow hosted job before it)
  await launcher.tick();
  const [name] = vms(w);
  w.sim.boot(SBX, name);
  w.sim.take(SBX, name, job);
  w.sim.finish(SBX, name, job); // started and ended between two ticks: never seen running
  w.advance(MIN);
  await launcher.tick();
  w.advance(MIN);
  await launcher.tick();
  assert.deepEqual(only(rows(w)).job, { id: job.id, name: 'ci / late' });
});

test('review 7: with GCE\'s operation history unreadable, a vanished VM\'s row waits; it is classified once history reads', async () => {
  const { w, launcher } = setup();
  const job = w.sim.queue(SBX, L(4));
  await launcher.tick();
  const [name] = vms(w);
  w.sim.boot(SBX, name);
  w.sim.take(SBX, name, job);
  w.advance(MIN);
  w.sim.preempt(name);
  w.hooks.operationsFail = true;
  await launcher.tick();
  assert.equal(only(rows(w)).state, 'running');
  delete w.hooks.operationsFail;
  await launcher.tick();
  assert.equal(only(rows(w)).end, 'preempted');
});

test('fix wave 2: an allocation id drawn twice is drawn again: two launches in one minute from a repeating source stay distinct', async () => {
  const draws = [5, 5, 5, 6];
  const { w, launcher } = setup({ random: () => draws.shift() ?? 7 });
  w.sim.queue(SBX, L(4));
  w.sim.queue(SBX, L(4));
  const out = await launcher.tick();
  assert.equal(out.launched.length, 2);
  assert.equal(new Set(out.launched).size, 2);
  assert.equal(rows(w).size, 2);
});

test('fix wave 2: an id already in the ledger window is never reused', async () => {
  const { w, launcher } = setup({ random: (() => { const d = [3, 4]; return () => d.shift() ?? 8; })() });
  const taken = allocationId(T0, () => 3);
  w.gh.comments.push({ id: 1, body: renderRow(finalRow(launchRow({ alloc: taken, repo: SBX, cpus: 4, at: T0 - 10_000, config: COMMIT }), { end: 'abandoned', deleted: T0 - 5_000, diskGb: 50 })), updated_at: new Date(T0).toISOString() });
  w.sim.queue(SBX, L(4));
  const out = await launcher.tick();
  assert.deepEqual(out.launched, [instanceName(allocationId(T0, () => 4))]);
  assert.equal([...rows(w).get(taken)].length, 1, 'the old row is untouched');
});

test('step 4: a VM whose job reported its end is deleted on the next tick, while the guest is still shutting down', async () => {
  const { w, launcher } = setup();
  const job = w.sim.queue(SBX, L(4));
  await launcher.tick();
  const [name] = vms(w);
  w.sim.boot(SBX, name);
  w.sim.take(SBX, name, job);
  w.advance(MIN);
  await launcher.tick();
  assert.ok(!w.log.includes(`read ci-kit/job ${name}`), 'a busy runner\'s VM is not read');
  w.sim.finish(SBX, name, job, { poweredOff: false });
  w.advance(20_000);
  await launcher.tick();
  assert.deepEqual(vms(w), [], 'deleted before it powered off');
  w.advance(MIN);
  await launcher.tick();
  const row = only(rows(w));
  assert.deepEqual([row.state, row.end, row.job?.id], ['final', 'done', job.id]);
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
});

test('step 4: an insert started late in the tick still waits its own deadline; the tick\'s budget only stops new attempts', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  w.hooks.beforeJit = () => w.advance(44_000); // the mint returns 44 s into a 45 s budget
  await launcher.tick();
  assert.ok(w.log.some((l) => /^insert-wait ci-kit-gce-\S+ 40000$/.test(l)), w.log.filter((l) => l.startsWith('insert-wait')).join('; '));
  assert.equal(vms(w).length, 1);
});

test('review (PR #20): a report beside a registered runner never deletes the VM if the runner takes a job before it is unregistered', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  await launcher.tick();
  const [name] = vms(w);
  w.sim.boot(SBX, name);
  w.sim.vm(name).attrs = { 'ci-kit/job': 'failed:unit' }; // a report left beside a runner that has not taken a job yet
  const late = w.sim.queue(SBX, L(4));
  w.hooks.beforeUnregister = (repo, r) => {
    if (r?.name === name) w.sim.take(repo, name, late); // GitHub assigns it a job first: the unregister gets 422
  };
  w.advance(MIN);
  await launcher.tick();
  assert.ok(vms(w).includes(name), 'the VM survives the refused unregister');
  const row = [...rows(w).values()].flat().find((r) => r.instance === name);
  assert.equal(row.state, 'running', 'no deleting row: its job is running');
});

// ci-kit#25: the ledger issue rotates before GitHub's 2,500-comment cap, and a job in flight across the rotation keeps
// its one row on the old issue, finalized there.
test('ledger rotation: a launch near the cap lands on a new issue, and a job in flight keeps its row on the old one', async () => {
  const { w, launcher } = setup();
  w.gh.issues[0].older = 1990;
  const first = w.sim.queue(SBX, L(4));
  await launcher.tick();
  const [a] = vms(w);
  assert.deepEqual(w.gh.comments.map((c) => c.issue), [1]);
  w.gh.issues[0].older = 2499; // the next comment on #1 would be its 2,500th, then nothing more is accepted
  w.sim.boot(SBX, a);
  w.sim.take(SBX, a, first);
  w.advance(MIN);
  const second = w.sim.queue(SBX, L(4));
  assert.equal((await launcher.tick()).launched.length, 1, 'the launch is not stopped by the old issue');
  const fresh = w.gh.issues.find((i) => i.number !== 1);
  assert.equal(fresh.title, 'pool ledger from 2026-10-16');
  const b = vms(w).find((n) => n !== a);
  const issueOf = (name) => w.gh.comments.filter((c) => parseRow(c.body)?.instance === name).map((c) => c.issue);
  assert.deepEqual(issueOf(b), [fresh.number]);
  w.advance(MIN);
  w.sim.finish(SBX, a, first);
  w.sim.boot(SBX, b);
  w.sim.take(SBX, b, second);
  await launcher.tick();
  w.advance(MIN);
  await launcher.tick();
  const byAlloc = rows(w);
  assert.equal(byAlloc.size, 2);
  for (const list of byAlloc.values()) assert.equal(list.length, 1, 'one comment per allocation');
  assert.deepEqual(issueOf(a), [1], 'the row stayed where it was written');
  assert.equal(parseRow(w.gh.comments.find((c) => c.issue === 1).body).state, 'final');
  assert.equal(parseRow(w.gh.comments.find((c) => c.issue === fresh.number).body).state, 'running');
});
