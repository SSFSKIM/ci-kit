// Placement admission from known limits (spec 2026-10-21 M6, the walk's refusal cost). A refused insert is the insert
// operation's error, 6-21 s after it was sent (live 2026-10-21), and walks in flight together each pay the same one, so
// the walk knows each placement's limits and skips a full one without an insert: the region's in-use addresses (a job
// VM with external egress holds one) and instances, from regions.get, and each family's vCPUs, from Cloud Quotas
// (C3D and C4D have no <FAMILY>_CPUS metric of their own; their grant is CPUS_PER_VM_FAMILY's (region, vm_family)
// entry). The limits are read live, not configured: grants still reconciling arrive by themselves, and a new gce.json
// key would be refused by a launcher running older code. What holds each limit comes from the tick's own listing,
// plus what its walks have sent.
import { machineCpus } from '../bake/plan.mjs';
import { providerKey } from './providers/contracts.mjs';

export const LIMITS_TTL_MS = 10 * 60_000; // grants change by hand, hours apart; a tick reads them from the cache
export const FAMILY_QUOTA = 'CPUS-PER-VM-FAMILY-per-project-region';
export const regionOf = (zone) => zone.replace(/-[a-z]$/, '');
export const familyOf = (machine) => machine.split('-')[0];

// A region's limits from GET regions/{region}: its addresses and instances, and the vCPUs of any family with a metric
// of its own (<FAMILY>_CPUS).
export function regionLimits(body) {
  const limits = { vcpus: {} };
  for (const q of body.quotas ?? []) {
    if (q.metric === 'IN_USE_ADDRESSES') limits.addresses = q.limit;
    else if (q.metric === 'INSTANCES') limits.instances = q.limit;
    else {
      const family = /^([A-Z][A-Z0-9]*)_CPUS$/.exec(q.metric)?.[1];
      if (family && family !== 'PREEMPTIBLE') limits.vcpus[family.toLowerCase()] = q.limit;
    }
  }
  return limits;
}

// Each (region, family)'s vCPUs from Cloud Quotas' CPUS_PER_VM_FAMILY quotaInfo: its own entry, else the quota's
// default (the entry with no dimensions). A value under 0 is unlimited, so no cap. pairs: [[region, family], …].
export function familyLimits(info, pairs) {
  const entries = info.dimensionsInfos ?? [];
  const fallback = entries.find((e) => !e.dimensions || Object.keys(e.dimensions).length === 0);
  const out = {};
  for (const [region, family] of pairs) {
    const own = entries.find((e) => e.dimensions?.region === region && e.dimensions?.vm_family?.toLowerCase() === family);
    const value = Number((own ?? fallback)?.details?.value);
    if (Number.isFinite(value) && value >= 0) out[`${region}|${family}`] = value;
  }
  return out;
}

const pairsOf = (placements) => [...new Map(placements.flatMap((p) => Object.values(p.machines).map((m) => {
  const pair = [p.region, familyOf(m)];
  return [pair.join('|'), pair];
}))).values()];

// The limits of gce.json's placements, read at once: {addresses, instances: region → n, vcpus: 'region|family' → n}.
// gce: lib/gce.mjs's region(name) and quotaInfo(id). Throws when any read fails.
export async function readLimits(gce, placements) {
  const regions = [...new Set(placements.map((p) => p.region))];
  const pairs = pairsOf(placements);
  const [bodies, families] = await Promise.all([Promise.all(regions.map((r) => gce.region(r))), gce.quotaInfo(FAMILY_QUOTA)]);
  const limits = { addresses: {}, instances: {}, vcpus: familyLimits(families, pairs) };
  const wanted = new Set(pairs.map((p) => p.join('|')));
  regions.forEach((region, i) => {
    const r = regionLimits(bodies[i]);
    if (r.addresses !== undefined) limits.addresses[region] = r.addresses;
    if (r.instances !== undefined) limits.instances[region] = r.instances;
    for (const [family, n] of Object.entries(r.vcpus)) if (wanted.has(`${region}|${family}`)) limits.vcpus[`${region}|${family}`] = n;
  });
  return limits;
}

// The limits across ticks (the server keeps one for the process): read again once LIMITS_TTL_MS old or when the
// placements change. get(placements) resolves to the limits, or to null while none was ever read; a failed read keeps
// the last good one. read(placements) → limits.
export function limitsCache({ read, ttlMs = LIMITS_TTL_MS, now = Date.now, log = () => {} }) {
  let held = null; // {limits, at, key}
  let reading = null;
  return {
    get(placements) {
      const key = pairsOf(placements).map((p) => p.join('|')).sort().join(',');
      if (held?.key === key && now() - held.at < ttlMs) return Promise.resolve(held.limits);
      reading ??= read(placements).then((limits) => {
        held = { limits, at: now(), key };
        return limits;
      }, (err) => {
        log(`quota limits: ${err.message}; ${held ? 'the last read is kept' : 'the walk runs without them'}`);
        return held?.limits ?? null;
      }).finally(() => { reading = null; });
      return reading;
    },
  };
}

// A tick's room in each placement: the limits, less what the listing's VMs hold (instances: viewInstance()s of every
// ci-kit VM, job and bake) and what its walks have sent. A stopped VM holds an instance but no vCPUs or address; a VM
// behind the NAT holds no address, and while gce.json's egress is `nat` no new one needs one. take() as an insert is
// sent and release() when it is refused or fails; an unknown outcome keeps its share, since its VM may exist. A refusal
// that still happens (the limit was wrong, or something outside the listing holds a share) closes that limit for the
// rest of the tick: refused(attempt, metric), whatever later releases do. pending: an earlier tick's inserts whose
// outcome is still unknown and whose VM is not listed ({zone, vcpus, egress}, from the ledger): each holds its region's
// instance and address, and its vCPUs in each family a placement offers in its zone (its machine is not recorded, so
// where two families share the zone both count it, the safe side). Null without limits: nothing is skipped, as before
// admission.
export function createRoom({ limits, instances, egress, pending = [], placements = [], provider = 'gce', account = null }) {
  if (!limits) return null;
  // Limits belong to this provider/account. Inventory and attempts keep their own identities, so a foreign
  // refusal or reservation cannot close this room. Human-readable GCE diagnostics keep their existing wording.
  const key = (scope, label) => providerKey({ provider: scope.provider ?? provider, account: scope.account ?? account }, label);
  const label = (k) => JSON.parse(k).at(-1);
  const caps = new Map();
  for (const [region, n] of Object.entries(limits.addresses ?? {})) caps.set(key({}, `${region} addresses`), n);
  for (const [region, n] of Object.entries(limits.instances ?? {})) caps.set(key({}, `${region} instances`), n);
  for (const [pair, n] of Object.entries(limits.vcpus ?? {})) caps.set(key({}, `${pair.replace('|', ' ')} vCPUs`), n);
  const held = new Map();
  const add = (key, n) => held.set(key, (held.get(key) ?? 0) + n);
  for (const i of instances) {
    const region = regionOf(i.zone);
    add(key(i, `${region} instances`), 1);
    if (i.status === 'TERMINATED') continue;
    add(key(i, `${region} ${familyOf(i.machine)} vCPUs`), i.vcpus);
    if (i.egress !== 'nat') add(key(i, `${region} addresses`), 1);
  }
  for (const u of pending) {
    const region = regionOf(u.zone);
    add(key(u, `${region} instances`), 1);
    if (u.egress !== 'nat') add(key(u, `${region} addresses`), 1);
    const families = new Set(placements.filter((p) => p.zones.includes(u.zone)).flatMap((p) => Object.values(p.machines).map(familyOf)));
    for (const family of families) add(key(u, `${region} ${family} vCPUs`), u.vcpus);
  }
  const closed = new Set(); // limits a refusal closed for the tick
  const needs = (p) => {
    const region = p.placement.region;
    return [[key(p, `${region} ${familyOf(p.machine)} vCPUs`), machineCpus(p.machine)], [key(p, `${region} instances`), 1], ...(egress === 'nat' ? [] : [[key(p, `${region} addresses`), 1]])];
  };
  const over = (p) => needs(p).find(([key, n]) => closed.has(key) || (caps.has(key) && (held.get(key) ?? 0) + n > caps.get(key)));
  const skipped = {};
  return {
    fits: (p) => !over(p),
    // The limit an attempt would pass, as "<region> <limit> held/cap", or null.
    why(p) {
      const o = over(p);
      return o ? `${label(o[0])} ${held.get(o[0]) ?? 0}/${caps.get(o[0])}` : null;
    },
    // An attempt the walk skipped for want of room, counted by the limit it would pass (the tick summary's `full`).
    skip(p) {
      const o = over(p);
      if (o) skipped[label(o[0])] = (skipped[label(o[0])] ?? 0) + 1;
    },
    skipped: () => ({ ...skipped }),
    take: (p) => needs(p).forEach(([key, n]) => add(key, n)),
    release: (p) => needs(p).forEach(([key, n]) => add(key, -n)),
    refused(p, metric) {
      const base = (metric ?? '').replace(/^PREEMPTIBLE_/, '');
      const region = p.placement.region;
      const family = familyOf(p.machine);
      const limit = base === 'IN_USE_ADDRESSES' ? `${region} addresses`
        : base === 'INSTANCES' ? `${region} instances`
          : base === 'CPUS_PER_VM_FAMILY' || base === `${family.toUpperCase()}_CPUS` ? `${region} ${family} vCPUs` : null;
      if (limit && base === metric) {
        const k = key(p, limit);
        closed.add(k);
        caps.set(k, Math.min(caps.get(k) ?? Infinity, held.get(k) ?? 0));
      }
    },
  };
}
