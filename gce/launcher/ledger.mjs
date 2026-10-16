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

// us-central1 rates, $ per vCPU-hour and per GiB-hour. Spot: the Cloud Billing catalog on 2026-10-16, as M7 recorded
// it (ci-kit-sandbox evidence/maws/gce-spot.md). On demand: the list prices of the same day. Memory per vCPU is the
// highcpu shape's. The address and the disk bill until the VM is deleted.
const RATES = {
  c3d: { gibPerVcpu: 2, spot: { vcpu: 0.00715, gib: 0.00096 }, standard: { vcpu: 0.033982, gib: 0.004555 } },
  e2: { gibPerVcpu: 1, spot: { vcpu: 0.01309, gib: 0.001754 }, standard: { vcpu: 0.021811, gib: 0.002923 } },
};
const IP_HOURLY = { spot: 0.0025, standard: 0.005 };
const DISK_GIB_MONTH = 0.10;
const HOURS_PER_MONTH = 730;

// The cost of a VM that lived `seconds` (billed for at least a minute), or null for a machine with no known rate.
export function dollars({ machine, provisioning, seconds, diskGb }) {
  const family = RATES[machine.split('-')[0]];
  if (!family || !/-highcpu-\d+$/.test(machine)) return null;
  const vcpus = machineCpus(machine);
  const rate = family[provisioning];
  const hours = Math.max(60, seconds) / 3600;
  return hours * (vcpus * rate.vcpu + vcpus * family.gibPerVcpu * rate.gib + IP_HOURLY[provisioning] + (diskGb * DISK_GIB_MONTH) / HOURS_PER_MONTH);
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;
const iso = (ms) => new Date(ms).toISOString();
const utc = (s) => s.slice(0, 19).replace('T', ' ');

export const launchRow = ({ alloc, repo, cpus, at, config }) =>
  ({ alloc, instance: instanceName(alloc), repo, cpus, at: iso(at), config: config.slice(0, 8), state: 'launching' });

// inst: {zone, machine, provisioning, created (ms)}.
export const runningRow = (row, inst) =>
  ({ ...row, machine: inst.machine, zone: inst.zone, provisioning: inst.provisioning, created: iso(inst.created), state: 'running' });

export const withJob = (row, job) => ({ ...row, job: { id: job.id, name: job.name } });

// Finalized, or about to be deleted (`state: 'deleting'`). Seconds run from the VM's creation to its deletion; an
// allocation that never had a VM has neither.
export function finalRow(row, { end, deleted, job, diskGb, state = 'final' }) {
  const seconds = row.created ? Math.max(0, Math.round((deleted - Date.parse(row.created)) / 1000)) : null;
  const cost = seconds === null ? null : dollars({ machine: row.machine, provisioning: row.provisioning, seconds, diskGb });
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
// the month at that day's rate, and the commit of the gce.json the launcher ran.
export function dailyLine(rows, day, config) {
  const ofDay = rows.filter((r) => r.state === 'final' && r.deleted?.startsWith(day));
  const vms = ofDay.filter((r) => r.seconds !== null && r.seconds !== undefined);
  const spent = round4(vms.reduce((sum, r) => sum + (r.dollars ?? 0), 0));
  const ends = {};
  for (const r of ofDay) ends[r.end] = (ends[r.end] ?? 0) + 1;
  return {
    day, vms: vms.length, seconds: vms.reduce((sum, r) => sum + r.seconds, 0), dollars: spent,
    month: Math.round(spent * 30 * 100) / 100, ends, config: config.slice(0, 8),
  };
}

export function renderDaily(d) {
  const ends = Object.entries(d.ends).map(([e, n]) => `${e} ${n}`).join(', ') || 'none';
  return [
    `<!-- ${DAILY_MARK} ${JSON.stringify(d)} -->`,
    `**GCE pool, ${d.day} (UTC):** ${d.vms} VMs, ${d.seconds} VM-seconds, $${d.dollars.toFixed(4)}; ` +
      `projected month $${d.month.toFixed(2)} at this day's rate. Ends: ${ends}. Launcher config (gce.json) ${d.config}.`,
  ].join('\n');
}

export const dailyDays = (comments) => new Set(comments.map((c) => marked(c.body, DAILY_MARK)?.day).filter(Boolean));
