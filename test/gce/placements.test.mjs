// Placements (spec 2026-10-21, M1): gce.json's ordered placements, the walk across
// placements (spot everywhere before on demand anywhere), quota memory scoped to what ran out, admission's bound, and
// the job VM's subnetwork and boot disk taken from its placement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GceError } from '../../lib/gce.mjs';
import { parseGceConfig, placementZones } from '../../gce/launcher/config.mjs';
import { WEST, CENTRAL, COMMON, NEW_CFG, ONE_REGION_CFG as OLD_CFG, M6_CFG, M6_PLACEMENTS } from './config-fixtures.mjs';
import { placements, walkPlacements, quotaScope, quotaBlocks, largestMachineCpus, jobInstance, viewInstance } from '../../gce/launcher/logic.mjs';

const key = (p) => `${p.machine}/${p.provisioning}@${p.zone}`;

test('the new form parses to its placements, in order', () => {
  assert.deepEqual(NEW_CFG.placements, [WEST, CENTRAL]);
  assert.deepEqual(placementZones(NEW_CFG), [...WEST.zones, ...CENTRAL.zones]);
});

test('the old form (region, subnetwork, zones, machines, machine_fallback at the top) is refused: placements is the only form', () => {
  const old = { ...COMMON, region: 'us-central1', subnetwork: 'ci-kit-us-central1', zones: CENTRAL.zones, machines: CENTRAL.machines, machine_fallback: { 2: 'c3d-highcpu-4' } };
  assert.throws(() => parseGceConfig(JSON.stringify(old)), /placements must be a non-empty list/);
  for (const k of ['region', 'subnetwork', 'zones', 'machines', 'machine_fallback']) assert.throws(() => parseGceConfig(JSON.stringify(old)), new RegExp(`unknown key "${k}"`));
});

test('a placement is validated: every size named, zones of its region, its disk type, nothing unknown; no old-form key beside them', () => {
  const with_ = (p) => JSON.stringify({ ...COMMON, placements: [{ ...WEST, ...p }] });
  assert.throws(() => parseGceConfig(with_({ machines: { 2: 'c4d-highcpu-2' } })), /placements\[0\]: machines must map each of 2, 4, 8, 16/);
  assert.throws(() => parseGceConfig(with_({ zones: ['us-central1-a'] })), /placements\[0\]: zones must be a non-empty list of zones of its region/);
  assert.throws(() => parseGceConfig(with_({ disk_type: undefined })), /placements\[0\]: disk_type must be a resource name/);
  assert.throws(() => parseGceConfig(with_({ preemptible: true })), /placements\[0\]: unknown key "preemptible"/);
  assert.throws(() => parseGceConfig(JSON.stringify({ ...COMMON, placements: [] })), /placements must be a non-empty list/);
  assert.throws(() => parseGceConfig(JSON.stringify({ ...COMMON, placements: [WEST], zones: ['us-west4-a'] })), /unknown key "zones"/);
});

// Egress (2026-10-21): job and bake VMs take an external address unless gce.json routes them through the NAT, parked
// because GitHub's runner endpoints stall first connections from it in bursts (docs/pool.md, The network).
test('egress: "external", the default when absent, or "nat"; any other value is a config error', () => {
  const { egress: _, ...noEgress } = COMMON;
  assert.equal(parseGceConfig(JSON.stringify({ ...noEgress, placements: [WEST] })).egress, 'external');
  const with_ = (egress) => JSON.stringify({ ...noEgress, placements: [WEST], egress });
  assert.equal(parseGceConfig(with_('external')).egress, 'external');
  assert.equal(parseGceConfig(with_('nat')).egress, 'nat');
  for (const bad of ['NAT', 'none', '', true, null]) assert.throws(() => parseGceConfig(with_(bad)), /egress must be "external" or "nat"/, String(bad));
});

test('the walk: spot in every zone of each placement in order, then on demand in the same order', () => {
  assert.deepEqual(placements(8, NEW_CFG).map(key), [
    ...WEST.zones.map((z) => `c4d-highcpu-8/spot@${z}`), ...CENTRAL.zones.map((z) => `c3d-highcpu-8/spot@${z}`),
    ...WEST.zones.map((z) => `c4d-highcpu-8/standard@${z}`), ...CENTRAL.zones.map((z) => `c3d-highcpu-8/standard@${z}`),
  ]);
  assert.equal(placements(8, NEW_CFG)[0].placement, NEW_CFG.placements[0], 'each attempt carries its placement');
});

test('one region, two families: spot e2, spot c3d, on-demand e2, on-demand c3d; an attempt is never repeated', () => {
  const a = (m, prov) => CENTRAL.zones.map((z) => `${m}/${prov}@${z}`);
  assert.deepEqual(placements(2, OLD_CFG).map(key), [
    ...a('e2-highcpu-2', 'spot'), ...a('c3d-highcpu-4', 'spot'), ...a('e2-highcpu-2', 'standard'), ...a('c3d-highcpu-4', 'standard'),
  ]);
  assert.deepEqual(placements(4, OLD_CFG).map(key), [...a('c3d-highcpu-4', 'spot'), ...a('c3d-highcpu-4', 'standard')]);
});

test('M6\'s eight placements parse in order; a region two placements share is one set of zones to list', () => {
  assert.deepEqual(M6_CFG.placements, M6_PLACEMENTS);
  assert.deepEqual(M6_CFG.placements.map((p) => `${p.machines[8].split('-')[0]}@${p.region}`), [
    'c4d@us-west4', 'c4d@us-central1', 'c4d@us-east1', 'c4d@us-east4', 'c4d@us-east5', 'c3d@us-central1', 'c3d@us-east1', 'c3d@us-east4',
  ]);
  assert.equal(placementZones(M6_CFG).length, 3 + 4 + 3 + 3 + 3);
});

test('the walk across M6\'s placements: spot C4D region by region, then spot C3D, then on demand in the same order', () => {
  const spot = (cpus) => M6_PLACEMENTS.flatMap((p) => p.zones.map((z) => `${p.machines[cpus]}/spot@${z}`));
  const standard = (cpus) => spot(cpus).map((k) => k.replace('/spot@', '/standard@'));
  assert.deepEqual(placements(8, M6_CFG).map(key), [...spot(8), ...standard(8)]);
  assert.deepEqual(placements(8, M6_CFG).slice(0, 7).map(key), [
    'c4d-highcpu-8/spot@us-west4-a', 'c4d-highcpu-8/spot@us-west4-b', 'c4d-highcpu-8/spot@us-west4-c',
    'c4d-highcpu-8/spot@us-central1-a', 'c4d-highcpu-8/spot@us-central1-b', 'c4d-highcpu-8/spot@us-central1-c', 'c4d-highcpu-8/spot@us-central1-f',
  ]);
  // Size 2 is c4d-highcpu-2 on C4D and c3d-highcpu-4 on C3D, so admission reserves 4 for it.
  const two = placements(2, M6_CFG).filter((p) => p.provisioning === 'spot');
  assert.deepEqual([...new Set(two.map((p) => p.machine))], ['c4d-highcpu-2', 'c3d-highcpu-4']);
  assert.equal(two.findIndex((p) => p.machine === 'c3d-highcpu-4'), 16, 'C3D only after every C4D zone');
  assert.equal(largestMachineCpus(2, M6_CFG), 4);
  assert.equal(largestMachineCpus(16, M6_CFG), 16);
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

// The family quota as Compute Engine reported it live (an insert operation's error, us-west4, 2026-10-21 19:50Z): code
// QUOTA_EXCEEDED, errorDetails quotaInfo {dimensions: {region, vm_family: 'C4D'}, limitName
// 'CPUS-PER-VM-FAMILY-per-project-region'}. The operation error's message, as lib/gce.mjs settles it:
const familyQuota = (region) => new GceError(403,
  `gce operation operation-1: QUOTA_EXCEEDED Quota 'CPUS_PER_VM_FAMILY' exceeded.  Limit: 50.0 in region ${region}.`, ['QUOTA_EXCEEDED'], { accepted: true, finished: true });

test('CPUS_PER_VM_FAMILY is the refused machine\'s family quota in its region: C4D refused never blocks C3D beside it', () => {
  const m6 = (cpus) => Object.fromEntries(placements(cpus, M6_CFG).map((p) => [key(p), p]));
  const c4d = m6(8)['c4d-highcpu-8/spot@us-central1-a'];
  assert.deepEqual(quotaScope(familyQuota('us-central1'), c4d), { region: 'us-central1', family: 'c4d', vcpus: 8 });
  assert.deepEqual(quotaScope(familyQuota('us-west4'), W8), { region: 'us-west4', family: 'c4d', vcpus: 8 }, 'the live refusal');
  const memory = [quotaScope(familyQuota('us-central1'), c4d)];
  assert.equal(quotaBlocks(memory, m6(8)['c3d-highcpu-8/spot@us-central1-a']), false, 'C3D in the same region');
  assert.equal(quotaBlocks(memory, m6(16)['c3d-highcpu-16/standard@us-central1-f']), false);
  assert.equal(quotaBlocks(memory, m6(8)['c4d-highcpu-8/spot@us-central1-b']), true, 'C4D there, same size');
  assert.equal(quotaBlocks(memory, m6(8)['c4d-highcpu-8/spot@us-east1-b']), false, 'C4D in another region');
  // The older per-family form keeps its meaning.
  assert.deepEqual(quotaScope(quota('C3D_CPUS', 'in region us-central1'), m6(8)['c3d-highcpu-8/spot@us-central1-a']), { region: 'us-central1', family: 'c3d', vcpus: 8 });
});

test('C4D refused for its family quota in every region: the walk asks each C4D placement once, then lands on C3D us-central1', async () => {
  const memory = [];
  const { tried, result } = await walk(8, (p) => (p.machine.startsWith('c4d-') ? familyQuota(p.placement.region) : null), memory, M6_CFG);
  assert.deepEqual(tried, [
    'c4d-highcpu-8/spot@us-west4-a', 'c4d-highcpu-8/spot@us-central1-a', 'c4d-highcpu-8/spot@us-east1-b',
    'c4d-highcpu-8/spot@us-east4-a', 'c4d-highcpu-8/spot@us-east5-a', 'c3d-highcpu-8/spot@us-central1-a',
  ]);
  assert.equal(result.placement.machine, 'c3d-highcpu-8');
  assert.equal(memory.length, 5);
  assert.ok(memory.every((q) => q.family === 'c4d'));
});

async function walk(cpus, script, memory, cfg = NEW_CFG) {
  const tried = [];
  const result = await walkPlacements(placements(cpus, cfg), {
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

test('the shipped gce.json is the spec\'s pool: M6\'s eight placements, C4D before C3D, no E2', () => {
  const text = readFileSync(new URL('../../pool/config/gce.json', import.meta.url), 'utf8');
  const shipped = parseGceConfig(text);
  const id = (p) => `${p.machines[8]}@${p.region}`;
  const byId = (list) => Object.fromEntries(list.map((p) => [id(p), p]));
  assert.deepEqual(byId(shipped.placements), byId(M6_PLACEMENTS), 'the same eight placements (their order is a commit on main)');
  assert.equal(shipped.placements.length, 8);
  const first = (family) => shipped.placements.findIndex((p) => p.machines[8].startsWith(`${family}-`));
  const last = (family) => shipped.placements.findLastIndex((p) => p.machines[8].startsWith(`${family}-`));
  assert.ok(last('c4d') < first('c3d'), 'speed first: every C4D placement before any C3D one');
  assert.equal(shipped.placements.some((p) => Object.values(p.machines).some((m) => m.startsWith('e2-'))), false);
  // The served repos change by commit, and max_vcpus follows the granted quotas (docs/pool.md, Quotas and budget), never
  // above the project's all-regions CPU quota (CPUS_ALL_REGIONS, 512 since 2026-10-21).
  const rest = ({ repos: _, placements: __, max_vcpus: ___, ...others }) => others;
  assert.ok(Number.isInteger(shipped.max_vcpus) && shipped.max_vcpus > 0 && shipped.max_vcpus <= 512, String(shipped.max_vcpus));
  assert.deepEqual(rest(shipped), rest(COMMON), 'every other key keeps its value');
  // Egress is named in the file, not left to the default: re-enabling the NAT is this one value, changed on main.
  assert.equal(JSON.parse(text).egress, 'external');
});
