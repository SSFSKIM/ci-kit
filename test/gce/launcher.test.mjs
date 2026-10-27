// The GCE launcher's orchestration (gce/launcher/launcher.mjs) against one shared fake of Compute Engine and GitHub
// (fake-world.mjs): a job's whole lifecycle, the idle rule and its race, two launchers at once, the crash windows,
// preemption, and a repo leaving gce.json (the move between backends, reversed). Spec §3a, M10 "Tests beyond the
// pure functions".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, gceErr } from './fake-world.mjs';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { parseRow, launchRow, renderRow, finalRow, runningRow, dollars } from '../../gce/launcher/ledger.mjs';
import { WEST, CENTRAL, ONE_REGION_CFG, M6_CFG } from './config-fixtures.mjs';
import { allocationId, instanceName, jobInstance, jitRequest, placements, stockoutMemory } from '../../gce/launcher/logic.mjs';
import { GceError } from '../../lib/gce.mjs';

const SBX = 'SSFSKIM/ci-kit-sandbox';
const BASE_CFG = ONE_REGION_CFG;
const CFG = { ...BASE_CFG, repos: [{ repo: SBX }] };
const T0 = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60_000;
const L = (n) => ['self-hosted', 'ci-kit-pool', `cpus-${n}`];
const COMMIT = 'c0ffee00aabbccddeeff00112233445566778899';

function setup({ cfg = CFG, start = T0, w = world({ start }), random } = {}) {
  let seq = 0;
  const make = (overrides = {}) => new Launcher({
    gce: w.gce, gh: w.github, ledger: createGceLedger(w.github, cfg.ledger, { now: w.now }), cfg, config: COMMIT,
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
const idName = (job) => job && { id: job.id, name: job.name };
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
  assert.deepEqual(idName(only(rows(w)).job), { id: job.id, name: 'ci / nproc' }, 'the job goes on the row while it runs');

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

test('v2 ledger provenance comes from the actual launcher project and selected image', async () => {
  const { w, launcher } = setup();
  w.g.images[0].labels['ci-kit-commit'] = 'baked-sha';
  w.sim.queue(SBX, L(4));
  await launcher.tick();
  const row = only(rows(w));
  assert.equal(row.v, 2);
  assert.equal(row.account, CFG.project);
  assert.equal(row.image, w.g.images[0].selfLink);
  assert.equal(row.image_commit, 'baked-sha');
  assert.equal(row.region, 'us-central1');
});

// Egress (2026-10-21): gce.json's egress picks the VM's network path, and its row keeps the one it launched with, so a
// change to the file between launch and the final row never reprices the VM.
test('a VM launched under egress "nat" has no external address and its row says nat; it is priced so after gce.json returns to external', async () => {
  const { w, make } = setup({ cfg: { ...CFG, egress: 'nat' } });
  const job = w.sim.queue(SBX, L(4), { name: 'ci / nproc' });
  await make().tick();
  const [name] = vms(w);
  assert.deepEqual(w.sim.vm(name).networkInterfaces, [{ subnetwork: 'regions/us-central1/subnetworks/ci-kit-us-central1' }]);
  assert.equal(only(rows(w)).egress, 'nat');
  const external = make({ cfg: CFG }); // the next commit of gce.json, read by the next tick
  w.sim.boot(SBX, name);
  w.sim.take(SBX, name, job);
  w.advance(MIN);
  await external.tick();
  w.sim.finish(SBX, name, job);
  await external.tick();
  w.advance(MIN);
  await external.tick();
  const row = only(rows(w));
  assert.equal(row.state, 'final');
  const priced = (egress) => Math.round(dollars({ machine: row.machine, zone: row.zone, provisioning: row.provisioning, seconds: row.seconds, diskGb: 50, diskType: row.diskType, egress }) * 1e4) / 1e4;
  assert.notEqual(priced('nat'), priced('external'));
  assert.deepEqual([row.egress, row.dollars], ['nat', priced('nat')]);
});

test('a VM launched under egress "external" takes an external address, and its row says so', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  await launcher.tick();
  const [name] = vms(w);
  assert.deepEqual(w.sim.vm(name).networkInterfaces[0].accessConfigs, [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }]);
  assert.equal(only(rows(w)).egress, 'external');
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

test('a quota refusal is a wait: nothing left behind, the row refused, the job still queued for a later tick', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  w.g.insertErrors.push({ match: () => true, error: () => new GceError(403, "Quota 'C3D_CPUS' exceeded", ['quotaExceeded']) });
  const out = await launcher.tick();
  assert.deepEqual(out.launched, []);
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
  assert.equal(only(rows(w)).end, 'refused');
  w.advance(MIN);
  assert.equal((await launcher.tick()).launched.length, 1, 'the next tick launches once quota allows');
});

test('spot refused in every zone: the same machine on demand, recorded on the row', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(8));
  for (const z of BASE_CFG.placements[0].zones) w.g.insertErrors.push({ match: (zone, body) => zone === z && body.scheduling.provisioningModel === 'SPOT', error: gceErr(['ZONE_RESOURCE_POOL_EXHAUSTED']) });
  await launcher.tick();
  const [name] = vms(w);
  assert.equal(w.sim.vm(name).labels['ci-kit-provisioning'], 'standard');
  assert.equal(w.sim.vm(name).zone.split('/').pop(), 'us-central1-a');
  const row = only(rows(w));
  assert.deepEqual([row.provisioning, row.machine], ['standard', 'c3d-highcpu-8']);
});

// Review (M6 placements, P2): with eight placements a size has 26 spot attempts before its first on-demand one, and
// a refusal takes ~2 s, so one tick's 45 s budget runs out first. The server builds a Launcher per tick and hands each
// the same stock-out memory, so the next tick skips the zones already refused and reaches on demand.
test('spot stocked out in all 26 zones of eight placements: the next tick skips what was refused and launches on demand', async () => {
  const cfg = { ...M6_CFG, repos: [{ repo: SBX }] };
  const { w, make } = setup({ cfg });
  const stockouts = stockoutMemory();
  w.sim.queue(SBX, L(8));
  const spot = placements(8, cfg).filter((p) => p.provisioning === 'spot');
  // Every spot zone stays stocked out for both ticks: each tick's inserts there are refused, 2 s apiece.
  const stockOut = () => {
    w.g.insertErrors = w.g.insertErrors.filter((e) => !e.stockout);
    for (const p of spot) {
      w.g.insertErrors.push({ stockout: true, match: (zone, body) => zone === p.zone && body.scheduling.provisioningModel === 'SPOT', error: () => {
        w.advance(2000);
        return gceErr(['ZONE_RESOURCE_POOL_EXHAUSTED'])();
      } });
    }
  };
  stockOut();
  const first = await make({ stockouts }).tick();
  assert.deepEqual(first.launched, [], 'the tick\'s budget ends inside the spot half');
  const refusedFirst = w.log.filter((l) => / refused$/.test(l)).length;
  assert.ok(refusedFirst > 20 && refusedFirst < spot.length, String(refusedFirst));
  w.advance(MIN);
  stockOut();
  const second = await make({ stockouts }).tick();
  assert.equal(second.launched.length, 1);
  assert.equal(w.log.filter((l) => / refused$/.test(l)).length, spot.length, 'no zone refused in the first tick is asked again');
  const vm = w.sim.vm(second.launched[0]);
  assert.equal(vm.labels['ci-kit-provisioning'], 'standard');
  assert.equal(vm.zone.split('/').pop(), 'us-west4-a');
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
    await w.gce.insertInstance('us-central1-a', jobInstance({ alloc, zone: 'us-central1-a', machine: 'c3d-highcpu-4', provisioning: 'spot', repo: SBX, cpus: 4, image: 'i', jit: 'j', placement: CFG.placements[0], cfg: CFG, config: COMMIT }));
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
  assert.deepEqual([row.state, row.end, idName(row.job)], ['final', 'preempted', { id: job.id, name: 'ci / unit' }]);
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
  await w.gce.insertInstance('us-central1-b', jobInstance({ alloc, zone: 'us-central1-b', machine: 'e2-highcpu-2', provisioning: 'spot', repo: SBX, cpus: 2, image: 'i', jit: 'j', placement: CFG.placements[0], cfg: { ...CFG, egress: 'nat' }, config: COMMIT }));
  w.sim.vm(instanceName(alloc)).status = 'TERMINATED';
  w.g.disks.push({ name: 'stray', zone: 'zones/us-central1-c', users: [], labels: { 'ci-kit': 'gce' }, creationTimestamp: new Date(T0 - 20 * MIN).toISOString() });
  w.g.instances.push({ name: 'ci-kit-gce-builder-old', status: 'RUNNING', zone: 'zones/us-central1-a', labels: { 'ci-kit': 'gce-builder' }, creationTimestamp: new Date(T0 - 5 * 60 * MIN).toISOString(), machineType: 'x/e2-standard-4' });
  await settle(w, launcher, 2);
  assert.equal(only(rows(w)).end, 'orphan');
  assert.equal(only(rows(w)).egress, 'nat', 'the orphan row takes the egress its VM\'s network interface shows, not the config\'s');
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

test('a public repo is refused', async () => {
  const w = world({ start: T0, repos: { [SBX]: { private: false } } });
  const { launcher } = setup({ w });
  w.sim.queue(SBX, L(4));
  assert.deepEqual((await launcher.tick()).launched, []);
});

test('a public repo whose entry allows it is served for push, dispatch and schedule', async () => {
  for (const event of ['push', 'workflow_dispatch', 'schedule']) {
    const w = world({ start: T0, repos: { [SBX]: { private: false } } });
    const { launcher } = setup({ w, cfg: { ...CFG, repos: [{ repo: SBX, allow_public: true }] } });
    w.sim.queue(SBX, L(4), { event });
    assert.equal((await launcher.tick()).launched.length, 1, event);
  }
});

test('a public exception refuses the whole repo for any unsafe active run, even one with no pool job', async () => {
  for (const status of ['queued', 'in_progress']) {
    for (const event of ['pull_request', 'pull_request_target', 'issue_comment', 'workflow_run', 'repository_dispatch', 'unknown', null]) {
      const w = world({ start: T0, repos: { [SBX]: { private: false } } });
      const { make } = setup({ w, cfg: { ...CFG, repos: [{ repo: SBX, allow_public: true }] } });
      const logs = [];
      const launcher = make({ log: (line) => logs.push(line) });
      w.sim.queue(SBX, L(4));
      const other = w.sim.queue(SBX, ['ubuntu-latest'], { event });
      w.gh.runs.find((r) => r.id === other.run_id).status = status;
      assert.deepEqual((await launcher.tick()).launched, [], `${event} (${status})`);
      assert.ok(logs.some((line) => line.includes(String(other.run_id)) && line.includes(event ?? 'unknown')), logs.join('\n'));
      assert.equal(w.log.filter((line) => line.startsWith('alert ')).length, 1);
    }
  }
});

test('private repos keep serving unsafe events, even with allow_public set; completed public runs do not block', async () => {
  for (const isPrivate of [true, false]) {
    const w = world({ start: T0, repos: { [SBX]: { private: isPrivate } } });
    const { launcher } = setup({ w, cfg: { ...CFG, repos: [{ repo: SBX, allow_public: true }] } });
    const job = w.sim.queue(SBX, L(4), { event: 'pull_request' });
    if (!isPrivate) {
      job.status = 'completed';
      w.gh.runs[0].status = 'completed';
      w.sim.queue(SBX, L(4));
    }
    assert.equal((await launcher.tick()).launched.length, 1);
    assert.equal(w.log.filter((line) => line.startsWith('alert ')).length, 0);
  }
});

test('an unsafe public run drains idle runners, leaves busy jobs alone, and alerts once across ticks and restarts', async () => {
  const w = world({ start: T0, repos: { [SBX]: { private: false } } });
  const { make } = setup({ w, cfg: { ...CFG, repos: [{ repo: SBX, allow_public: true }] } });
  const launcher = make({ alert: undefined }); // The production issue-backed deduplication, not setup's alert recorder.
  const busyJob = w.sim.queue(SBX, L(4));
  w.sim.queue(SBX, L(2));
  await launcher.tick();
  const busy = w.g.instances.find((v) => v.labels['ci-kit-cpus'] === '4').name;
  const idle = w.g.instances.find((v) => v.name !== busy).name;
  w.sim.boot(SBX, busy);
  w.sim.take(SBX, busy, busyJob);
  w.sim.boot(SBX, idle);
  const unsafe = w.sim.queue(SBX, ['ubuntu-latest'], { event: 'pull_request_target' });
  for (const current of [launcher, launcher, make({ alert: undefined })]) {
    assert.deepEqual((await current.tick()).launched, []);
    w.advance(MIN);
  }
  assert.deepEqual(vms(w), [busy]);
  assert.ok(w.log.indexOf(`unregister ${idle}`) < w.log.indexOf(`delete ${idle}`));
  const alerts = w.gh.issues.filter((i) => i.labels?.includes('ci-kit-alert'));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].body, new RegExp(`${unsafe.run_id}`));
  assert.match(alerts[0].body, /pull_request_target/);
  assert.match(alerts[0].body, /push.*workflow_dispatch.*schedule/);
  assert.match(alerts[0].body, /docs\/pool.md/);
  w.gh.runs.find((r) => r.id === unsafe.run_id).status = 'completed';
  unsafe.status = 'completed';
  assert.equal((await launcher.tick()).launched.length, 1, 'safe demand resumes once the unsafe run ends');
});

test('an unreadable public run list launches nothing without draining its idle runners', async () => {
  const w = world({ start: T0, repos: { [SBX]: { private: false } } });
  const { launcher } = setup({ w, cfg: { ...CFG, repos: [{ repo: SBX, allow_public: true }] } });
  w.sim.queue(SBX, L(4));
  await launcher.tick();
  const [idle] = vms(w);
  w.sim.boot(SBX, idle);
  w.sim.queue(SBX, L(2));
  w.github.runsByStatus = async () => { throw new Error('unavailable'); };
  const out = await launcher.tick();
  assert.deepEqual([out.launched, out.deleted, out.unregistered], [[], [], []]);
  assert.deepEqual(vms(w), [idle]);
  assert.equal(w.sim.runner(SBX, idle).busy, false);
  assert.equal(w.log.filter((line) => line.startsWith('alert ')).length, 0);
});

test('a failed job read still refuses an unsafe public run, and keeps a safe one\'s idle runners', async () => {
  for (const event of ['pull_request_target', 'push']) {
    const w = world({ start: T0, repos: { [SBX]: { private: false } } });
    const { launcher } = setup({ w, cfg: { ...CFG, repos: [{ repo: SBX, allow_public: true }] } });
    w.sim.queue(SBX, L(4));
    await launcher.tick();
    const [idle] = vms(w);
    w.sim.boot(SBX, idle);
    w.sim.queue(SBX, L(2), { event });
    w.github.listJobs = async () => { throw new Error('502 Bad Gateway'); };
    const out = await launcher.tick();
    assert.deepEqual(out.launched, [], event);
    if (event === 'push') {
      assert.deepEqual([out.deleted, out.unregistered], [[], []]);
      assert.deepEqual(vms(w), [idle]);
      assert.equal(w.log.filter((line) => line.startsWith('alert ')).length, 0);
    } else {
      assert.deepEqual(vms(w), []);
      assert.ok(w.log.indexOf(`unregister ${idle}`) < w.log.indexOf(`delete ${idle}`));
      assert.equal(w.log.filter((line) => line.startsWith('alert ')).length, 1);
    }
  }
});

test('an alert failure never admits an unsafe public repo', async () => {
  const w = world({ start: T0, repos: { [SBX]: { private: false } } });
  const { make } = setup({ w, cfg: { ...CFG, repos: [{ repo: SBX, allow_public: true }] } });
  w.sim.queue(SBX, L(4));
  w.sim.queue(SBX, ['ubuntu-latest'], { event: 'issue_comment' });
  const launcher = make({ alert: async () => { throw new Error('unavailable'); } });
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
  assert.deepEqual(idName(only(rows(w)).job), { id: job.id, name: 'ci / late' });
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

// Placements (spec 2026-10-21, M1): the tick across regions and families, with quota memory scoped to what ran out.
const NEW_CFG = { ...CFG, placements: [WEST, CENTRAL] };
// As Compute Engine refuses an insert for quota: outright, its message naming the metric and the region.
const quotaRefusal = (metric, where) => new GceError(403, `gce POST /zones/x/instances: 403 Quota '${metric}' exceeded.  Limit: 50.0 ${where}.`, ['quotaExceeded']);
const regionOf = (zone) => zone.replace(/-[a-z]$/, '');
// Every insert the world was asked for, refused or not: [machine, zone].
const asked = (w) => {
  const out = [];
  const before = w.hooks.beforeInsert;
  w.hooks.beforeInsert = (zone, body) => {
    out.push([body.machineType.split('/').pop(), zone]);
    before?.(zone, body);
  };
  return out;
};
const placed = (w) => w.g.instances.map((i) => `${i.machineType.split('/').pop()}@${regionOf(i.zone.split('/').pop())}`);

test('placements: more than 16 jobs, us-west4 refusing for quota and us-central1 with room: every job launches in that one tick', async () => {
  const { w, launcher } = setup({ cfg: NEW_CFG });
  for (let k = 0; k < 20; k += 1) w.sim.queue(SBX, L(2));
  const tries = asked(w);
  w.hooks.beforeInsert = ((before) => (zone, body) => {
    before(zone, body);
    if (zone.startsWith('us-west4')) throw quotaRefusal('C4D_CPUS', 'in region us-west4');
  })(w.hooks.beforeInsert);
  const out = await launcher.tick();
  assert.equal(out.launched.length, 20);
  assert.equal(out.waiting, 0);
  assert.deepEqual(new Set(placed(w)), new Set(['c3d-highcpu-4@us-central1']));
  const west = tries.filter(([, z]) => z.startsWith('us-west4')).length;
  assert.ok(west >= 1 && west <= 16, `us-west4 is asked only by the launches already walking when it first refused (${west})`);
  for (const r of rows(w).values()) assert.equal(r.at(-1).diskType, 'pd-balanced');
});

test('placements: a family\'s quota refusal does not block another family in that region; the refused family is not asked again', async () => {
  // The old form: size 2 on e2-highcpu-2, its fallback c3d-highcpu-4 in the same region.
  const { w, launcher } = setup();
  for (let k = 0; k < 18; k += 1) w.sim.queue(SBX, L(2));
  w.sim.queue(SBX, L(4));
  const tries = asked(w);
  w.hooks.beforeInsert = ((before) => (zone, body) => {
    before(zone, body);
    if (body.machineType.endsWith('/e2-highcpu-2')) throw quotaRefusal('E2_CPUS', 'in region us-central1');
  })(w.hooks.beforeInsert);
  const out = await launcher.tick();
  assert.equal(out.launched.length, 19, 'the 4-vCPU C3D launch is not stopped by E2\'s refusal');
  assert.deepEqual(new Set(placed(w)), new Set(['c3d-highcpu-4@us-central1']));
  assert.ok(w.g.instances.every((i) => i.labels['ci-kit-provisioning'] === 'spot'), 'E2\'s refusal does not push C3D to on demand');
  assert.ok(tries.filter(([m]) => m === 'e2-highcpu-2').length <= 16, 'later launches skip E2');
});

test('placements: a 16-vCPU quota refusal does not block a 2-vCPU launch in the same family and region', async () => {
  const { w, launcher } = setup({ cfg: { ...NEW_CFG, max_vcpus: 1000 } });
  for (let k = 0; k < 16; k += 1) w.sim.queue(SBX, L(16));
  w.advance(1000);
  w.sim.queue(SBX, L(2)); // the youngest: it starts once a 16-vCPU launch has finished, after us-west4 refused
  w.hooks.beforeInsert = (zone, body) => {
    if (zone.startsWith('us-west4') && body.machineType.endsWith('-16')) throw quotaRefusal('C4D_CPUS', 'in region us-west4');
  };
  const out = await launcher.tick();
  assert.equal(out.launched.length, 17);
  assert.equal(placed(w).filter((p) => p === 'c3d-highcpu-16@us-central1').length, 16);
  assert.deepEqual(placed(w).filter((p) => !p.startsWith('c3d-highcpu-16')), ['c4d-highcpu-2@us-west4']);
  const small = w.g.instances.find((i) => i.labels['ci-kit-cpus'] === '2');
  assert.equal(small.labels['ci-kit-disk'], 'hyperdisk-balanced');
  const row = [...rows(w).values()].map((r) => r.at(-1)).find((r) => r.cpus === 2);
  assert.deepEqual([row.machine, row.zone, row.diskType], ['c4d-highcpu-2', 'us-west4-a', 'hyperdisk-balanced']);
});

test('placements: quota refused in every placement stops the later launches it covers before any runner or row is made for them', async () => {
  const { w, launcher } = setup({ cfg: NEW_CFG });
  for (let k = 0; k < 20; k += 1) w.sim.queue(SBX, L(4));
  w.hooks.beforeInsert = () => {
    throw quotaRefusal('CPUS_ALL_REGIONS', 'globally');
  };
  const out = await launcher.tick();
  assert.deepEqual(out.launched, []);
  const jits = w.log.filter((l) => l.startsWith('jit ')).length;
  assert.ok(jits >= 1 && jits <= 16, `only the launches already under way minted a runner (${jits})`);
  assert.equal(rows(w).size, jits);
  assert.ok([...rows(w).values()].every((r) => r.at(-1).end === 'refused'));
  assert.deepEqual(leftovers(w), { instances: 0, disks: 0, runners: 0 });
});

test('placements: the listing is complete only when it read every placement\'s zone; a zone outside them does not matter', async () => {
  const { w, launcher } = setup({ cfg: NEW_CFG });
  w.sim.queue(SBX, L(4));
  w.hooks.unreachable = 'us-west4-b';
  assert.deepEqual((await launcher.tick()).launched, [], 'a placement zone missing: nothing is admitted');
  w.hooks.unreachable = 'europe-west4-a';
  w.advance(MIN);
  assert.equal((await launcher.tick()).launched.length, 1);
  assert.deepEqual(placed(w), ['c4d-highcpu-4@us-west4']);
});

test('placements (review): a zone a live row names counts toward completeness, though no placement names it any more', async () => {
  // A busy 4-vCPU VM in us-west4; gce.json rolls back to us-central1 only; us-west4-a is unreachable.
  const { w, launcher, make } = setup({ cfg: { ...NEW_CFG, max_vcpus: 4 } });
  const job = w.sim.queue(SBX, L(4));
  await launcher.tick();
  const [name] = vms(w);
  assert.equal(w.sim.vm(name).zone.split('/').pop(), 'us-west4-a');
  w.sim.boot(SBX, name);
  w.sim.take(SBX, name, job);
  const central = make({ cfg: { ...CFG, placements: [CENTRAL], max_vcpus: 4 } });
  w.sim.queue(SBX, L(4));
  w.hooks.unreachable = 'us-west4-a';
  w.advance(MIN);
  assert.deepEqual((await central.tick()).launched, [], 'the hidden VM still counts: nothing is admitted over max_vcpus');
  delete w.hooks.unreachable;
  w.advance(MIN);
  const out = await central.tick();
  assert.deepEqual(out.launched, []);
  assert.equal(out.waiting, 1, 'once the listing is whole, the busy VM holds the 4 vCPUs and the job waits');
});

test('placements (review): while a live row names no zone (its running write failed), any zone the listing missed blocks admission', async () => {
  // A C4D insert succeeds but its running row is never written: the row stays launching, with no zone.
  const { w, make } = setup({ cfg: { ...NEW_CFG, max_vcpus: 4 } });
  const real = createGceLedger(w.github, CFG.ledger, { now: w.now });
  const failing = { ...real, upsert: async (row, opts) => {
    if (row.state === 'running') throw new Error('ledger write failed');
    return real.upsert(row, opts);
  } };
  w.sim.queue(SBX, L(4));
  await make({ ledger: failing }).tick();
  const [name] = vms(w);
  assert.equal(w.sim.vm(name).zone.split('/').pop(), 'us-west4-a');
  assert.equal(only(rows(w)).state, 'launching');
  // gce.json rolls back to us-central1 only, and us-west4-a is unreachable.
  const central = make({ cfg: { ...CFG, placements: [CENTRAL], max_vcpus: 4 } });
  w.sim.queue(SBX, L(4));
  w.hooks.unreachable = 'us-west4-a';
  w.advance(MIN);
  assert.deepEqual((await central.tick()).launched, [], 'a zoneless live row: the whole listing must be read');
  delete w.hooks.unreachable;
  w.advance(MIN);
  const out = await central.tick();
  assert.deepEqual(out.launched, []);
  assert.equal(out.waiting, 1, 'the VM, seen again, holds the 4 vCPUs');
});

// ── M3: the tick and the cover ─────────────────────────────────────────────────────────────────────────────────

// The 10-21 sequence (GitHub's job timeline and the pool ledger): MAWS run 39583515002's static job 119166794835
// (cpus-4) was queued at 10:17:58 and started at 10:20:04, 126 s later. The tick at 10:18:2x launched its run's unit
// and probes but nothing for static: hscox688lt, the cpus-4 VM of an earlier run's static job 119162503511 (started
// 10:10:17, the last job of its run, completed 10:18:12), still had its runner registered and not busy, and was
// counted as cover. The same tick deleted it (its job had reported), and the next tick launched hscp78uw4c.
test('cover, replayed from 10-21: a VM whose job just ended covers no queued job, and the job launches in that tick', async () => {
  const MAWS = 'SSFSKIM/MAWS';
  const at = (hms) => Date.parse(`2026-10-21T${hms}Z`);
  const w = world({ start: at('10:07:44'), repos: { [MAWS]: { private: true } } });
  const { launcher } = setup({ cfg: { ...BASE_CFG, repos: [{ repo: MAWS }] }, w });
  const earlier = w.sim.queue(MAWS, L(4), { name: 'static' }); // 119162503511
  w.advance(at('10:09:31') - w.now());
  await launcher.tick();
  const [old] = vms(w); // hscox688lt
  w.advance(at('10:10:17') - w.now());
  w.sim.boot(MAWS, old);
  w.sim.take(MAWS, old, earlier);
  w.advance(at('10:11:20') - w.now());
  await launcher.tick(); // a tick while it runs records the job on its row
  assert.equal(only(rows(w)).job?.id, earlier.id);

  w.advance(at('10:17:58') - w.now());
  const unit = w.sim.queue(MAWS, L(8), { name: 'unit' });
  const probes = w.sim.queue(MAWS, L(2), { name: 'probes', run: unit.run_id });
  const stat = w.sim.queue(MAWS, L(4), { name: 'static', run: unit.run_id }); // 119166794835
  w.advance(at('10:18:12') - w.now());
  w.sim.finish(MAWS, old, earlier, { poweredOff: false, runnerLeaves: false });
  assert.deepEqual([w.sim.runner(MAWS, old).busy, w.gh.runs.find((r) => r.id === earlier.run_id).status], [false, 'completed'],
    'its runner still reads registered and not busy, and its run is over: this tick lists no job naming it');

  w.advance(at('10:18:22') - w.now());
  const out = await launcher.tick();
  assert.equal(out.launched.length, 3, 'static, unit and probes all launch in this tick');
  const sizes = vms(w).filter((n) => n !== old).map((n) => w.sim.vm(n).labels['ci-kit-cpus']).sort();
  assert.deepEqual(sizes, ['2', '4', '8']);
  assert.deepEqual(out.deleted, [`${old} (job-exited)`], 'and the ended VM goes in the same tick');
  assert.ok([unit, probes, stat].every((j) => j.status === 'queued'));
});

// Every call to Compute Engine and GitHub answers on a later turn, as a remote API's does, and is counted on a logical
// clock of call layers: a call ends one layer after it began, so calls made together end in the same layer and a call
// made after another ended lands in a later one. The layer is the depth of sequential calls, whatever the machine's
// load (wall time, the measure here before, stretched under load: ci-kit#77). Every call waits the same 1 ms timer,
// and Node fires equal timers in the order they were set, so the count is the same on every run.
const layered = (api, clock) => Object.fromEntries(Object.entries(api).map(([k, fn]) =>
  [k, typeof fn === 'function' ? async (...a) => {
    const began = clock.layer;
    await new Promise((r) => setTimeout(r, 1));
    clock.layer = Math.max(clock.layer, began + 1);
    return fn(...a);
  } : fn]));

// Spec M6 (NAT): a VM that boots but cannot reach GitHub must not hold its job for the whole idle window unseen.
test('a VM RUNNING over 3 min whose runner never came online is reported at ERROR with its zone and region, and its job gets another VM', async () => {
  // The hint names what carries the VM's egress: its own external address, or its region's Cloud NAT.
  for (const [egress, check] of [['external', 'its external address'], ['nat', 'the Cloud NAT of us-central1']]) {
    const errors = [];
    const { w, make } = setup({ cfg: { ...CFG, egress } });
    const launcher = make({ error: (message, fields) => errors.push({ message, fields }) });
    w.sim.queue(SBX, L(4));
    assert.equal((await launcher.tick()).launched.length, 1);
    const [name] = vms(w);
    const vm = w.sim.vm(name);
    vm.status = 'RUNNING'; // it starts, but its runner never connects
    vm.lastStartTimestamp = new Date(w.now()).toISOString();
    w.advance(2 * MIN);
    assert.deepEqual((await launcher.tick()).launched, [], 'still within the boot allowance: its runner covers the job');
    assert.deepEqual(errors, []);
    w.advance(2 * MIN);
    const out = await launcher.tick();
    assert.equal(out.launched.length, 1, 'the job is launched again');
    const zone = vm.zone.split('/').pop();
    assert.deepEqual(errors.map((e) => e.fields), [{ event: 'runner-never-online', instance: name, zone, region: zone.replace(/-[a-z]$/, ''), runningSeconds: 240 }]);
    assert.match(errors[0].message, new RegExp(`^runner never online: ${name} \\(c3d-highcpu-4@${zone}\\)`));
    assert.match(errors[0].message, new RegExp(`check ${check}`), egress);
  }
});

test('a VM whose runner came online is cover however long it has run, and nothing is reported', async () => {
  const errors = [];
  const { w, make } = setup();
  const launcher = make({ error: (message, fields) => errors.push({ message, fields }) });
  w.sim.queue(SBX, L(4));
  await launcher.tick();
  w.sim.boot(SBX, vms(w)[0]);
  w.advance(5 * MIN);
  assert.deepEqual((await launcher.tick()).launched, []);
  assert.deepEqual(errors, []);
});

test('reads in parallel, launches before cleanup: the first insert comes a few calls into the tick, however much else there is', async () => {
  const MAWS = 'SSFSKIM/MAWS';
  const MANIM = 'SSFSKIM/manim-master';
  const repos = { [SBX]: { private: true }, [MAWS]: { private: true }, [MANIM]: { private: true } };
  const cfg = { ...BASE_CFG, repos: Object.keys(repos).map((repo) => ({ repo })) };
  const w = world({ start: T0, repos });
  const { launcher } = setup({ cfg, w });
  // Work for every part of the tick: a busy VM, a VM whose job just reported, two runs queued in each repo.
  for (const repo of Object.keys(repos)) w.sim.queue(repo, L(4));
  await launcher.tick();
  const names = vms(w);
  const jobs = w.gh.jobs.slice();
  names.forEach((n, k) => {
    const repo = Object.keys(repos)[k];
    w.sim.boot(repo, n);
    w.sim.take(repo, n, jobs[k]);
  });
  w.advance(MIN);
  await launcher.tick();
  w.sim.finish(MAWS, names[1], jobs[1], { poweredOff: false });
  for (const repo of Object.keys(repos)) for (const size of [2, 8]) w.sim.queue(repo, L(size));
  w.advance(MIN);

  const clock = { layer: 0 };
  let first = null;
  w.hooks.beforeInsert = () => { first ??= clock.layer; };
  const slow = new Launcher({
    gce: layered(w.gce, clock), gh: layered(w.github, clock), ledger: createGceLedger(layered(w.github, clock), cfg.ledger, { now: w.now }),
    cfg, config: COMMIT, now: w.now, random: () => Math.floor(Math.random() * 36 ** 5), alert: async () => {},
  });
  const out = await slow.tick();
  assert.equal(out.launched.length, 6);
  assert.ok(out.deleted.some((d) => d.startsWith(names[1])), 'the cleanup ran in the same tick');
  // Sequentially this tick makes about 30 calls before its first insert. In parallel: the ledger, then the instances;
  // beside them each repo's runners, runs and jobs; then the ledger row, the JIT config and the insert.
  assert.ok(first < 10, `the first insert came ${first} calls deep`);
});

test('timing: the tick reports its first insert, and a row its job\'s run, workflow, queued and started times and its VM\'s RUNNING time', async () => {
  const { w, launcher } = setup();
  const quiet = await launcher.tick();
  assert.equal(quiet.firstInsert, null, 'no insert, no time');
  w.advance(5_000);
  const job = w.sim.queue(SBX, L(4), { name: 'ci / nproc' });
  w.advance(20_000);
  const out = await launcher.tick();
  assert.equal(out.firstInsert, new Date(w.now()).toISOString());
  const [name] = vms(w);
  w.advance(15_000);
  w.sim.boot(SBX, name);
  w.advance(10_000);
  w.sim.take(SBX, name, job);
  w.advance(MIN);
  await launcher.tick();
  const row = only(rows(w));
  assert.deepEqual(row.job, {
    id: job.id, name: 'ci / nproc', run: job.run_id, workflow: '.github/workflows/gate.yml', queued: new Date(T0 + 5_000).toISOString(),
    started: new Date(T0 + 50_000).toISOString(), labels: L(4), required_provider: 'any',
  });
  assert.equal(row.running, new Date(T0 + 40_000).toISOString());
  w.advance(MIN);
  w.sim.finish(SBX, name, job);
  await launcher.tick();
  w.advance(MIN);
  await launcher.tick();
  const final = only(rows(w));
  assert.deepEqual([final.state, final.running, final.job.started], ['final', row.running, row.job.started]);
});

test('timing: a slow first insert is attributable to observation, the launching row and JIT calls', async () => {
  const { w, make } = setup();
  const launcher = make({ limits: { get: async () => null } });
  const job = w.sim.queue(SBX, L(4));
  const list = w.gce.listInstances;
  w.gce.listInstances = async (...args) => { w.advance(6_000); return list(...args); };
  w.hooks.commentWrite = () => { w.advance(250); };
  const jit = w.github.jitConfig;
  w.github.jitConfig = async (...args) => { w.advance(500); return jit(...args); };
  const out = await launcher.tick();
  const instance = out.launched[0];
  assert.equal(out.launched.length, 1);
  assert.equal(out.firstInsert, new Date(T0 + 6_750).toISOString());
  const call = (name) => out.preparation.find((c) => c.call === name);
  assert.deepEqual(call('gce.listInstances'), { call: 'gce.listInstances', started: new Date(T0).toISOString(), ms: 6_000 });
  assert.equal(call('observe').ms, 6_000);
  assert.deepEqual(call('ledger.launching'), { call: 'ledger.launching', repo: SBX, instance, started: new Date(T0 + 6_000).toISOString(), ms: 250 });
  assert.deepEqual(call('github.jitConfig'), { call: 'github.jitConfig', repo: SBX, instance, started: new Date(T0 + 6_250).toISOString(), ms: 500 });
  assert.deepEqual([call('github.listJobs').repo, call('github.listJobs').run], [SBX, job.run_id]);
  for (const name of ['ledger.read', 'ledger.rows', 'gce.listDisks', 'gce.builders', 'gce.images', 'github.getRepo', 'github.runners', 'github.runs.queued', 'github.runs.in_progress', 'images.wait', 'limits.get', 'limits.wait']) {
    assert.ok(call(name), `${name} is timed, even when fast`);
  }
  const next = await launcher.tick();
  assert.notEqual(next.preparation, out.preparation, 'each tick owns its timings');
  assert.equal(next.preparation.some((c) => c.call === 'github.jitConfig'), false, 'no stale launch timings on a quiet tick');
  assert.equal(next.preparation.find((c) => c.call === 'gce.jobReport').instance, instance, 'guest reports identify their VM');
});

test('timing: a job no tick saw running is found when its VM is retired, with its times', async () => {
  const { w, launcher } = setup();
  const job = w.sim.queue(SBX, L(2), { name: 'probes' });
  await launcher.tick();
  const [name] = vms(w);
  w.advance(20_000);
  w.sim.boot(SBX, name);
  w.sim.take(SBX, name, job);
  w.advance(30_000);
  w.sim.finish(SBX, name, job);
  w.advance(10_000);
  await launcher.tick();
  w.advance(MIN);
  await launcher.tick();
  const row = only(rows(w));
  assert.deepEqual([row.end, row.job.id, row.job.run, row.job.queued, row.job.started, row.running],
    ['done', job.id, job.run_id, new Date(T0).toISOString(), new Date(T0 + 20_000).toISOString(), new Date(T0 + 20_000).toISOString()]);
});

test('a tick that cannot list the instances fails whole, launching and deleting nothing, while its other reads settle', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  w.gce.listInstances = async () => { throw new GceError(503, 'instances listing failed'); };
  const getRepo = w.github.getRepo;
  w.github.getRepo = async (repo) => { await new Promise((r) => setTimeout(r, 20)); return getRepo(repo); }; // slower than the failure
  await assert.rejects(launcher.tick(), /instances listing failed/);
  assert.deepEqual(w.log.filter((l) => /^(insert|delete|unregister)/.test(l)), []);
});

// Review (M3, P2): a repo's two run snapshots are taken in order, queued then in progress. A run that starts between
// them (another runner took its first job) is then in the second, and its still-queued pool jobs launch this tick;
// two snapshots taken at once could each miss it.
test('a run that starts between the queued and in-progress snapshots still has its queued jobs launched', async () => {
  const { w, launcher } = setup();
  const a = w.sim.queue(SBX, L(4), { name: 'a' });
  w.sim.queue(SBX, L(2), { name: 'b', run: a.run_id });
  const runsByStatus = w.github.runsByStatus;
  w.github.runsByStatus = async (repo, status) => {
    if (status === 'queued') {
      await new Promise((r) => setImmediate(r));
      w.gh.runs.find((r) => r.id === a.run_id).status = 'in_progress'; // it starts just before this snapshot
    }
    return runsByStatus(repo, status);
  };
  const out = await launcher.tick();
  assert.equal(out.launched.length, 2);
});

test('a run listed both queued and in progress (it started between the two listings) is read once: no double launch', async () => {
  const { w, launcher } = setup();
  const a = w.sim.queue(SBX, L(4), { name: 'a' });
  w.sim.queue(SBX, L(2), { name: 'b', run: a.run_id });
  const runsByStatus = w.github.runsByStatus;
  w.github.runsByStatus = async (repo, status) => {
    const list = await runsByStatus(repo, status);
    if (status === 'queued') w.gh.runs.find((r) => r.id === a.run_id).status = 'in_progress'; // it starts just after
    return list;
  };
  const out = await launcher.tick();
  assert.equal(out.launched.length, 2);
});
