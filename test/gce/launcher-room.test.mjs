// Placement admission in the launcher's tick (spec 2026-10-21 M6, the walk's refusal cost), against the shared fake of
// Compute Engine and GitHub: a burst past the first placement's addresses is spread over the placements by their known
// limits with no quota refusal, what the listing holds counts against them, a launch with every placement full waits
// without an insert, a refusal from a limit that was wrong closes it for the rest of the tick, and a launch the
// tick's deadline cut off is counted for the follow-up tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, gceErr } from './fake-world.mjs';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { M6_CFG } from './config-fixtures.mjs';
import { GceError } from '../../lib/gce.mjs';
import { launchRow, renderRow } from '../../gce/launcher/ledger.mjs';
import { allocationId } from '../../gce/launcher/logic.mjs';

const SBX = 'SSFSKIM/ci-kit-sandbox';
const CFG = { ...M6_CFG, repos: [{ repo: SBX }], max_vcpus: 386 };
const T0 = Date.parse('2026-10-21T23:23:00Z');
const L = (n) => ['self-hosted', 'ci-kit-pool', `cpus-${n}`];
const COMMIT = 'c0ffee00aabbccddeeff00112233445566778899';
// The live limits of 2026-10-21 (regions.get, Cloud Quotas).
const LIVE = {
  addresses: { 'us-west4': 8, 'us-central1': 32, 'us-east1': 8, 'us-east4': 8, 'us-east5': 8 },
  instances: { 'us-west4': 64, 'us-central1': 64, 'us-east1': 24, 'us-east4': 24, 'us-east5': 24 },
  vcpus: {
    'us-west4|c4d': 50, 'us-central1|c4d': 24, 'us-east1|c4d': 24, 'us-east4|c4d': 24, 'us-east5|c4d': 24,
    'us-central1|c3d': 192, 'us-east1|c3d': 24, 'us-east4|c3d': 24,
  },
};

function setup({ limits = LIVE, budgetMs } = {}) {
  const w = world({ start: T0 });
  let seq = 0;
  const reads = [];
  const launcher = new Launcher({
    gce: w.gce, gh: w.github, ledger: createGceLedger(w.github, CFG.ledger, { now: w.now }), cfg: CFG, config: COMMIT, poolRepos: [],
    now: w.now, random: () => (seq += 1), alert: async () => {}, log: (m) => w.log.push(`log ${m}`), after: w.after,
    limits: { get: async (placements) => { reads.push(placements.length); return limits; } }, ...(budgetMs ? { budgetMs } : {}),
  });
  return { w, launcher, reads };
}
const zoneOf = (w, name) => w.sim.vm(name).zone.split('/').pop();
const quotaErr = (metric, region) => () => new GceError(200, `operation failed: QUOTA_EXCEEDED Quota '${metric}' exceeded.  Limit: 8.0 in region ${region}.`, ['QUOTA_EXCEEDED'], { accepted: true, finished: true });

test('a burst of 20 cpus-4 jobs: us-west4 to its 8 addresses, C4D us-central1 to its 24 vCPUs, us-east1 for the rest; no insert refused', async () => {
  const { w, launcher, reads } = setup();
  for (let k = 0; k < 20; k += 1) w.sim.queue(SBX, L(4), { name: `ci / walk-${k}` });
  const out = await launcher.tick();
  assert.equal(out.launched.length, 20);
  assert.equal(reads.length, 1, 'the limits are asked for once a tick');
  const regions = {};
  for (const name of out.launched) {
    const key = `${w.sim.vm(name).machineType.split('/').pop()}@${zoneOf(w, name).replace(/-[a-z]$/, '')}`;
    regions[key] = (regions[key] ?? 0) + 1;
  }
  assert.deepEqual(regions, { 'c4d-highcpu-4@us-west4': 8, 'c4d-highcpu-4@us-central1': 6, 'c4d-highcpu-4@us-east1': 6 });
  assert.equal(w.log.filter((l) => / refused$/.test(l)).length, 0, 'every full placement skipped without an insert');
  assert.deepEqual(out.refusals, []);
  assert.ok(out.full['us-west4 addresses'] >= 12, JSON.stringify(out.full));
  assert.ok(out.full['us-central1 c4d vCPUs'] >= 6, JSON.stringify(out.full));
});

test('what the listing holds counts: 6 VMs up in us-west4 leave it room for 2', async () => {
  const { w, launcher } = setup();
  for (let k = 0; k < 6; k += 1) w.sim.queue(SBX, L(4));
  await launcher.tick();
  for (let k = 0; k < 4; k += 1) w.sim.queue(SBX, L(4));
  w.advance(60_000);
  const out = await launcher.tick();
  const zones = out.launched.map((n) => zoneOf(w, n));
  assert.deepEqual(zones.filter((z) => z.startsWith('us-west4')).length, 2);
  assert.deepEqual(zones.filter((z) => z.startsWith('us-central1')).length, 2);
});

test('every placement full: the launch waits without a row, a runner or an insert', async () => {
  const none = { addresses: Object.fromEntries(Object.keys(LIVE.addresses).map((r) => [r, 0])), instances: {}, vcpus: {} };
  const { w, launcher } = setup({ limits: none });
  w.sim.queue(SBX, L(4));
  const out = await launcher.tick();
  assert.deepEqual(out.launched, []);
  assert.equal(w.log.filter((l) => l.startsWith('insert') || l.startsWith('jit')).length, 0);
  assert.ok(w.log.some((l) => /waits: every placement for its size is full/.test(l)));
  assert.ok(out.full['us-west4 addresses'] >= 1, `the summary counts it: ${JSON.stringify(out.full)}`);
});

test('a limit that was wrong: its refusal closes it, so the walk goes on to the next placement and the next tick reads afresh', async () => {
  const { w, launcher } = setup();
  // Something outside the listing holds us-west4's addresses: the insert is refused, as it was live.
  w.g.insertErrors.push({ match: (zone) => zone.startsWith('us-west4'), error: quotaErr('IN_USE_ADDRESSES', 'us-west4') });
  w.sim.queue(SBX, L(4));
  const first = await launcher.tick();
  assert.deepEqual(first.launched.map((n) => zoneOf(w, n)), ['us-central1-a']);
  assert.equal(w.log.filter((l) => / refused$/.test(l)).length, 1, 'us-west4-b and -c are not asked');
  w.sim.queue(SBX, L(4));
  w.advance(60_000);
  const second = await launcher.tick();
  assert.deepEqual(second.launched.map((n) => zoneOf(w, n)), ['us-west4-a'], 'a tick\'s closed limit is its own');
});

test('a launch the tick\'s deadline cut off is counted for the follow-up tick', async () => {
  const { w, launcher } = setup({ budgetMs: 10_000 });
  w.g.insertErrors.push({ match: (zone) => zone === 'us-west4-a', error: () => {
    w.advance(11_000);
    return gceErr(['ZONE_RESOURCE_POOL_EXHAUSTED'])();
  } });
  w.sim.queue(SBX, L(4));
  const out = await launcher.tick();
  assert.deepEqual(out.launched, []);
  assert.equal(out.cut, 1);
});

test('review: an earlier tick\'s insert still unsettled and unlisted holds its placement\'s room', async () => {
  const one = { ...LIVE, addresses: { ...LIVE.addresses, 'us-west4': 1 } };
  const { w, launcher } = setup({ limits: one });
  // The ledger's row of a launch whose insert into us-west4-a never settled, its VM not (yet) listed.
  const at = T0 - 60_000;
  const alloc = allocationId(at, () => 7);
  const row = { ...launchRow({ alloc, repo: SBX, cpus: 4, at, config: COMMIT, egress: 'external', reserved: 4 }), slow: [{ zone: 'us-west4-a', outcome: 'unknown', sent: new Date(at).toISOString() }] };
  w.gh.comments.push({ id: 1, body: renderRow(row), updated_at: new Date(at).toISOString() });
  w.sim.queue(SBX, L(4));
  const out = await launcher.tick();
  assert.deepEqual(out.launched.map((n) => zoneOf(w, n)), ['us-central1-a'], 'us-west4\'s one address is the pending insert\'s');
});
