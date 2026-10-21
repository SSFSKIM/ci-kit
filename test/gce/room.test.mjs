// Placement admission from known limits (spec 2026-10-21 M6, the walk's refusal cost): the limits read live (regions.get
// for addresses and instances, Cloud Quotas for each family's vCPUs), cached across ticks, and a tick's room in each
// placement from them and its own listing, so a walk skips a full placement instead of paying its quota refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionLimits, familyLimits, readLimits, limitsCache, createRoom, LIMITS_TTL_MS } from '../../gce/launcher/room.mjs';
import { placements, walkPlacements, quotaBlocks } from '../../gce/launcher/logic.mjs';
import { GceError } from '../../lib/gce.mjs';
import { M6_CFG } from './config-fixtures.mjs';

// As GET regions/{region} returns it (recorded 2026-10-21, us-west4; quotas trimmed to those read and a few beside).
const REGION = (name, { addresses = 8, instances = 64, extra = [] } = {}) => ({
  kind: 'compute#region', name,
  quotas: [
    { limit: 200, metric: 'CPUS', usage: 0 }, { limit: 8, metric: 'STATIC_ADDRESSES', usage: 0 },
    { limit: addresses, metric: 'IN_USE_ADDRESSES', usage: 0 }, { limit: instances, metric: 'INSTANCES', usage: 0 },
    { limit: 24, metric: 'PREEMPTIBLE_CPUS', usage: 0 }, ...extra,
  ],
});
// As Cloud Quotas' quotaInfos/CPUS-PER-VM-FAMILY-per-project-region returns it (recorded 2026-10-21, trimmed): one
// entry per granted (region, family), and the default for the rest.
const FAMILIES = {
  quotaId: 'CPUS-PER-VM-FAMILY-per-project-region', dimensions: ['region', 'vm_family'],
  dimensionsInfos: [
    { dimensions: { region: 'us-central1', vm_family: 'C3D' }, details: { value: '192' }, applicableLocations: ['us-central1'] },
    { dimensions: { region: 'us-central1', vm_family: 'C4D' }, details: { value: '24' }, applicableLocations: ['us-central1'] },
    { dimensions: { vm_family: 'C4D', region: 'us-west4' }, details: { value: '50' }, applicableLocations: ['us-west4'] },
    { dimensions: { region: 'us-east1', vm_family: 'C4D' }, details: { value: '24' }, applicableLocations: ['us-east1'] },
    { details: { value: '24' }, applicableLocations: ['us-central1', 'us-east1', 'us-east4', 'us-east5', 'us-west4'] },
  ],
};

test('a region\'s limits: its addresses and instances, and any family with a quota of its own (<FAMILY>_CPUS)', () => {
  assert.deepEqual(regionLimits(REGION('us-west4')), { addresses: 8, instances: 64, vcpus: {} });
  assert.deepEqual(regionLimits(REGION('us-central1', { extra: [{ limit: 96, metric: 'C2D_CPUS', usage: 0 }] })).vcpus, { c2d: 96 });
});

test('each family\'s vCPUs in a region: its own entry, else the quota\'s default; unlimited (-1) is no cap', () => {
  const v = familyLimits(FAMILIES, [['us-west4', 'c4d'], ['us-central1', 'c3d'], ['us-central1', 'c4d'], ['us-east4', 'c4d']]);
  assert.deepEqual(v, { 'us-west4|c4d': 50, 'us-central1|c3d': 192, 'us-central1|c4d': 24, 'us-east4|c4d': 24 });
  const unlimited = { ...FAMILIES, dimensionsInfos: [{ dimensions: { region: 'us-west4', vm_family: 'C4D' }, details: { value: '-1' } }] };
  assert.deepEqual(familyLimits(unlimited, [['us-west4', 'c4d'], ['us-east1', 'c4d']]), {}, 'no default entry either');
});

test('readLimits reads every placement region and the family quota at once; a family\'s own metric comes first', async () => {
  const calls = [];
  const gce = {
    region: async (r) => {
      calls.push(`region ${r}`);
      return REGION(r, { addresses: r === 'us-central1' ? 32 : 8, extra: r === 'us-central1' ? [{ limit: 96, metric: 'C3D_CPUS', usage: 0 }] : [] });
    },
    quotaInfo: async (id) => { calls.push(`quota ${id}`); return FAMILIES; },
  };
  const limits = await readLimits(gce, M6_CFG.placements.slice(0, 2).concat(M6_CFG.placements[5]));
  assert.deepEqual(calls.sort(), ['quota CPUS-PER-VM-FAMILY-per-project-region', 'region us-central1', 'region us-west4']);
  assert.deepEqual(limits.addresses, { 'us-west4': 8, 'us-central1': 32 });
  assert.deepEqual(limits.instances, { 'us-west4': 64, 'us-central1': 64 });
  assert.deepEqual(limits.vcpus, { 'us-west4|c4d': 50, 'us-central1|c4d': 24, 'us-central1|c3d': 96 });
});

const WEST_ONLY = M6_CFG.placements.slice(0, 1);
test('the cache: one read for ticks inside its TTL, a fresh one after; a failed read keeps the last good, or none', async () => {
  let t = 0;
  let reads = 0;
  let fail = false;
  const logged = [];
  const cache = limitsCache({
    now: () => t, log: (m) => logged.push(m),
    read: async () => {
      reads += 1;
      if (fail) throw new Error('403 cloudquotas.quotas.get denied');
      return { n: reads };
    },
  });
  fail = true;
  assert.equal(await cache.get(WEST_ONLY), null, 'no read yet and this one failed: no limits');
  assert.match(logged.pop(), /403 .*the walk runs without them/);
  fail = false;
  assert.deepEqual(await cache.get(WEST_ONLY), { n: 2 });
  t += LIMITS_TTL_MS - 1;
  assert.deepEqual(await cache.get(WEST_ONLY), { n: 2 });
  assert.equal(reads, 2);
  t += 1;
  fail = true;
  assert.deepEqual(await cache.get(WEST_ONLY), { n: 2 }, 'stale and the read failed: the last good');
  assert.match(logged.pop(), /the last read is kept/);
  fail = false;
  assert.deepEqual(await cache.get(M6_CFG.placements), { n: 4 }, 'another set of placements is read at once');
});

const view = (zone, machine, { status = 'RUNNING', egress = 'external' } = {}) => ({ zone, machine, vcpus: Number(machine.split('-').pop()), status, egress });
const LIMITS = { addresses: { 'us-west4': 8, 'us-central1': 32 }, instances: { 'us-west4': 64, 'us-central1': 64 }, vcpus: { 'us-west4|c4d': 50, 'us-central1|c4d': 24, 'us-central1|c3d': 192 } };
const attempt = (cpus, region, family = 'c4d') => placements(cpus, M6_CFG).find((p) => p.placement.region === region && p.machine.startsWith(family));

test('room: a placement fits while its family\'s vCPUs, its region\'s addresses and its instances stay under their limits', () => {
  const room = createRoom({ limits: LIMITS, instances: [...Array(7)].map(() => view('us-west4-a', 'c4d-highcpu-4')), egress: 'external' });
  const west = attempt(4, 'us-west4');
  assert.ok(room.fits(west), '7 of 8 addresses');
  room.take(west);
  assert.ok(!room.fits(west), 'the 8th taken');
  assert.equal(room.why(west), 'us-west4 addresses 8/8');
  room.release(west);
  assert.ok(room.fits(west), 'a refused insert gives its share back');
  // vCPUs: 24 C4D in us-central1 are 6 c4d-4s; C3D there is counted apart.
  const c4d = attempt(4, 'us-central1');
  const c3d = attempt(4, 'us-central1', 'c3d');
  for (let k = 0; k < 6; k += 1) room.take(c4d);
  assert.ok(!room.fits(c4d));
  assert.equal(room.why(c4d), 'us-central1 c4d vCPUs 24/24');
  assert.ok(room.fits(c3d), 'another family in the same region');
  room.take(west);
  assert.ok(!room.fits(attempt(2, 'us-west4')), 'a smaller machine needs an address too');
});

test('room counts what holds each limit: a stopped VM no vCPUs or address, a VM behind the NAT no address', () => {
  const instances = [view('us-west4-a', 'c4d-highcpu-16', { status: 'TERMINATED' }), view('us-west4-b', 'c4d-highcpu-16', { egress: 'nat' })];
  const room = createRoom({ limits: { ...LIMITS, vcpus: { 'us-west4|c4d': 32 } }, instances, egress: 'external' });
  assert.ok(room.fits(attempt(16, 'us-west4')), '16 of 32 vCPUs held');
  room.take(attempt(16, 'us-west4'));
  assert.ok(!room.fits(attempt(2, 'us-west4')));
  const nat = createRoom({ limits: { ...LIMITS, addresses: { 'us-west4': 0 } }, instances: [], egress: 'nat' });
  assert.ok(nat.fits(attempt(4, 'us-west4')), 'a NAT VM takes no address');
  assert.equal(createRoom({ limits: null, instances: [], egress: 'external' }), null, 'no limits read: no admission');
});

test('a refusal that still happens closes its limit for the tick, whatever size asks next', () => {
  const room = createRoom({ limits: LIMITS, instances: [view('us-west4-a', 'c4d-highcpu-4')], egress: 'external' });
  const west = attempt(4, 'us-west4');
  room.take(west);
  room.release(west);
  room.refused(west, 'IN_USE_ADDRESSES');
  assert.ok(!room.fits(attempt(2, 'us-west4')), 'the limit was wrong: nothing more there this tick');
  assert.ok(room.fits(attempt(4, 'us-central1')));
  room.refused(attempt(4, 'us-central1'), 'CPUS_PER_VM_FAMILY');
  assert.ok(!room.fits(attempt(2, 'us-central1')));
  assert.ok(room.fits(attempt(4, 'us-central1', 'c3d')), 'a family\'s refusal leaves the other family');
  room.refused(attempt(4, 'us-central1', 'c3d'), 'PREEMPTIBLE_CPUS');
  assert.ok(room.fits(attempt(4, 'us-central1', 'c3d')), 'a quota room does not track is left to the quota memory');
});

const quotaErr = (metric, region) => new GceError(200, `operation failed: QUOTA_EXCEEDED Quota '${metric}' exceeded.  Limit: 8.0 in region ${region}.`, ['QUOTA_EXCEEDED'], { accepted: true, finished: true });

test('the walk skips a full placement without an insert, and gives back what a refused insert took', async () => {
  const room = createRoom({ limits: LIMITS, instances: [...Array(8)].map(() => view('us-west4-a', 'c4d-highcpu-4')), egress: 'external' });
  const sent = [];
  const memory = [];
  const result = await walkPlacements(placements(4, M6_CFG), {
    attempt: async (p) => {
      sent.push(`${p.machine}@${p.zone}`);
      if (p.zone === 'us-central1-a') throw quotaErr('CPUS_PER_VM_FAMILY', 'us-central1');
    },
    reconcile: async () => 'unknown', quota: memory, room,
  });
  assert.deepEqual(sent, ['c4d-highcpu-4@us-central1-a', 'c4d-highcpu-4@us-east1-b'], 'us-west4\'s full addresses cost no insert');
  assert.equal(result.placement.zone, 'us-east1-b');
  assert.ok(!room.fits(attempt(2, 'us-central1')), 'the refusal closed C4D us-central1');
  assert.ok(quotaBlocks(memory, attempt(4, 'us-central1')));
});

test('review: a closed limit stays closed when another insert in flight gives its share back', () => {
  const room = createRoom({ limits: LIMITS, instances: [], egress: 'external' });
  const four = attempt(4, 'us-west4');
  room.take(four);
  room.take(four);
  room.release(four);
  room.refused(four, 'IN_USE_ADDRESSES'); // the first refused: something outside the listing holds the rest
  room.release(four); // the second fails for capacity
  assert.ok(!room.fits(attempt(2, 'us-west4')), 'no address came free');
});

test('review: an unsettled insert of an earlier tick holds its region\'s address, instance and vCPUs while unlisted', () => {
  const pending = [{ zone: 'us-west4-a', vcpus: 4, egress: 'external' }];
  const room = createRoom({ limits: { ...LIMITS, addresses: { 'us-west4': 1 } }, instances: [], pending, egress: 'external', placements: M6_CFG.placements });
  assert.ok(!room.fits(attempt(4, 'us-west4')));
  assert.equal(room.why(attempt(4, 'us-west4')), 'us-west4 addresses 1/1');
  const vcpus = createRoom({ limits: { ...LIMITS, vcpus: { 'us-west4|c4d': 6 } }, instances: [], pending, egress: 'external', placements: M6_CFG.placements });
  assert.ok(!vcpus.fits(attempt(4, 'us-west4')), '4 of 6 held by the pending insert');
});
