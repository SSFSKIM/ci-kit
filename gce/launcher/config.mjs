// The GCE backend's config (spec I12): pool/config/gce.json in the kit. No secrets.
// Capacity is an ordered list of placements (spec 2026-10-21 Placements): each a region and machine family the launcher
// may create a VM in, with its zones, subnetwork, a machine for every size and the boot disk type.
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
export const SIZES = ['2', '4', '8', '16'];
const COMMON = ['repos', 'project', 'disk_gb', 'max_run_minutes', 'max_vcpus', 'image_family', 'idle_runner_minutes', 'network', 'egress', 'ledger'];
// How job and bake VMs reach the internet: `external`, each its own ephemeral external address (the default), or `nat`,
// none, through its region's Cloud NAT (gce/deploy.sh network). The NAT is parked (docs/pool.md, The network): behind it
// GitHub's runner endpoints stall a burst of runners' first connections.
export const EGRESS = ['external', 'nat'];
const DEFAULT_EGRESS = 'external';
const PLACEMENT = ['region', 'subnetwork', 'zones', 'machines', 'disk_type'];

const name = (v) => typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v);
const positive = (v) => Number.isInteger(v) && v > 0;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const machineMap = (v) => object(v) && Object.entries(v).every(([k, m]) => SIZES.includes(k) && name(m)) && SIZES.every((k) => k in v);

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
  if (!machineMap(p.machines)) errors.push(`${where}: machines must map each of 2, 4, 8, 16 to a machine type`);
}

function parseObject(text, provider) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    throw new Error(`ci-kit: ${provider} config is not JSON`);
  }
  if (!object(cfg)) throw new Error(`ci-kit: ${provider} config must be an object`);
  return cfg;
}

function checkKeys(value, allowed, where, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${where}: unknown key "${key}"`);
}

function checkRepo(r, i, errors) {
  const where = `repos[${i}]`;
  if (!object(r) || typeof r.repo !== 'string' || !REPO.test(r.repo)) {
    errors.push(`${where} must name a repo as OWNER/NAME`);
    return;
  }
  checkKeys(r, ['repo', 'providers', 'allow_public'], where, errors);
  if ('allow_public' in r && r.allow_public !== true) errors.push(`${where}.allow_public must be true when present`);
  if (!('providers' in r)) return;
  if (!Array.isArray(r.providers)) {
    errors.push(`${where}.providers must be a list`);
    return;
  }
  r.providers.forEach((p, j) => {
    const at = `${where}.providers[${j}]`;
    if (!object(p)) {
      errors.push(`${at} must be an object`);
      return;
    }
    checkKeys(p, ['provider', 'account', 'max_vcpus'], at, errors);
    if (!['gce', 'ec2'].includes(p.provider)) errors.push(`${at}: provider must be gce or ec2`);
    if ('account' in p && (typeof p.account !== 'string' || !p.account)) errors.push(`${at}: account must be a non-empty string`);
    if ('max_vcpus' in p && !positive(p.max_vcpus)) errors.push(`${at}: max_vcpus must be a positive integer`);
  });
}

export function parseGceConfig(text) {
  const cfg = parseObject(text, 'gce');
  const errors = [];
  for (const key of Object.keys(cfg)) if (![...COMMON, 'placements'].includes(key)) errors.push(`unknown key "${key}"`);
  if (!Array.isArray(cfg.repos)) errors.push('repos must be a list');
  else cfg.repos.forEach((r, i) => checkRepo(r, i, errors));
  for (const key of ['project', 'image_family', 'network']) if (!name(cfg[key])) errors.push(`${key} must be a resource name`);
  if ('egress' in cfg && !EGRESS.includes(cfg.egress)) errors.push(`egress must be ${EGRESS.map((e) => `"${e}"`).join(' or ')}`);
  if (!Array.isArray(cfg.placements) || cfg.placements.length === 0) errors.push('placements must be a non-empty list');
  else cfg.placements.forEach((p, i) => checkPlacement(p, `placements[${i}]`, errors));
  for (const key of ['disk_gb', 'max_run_minutes', 'max_vcpus', 'idle_runner_minutes']) if (!positive(cfg[key])) errors.push(`${key} must be a positive integer`);
  if (typeof cfg.ledger?.repo !== 'string' || !REPO.test(cfg.ledger.repo) || typeof cfg.ledger?.issue_title !== 'string') {
    errors.push('ledger must be {"repo": "OWNER/NAME", "issue_title": "…"}');
  }
  if (errors.length) throw new Error(`ci-kit: gce config: ${errors.join('; ')}`);
  return { ...cfg, egress: cfg.egress ?? DEFAULT_EGRESS };
}

const EC2_ACCOUNT = ['account', 'enabled', 'region', 'placements', 'disk_gb', 'initialization_mibps', 'security_group', 'report_bucket', 'roles', 'credit'];
const date = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const ec2Machine = (v) => typeof v === 'string' && /^[a-z][a-z0-9]*\.[a-z0-9]+$/.test(v);

function checkEc2Account(a, i, errors) {
  const where = `accounts[${i}]`;
  if (!object(a)) {
    errors.push(`${where} must be an object`);
    return;
  }
  checkKeys(a, EC2_ACCOUNT, where, errors);
  if (typeof a.account !== 'string' || !/^\d{12}$/.test(a.account)) errors.push(`${where}: account must be a 12-digit string`);
  if ('enabled' in a && typeof a.enabled !== 'boolean') errors.push(`${where}: enabled must be a boolean`);
  if (a.region !== 'us-east-2') errors.push(`${where}: region must be us-east-2`);
  if (!positive(a.disk_gb)) errors.push(`${where}: disk_gb must be a positive integer`);
  if ('initialization_mibps' in a && (!Number.isInteger(a.initialization_mibps) || a.initialization_mibps < 100 || a.initialization_mibps > 300)) errors.push(`${where}: initialization_mibps must be an integer from 100 through 300`);
  if (typeof a.security_group !== 'string' || !/^sg-[0-9a-f]+$/.test(a.security_group)) errors.push(`${where}: security_group must be a security group id`);
  if (typeof a.report_bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(a.report_bucket)) errors.push(`${where}: report_bucket must be a bucket name`);
  if (!Array.isArray(a.placements) || !a.placements.length) errors.push(`${where}: placements must be a non-empty list`);
  else a.placements.forEach((p, j) => {
    const at = `${where}.placements[${j}]`;
    if (!object(p)) {
      errors.push(`${at} must be an object`);
      return;
    }
    // EC2 jobs are spot-only: there is deliberately no provisioning or on-demand key.
    checkKeys(p, ['zone', 'subnet', 'machines'], at, errors);
    if (typeof p.zone !== 'string' || !/^us-east-2[a-z]$/.test(p.zone)) errors.push(`${at}: zone must be in us-east-2`);
    if (typeof p.subnet !== 'string' || !/^subnet-[0-9a-f]+$/.test(p.subnet)) errors.push(`${at}: subnet must be a subnet id`);
    if (!object(p.machines) || !SIZES.every((k) => ec2Machine(p.machines[k])) || Object.keys(p.machines).some((k) => !SIZES.includes(k))) {
      errors.push(`${at}: machines must map each of 2, 4, 8, 16 to an EC2 instance type`);
    }
  });
  if (object(a.roles)) checkKeys(a.roles, ['launcher', 'bake', 'guard'], `${where}.roles`, errors);
  for (const role of ['launcher', 'bake', 'guard']) {
    const arn = a.roles?.[role];
    const match = typeof arn === 'string' && /^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9_+=,.@/-]+$/.exec(arn);
    if (!match || match[1] !== a.account) {
      errors.push(`${where}: roles.${role} must name account ${a.account} in an IAM role ARN`);
    }
  }
  if ('credit' in a) {
    const c = a.credit;
    if (!object(c)) errors.push(`${where}: credit must be an object`);
    else {
      checkKeys(c, ['enabled', 'since', 'until', 'budget_usd'], `${where}.credit`, errors);
      if (typeof c.enabled !== 'boolean') errors.push(`${where}: credit.enabled must be a boolean`);
      if (!date(c.since) || !date(c.until) || c.since > c.until) errors.push(`${where}: credit dates must be YYYY-MM-DD, since no later than until`);
      if (!Number.isFinite(c.budget_usd) || c.budget_usd <= 0) errors.push(`${where}: credit.budget_usd must be a positive finite number`);
    }
  }
}

export function parseEc2Config(text) {
  const cfg = parseObject(text, 'ec2');
  const errors = [];
  checkKeys(cfg, ['enabled', 'accounts'], 'ec2', errors);
  if (typeof cfg.enabled !== 'boolean') errors.push('enabled must be a boolean');
  if (!Array.isArray(cfg.accounts)) errors.push('accounts must be a list');
  else {
    const seen = new Set();
    cfg.accounts.forEach((a, i) => {
      checkEc2Account(a, i, errors);
      if (seen.has(a?.account)) errors.push(`accounts[${i}]: duplicate account ${a?.account}`);
      seen.add(a?.account);
    });
  }
  if (errors.length) throw new Error(`ci-kit: ec2 config: ${errors.join('; ')}`);
  return { ...cfg, accounts: cfg.accounts.map((a) => ({ ...a, enabled: a.enabled ?? true })) };
}

// Resolution is separate from launch eligibility: even disabled accounts validate and remain managed. Keep cfg.repos
// unchanged for GCE-only consumers; the scheduler consumes this resolved list instead.
export function resolveRepoProviders(cfg, ec2, { log = () => {} } = {}) {
  const accounts = ec2?.accounts.map((a) => a.account) ?? [];
  const skipped = [];
  const resolved = cfg.repos.map(({ repo, providers = [{ provider: 'gce' }] }) => {
    const seen = new Set();
    const list = [];
    for (const entry of providers) {
      const { provider } = entry;
      if (provider === 'ec2' && ec2 === null) {
        skipped.push(repo);
        continue;
      }
      let account = entry.account;
      if (provider === 'gce') {
        if (account !== undefined && account !== cfg.project) throw new Error(`ci-kit: ${repo}: gce account must be ${cfg.project}`);
        account = cfg.project;
      } else {
        if (account === undefined && accounts.length > 1) throw new Error(`ci-kit: ${repo}: ambiguous ec2 account; name account explicitly`);
        account ??= accounts[0];
        if (!accounts.includes(account)) throw new Error(`ci-kit: ${repo}: unknown ec2 account ${account ?? '(none configured)'}`);
      }
      const key = `${provider}/${account}`;
      if (seen.has(key)) throw new Error(`ci-kit: ${repo}: duplicate provider instance ${key}`);
      seen.add(key);
      list.push({ ...entry, account });
    }
    return [repo, list];
  });
  if (skipped.length) log(`config: ec2.json absent; skipping EC2 providers for ${[...new Set(skipped)].join(', ')}`);
  return Object.fromEntries(resolved);
}

// Every zone a placement names: where the launcher creates VMs, so the zones an instance listing must cover to be
// complete.
export const placementZones = (cfg) => [...new Set(cfg.placements.flatMap((p) => p.zones))];
