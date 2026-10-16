// The GCE backend's config (spec I12): pool/config/gce.json in the kit, beside pool.json. No secrets.
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SIZES = ['2', '4', '8', '16'];
const KEYS = [
  'repos', 'project', 'region', 'zones', 'machines', 'machine_fallback', 'disk_gb', 'max_run_minutes', 'max_vcpus',
  'image_family', 'idle_runner_minutes', 'network', 'subnetwork', 'ledger',
];

const name = (v) => typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v);
const positive = (v) => Number.isInteger(v) && v > 0;
const machineMap = (v, { all }) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.entries(v).every(([k, m]) => SIZES.includes(k) && name(m)) &&
  (!all || SIZES.every((k) => k in v));

export function parseGceConfig(text) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    throw new Error('ci-kit: gce config is not JSON');
  }
  const errors = [];
  for (const key of Object.keys(cfg)) if (!KEYS.includes(key)) errors.push(`unknown key "${key}"`);
  if (!Array.isArray(cfg.repos)) errors.push('repos must be a list');
  (cfg.repos ?? []).forEach((r, i) => {
    if (typeof r?.repo !== 'string' || !REPO.test(r.repo) || Object.keys(r).length !== 1) errors.push(`repos[${i}] must be {"repo": "OWNER/NAME"}`);
  });
  for (const key of ['project', 'region', 'image_family', 'network', 'subnetwork']) if (!name(cfg[key])) errors.push(`${key} must be a resource name`);
  if (!Array.isArray(cfg.zones) || cfg.zones.length === 0 || !cfg.zones.every(name)) errors.push('zones must be a non-empty list of zones');
  if (!machineMap(cfg.machines, { all: true })) errors.push('machines must map each of 2, 4, 8, 16 to a machine type');
  if (cfg.machine_fallback !== undefined && !machineMap(cfg.machine_fallback, { all: false })) errors.push('machine_fallback must map sizes to machine types');
  for (const key of ['disk_gb', 'max_run_minutes', 'max_vcpus', 'idle_runner_minutes']) if (!positive(cfg[key])) errors.push(`${key} must be a positive integer`);
  if (typeof cfg.ledger?.repo !== 'string' || !REPO.test(cfg.ledger.repo) || typeof cfg.ledger?.issue_title !== 'string') {
    errors.push('ledger must be {"repo": "OWNER/NAME", "issue_title": "…"}');
  }
  if (errors.length) throw new Error(`ci-kit: gce config: ${errors.join('; ')}`);
  return cfg;
}

// One file per repo (spec §3a, Which backend serves a repo): a repo listed in gce.json and in pool.json is served by
// neither, so no pool job is ever served by both backends. gceRepos: gce.json's entries; poolRepos: pool.json's names.
export function servedRepos(gceRepos, poolRepos) {
  const inPool = new Set(poolRepos.map((r) => r.toLowerCase()));
  const served = [];
  const both = [];
  for (const { repo } of gceRepos) (inPool.has(repo.toLowerCase()) ? both : served).push(repo);
  return { served, both };
}
