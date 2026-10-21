// The GCE launcher's decisions (spec §3a The launcher, VM lifecycle; I12), as pure functions over recorded Compute
// Engine and Actions API shapes. launcher.mjs observes, decides through these, and acts. Times are epoch ms.
import { randomBytes } from 'node:crypto';
import { refusal, machineCpus, networkInterface } from '../bake/plan.mjs';
import { workDir } from '../../pool/agent/docker.mjs';

const MIN = 60_000;
export const RUNNER_ORPHAN_MS = 5 * MIN; // a runner with no instance (a crash between mint and insert)
export const ABANDON_MS = 10 * MIN; // a launching row with no instance and no runner
export const OVERAGE_GRACE_MS = 5 * MIN; // past max_run_minutes, which Compute Engine should have enforced
export const DISK_ORPHAN_MS = 10 * MIN; // a disk is attached as its instance is created; give that time
export const RUNNER_ONLINE_MS = 3 * MIN; // a VM's runner is online ~16 s after it starts (M3); this is far past that
const DONE_STATUSES = new Set(['TERMINATED']);

// Allocation ids: 10 lowercase base36 characters, the launch minute (5; good until 2084) then 5 random (36^5, about
// 60 million a minute). The id names the VM and its runner, and its age is readable from the id alone: the runners
// API gives no creation time, and a ledger lookup would race a concurrent launcher's fresh runner. The time read
// back is the end of the minute, so an age taken from it is never more than the real one.
const ALLOC = /^[0-9a-z]{10}$/;
export function allocationId(nowMs, random = () => randomBytes(4).readUInt32BE(0)) {
  return Math.floor(nowMs / MIN).toString(36).padStart(5, '0') + (random() % 36 ** 5).toString(36).padStart(5, '0');
}
export const allocationTime = (alloc) => (ALLOC.test(alloc ?? '') ? (parseInt(alloc.slice(0, 5), 36) + 1) * MIN : null);
export const instanceName = (alloc) => `ci-kit-gce-${alloc}`;
export const allocOf = (name) => /^ci-kit-gce-([0-9a-z]{10})$/.exec(name ?? '')?.[1] ?? null;

// `ci-kit-repo=<owner>--<repo>`, lowercased; a character GCE labels do not allow ('.') becomes '_'.
export const repoLabel = (repo) => repo.toLowerCase().replace('/', '--').replace(/[^a-z0-9_-]/g, '_');

export const runnerLabels = (cpus) => ['self-hosted', 'ci-kit-pool', `cpus-${cpus}`, 'ci-kit-gce'];

// The size of a job this backend can serve: exactly one cpus-N with N in `machines`, ci-kit-pool, and no label its
// runner will not carry (GitHub matches labels case-insensitively). Else null.
export function jobCpus(labels, machines) {
  const lower = labels.map((l) => l.toLowerCase());
  const sizes = lower.map((l) => /^cpus-(\d+)$/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  if (sizes.length !== 1 || !lower.includes('ci-kit-pool') || !machines[String(sizes[0])]) return null;
  const allowed = new Set(runnerLabels(sizes[0]));
  return lower.every((l) => allowed.has(l)) ? sizes[0] : null;
}

const last = (url) => (url ?? '').split('/').pop();

// The fields of an instance the launcher decides on.
export function viewInstance(i) {
  const machine = last(i.machineType);
  return {
    name: i.name,
    alloc: allocOf(i.name) ?? i.labels?.['ci-kit-alloc'] ?? null,
    zone: last(i.zone),
    machine,
    vcpus: machineCpus(machine),
    status: i.status,
    created: Date.parse(i.creationTimestamp),
    running: Date.parse(i.lastStartTimestamp) || null, // when it last became RUNNING; none before its first boot
    repoLabel: i.labels?.['ci-kit-repo'] ?? null,
    cpus: Number(i.labels?.['ci-kit-cpus']) || null,
    provisioning: i.labels?.['ci-kit-provisioning'] ?? null,
    config: i.labels?.['ci-kit-config'] ?? null,
    diskType: i.labels?.['ci-kit-disk'] ?? null, // null on a VM launched before placements
    egress: i.networkInterfaces ? (i.networkInterfaces.some((n) => n.accessConfigs?.length) ? 'external' : 'nat') : null,
    raw: i,
  };
}

export const isGce = (r) => r?.labels?.['ci-kit'] === 'gce';

// The instances whose runner has taken a job (M3 Cover). A job VM is single-use (JIT): once its runner has taken a job
// it never takes another, though its runner reads registered and not busy from the job's end until GitHub removes
// it. Known from any of: a job this tick read names it as its runner; its ledger row recorded a job (a tick saw it
// busy; the job's run may be over, so no job this tick read names it); its job unit reported (ci-kit/job).
// jobs: the jobs this tick read; rows: the ledger's; reports: Map instance name → its ci-kit/job report or null.
export function claimedInstances({ jobs, rows, reports }) {
  return new Set([
    ...jobs.map((j) => j.runner_name).filter(Boolean),
    ...rows.filter((r) => r.job).map((r) => r.instance),
    ...[...reports].filter(([, report]) => report).map(([name]) => name),
  ]);
}

// A VM whose runner never came online (spec 2026-10-21 M6): RUNNING for over RUNNER_ONLINE_MS while its JIT runner,
// registered at launch, reads offline and has taken no job. It booted but cannot reach GitHub (its region's NAT
// missing, misconfigured or out of ports), so it covers no job, and the launcher reports it. A runner that went
// offline before taking a job reads the same, and is as broken. r: its runner; claimed: claimedInstances().
const neverOnline = (i, r, now, claimed) =>
  Boolean(r) && r.status !== 'online' && !r.busy && !claimed.has(i.name) && i.status === 'RUNNING' && i.running !== null && now - i.running > RUNNER_ONLINE_MS;

// Each instance's runner, from runners (Map repo → Map runner name → runner); undefined when its repo's listing failed.
function runnerLookup(runners) {
  const repoByLabel = new Map([...runners.keys()].map((r) => [repoLabel(r), r]));
  return (i) => {
    const repo = repoByLabel.get(i.repoLabel);
    return { repo, runner: repo && runners.get(repo).get(i.name) };
  };
}

// The instances neverOnline() names, for the launcher to log at ERROR.
export function runnersNeverOnline({ instances, runners, now, claimed = new Set() }) {
  const of = runnerLookup(runners);
  return instances.filter((i) => neverOnline(i, of(i).runner, now, claimed));
}

// Which queued jobs get a VM now (spec §3a Demand). Demand is keyed by (repo, size): a servable job's labels are
// determined by its size. Each key's unclaimed instances (runner registered and not busy, younger than
// idle_runner_minutes, its runner never having taken a job, and not neverOnline()) cover one queued job each; a busy
// or claimed instance covers nothing. The rest launch oldest first while the vCPUs in flight stay at or under
// max_vcpus; a job that does not fit holds the line (first in, first out, as on the Hetzner box), and the rest wait in
// GitHub's queue.
// queued: queued pool jobs of served repos, each with `repo`. instances: viewInstance()s of every ci-kit=gce instance.
// runners: Map repo → Map runner name → runner, for each repo whose listing succeeded; a repo without one gets nothing.
// claimed: claimedInstances(). complete: false when the instance listing missed a zone; nothing is admitted then,
// since the vCPUs in flight and the coverage are unknown. A launch reserves the largest machine its walk could land
// on (any placement's). inflight: the vCPUs in flight with this plan's launches, what pre-launch may add to (none
// when the listing is incomplete).
// rows: the ledger's. A launching row whose VM may still appear and is not listed (pendingAllocation: its insert never
// settled, spec M6, which takes 41-121 s, or it is a race's) keeps the vCPUs its launch reserved (`reserved`, as the
// row recorded it: a placement changed since must not shrink it), and while its runner is registered, not busy,
// unclaimed and younger than idle_runner_minutes it covers a job of its size, as its VM would. Without that, the next
// tick, or a restarted launcher, would launch again for the same job, and race again.
export function planLaunches({ queued, instances, runners, now, cfg, complete = true, claimed = new Set(), rows = [] }) {
  if (!complete) return { launches: [], waiting: [...queued], unservable: [] };
  const idleMs = cfg.idle_runner_minutes * MIN;
  const of = runnerLookup(runners);
  const key = (repo, cpus) => `${repo.toLowerCase()}|${cpus}`;
  const cover = new Map();
  let inflight = 0;
  for (const i of instances) {
    if (DONE_STATUSES.has(i.status)) continue;
    inflight += i.vcpus;
    const { repo, runner: r } = of(i);
    if (r && !r.busy && !claimed.has(i.name) && now - i.created < idleMs && !neverOnline(i, r, now, claimed)) {
      cover.set(key(repo, i.cpus), (cover.get(key(repo, i.cpus)) ?? 0) + 1);
    }
  }
  const listed = new Set(instances.map((i) => i.alloc));
  for (const row of rows) {
    if (listed.has(row.alloc) || !pendingAllocation(row)) continue;
    inflight += row.reserved ?? largestMachineCpus(row.cpus, cfg);
    const r = runners.get(row.repo)?.get(row.instance);
    if (r && !r.busy && !claimed.has(row.instance) && now - Date.parse(row.at) < idleMs) cover.set(key(row.repo, row.cpus), (cover.get(key(row.repo, row.cpus)) ?? 0) + 1);
  }
  const launches = [];
  const waiting = [];
  const unservable = [];
  const ordered = [...queued].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  for (const job of ordered) {
    if (!runners.has(job.repo)) continue;
    const cpus = jobCpus(job.labels, cfg.placements[0].machines); // every placement names every size
    if (cpus === null) {
      unservable.push(job);
      continue;
    }
    const k = key(job.repo, cpus);
    if ((cover.get(k) ?? 0) > 0) {
      cover.set(k, cover.get(k) - 1);
      continue;
    }
    const need = largestMachineCpus(cpus, cfg);
    if (waiting.length || inflight + need > cfg.max_vcpus) {
      waiting.push(job);
      continue;
    }
    inflight += need;
    launches.push({ job, repo: job.repo, cpus });
  }
  return { launches, waiting, unservable, inflight };
}

export const largestMachineCpus = (cpus, cfg) => Math.max(...cfg.placements.map((p) => machineCpus(p.machines[cpus])));

// The attempts for a size, in order (spec 2026-10-21, The walk): spot in every zone of the first placement, then of the
// next, and so on; then on demand in the same order. An attempt (machine, zone, provisioning) is made once, however
// many placements name it (the old form's fallback placement repeats the sizes it does not name).
export function placements(cpus, cfg) {
  const seen = new Set();
  const out = [];
  for (const provisioning of ['spot', 'standard']) {
    for (const placement of cfg.placements) {
      const machine = placement.machines[cpus];
      for (const zone of placement.zones) {
        const key = `${machine}|${zone}|${provisioning}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ machine, provisioning, zone, placement });
      }
    }
  }
  return out;
}

const familyOf = (machine) => machine.split('-')[0];

// What a quota refusal ran out of, from the metric and region its message names (Compute Engine words it "Quota
// 'C4D_CPUS' exceeded.  Limit: 50.0 in region us-west4."; the all-regions quota "... globally."): a family's CPUs
// by (region, family), any other regional quota (CPUS, instances, addresses, disk capacity) by region, the
// all-regions CPUs everywhere. A PREEMPTIBLE_ quota binds spot requests only. A refusal that names nothing is taken
// as the machine's family's. vcpus: the refused machine's; a request smaller than it may still fit.
export function quotaScope(err, attempt) {
  const message = err?.message ?? '';
  const vcpus = machineCpus(attempt.machine);
  const region = /in region ([a-z0-9-]+)/.exec(message)?.[1] ?? attempt.placement.region;
  const metric = quotaMetric(err);
  if (!metric) return { region, family: familyOf(attempt.machine), vcpus };
  const spot = metric.startsWith('PREEMPTIBLE_') ? { spot: true } : {};
  const base = metric.replace(/^PREEMPTIBLE_/, '');
  if (base === 'CPUS_ALL_REGIONS' || / globally/.test(message)) return { ...spot, vcpus };
  const family = /^([A-Z0-9]+)_CPUS$/.exec(base)?.[1];
  return family ? { region, family: family.toLowerCase(), ...spot, vcpus } : { region, ...spot, vcpus };
}

// The quota a refusal's message names ('C4D_CPUS', 'IN_USE_ADDRESSES', ...), or undefined.
export const quotaMetric = (err) => /Quota '([A-Z0-9_]+)' exceeded/.exec(err?.message ?? '')?.[1];

// Whether a remembered refusal covers an attempt: in its scope, and of the same or more vCPUs.
export const quotaBlocks = (memory, attempt) => memory.some((q) =>
  (!q.region || q.region === attempt.placement.region) && (!q.family || q.family === familyOf(attempt.machine)) &&
  (!q.spot || attempt.provisioning === 'spot') && machineCpus(attempt.machine) >= q.vcpus);

// What a failed insert means. 'capacity' (ZONE_RESOURCE_POOL_EXHAUSTED*: this zone, this provisioning) and 'quota'
// (a region's or the project's, as its message names it: quotaScope) are definite refusals. 'failed': nothing was
// created and trying elsewhere would not help (the operation finished with another error, or the request was refused
// outright). 'unknown': the insert may have been accepted (a timeout, a lost response, a 5xx, a wait call that failed).
export function insertOutcome(err) {
  const why = refusal(err);
  if (why) return why;
  if (err?.finished) return 'failed';
  if (err?.status >= 400 && err.status < 500 && !err.accepted) return 'failed';
  return 'unknown';
}

// How long an insert may stay unsettled before a second allocation races it (spec M6). Provisional: the day it was
// sized from (2026-10-21) had ordinary inserts accepted in 8-15 s and 15 slow ones settling after 41-121 s, but those
// counted only operations that outlived the 40 s wait. Every insert's send-to-settle time is on the tick summary
// (`inserts`) so this can be re-sized from all of them.
export const RACE_AFTER_MS = 20_000;

// The attempts a race of the pending attempt walks (spec M6): those after it in the walk, in other zones; spot before
// on demand as the walk has them, and within each, other regions before the pending one's.
export function raceAttempts(list, pending) {
  const rank = (p) => (p.provisioning === 'spot' ? 0 : 2) + (p.placement.region === pending.placement.region ? 1 : 0);
  return list.slice(list.indexOf(pending) + 1).filter((p) => p.zone !== pending.zone).sort((a, b) => rank(a) - rank(b));
}

// What a launch's row keeps of its walk (spec M6 counts), from walkPlacements' `tried`: its refusals ({kind:
// 'capacity'|'quota', zone, metric when the message names one}), and its slow inserts, those still unsettled
// RACE_AFTER_MS after they were sent or never settled in the tick ({zone, outcome, sent, done: when it settled,
// absent while it has not}).
export function walkRecord(tried) {
  const iso = (ms) => new Date(ms).toISOString();
  const refused = tried.filter((t) => t.outcome === 'capacity' || t.outcome === 'quota')
    .map((t) => ({ kind: t.outcome, zone: t.zone, ...(t.metric ? { metric: t.metric } : {}) }));
  const slow = tried.filter((t) => t.outcome === 'unknown' || t.ms >= RACE_AFTER_MS)
    .map((t) => ({ zone: t.zone, outcome: t.outcome, sent: iso(t.sent), ...(t.outcome === 'unknown' ? {} : { done: iso(t.sent + t.ms) }) }));
  return { ...(refused.length ? { refused } : {}), ...(slow.length ? { slow } : {}) };
}

// A launching row whose VM may yet appear though none is listed: its insert never settled, or it is a race's, whose row
// is written before its runner and insert (a launcher restarted while that insert is in flight must count it). One whose
// last insert is known refused will have no VM, whatever its row's state still says.
export function pendingAllocation(row) {
  if (row.state !== 'launching') return false;
  const last = row.slow?.at(-1);
  if (last?.done && last.outcome !== 'created') return false;
  return Boolean(row.race || unsettledInsert(row));
}

// A row's insert that never settled (outcome unknown, its operation's end not yet learned), or null; none once the row
// is final. A walk stops at an unknown outcome, so a row has at most one.
export const unsettledInsert = (row) => (row.state !== 'final' && row.slow?.find((s) => !s.done)) || null;

// Walks the attempts until one creates the VM. Capacity moves to the next zone. A quota refusal is remembered in
// `quota` (the tick's memory, quotaScope) and every attempt it covers is skipped, here and in the tick's later walks.
// An unknown outcome is reconciled (through the zone's operation) before anything else is tried, and if it stays
// unknown the walk stops: two zones must never both hold this allocation's VM.
// attempt(p) resolves once created and throws the insert's error; reconcile(p, err) resolves to an outcome, or to
// {outcome, error} with the error the settled operation carries (its message names a quota's metric). No new
// attempt starts at or past `deadline` (the tick's budget): the walk stops with 'deadline', having created nothing.
// Once `raced()` (a second allocation races this one's pending insert, spec M6), the walk makes no further attempt and
// stops with 'raced': the race carries the job, and this allocation is never moved to another zone.
// Returns {placement, tried, stop: 'exhausted'|'failed'|'unknown'|'deadline'|'raced' when no placement, quota: true if
// any refused it}. Each of `tried` is the attempt with its outcome, when it was sent (`sent`, ms) and how long it took to
// settle (`ms`), and a quota refusal's `metric`.
export async function walkPlacements(list, { attempt, reconcile, now = Date.now, deadline = Infinity, quota: memory = [], raced = () => false }) {
  const tried = [];
  let quota = false;
  for (const p of list) {
    if (quotaBlocks(memory, p)) continue;
    if (raced()) return { placement: null, tried, stop: 'raced', quota };
    if (now() >= deadline) return { placement: null, tried, stop: 'deadline', quota };
    const sent = now();
    let outcome;
    let error = null;
    try {
      await attempt(p);
      outcome = 'created';
    } catch (err) {
      error = err;
      outcome = insertOutcome(err);
      if (outcome === 'unknown') {
        const settled = await reconcile(p, err);
        outcome = settled?.outcome ?? settled;
        error = settled?.error ?? error;
      }
    }
    tried.push({ ...p, outcome, sent, ms: now() - sent, ...(outcome === 'quota' ? { metric: quotaMetric(error) } : {}) });
    if (outcome === 'created') return { placement: p, tried, quota };
    if (outcome === 'capacity') continue;
    if (outcome === 'quota') {
      quota = true;
      memory.push(quotaScope(error, p));
      continue;
    }
    return { placement: null, tried, stop: outcome, quota };
  }
  return { placement: null, tried, stop: 'exhausted', quota };
}

// The job VM (spec §3a VM lifecycle step 2, I12). No service account; its placement's subnetwork with gce.json's egress
// (networkInterface: an external address, or under `nat` none, the region's Cloud NAT carrying its traffic so the
// region's address quota does not bound the pool); the JIT config in metadata `ci-kit-jit` with guest
// attributes on; a run limit after which Compute Engine deletes the VM; a boot disk of the placement's type that goes
// with it, named in the label `ci-kit-disk` so the ledger prices it (the instance resource does not say). `config` is
// the commit of the gce.json the launcher runs.
export function jobInstance({ alloc, zone, machine, provisioning, placement, repo, cpus, image, jit, cfg, config }) {
  const name = instanceName(alloc);
  const diskLabels = { 'ci-kit': 'gce', 'ci-kit-alloc': alloc };
  const scheduling = { instanceTerminationAction: 'DELETE', maxRunDuration: { seconds: String(cfg.max_run_minutes * 60) }, automaticRestart: false };
  return {
    name,
    machineType: `zones/${zone}/machineTypes/${machine}`,
    labels: {
      ...diskLabels, 'ci-kit-repo': repoLabel(repo), 'ci-kit-cpus': String(cpus), 'ci-kit-provisioning': provisioning,
      'ci-kit-config': config.slice(0, 8), 'ci-kit-disk': placement.disk_type,
    },
    disks: [{
      boot: true,
      autoDelete: true,
      initializeParams: { diskName: name, sourceImage: image, diskSizeGb: String(cfg.disk_gb), diskType: `zones/${zone}/diskTypes/${placement.disk_type}`, labels: diskLabels },
    }],
    networkInterfaces: [networkInterface(placement, cfg.egress)],
    serviceAccounts: [],
    metadata: { items: [{ key: 'enable-guest-attributes', value: 'TRUE' }, { key: 'ci-kit-jit', value: jit }] },
    scheduling: provisioning === 'spot'
      ? { provisioningModel: 'SPOT', ...scheduling, onHostMaintenance: 'TERMINATE' }
      : { provisioningModel: 'STANDARD', ...scheduling },
  };
}

export const jitRequest = (alloc, cpus) => ({ name: instanceName(alloc), labels: runnerLabels(cpus), work_folder: workDir(instanceName(alloc)) });

// The newest image of the family labelled ci-kit-ready=true, from a list: never getFromFamily, which returns the
// newest image whether or not its smoke check passed (spec I12).
export function newestReadyImage(images, family) {
  return images
    .filter((i) => i.labels?.['ci-kit'] === 'gce-image' && i.labels['ci-kit-ready'] === 'true' && i.family === family && i.status === 'READY')
    .sort((a, b) => Date.parse(b.creationTimestamp) - Date.parse(a.creationTimestamp))[0] ?? null;
}

// What to do with each ci-kit=gce instance (spec §3a Cleanup). runnersOf(view) → Map runner name → runner for the
// instance's repo, or undefined when that listing failed or the repo is unknown: then only the stopped and overage
// rules apply, since a failed listing is never read as idleness. served: Set of served repo labels; an instance of
// an unserved repo is draining (its idle runner goes at once, its busy one finishes).
// reports: Map instance name → its job unit's `ci-kit/job` report (`exit:<code>` or `failed:<step>`), read for the
// instances reportable() names. A VM that reported is deleted at once: its job is over and its runner gone or dead,
// and the guest's power-off takes about a minute and a half more (A13: the VM gone within 2 min of the job's end).
// Returns [{instance, action: 'delete'|'unregister-delete', end, reason, unregister?, alert?}].
export function reviewInstances({ instances, runnersOf, served, now, cfg, reports = new Map() }) {
  const idleMs = cfg.idle_runner_minutes * MIN;
  const actions = [];
  for (const i of instances) {
    if (!isGce(i.raw)) continue;
    const runners = runnersOf(i);
    const r = runners?.get(i.name) ?? null;
    const age = now - i.created;
    if (DONE_STATUSES.has(i.status)) {
      actions.push({ instance: i, action: 'delete', end: 'done', reason: 'stopped', unregister: r !== null && !r.busy });
    } else if (age > cfg.max_run_minutes * MIN + OVERAGE_GRACE_MS) {
      actions.push({ instance: i, action: 'delete', end: 'max-run', reason: 'overage', unregister: r !== null && !r.busy, alert: true });
    } else if (runners === undefined || r?.busy) {
      continue;
    } else if (reports.get(i.name)) {
      // A runner still registered is unregistered first, with the idle rule's veto: if GitHub refuses (it has just
      // taken a job), the VM stays. A VM boots once (no restart policy), so its report is this boot's, but the veto
      // does not rest on that.
      actions.push({ instance: i, action: r ? 'unregister-delete' : 'delete', end: 'done', reason: 'job-exited' });
    } else if (r && (!served.has(i.repoLabel) || age >= idleMs)) {
      actions.push({ instance: i, action: 'unregister-delete', end: 'cancelled-idle', reason: served.has(i.repoLabel) ? 'idle-runner' : 'unserved' });
    } else if (!r && age >= idleMs) {
      // Its JIT runner is gone (its job ended), yet the VM did not power off.
      actions.push({ instance: i, action: 'delete', end: 'done', reason: 'runner-gone' });
    }
  }
  return actions;
}

// The instances worth reading `ci-kit/job` for: up (not TERMINATED, which the stopped rule takes), their repo's
// runners listed, and their runner not busy (a busy runner's job is still running).
export function reportable(instances, runnersOf) {
  return instances.filter((i) => {
    const runners = runnersOf(i);
    return isGce(i.raw) && !DONE_STATUSES.has(i.status) && runners !== undefined && !runners.get(i.name)?.busy;
  });
}

// What to do with each ledger row that is not final (spec §3a, I12): a launching row whose VM exists is recorded
// running; once the VM is gone, a deleting row is finalized with the end it was given, and a running one by what
// happened to it (a preemption GCE recorded, the run limit, else `orphan`: gone by a hand outside the launcher); a
// launching row with no VM and no runner 10 min after its launch never got one (`abandoned`).
// runnerKnown(row): whether the row's repo's runners were listed; runnerOf(row): its runner, or null.
// preempted: Set of instance names with a compute.instances.preempted operation, or null when that history could
// not be read: a vanished VM is then not classified this tick. complete: false when the instance listing missed a
// zone; then no row is finalized for its VM's absence.
export function reviewRows({ rows, instances, runnerKnown, runnerOf, preempted, now, cfg, complete = true }) {
  const byAlloc = new Map(instances.map((i) => [i.alloc, i]));
  const actions = [];
  for (const row of rows) {
    if (row.state === 'final') continue;
    const inst = byAlloc.get(row.alloc);
    if (inst) {
      if (row.state === 'launching') actions.push({ row, action: 'running', instance: inst });
      continue;
    }
    if (!complete) continue;
    const launched = allocationTime(row.alloc) ?? Date.parse(row.at);
    if (row.state === 'deleting') {
      actions.push({ row, action: 'final', end: row.end });
      continue;
    }
    if (preempted === null) continue; // without the history, a vanished VM cannot be told from a preempted one
    if (preempted.has(row.instance)) {
      actions.push({ row, action: 'final', end: 'preempted' });
    } else if (row.state === 'running') {
      // The run limit counts from the VM's recorded creation; the id's time rounds up and would call a VM deleted
      // at its limit an orphan.
      const created = row.created ? Date.parse(row.created) : launched;
      actions.push({ row, action: 'final', end: now - created >= cfg.max_run_minutes * MIN ? 'max-run' : 'orphan' });
    } else if (now - launched >= ABANDON_MS && runnerKnown(row) && !runnerOf(row)) {
      actions.push({ row, action: 'final', end: 'abandoned' });
    }
  }
  return actions;
}

// Runners named ci-kit-gce-<alloc> whose instance does not exist, older than 5 min and not busy: minted, then the
// insert never happened (a crash, or an insert whose outcome stayed unknown).
export function orphanRunners({ runners, instanceNames, now, complete = true }) {
  if (!complete) return [];
  return runners.filter((r) => {
    const launched = allocationTime(allocOf(r.name));
    return launched !== null && !instanceNames.has(r.name) && !r.busy && now - launched >= RUNNER_ORPHAN_MS;
  });
}

// ci-kit=gce disks attached to nothing (a boot disk outlived its VM), older than 10 min.
export const orphanDisks = (disks, now) =>
  disks.filter((d) => isGce(d) && !(d.users?.length) && now - Date.parse(d.creationTimestamp) >= DISK_ORPHAN_MS);
