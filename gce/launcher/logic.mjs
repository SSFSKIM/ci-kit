// The GCE launcher's decisions (spec §3a The launcher, VM lifecycle; I12), as pure functions over recorded Compute
// Engine and Actions API shapes. launcher.mjs observes, decides through these, and acts. Times are epoch ms.
import { randomBytes } from 'node:crypto';
import { refusal, machineCpus } from '../bake/plan.mjs';
import { workDir } from '../../pool/agent/docker.mjs';

const MIN = 60_000;
export const RUNNER_ORPHAN_MS = 5 * MIN; // a runner with no instance (a crash between mint and insert)
export const ABANDON_MS = 10 * MIN; // a launching row with no instance and no runner
export const OVERAGE_GRACE_MS = 5 * MIN; // past max_run_minutes, which Compute Engine should have enforced
export const DISK_ORPHAN_MS = 10 * MIN; // a disk is attached as its instance is created; give that time
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
    repoLabel: i.labels?.['ci-kit-repo'] ?? null,
    cpus: Number(i.labels?.['ci-kit-cpus']) || null,
    provisioning: i.labels?.['ci-kit-provisioning'] ?? null,
    config: i.labels?.['ci-kit-config'] ?? null,
    raw: i,
  };
}

export const isGce = (r) => r?.labels?.['ci-kit'] === 'gce';

// Which queued jobs get a VM now (spec §3a Demand). Demand is keyed by (repo, size): a servable job's labels are
// determined by its size. Each key's unclaimed instances (runner registered and not busy, younger than
// idle_runner_minutes) cover one queued job each; a busy instance covers nothing. The rest launch oldest first while
// the vCPUs in flight stay at or under max_vcpus; a job that does not fit holds the line (first in, first out, as on
// the Hetzner box), and the rest wait in GitHub's queue.
// queued: queued pool jobs of served repos, each with `repo`. instances: viewInstance()s of every ci-kit=gce instance.
// runners: Map repo → Map runner name → runner, for each repo whose listing succeeded; a repo without one gets nothing.
// complete: false when the instance listing missed a zone; nothing is admitted then, since the vCPUs in flight and
// the coverage are unknown. A launch reserves the largest machine its walk could land on (machine_fallback).
export function planLaunches({ queued, instances, runners, now, cfg, complete = true }) {
  if (!complete) return { launches: [], waiting: [...queued], unservable: [] };
  const idleMs = cfg.idle_runner_minutes * MIN;
  const repoByLabel = new Map([...runners.keys()].map((r) => [repoLabel(r), r]));
  const key = (repo, cpus) => `${repo.toLowerCase()}|${cpus}`;
  const cover = new Map();
  let inflight = 0;
  for (const i of instances) {
    if (DONE_STATUSES.has(i.status)) continue;
    inflight += i.vcpus;
    const repo = repoByLabel.get(i.repoLabel);
    const r = repo && runners.get(repo).get(i.name);
    if (r && !r.busy && now - i.created < idleMs) cover.set(key(repo, i.cpus), (cover.get(key(repo, i.cpus)) ?? 0) + 1);
  }
  const launches = [];
  const waiting = [];
  const unservable = [];
  const ordered = [...queued].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  for (const job of ordered) {
    if (!runners.has(job.repo)) continue;
    const cpus = jobCpus(job.labels, cfg.machines);
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
  return { launches, waiting, unservable };
}

export const largestMachineCpus = (cpus, cfg) =>
  Math.max(...[cfg.machines[cpus], cfg.machine_fallback?.[cpus]].filter(Boolean).map(machineCpus));

// The attempts for a size, in order: its machine as spot in every configured zone, then on demand in every zone, then
// its fallback machine (machine_fallback) the same way.
export function placements(cpus, cfg) {
  const machines = [cfg.machines[cpus], cfg.machine_fallback?.[cpus]].filter((m, i, all) => m && all.indexOf(m) === i);
  return machines.flatMap((machine) => ['spot', 'standard'].flatMap((provisioning) => cfg.zones.map((zone) => ({ machine, provisioning, zone }))));
}

// What a failed insert means. 'capacity' (ZONE_RESOURCE_POOL_EXHAUSTED*: this zone, this provisioning) and 'quota'
// (the region's, for the machine's family) are definite refusals. 'failed': nothing was created and trying elsewhere
// would not help (the operation finished with another error, or the request was refused outright). 'unknown': the
// insert may have been accepted (a timeout, a lost response, a 5xx, a wait call that failed).
export function insertOutcome(err) {
  const why = refusal(err);
  if (why) return why;
  if (err?.finished) return 'failed';
  if (err?.status >= 400 && err.status < 500 && !err.accepted) return 'failed';
  return 'unknown';
}

// Walks the placements until one creates the VM. Capacity moves to the next placement; quota skips the machine's
// remaining placements. An unknown outcome is reconciled (through the zone's operation) before anything else is
// tried, and if it stays unknown the walk stops: two zones must never both hold this allocation's VM.
// attempt(p) resolves once created and throws the insert's error; reconcile(p, err) resolves to an outcome. No new
// attempt starts at or past `deadline` (the tick's budget): the walk stops with 'deadline', having created nothing.
// Returns {placement, tried, stop: 'exhausted'|'failed'|'unknown'|'deadline' when no placement, quota: true if any
// refused it}.
export async function walkPlacements(list, { attempt, reconcile, now = Date.now, deadline = Infinity }) {
  const tried = [];
  let skip = null;
  let quota = false;
  for (const p of list) {
    if (p.machine === skip) continue;
    if (now() >= deadline) return { placement: null, tried, stop: 'deadline', quota };
    let outcome;
    try {
      await attempt(p);
      outcome = 'created';
    } catch (err) {
      outcome = insertOutcome(err);
      if (outcome === 'unknown') outcome = await reconcile(p, err);
    }
    tried.push({ ...p, outcome });
    if (outcome === 'created') return { placement: p, tried, quota };
    if (outcome === 'capacity') continue;
    if (outcome === 'quota') {
      quota = true;
      skip = p.machine;
      continue;
    }
    return { placement: null, tried, stop: outcome, quota };
  }
  return { placement: null, tried, stop: 'exhausted', quota };
}

// The job VM (spec §3a VM lifecycle step 2, I12). No service account; the kit's subnetwork with an ephemeral external
// address; the JIT config in metadata `ci-kit-jit` with guest attributes on; a run limit after which Compute Engine
// deletes the VM; a boot disk that goes with it. `config` is the commit of the gce.json the launcher runs.
export function jobInstance({ alloc, zone, machine, provisioning, repo, cpus, image, jit, cfg, config }) {
  const name = instanceName(alloc);
  const diskLabels = { 'ci-kit': 'gce', 'ci-kit-alloc': alloc };
  const scheduling = { instanceTerminationAction: 'DELETE', maxRunDuration: { seconds: String(cfg.max_run_minutes * 60) }, automaticRestart: false };
  return {
    name,
    machineType: `zones/${zone}/machineTypes/${machine}`,
    labels: {
      ...diskLabels, 'ci-kit-repo': repoLabel(repo), 'ci-kit-cpus': String(cpus), 'ci-kit-provisioning': provisioning,
      'ci-kit-config': config.slice(0, 8),
    },
    disks: [{
      boot: true,
      autoDelete: true,
      initializeParams: { diskName: name, sourceImage: image, diskSizeGb: String(cfg.disk_gb), diskType: `zones/${zone}/diskTypes/pd-balanced`, labels: diskLabels },
    }],
    networkInterfaces: [{ subnetwork: `regions/${cfg.region}/subnetworks/${cfg.subnetwork}`, accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }] }],
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
