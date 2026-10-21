// Placements (spec 2026-10-21, M1): gce.json's ordered placements and the old form read as placements, the walk across
// placements (spot everywhere before on demand anywhere), quota memory scoped to what ran out, admission's bound, and
// the job VM's subnetwork and boot disk taken from its placement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GceError } from '../../lib/gce.mjs';
import { parseGceConfig, placementZones } from '../../gce/launcher/config.mjs';
import { placements, walkPlacements, quotaScope, quotaBlocks, largestMachineCpus, jobInstance, viewInstance } from '../../gce/launcher/logic.mjs';

const OLD = JSON.parse(readFileSync(new URL('../../pool/config/gce.json', import.meta.url), 'utf8'));
const COMMON = Object.fromEntries(Object.entries(OLD).filter(([k]) => !['region', 'subnetwork', 'zones', 'machines', 'machine_fallback'].includes(k)));
const WEST = {
  region: 'us-west4', subnetwork: 'ci-kit-us-west4', zones: ['us-west4-a', 'us-west4-b', 'us-west4-c'],
  machines: { 2: 'c4d-highcpu-2', 4: 'c4d-highcpu-4', 8: 'c4d-highcpu-8', 16: 'c4d-highcpu-16' }, disk_type: 'hyperdisk-balanced',
};
const CENTRAL = {
  region: 'us-central1', subnetwork: 'ci-kit-us-central1', zones: ['us-central1-a', 'us-central1-b', 'us-central1-c', 'us-central1-f'],
  machines: { 2: 'c3d-highcpu-4', 4: 'c3d-highcpu-4', 8: 'c3d-highcpu-8', 16: 'c3d-highcpu-16' }, disk_type: 'pd-balanced',
};
// The new form as the spec writes it: C4D us-west4 first, C3D us-central1 second.
export const NEW_CFG = parseGceConfig(JSON.stringify({ ...COMMON, placements: [WEST, CENTRAL] }));
const OLD_CFG = parseGceConfig(JSON.stringify(OLD));
const key = (p) => `${p.machine}/${p.provisioning}@${p.zone}`;

test('the new form parses to its placements, in order', () => {
  assert.deepEqual(NEW_CFG.placements, [WEST, CENTRAL]);
  assert.deepEqual(placementZones(NEW_CFG), [...WEST.zones, ...CENTRAL.zones]);
});

test('the old form reads as its placement plus machine_fallback as a second of the same region, and keeps none of its keys', () => {
  const first = { region: 'us-central1', subnetwork: 'ci-kit-us-central1', zones: OLD.zones, machines: OLD.machines, disk_type: 'pd-balanced' };
  assert.deepEqual(OLD_CFG.placements, [first, { ...first, machines: { ...OLD.machines, 2: 'c3d-highcpu-4' } }]);
  for (const k of ['region', 'subnetwork', 'zones', 'machines', 'machine_fallback']) assert.equal(k in OLD_CFG, false, k);
  const { machine_fallback: _, ...noFallback } = OLD;
  assert.equal(parseGceConfig(JSON.stringify(noFallback)).placements.length, 1);
});

test('a placement is validated: every size named, zones of its region, its disk type, nothing unknown; the forms do not mix', () => {
  const with_ = (p) => JSON.stringify({ ...COMMON, placements: [{ ...WEST, ...p }] });
  assert.throws(() => parseGceConfig(with_({ machines: { 2: 'c4d-highcpu-2' } })), /placements\[0\]: machines must map each of 2, 4, 8, 16/);
  assert.throws(() => parseGceConfig(with_({ zones: ['us-central1-a'] })), /placements\[0\]: zones must be a non-empty list of zones of its region/);
  assert.throws(() => parseGceConfig(with_({ disk_type: undefined })), /placements\[0\]: disk_type must be a resource name/);
  assert.throws(() => parseGceConfig(with_({ preemptible: true })), /placements\[0\]: unknown key "preemptible"/);
  assert.throws(() => parseGceConfig(JSON.stringify({ ...COMMON, placements: [] })), /placements must be a non-empty list/);
  assert.throws(() => parseGceConfig(JSON.stringify({ ...COMMON, placements: [WEST], zones: ['us-west4-a'] })), /unknown key "zones"/);
});

test('the walk: spot in every zone of each placement in order, then on demand in the same order', () => {
  assert.deepEqual(placements(8, NEW_CFG).map(key), [
    ...WEST.zones.map((z) => `c4d-highcpu-8/spot@${z}`), ...CENTRAL.zones.map((z) => `c3d-highcpu-8/spot@${z}`),
    ...WEST.zones.map((z) => `c4d-highcpu-8/standard@${z}`), ...CENTRAL.zones.map((z) => `c3d-highcpu-8/standard@${z}`),
  ]);
  assert.equal(placements(8, NEW_CFG)[0].placement, NEW_CFG.placements[0], 'each attempt carries its placement');
});

test('on the old form: spot e2, spot c3d, on-demand e2, on-demand c3d; an attempt is never repeated', () => {
  const a = (m, prov) => OLD.zones.map((z) => `${m}/${prov}@${z}`);
  assert.deepEqual(placements(2, OLD_CFG).map(key), [
    ...a('e2-highcpu-2', 'spot'), ...a('c3d-highcpu-4', 'spot'), ...a('e2-highcpu-2', 'standard'), ...a('c3d-highcpu-4', 'standard'),
  ]);
  assert.deepEqual(placements(4, OLD_CFG).map(key), [...a('c3d-highcpu-4', 'spot'), ...a('c3d-highcpu-4', 'standard')]);
});

test('admission reserves the largest machine any placement could give the size', () => {
  assert.equal(largestMachineCpus(2, NEW_CFG), 4, 'c4d-highcpu-2 or c3d-highcpu-4');
  assert.equal(largestMachineCpus(8, NEW_CFG), 8);
  assert.equal(largestMachineCpus(2, OLD_CFG), 4, 'e2-highcpu-2 or its fallback c3d-highcpu-4, as today');
});

// Quota refusals as Compute Engine words them (the error's message carries the API's own).
const quota = (metric, where = 'in region us-west4') => new GceError(403, `gce POST /zones/x/instances: 403 Quota '${metric}' exceeded.  Limit: 50.0 ${where}.`, ['quotaExceeded']);
const at = (cpus, cfg = NEW_CFG) => Object.fromEntries(placements(cpus, cfg).map((p) => [key(p), p]));
const W8 = at(8)['c4d-highcpu-8/spot@us-west4-a'];

test('a quota refusal is scoped to what ran out, as its message names it', () => {
  assert.deepEqual(quotaScope(quota('C4D_CPUS'), W8), { region: 'us-west4', family: 'c4d', vcpus: 8 });
  assert.deepEqual(quotaScope(quota('PREEMPTIBLE_C4D_CPUS'), W8), { region: 'us-west4', family: 'c4d', spot: true, vcpus: 8 });
  for (const metric of ['INSTANCES', 'IN_USE_ADDRESSES', 'DISKS_TOTAL_GB', 'SSD_TOTAL_GB', 'CPUS']) {
    assert.deepEqual(quotaScope(quota(metric), W8), { region: 'us-west4', vcpus: 8 }, metric);
  }
  assert.deepEqual(quotaScope(quota('PREEMPTIBLE_CPUS'), W8), { region: 'us-west4', spot: true, vcpus: 8 });
  assert.deepEqual(quotaScope(quota('CPUS_ALL_REGIONS', 'globally'), W8), { vcpus: 8 });
  // A refusal that names nothing (one settled through its operation's codes) is taken as the machine's family's.
  assert.deepEqual(quotaScope(new GceError(200, 'operation failed', ['QUOTA_EXCEEDED']), W8), { region: 'us-west4', family: 'c4d', vcpus: 8 });
  assert.deepEqual(quotaScope(null, W8), { region: 'us-west4', family: 'c4d', vcpus: 8 });
});

test('a remembered refusal skips only requests of the same or more vCPUs in its scope', () => {
  const memory = [quotaScope(quota('C4D_CPUS'), W8)];
  const blocked = (cpus, k) => quotaBlocks(memory, at(cpus)[k]);
  assert.equal(blocked(8, 'c4d-highcpu-8/standard@us-west4-c'), true);
  assert.equal(blocked(16, 'c4d-highcpu-16/spot@us-west4-b'), true);
  assert.equal(blocked(4, 'c4d-highcpu-4/spot@us-west4-a'), false, 'a smaller one may still fit');
  assert.equal(blocked(8, 'c3d-highcpu-8/spot@us-central1-a'), false, 'another region');
  const old = { 'C3D_CPUS in us-central1': quotaScope(quota('C3D_CPUS', 'in region us-central1'), at(2, OLD_CFG)['c3d-highcpu-4/spot@us-central1-a']) };
  assert.equal(quotaBlocks(Object.values(old), at(2, OLD_CFG)['e2-highcpu-2/spot@us-central1-b']), false, 'another family');
  const spotOnly = [quotaScope(quota('PREEMPTIBLE_CPUS'), W8)];
  assert.equal(quotaBlocks(spotOnly, at(8)['c4d-highcpu-8/standard@us-west4-a']), false, 'a preemptible quota binds spot only');
  const everywhere = [quotaScope(quota('CPUS_ALL_REGIONS', 'globally'), W8)];
  assert.equal(quotaBlocks(everywhere, at(8)['c3d-highcpu-8/standard@us-central1-f']), true);
  assert.equal(quotaBlocks(everywhere, at(4)['c3d-highcpu-4/spot@us-central1-a']), false);
});

async function walk(cpus, script, memory) {
  const tried = [];
  const result = await walkPlacements(placements(cpus, NEW_CFG), {
    attempt: async (p) => {
      tried.push(key(p));
      const err = script(p);
      if (err) throw err;
    },
    reconcile: async () => 'unknown',
    quota: memory,
  });
  return { tried, result };
}

test('a family quota refusal skips the rest of that placement and the walk goes on to the next, remembering it', async () => {
  const memory = [];
  const { tried, result } = await walk(8, (p) => (p.placement.region === 'us-west4' ? quota('C4D_CPUS') : null), memory);
  assert.deepEqual(tried, ['c4d-highcpu-8/spot@us-west4-a', 'c3d-highcpu-8/spot@us-central1-a']);
  assert.equal(result.placement.zone, 'us-central1-a');
  assert.equal(result.quota, true);
  assert.deepEqual(memory, [{ region: 'us-west4', family: 'c4d', vcpus: 8 }]);
  // The next launch of the tick does not ask us-west4 again; a smaller one does.
  assert.deepEqual((await walk(16, () => null, memory)).tried, ['c3d-highcpu-16/spot@us-central1-a']);
  assert.deepEqual((await walk(4, () => null, memory)).tried, ['c4d-highcpu-4/spot@us-west4-a']);
});

test('a capacity refusal moves zone by zone, across placements, before any on-demand attempt', async () => {
  const cap = new GceError(200, 'op', ['ZONE_RESOURCE_POOL_EXHAUSTED'], { accepted: true, finished: true });
  const { tried, result } = await walk(4, (p) => (p.provisioning === 'spot' ? cap : null), []);
  assert.deepEqual(tried, [...placements(4, NEW_CFG).filter((p) => p.provisioning === 'spot').map(key), 'c4d-highcpu-4/standard@us-west4-a']);
  assert.equal(result.placement.provisioning, 'standard');
});

test('a walk whose every placement is remembered refused makes no attempt', async () => {
  const memory = [{ vcpus: 2 }];
  const { tried, result } = await walk(2, () => null, memory);
  assert.deepEqual(tried, []);
  assert.equal(result.stop, 'exhausted');
});

test('the job VM is on its placement\'s subnetwork and boot disk type, and labelled with that disk type', () => {
  const [west] = placements(2, NEW_CFG);
  const body = jobInstance({ alloc: '0000000abc', ...west, repo: 'SSFSKIM/MAWS', cpus: 2, image: 'i', jit: 'j', cfg: NEW_CFG, config: 'abcdef0123' });
  assert.equal(body.machineType, 'zones/us-west4-a/machineTypes/c4d-highcpu-2');
  assert.equal(body.networkInterfaces[0].subnetwork, 'regions/us-west4/subnetworks/ci-kit-us-west4');
  assert.equal(body.disks[0].initializeParams.diskType, 'zones/us-west4-a/diskTypes/hyperdisk-balanced');
  assert.equal(body.labels['ci-kit-disk'], 'hyperdisk-balanced');
  const central = placements(8, NEW_CFG).find((p) => p.placement.region === 'us-central1');
  const c = jobInstance({ alloc: '0000000abc', ...central, repo: 'SSFSKIM/MAWS', cpus: 8, image: 'i', jit: 'j', cfg: NEW_CFG, config: 'abcdef0123' });
  assert.equal(c.networkInterfaces[0].subnetwork, 'regions/us-central1/subnetworks/ci-kit-us-central1');
  assert.equal(c.disks[0].initializeParams.diskType, 'zones/us-central1-a/diskTypes/pd-balanced');
  // The launcher reads the disk type back from the label; a VM launched before placements has none.
  assert.equal(viewInstance({ ...c, zone: 'x/us-central1-a', creationTimestamp: '2026-10-21T00:00:00Z' }).diskType, 'pd-balanced');
  assert.equal(viewInstance({ ...c, labels: {}, zone: 'x/us-central1-a', creationTimestamp: '2026-10-21T00:00:00Z' }).diskType, null);
});
