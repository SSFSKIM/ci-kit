// The GCE ledger rows (spec I12): one comment per allocation on the pool ledger issue, keyed by the allocation id,
// written `launching` before the JIT mint and finalized in place; and a daily line. A row only moves forward:
// launching → running (its VM exists) → deleting (just before the launcher's delete call) → final. The hidden mark
// differs from the Hetzner rows' (pool/lib/ledger.mjs), so each backend's readers see only their own rows.
import { instanceName } from './logic.mjs';
import { machineCpus } from '../bake/plan.mjs';

const ROW_MARK = 'ci-kit-gce-ledger';
const DAILY_MARK = 'ci-kit-gce-daily';
export const STATES = ['launching', 'running', 'deleting', 'final'];
const rank = (row) => STATES.indexOf(row.state);
export const moreFinal = (a, b) => rank(a) > rank(b);

// Rates by region and family, $ per vCPU-hour and per GiB-hour of memory (`gb`: per GB-hour, 10^9 bytes, as the
// catalog prices C4D's memory). A VM in a region or family with no rate here, or on a disk type its region has no
// price for, is unpriced.
// - us-central1 c3d and e2. Spot: the Cloud Billing catalog on 2026-10-16, as M7 recorded it (ci-kit-sandbox
//   evidence/maws/gce-spot.md). On demand: the list prices of the same day.
// - us-west4 c4d: the Cloud Billing catalog on 2026-10-21 (Compute Engine 6F81-5844-456A): spot core 4FCE-953F-3CE6,
//   spot RAM 9841-EB59-D7A0; on-demand core CB83-B2B2-36C9, on-demand RAM BECC-C6A5-A981.
const RATES = {
  'us-central1': {
    c3d: { spot: { vcpu: 0.00715, gib: 0.00096 }, standard: { vcpu: 0.033982, gib: 0.004555 } },
    e2: { spot: { vcpu: 0.01309, gib: 0.001754 }, standard: { vcpu: 0.021811, gib: 0.002923 } },
  },
  'us-west4': {
    c4d: { spot: { vcpu: 0.0062, gb: 0.000661 }, standard: { vcpu: 0.036834, gb: 0.00393707 } },
  },
};
// GiB of memory of each highcpu size (gcloud compute machine-types describe; C4D's is not a fixed ratio).
const MEMORY_GIB = { e2: { 2: 2, 4: 4, 8: 8, 16: 16 }, c3d: { 4: 8, 8: 16, 16: 32 }, c4d: { 2: 3, 4: 7, 8: 15, 16: 30 } };
const GB_PER_GIB = 2 ** 30 / 1e9;
const IP_HOURLY = { spot: 0.0025, standard: 0.005 };
// Boot disks by region and type, $ a month: per GiB, and for Hyperdisk Balanced per IOPS and per MiB/s provisioned
// above the 3,000 IOPS and 140 MiB/s its capacity price includes. pd-balanced us-central1: the list price of
// 2026-10-16. hyperdisk-balanced us-west4: the catalog on 2026-10-21, capacity F704-99E9-0130, IOPS D4CA-3484-910A,
// throughput E96C-BF4C-C467.
const DISKS = {
  'us-central1': { 'pd-balanced': { gib: 0.10 } },
  'us-west4': { 'hyperdisk-balanced': { gib: 0.09, iops: 0.006, mibps: 0.045 } },
};
const HOURS_PER_MONTH = 730;
const OLD_DISK_TYPE = 'pd-balanced'; // a row from before placements names no disk type; its VM booted from this

// A disk's month. The launcher provisions no Hyperdisk performance, so a volume has its defaults (Compute Engine's
// Hyperdisk Balanced docs, for 6 GiB and up): 3,000 + 6 IOPS and 140 + 1.5 MiB/s (at most 2,400) per GiB, of which
// 3,000 IOPS and 140 MiB/s are free.
function diskMonthly(price, gb) {
  const iops = price.iops ? 6 * gb * price.iops : 0;
  const throughput = price.mibps ? (Math.min(2400, 140 + 1.5 * gb) - 140) * price.mibps : 0;
  return gb * price.gib + iops + throughput;
}

const regionOf = (zone) => zone.replace(/-[a-z]$/, '');

// The cost of a VM that lived `seconds` (billed for at least a minute), or null when it has no known price.
export function dollars({ machine, zone, provisioning, seconds, diskGb, diskType }) {
  const region = regionOf(zone ?? '');
  const family = machine.split('-')[0];
  const rate = RATES[region]?.[family]?.[provisioning];
  const disk = DISKS[region]?.[diskType ?? OLD_DISK_TYPE];
  if (!rate || !disk || !/-highcpu-\d+$/.test(machine)) return null;
  const vcpus = machineCpus(machine);
  const gib = MEMORY_GIB[family][vcpus];
  if (!gib) return null;
  const memory = rate.gib ? gib * rate.gib : gib * GB_PER_GIB * rate.gb;
  const hours = Math.max(60, seconds) / 3600;
  return hours * (vcpus * rate.vcpu + memory + IP_HOURLY[provisioning] + diskMonthly(disk, diskGb) / HOURS_PER_MONTH);
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;
const iso = (ms) => new Date(ms).toISOString();
const utc = (s) => s.slice(0, 19).replace('T', ' ');

export const launchRow = ({ alloc, repo, cpus, at, config }) =>
  ({ alloc, instance: instanceName(alloc), repo, cpus, at: iso(at), config: config.slice(0, 8), state: 'launching' });

// inst: {zone, machine, provisioning, diskType, created (ms)}. A VM launched before placements carries no disk type.
export const runningRow = (row, inst) => ({
  ...row, machine: inst.machine, zone: inst.zone, provisioning: inst.provisioning, ...(inst.diskType ? { diskType: inst.diskType } : {}),
  created: iso(inst.created), state: 'running',
});

export const withJob = (row, job) => ({ ...row, job: { id: job.id, name: job.name } });

// Finalized, or about to be deleted (`state: 'deleting'`). Seconds run from the VM's creation to its deletion; an
// allocation that never had a VM has neither.
export function finalRow(row, { end, deleted, job, diskGb, state = 'final' }) {
  const seconds = row.created ? Math.max(0, Math.round((deleted - Date.parse(row.created)) / 1000)) : null;
  const cost = seconds === null ? null : dollars({ machine: row.machine, zone: row.zone, provisioning: row.provisioning, seconds, diskGb, diskType: row.diskType });
  return {
    ...row, ...(job ? { job: { id: job.id, name: job.name } } : {}),
    deleted: iso(deleted), seconds, dollars: cost === null ? null : round4(cost), end, state,
  };
}

const dash = (v) => (v == null ? '-' : String(v));

export function renderRow(row) {
  const deleted = { launching: 'launching', running: 'running', deleting: `deleting ${row.deleted && utc(row.deleted)}`, final: row.deleted && utc(row.deleted) }[row.state];
  return [
    `<!-- ${ROW_MARK} ${JSON.stringify(row)} -->`,
    '| alloc | instance | repo | job (actual) | created (UTC) | deleted (UTC) | machine@zone | spot/standard | seconds | $ | end |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    `| ${row.alloc} | ${row.instance} | ${row.repo} | ${row.job ? `${row.job.name} (${row.job.id})` : '-'} | ${row.created ? utc(row.created) : '-'} | ` +
      `${dash(deleted)} | ${row.machine ? `${row.machine}@${row.zone}` : '-'} | ${dash(row.provisioning)} | ${dash(row.seconds)} | ` +
      `${row.dollars == null ? '-' : row.dollars.toFixed(4)} | ${dash(row.end)} |`,
  ].join('\n');
}

function marked(body, mark) {
  const m = new RegExp(`^<!-- ${mark} (\\{.*\\}) -->`).exec(body ?? '');
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export const parseRow = (body) => marked(body, ROW_MARK);

// An allocation's row comments, the one that counts first: the most final, then the oldest comment. Every reader and
// writer orders them the same way, so concurrent writers converge on the same comment.
export function rowComments(comments, alloc) {
  return comments
    .map((c) => ({ c, row: parseRow(c.body) }))
    .filter((x) => x.row && (alloc === undefined || x.row.alloc === alloc))
    .sort((a, b) => rank(b.row) - rank(a.row) || a.c.id - b.c.id);
}

export function rowsOf(comments) {
  const seen = new Set();
  const rows = [];
  for (const { row } of rowComments(comments)) {
    if (seen.has(row.alloc)) continue;
    seen.add(row.alloc);
    rows.push(row);
  }
  return rows;
}

// The day's totals (UTC `day`, YYYY-MM-DD): VMs, seconds and dollars of the rows finalized that day, each end's count,
// the month at that day's rate, the commit of the gce.json the launcher ran, and each family@region's VMs and dollars
// (spec 2026-10-21: each placement's count and cost, so a price swing shows), with the VMs it could not price.
export function dailyLine(rows, day, config) {
  const ofDay = rows.filter((r) => r.state === 'final' && r.deleted?.startsWith(day));
  const vms = ofDay.filter((r) => r.seconds !== null && r.seconds !== undefined);
  const spent = round4(vms.reduce((sum, r) => sum + (r.dollars ?? 0), 0));
  const ends = {};
  for (const r of ofDay) ends[r.end] = (ends[r.end] ?? 0) + 1;
  const families = {};
  for (const r of vms) {
    const at = `${r.machine.split('-')[0]}@${regionOf(r.zone)}`;
    const f = (families[at] ??= { vms: 0, dollars: 0 });
    f.vms += 1;
    f.dollars = round4(f.dollars + (r.dollars ?? 0));
    if (r.dollars == null) f.unpriced = (f.unpriced ?? 0) + 1;
  }
  return {
    day, vms: vms.length, seconds: vms.reduce((sum, r) => sum + r.seconds, 0), dollars: spent,
    month: Math.round(spent * 30 * 100) / 100, ends, config: config.slice(0, 8), families,
  };
}

export function renderDaily(d) {
  const ends = Object.entries(d.ends).map(([e, n]) => `${e} ${n}`).join(', ') || 'none';
  const families = Object.entries(d.families ?? {})
    .map(([at, f]) => `${at} ${f.vms} VMs $${f.dollars.toFixed(4)}${f.unpriced ? ` (${f.unpriced} unpriced)` : ''}`).join(', ');
  return [
    `<!-- ${DAILY_MARK} ${JSON.stringify(d)} -->`,
    `**GCE pool, ${d.day} (UTC):** ${d.vms} VMs, ${d.seconds} VM-seconds, $${d.dollars.toFixed(4)}; ` +
      `projected month $${d.month.toFixed(2)} at this day's rate. Ends: ${ends}.${families ? ` By family@region: ${families}.` : ''} ` +
      `Launcher config (gce.json) ${d.config}.`,
  ].join('\n');
}

export const dailyDays = (comments) => new Set(comments.map((c) => marked(c.body, DAILY_MARK)?.day).filter(Boolean));
