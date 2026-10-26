// The operational boundary, exercised against Compute/GitHub shapes rather than a mocked provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../../gce/launcher/providers/gce.mjs';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { launchRow, parseRow } from '../../gce/launcher/ledger.mjs';
import { allocationId, instanceName } from '../../gce/launcher/logic.mjs';
import { GceError } from '../../lib/gce.mjs';
import { world } from './fake-world.mjs';
import { NEW_CFG } from './config-fixtures.mjs';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const REPO = 'SSFSKIM/ci-kit-sandbox';
const CFG = { ...NEW_CFG, repos: [{ repo: REPO }] };
const CONFIG = 'c0ffee00';
function setup(extra = {}) {
  const w = world({ start: NOW });
  const logs = [];
  const provider = createProvider({ gce: w.gce, cfg: CFG, config: CONFIG, now: w.now, after: w.after, log: (s) => logs.push(s), ...extra });
  const row = launchRow({ alloc: allocationId(NOW, () => 1), repo: REPO, cpus: 2, at: NOW, config: CONFIG,
    account: CFG.project, image: w.g.images[0].selfLink, reserved: 4 });
  const candidate = provider.candidates(CFG, 2).find((c) => c.machine === 'c3d-highcpu-4');
  return { w, logs, provider, row, candidate };
}

test('launch uses the candidate disk/subnet and logical labels; observe preserves physical reservation and ready image provenance', async () => {
  const { w, provider, row, candidate } = setup();
  w.g.images[0].labels['ci-kit-commit'] = 'abc123';
  assert.equal(provider.name, 'gce');
  const image = await provider.readyImage();
  assert.equal(image.id, w.g.images[0].selfLink);
  assert.equal(image.manifest['ci-kit-commit'], 'abc123');
  const result = await provider.launch(row, candidate, 'encoded-jit');
  assert.equal(result.outcome, 'accepted');
  const vm = w.g.instances[0];
  assert.equal(vm.labels['ci-kit-cpus'], '2');
  assert.equal(vm.labels['ci-kit-disk'], 'pd-balanced');
  assert.equal(vm.networkInterfaces[0].subnetwork, 'regions/us-central1/subnetworks/ci-kit-us-central1');
  assert.equal(vm.metadata.items.find((m) => m.key === 'ci-kit-jit').value, 'encoded-jit');
  assert.equal(vm.metadata.items.find((m) => m.key === 'ci-kit-repo')?.value, REPO);
  assert.equal(vm.scheduling.maxRunDuration.seconds, '7200');
  const seen = await provider.observe();
  assert.equal(seen.complete, true);
  assert.equal(seen.instances.length, 1, 'foreign instances excluded');
  const instance = seen.instances[0];
  assert.equal(instance.alloc, row.alloc);
  assert.equal(instance.size, 2);
  assert.equal(instance.candidate.vcpus, 4);
  assert.deepEqual(instance.labels, ['self-hosted', 'ci-kit-pool', 'cpus-2', 'ci-kit-gce']);
  await provider.terminate(instance);
  assert.equal(w.g.instances.length, 0);
  assert.equal(w.g.disks.length, 0);
});

test('inventory waits for ledger rows and protects removed zones and zoneless failed running writes', async () => {
  const { w, provider, row } = setup();
  w.hooks.unreachable = 'us-east4-a'; // outside configured placements
  assert.equal((await provider.observe()).complete, true);
  assert.equal((await provider.observe({ rows: [{ ...row, zone: 'us-east4-a' }] })).complete, false);
  assert.equal((await provider.observe({ rows: [row] })).complete, false);
  assert.equal((await provider.observe({ rows: [{ ...row, state: 'final' }] })).complete, true);
  let release;
  let listed = false;
  const list = w.gce.listInstances;
  w.gce.listInstances = (...args) => { listed = true; return list(...args); };
  const observing = provider.observe({ rows: new Promise((r) => { release = r; }) });
  await Promise.resolve();
  assert.equal(listed, false);
  release([]);
  await observing;
  assert.equal(listed, true);
  w.gce.listInstances = async () => { throw new Error('unavailable'); };
  await assert.rejects(provider.observe(), /unavailable/);
});

test('provider room accounts for unlisted pending inserts and builders without double-counting a listed allocation', async () => {
  const limits = { get: async () => ({ addresses: { 'us-central1': 3 }, instances: {}, vcpus: {} }) };
  const { w, provider, row, candidate } = setup({ limits });
  const pending = { ...row, slow: [{ zone: candidate.zone, sent: row.at, outcome: 'unknown' }], egress: 'external' };
  w.g.instances.push({ name: 'ci-kit-builder-test', zone: 'zones/us-central1-a', machineType: 'x/c3d-highcpu-4',
    labels: { 'ci-kit': 'gce-builder' }, networkInterfaces: [{ accessConfigs: [{}] }], creationTimestamp: row.at, status: 'RUNNING' });
  const room = await (await provider.observe({ rows: [pending] })).room;
  assert.equal(room.fits(candidate), true);
  room.take(candidate);
  assert.equal(room.fits(candidate), false);
  await provider.launch(row, candidate, 'jit');
  const nextRoom = await (await provider.observe({ rows: [pending] })).room;
  assert.equal(nextRoom.fits(candidate), true, 'listed VM replaces, not adds to, the pending reservation');
});

for (const [status, codes, opts, expected] of [
  [200, ['ZONE_RESOURCE_POOL_EXHAUSTED'], { accepted: true, finished: true }, 'capacity'],
  [200, ['QUOTA_EXCEEDED'], { accepted: true, finished: true }, 'quota'],
  [403, [], {}, 'denied'],
  [429, [], {}, 'throttled'],
  [503, [], {}, 'uncertain'],
]) test(`launch classifies ${status}/${codes.join(',')} as ${expected} without losing operation evidence`, async () => {
  const { w, provider, row, candidate } = setup();
  const error = new GceError(status, 'insert refused', codes, { ...opts, operation: 'operation-link' });
  w.g.insertErrors.push({ match: () => true, error: () => error });
  const result = await provider.launch(row, candidate, 'jit');
  assert.equal(result.outcome, expected);
  assert.equal(result.detail, 'insert refused');
  assert.equal(result.error, error, 'legacy walk keeps original quota/operation metadata');
});

test('restart reconciliation observes the recorded operation, never repeats the launch', async () => {
  const { w, provider, row, candidate } = setup();
  w.g.insertErrors.push({ match: () => true, running: true,
    error: (op) => new GceError(504, 'wait ended', [], { accepted: true, operation: op.selfLink }) });
  const first = await provider.launch(row, candidate, 'jit');
  assert.equal(first.outcome, 'uncertain');
  const pending = { ...row, slow: [{ zone: candidate.zone, sent: row.at, operation: first.error.operation, outcome: 'unknown' }] };
  const restarted = createProvider({ gce: w.gce, cfg: CFG, now: w.now, after: w.after });
  assert.equal((await restarted.reconcileLaunch(pending)).outcome, 'uncertain');
  w.sim.completeInsert(row.instance);
  const result = await restarted.reconcileLaunch(pending);
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.done, row.at);
  assert.equal(w.log.filter((s) => s.startsWith('insert-wait')).length, 1);
});

test('late operation reads are batched by zone and preserve the refusal metric and settlement timestamp', async () => {
  const { w, provider, row, candidate } = setup();
  w.g.insertErrors.push({ match: () => true, running: true,
    error: (op) => new GceError(504, 'wait ended', [], { accepted: true, operation: op.selfLink }) });
  const result = await provider.launch(row, candidate, 'jit');
  const pending = { ...row, slow: [{ zone: candidate.zone, sent: row.at, operation: result.error.operation, outcome: 'unknown' }] };
  w.advance(60_000);
  w.sim.completeInsert(row.instance, { codes: ['QUOTA_EXCEEDED'], message: "Quota 'IN_USE_ADDRESSES' exceeded. Limit: 8 in region us-central1." });
  const settled = await provider.reconcileLaunches([pending]);
  assert.equal(settled.get(row.alloc).outcome, 'quota');
  assert.equal(settled.get(row.alloc).done, new Date(NOW + 60_000).toISOString());
  assert.match(settled.get(row.alloc).detail, /IN_USE_ADDRESSES/);
  assert.equal(w.log.filter((s) => s.startsWith('read operations')).length, 1);
});

test('GCE exit and startup failure reports are terminal, missing reports remain unknown', async () => {
  const { w, provider, row, candidate } = setup();
  await provider.launch(row, candidate, 'jit');
  assert.deepEqual((await provider.readReports([{ ...row, zone: candidate.zone }])).get(row.alloc), { telemetry: [] });
  for (const value of ['exit:0', 'failed:docker']) {
    w.g.instances[0].attrs = { 'ci-kit/job': value };
    assert.deepEqual((await provider.readReports([{ ...row, zone: candidate.zone }])).get(row.alloc),
      { telemetry: [], terminal: { kind: 'terminal', value } });
  }
  w.gce.guestAttribute = async () => { throw new GceError(503, 'unavailable'); };
  assert.deepEqual((await provider.readReports([{ ...row, zone: candidate.zone }])).get(row.alloc), { telemetry: [] });
});

for (const kind of ['boot', 'notice', 'claimed']) test(`${kind}-only bundles neither claim a runner nor retire its VM`, async () => {
  const { w, provider } = setup();
  let seq = 0;
  const ledger = createGceLedger(w.github, CFG.ledger, { now: w.now });
  const make = () => new Launcher({ provider, gh: w.github, ledger, cfg: CFG, config: CONFIG, now: w.now, random: () => ++seq });
  w.sim.queue(REPO, ['self-hosted', 'ci-kit-pool', 'cpus-2']);
  const first = await make().tick();
  assert.equal(first.launched.length, 1);
  const name = first.launched[0];
  w.sim.boot(REPO, name);
  provider.readReports = async (allocs) => new Map(allocs.map((a) => [a.alloc,
    { telemetry: [{ kind: kind === 'claimed' ? 'claimed' : 'telemetry', stage: kind }] }]));
  const next = await make().tick();
  assert.deepEqual(next.launched, [], 'idle runner still covers queued job');
  assert.deepEqual(next.deleted, [], 'nonterminal evidence cannot retire a runner');
  assert.equal(w.g.instances.length, 1);
  provider.readReports = async (allocs) => new Map(allocs.map((a) => [a.alloc,
    { telemetry: [], terminal: { kind: 'terminal', value: 'exit:0' } }]));
  const ended = await make().tick();
  assert.equal(ended.launched.length, 1, 'terminal evidence excludes old runner from coverage');
  assert.equal(ended.deleted.length, 1);
  assert.equal(w.gh.comments.map((c) => parseRow(c.body)).find((r) => r?.instance === name).state, 'deleting');
});

test('orphan cleanup removes only eligible disks and stale builders, not attached disks or job VMs', async () => {
  const { w, provider, row, candidate } = setup();
  await provider.launch(row, candidate, 'jit');
  const old = new Date(NOW - 5 * 3600_000).toISOString();
  w.g.disks.push({ name: 'orphan', zone: `zones/${candidate.zone}`, labels: { 'ci-kit': 'gce' }, creationTimestamp: old });
  w.g.disks.push({ name: 'foreign', zone: `zones/${candidate.zone}`, labels: {}, creationTimestamp: old });
  w.g.instances.push({ name: 'builder', zone: `zones/${candidate.zone}`, machineType: 'x/c3d-highcpu-4', status: 'TERMINATED',
    labels: { 'ci-kit': 'gce-builder' }, creationTimestamp: old });
  const seen = await provider.observe();
  const removed = await provider.cleanupOrphans(seen);
  assert.deepEqual(removed, ['disk orphan', 'builder (old builder)']);
  assert.equal(w.g.instances[0].name, instanceName(row.alloc));
  assert.deepEqual(w.g.disks.map((d) => d.name), [row.instance, 'foreign']);
});
