// The GCE backend's config (spec I12): pool/config/gce.json in the kit, beside pool.json. No secrets.
// Capacity is an ordered list of placements (spec 2026-10-21 Placements): each a region and machine family the launcher
// may create a VM in, with its zones, subnetwork, a machine for every size and the boot disk type. The old form (one
// region's `region`, `subnetwork`, `zones`, `machines` and `machine_fallback`) is still read until main carries the new
// one (M2). Either way the parsed config carries `placements` and none of the old keys.
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
export const SIZES = ['2', '4', '8', '16'];
const COMMON = ['repos', 'project', 'disk_gb', 'max_run_minutes', 'max_vcpus', 'image_family', 'idle_runner_minutes', 'network', 'ledger'];
const OLD = ['region', 'zones', 'machines', 'machine_fallback', 'subnetwork'];
const PLACEMENT = ['region', 'subnetwork', 'zones', 'machines', 'disk_type'];
const OLD_DISK_TYPE = 'pd-balanced'; // every VM before placements booted from it

const name = (v) => typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v);
const positive = (v) => Number.isInteger(v) && v > 0;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const machineMap = (v, { all }) =>
  object(v) && Object.entries(v).every(([k, m]) => SIZES.includes(k) && name(m)) && (!all || SIZES.every((k) => k in v));

function checkPlacement(p, where, errors) {
  if (!object(p)) {
    errors.push(`${where} must be an object`);
    return;
  }
  for (const key of Object.keys(p)) if (!PLACEMENT.includes(key)) errors.push(`${where}: unknown key "${key}"`);
  for (const key of ['region', 'subnetwork', 'disk_type']) if (!name(p[key])) errors.push(`${where}: ${key} must be a resource name`);
  if (!Array.isArray(p.zones) || p.zones.length === 0 || !p.zones.every((z) => name(z) && z.startsWith(`${p.region}-`))) {
    errors.push(`${where}: zones must be a non-empty list of zones of its region`);
  }
  if (!machineMap(p.machines, { all: true })) errors.push(`${where}: machines must map each of 2, 4, 8, 16 to a machine type`);
}

// The old form as placements (spec Decision Log, pre-flight): `machine_fallback` becomes a second placement of the
// same region, subnetwork and zones whose machines are the primary ones with the fallback's over them. The walk drops
// the attempts it repeats, so only the sizes the fallback names gain anything from it.
function oldPlacements(cfg) {
  const first = { region: cfg.region, subnetwork: cfg.subnetwork, zones: cfg.zones, machines: cfg.machines, disk_type: OLD_DISK_TYPE };
  return cfg.machine_fallback ? [first, { ...first, machines: { ...cfg.machines, ...cfg.machine_fallback } }] : [first];
}

export function parseGceConfig(text) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    throw new Error('ci-kit: gce config is not JSON');
  }
  const errors = [];
  const old = !('placements' in cfg);
  const keys = old ? [...COMMON, ...OLD] : [...COMMON, 'placements'];
  for (const key of Object.keys(cfg)) if (!keys.includes(key)) errors.push(`unknown key "${key}"`);
  if (!Array.isArray(cfg.repos)) errors.push('repos must be a list');
  (cfg.repos ?? []).forEach((r, i) => {
    if (typeof r?.repo !== 'string' || !REPO.test(r.repo) || Object.keys(r).length !== 1) errors.push(`repos[${i}] must be {"repo": "OWNER/NAME"}`);
  });
  for (const key of ['project', 'image_family', 'network']) if (!name(cfg[key])) errors.push(`${key} must be a resource name`);
  if (old) {
    for (const key of ['region', 'subnetwork']) if (!name(cfg[key])) errors.push(`${key} must be a resource name`);
    if (!Array.isArray(cfg.zones) || cfg.zones.length === 0 || !cfg.zones.every(name)) errors.push('zones must be a non-empty list of zones');
    if (!machineMap(cfg.machines, { all: true })) errors.push('machines must map each of 2, 4, 8, 16 to a machine type');
    if (cfg.machine_fallback !== undefined && !machineMap(cfg.machine_fallback, { all: false })) errors.push('machine_fallback must map sizes to machine types');
  } else if (!Array.isArray(cfg.placements) || cfg.placements.length === 0) {
    errors.push('placements must be a non-empty list');
  } else {
    cfg.placements.forEach((p, i) => checkPlacement(p, `placements[${i}]`, errors));
  }
  for (const key of ['disk_gb', 'max_run_minutes', 'max_vcpus', 'idle_runner_minutes']) if (!positive(cfg[key])) errors.push(`${key} must be a positive integer`);
  if (typeof cfg.ledger?.repo !== 'string' || !REPO.test(cfg.ledger.repo) || typeof cfg.ledger?.issue_title !== 'string') {
    errors.push('ledger must be {"repo": "OWNER/NAME", "issue_title": "…"}');
  }
  if (errors.length) throw new Error(`ci-kit: gce config: ${errors.join('; ')}`);
  if (!old) return cfg;
  const placements = oldPlacements(cfg);
  for (const key of OLD) delete cfg[key];
  return { ...cfg, placements };
}

// Every zone a placement names: where the launcher creates VMs, so the zones an instance listing must cover to be
// complete.
export const placementZones = (cfg) => [...new Set(cfg.placements.flatMap((p) => p.zones))];

// One file per repo (spec §3a, Which backend serves a repo): a repo listed in gce.json and in pool.json is served by
// neither, so no pool job is ever served by both backends. gceRepos: gce.json's entries; poolRepos: pool.json's names.
export function servedRepos(gceRepos, poolRepos) {
  const inPool = new Set(poolRepos.map((r) => r.toLowerCase()));
  const served = [];
  const both = [];
  for (const { repo } of gceRepos) (inPool.has(repo.toLowerCase()) ? both : served).push(repo);
  return { served, both };
}
