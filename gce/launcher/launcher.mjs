// The GCE launcher's reconciliation (spec §3a The launcher): one tick, with every outside effect injected so the
// orchestration is testable. server.mjs runs ticks for Cloud Scheduler and the webhook (ticker.mjs). The decisions
// are in logic.mjs; this file observes (Compute Engine, GitHub, the ledger), decides through logic.mjs, and acts.
// Nothing is kept between ticks: state lives in GCE labels, the ledger and GitHub, so every tick can act as the
// first, and two overlapping ticks (Cloud Run can briefly run two) stay correct: deletes and unregisters treat 404
// as done, ledger rows are keyed by allocation and only move forward, and an over-launch leaves idle runners that the
// idle rule removes. Quota is the hard cap: a refusal is remembered for the rest of the tick, scoped to what ran out
// (logic.mjs quotaScope), and later launches skip what it covers; one with nothing left to try waits in GitHub's queue.
// A tick reads everything it can at once and launches before it cleans up (spec M3): a job's wait for its VM is
// mostly the time to its first insert. A run that has begun before its pool jobs are queued gets their VMs launched
// ahead of them (spec M5, prelaunch.mjs), after the queued jobs' launches and with what they leave of max_vcpus.
// An insert still unsettled RACE_AFTER_MS after it was sent is raced by a second allocation of its size in another zone
// (spec M6), while the first keeps waiting on its own operation and is never moved; whichever VM's runner a job takes
// first serves it, and the other is an ordinary unclaimed VM the idle rule removes.
import { GceError } from '../../lib/gce.mjs';
import { createAlerts } from '../../pool/lib/alerts.mjs';
import { queuedPoolJobs } from '../../pool/agent/logic.mjs';
import { staleBakeInstances } from '../bake/plan.mjs';
import { servedRepos, placementZones } from './config.mjs';
import {
  allocationId, instanceName, repoLabel, viewInstance, isGce, planLaunches, runnersNeverOnline, placements, quotaBlocks, insertOutcome, walkPlacements,
  jobInstance, jitRequest, newestReadyImage, reviewInstances, reviewRows, orphanRunners, orphanDisks, reportable, claimedInstances,
  largestMachineCpus, raceAttempts, walkRecord, unsettledInsert, quotaMetric, RACE_AFTER_MS,
} from './logic.mjs';
import { planPrelaunches } from './prelaunch.mjs';
import { launchRow, runningRow, withJob, jobRecord, finalRow, dailyLine, launchCounts, natDay } from './ledger.mjs';

export const TICK_BUDGET_MS = 45_000;
const INSERT_DEADLINE_MS = 40_000;
const PARALLEL_LAUNCHES = 16; // a burst launches in one round: each insert waits ~10–20 s for its operation
const DAILY_WITHIN_MS = 2 * 3600_000; // the 26 h ledger window holds all of yesterday only early in the day
// Cloud NAT's samples take up to 225 s to be readable: the day's line, which reads its NAT once, waits past that.
const DAILY_AFTER_MS = 5 * 60_000;
const SETTLE_BUDGET_MS = 15_000; // what a tick spends learning how unsettled inserts ended; the rest wait a tick
const SETTLE_PARALLEL = 4; // zones whose operations are read at once
// How far an insert operation's insertTime may fall before the launcher's own send time (clocks and request latency)
// and still be that insert's, when its link is unknown. A walk's earlier attempt in the same zone was sent at least one
// operation earlier.
const SEND_SKEW_MS = 2_000;
const NAT_GATEWAY = 'ci-kit-nat'; // each placement region's Cloud NAT (gce/deploy.sh network)
const zoneOf = (r) => r.zone.split('/').pop();
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const iso = (ms) => new Date(ms).toISOString();
// What a finished insert operation means: {outcome (insertOutcome), error}, the error worded as lib/gce.mjs words a
// failed operation, so a quota refusal's message still names its metric and region (quotaScope, quotaMetric).
function settledAs(op) {
  if (!op.error?.errors?.length) return { outcome: 'created', error: null };
  const error = new GceError(op.httpErrorStatusCode ?? 200, `gce operation ${op.name}: ${op.error.errors.map((e) => `${e.code} ${e.message ?? ''}`.trim()).join('; ')}`,
    op.error.errors.map((e) => e.code), { accepted: true, finished: true, operation: op.selfLink ?? null });
  return { outcome: insertOutcome(error), error };
}
const NEVER = new Promise(() => {});

// The insert operation of an unsettled insert (a row's slow entry), among a zone's operations for its instance: by the
// link the API gave, else the newest sent no earlier than the insert (less SEND_SKEW_MS), so a walk's earlier attempt in
// the same zone under the same name (spot, then on demand) is never taken for it. None found: it stays unsettled.
function operationOf(ops, instance, insert) {
  const mine = ops.filter((o) => o.operationType === 'insert' && o.targetLink.endsWith(`/instances/${instance}`));
  if (insert.operation) return mine.find((o) => o.selfLink === insert.operation) ?? null;
  const after = Date.parse(insert.sent) - SEND_SKEW_MS;
  return mine.filter((o) => Date.parse(o.insertTime) >= after).sort((a, b) => Date.parse(b.insertTime) - Date.parse(a.insertTime))[0] ?? null;
}

// deps: {gce, gh, ledger, cfg, config, poolRepos, now, log, error, random, alert, after}; error(message, fields) logs at
// ERROR what a log-based alert watches (gce/deploy.sh alert), log otherwise.
// cfg: the gce.json it runs, config: that file's commit; poolRepos: the repo names in pool.json (one file per repo).
// after(ms) → {promise, cancel}: a timer, the race's (tests run it on their clock).
export class Launcher {
  constructor(deps) {
    Object.assign(this, deps);
    this.now ??= Date.now;
    this.log ??= () => {};
    this.error ??= (message) => this.log(message);
    this.alert ??= createAlerts(this.gh, this.cfg.ledger.repo, { log: this.log });
    this.budgetMs ??= TICK_BUDGET_MS;
    this.insertDeadlineMs ??= INSERT_DEADLINE_MS;
    this.after ??= (ms) => {
      let timer;
      const promise = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
      return { promise, cancel: () => clearTimeout(timer) };
    };
  }

  // One reconciliation. Throws only when Compute Engine or the ledger cannot be read (the tick then did nothing), or
  // when the image list cannot be read for a launch. out.firstInsert: when the tick sent its first insert, or null;
  // out.prelaunched: the VMs of out.launched launched ahead of a run's pool jobs; out.raced: those that race another's
  // slow insert (`<race> for <original>`). The walks' counts (spec M6): out.inserts, every insert sent, {zone, machine,
  // provisioning, outcome, seconds from send to settle, null when it never settled}; and of the rows the launches wrote,
  // out.refusals, out.slow and out.onDemand (ledger.mjs launchCounts).
  async tick() {
    const deadline = this.now() + this.budgetMs;
    const out = { launched: [], prelaunched: [], raced: [], deleted: [], unregistered: [], finalized: [], waiting: 0, firstInsert: null, inserts: [] };
    const seen = await this.observe();
    // Launches start first, and the cleanup runs beside them: neither waits for the other. Launching before cleaning
    // up can only under-admit for a tick (a VM about to be deleted still counts against max_vcpus), never over-admit.
    const done = await Promise.allSettled([this.launchAll(seen, out, deadline), this.cleanUp(seen, out)]);
    const failed = done.find((d) => d.status === 'rejected');
    if (failed) throw failed.reason;
    await this.daily(seen);
    return Object.assign(out, launchCounts(seen.launches));
  }

  async cleanUp(seen, out) {
    await this.recordJobs(seen);
    // Learning how unsettled inserts ended runs beside the retirements, so a slow or failing operation read never holds
    // a VM's deletion; only finalizing rows, which may rewrite the same rows, waits for it (within its budget).
    const settling = this.settleInserts(seen);
    settling.catch(() => {});
    await this.cleanInstances(seen, out);
    await settling;
    await this.settleRows(seen, out);
    await this.cleanRunners(seen, out);
    await this.cleanLeftovers(seen, out);
  }

  // ── observation ────────────────────────────────────────────────────────────────────────────────────────────────

  // Everything at once, but for two orders that hold: the ledger is read before the instances, and each repo's
  // runners before its jobs.
  async observe() {
    const { served: listed, both } = servedRepos(this.cfg.repos, this.poolRepos);
    const alerted = Promise.all(both.map(async (repo) => {
      this.log(`refusing ${repo}: it is in gce.json and pool.json, and a repo is served by one backend only`);
      await this.alert({
        title: `ci-kit alert: ${repo} is in both gce.json and pool.json`,
        body: `The GCE launcher serves neither copy of ${repo} until one file lists it (spec §3a, one file per repo).`,
      }).catch((err) => this.log(`alert: ${err.message}`));
    }));
    // The ledger is read before the instances: a row seen running was written after its insert, so its VM is in the
    // listing that follows unless it is gone. (A row whose VM is missing is confirmed with a direct read anyway.)
    const store = (async () => {
      await this.ledger.read();
      const rows = await this.ledger.rows();
      const [listing, disks, builders] = await Promise.all([
        this.gce.listInstances('labels.ci-kit=gce'),
        this.gce.listDisks('labels.ci-kit=gce'),
        this.gce.instances('labels.ci-kit=gce-builder'),
      ]);
      return { rows, listing, disks: disks.items, builders };
    })();
    // Read now so that a launch does not wait for it; a tick with nothing to launch never looks.
    const images = this.gce.images('labels.ci-kit=gce-image');
    images.catch(() => {});
    const reads = new Map(listed.map((repo) => [repo, this.readRepo(repo)]));

    // Awaited first: it is the one read whose failure fails the tick, and a rejection nobody awaits yet would end the
    // process. Every other read resolves, whatever happens to it.
    const { rows, listing, disks, builders } = await store;
    // Public repos are refused, as on the Hetzner box; a repo whose visibility cannot be read is not served this tick.
    const served = [];
    for (const [repo, read] of reads) {
      const visible = await read.visible;
      if (visible === true) served.push(repo);
      else if (visible === false) this.log(`refusing ${repo}: it is public, and the pool serves private repos only`);
      else this.log(`not serving ${repo} this tick: its visibility could not be read (${visible.message})`);
    }
    const instances = listing.items.filter(isGce).map(viewInstance);
    // A zone the listing missed may hide our VMs: nothing is admitted, and nothing is cleaned up for being absent. Ours
    // live in the placements' zones and in the zones of the rows not yet final (a VM outlives a placement removed or
    // rolled back from gce.json); a zone outside both holds none of ours, and its outage does not stop the pool. A
    // live row with no zone (a launching row whose running write failed after its insert) could be anywhere: while one
    // exists, every zone of the listing must be read whole.
    const live = rows.filter((r) => r.state !== 'final');
    const ours = new Set([...placementZones(this.cfg), ...live.filter((r) => r.zone).map((r) => r.zone)]);
    const missing = [...ours].filter((z) => !listing.zones.has(z));
    if (live.some((r) => !r.zone) && !listing.complete) missing.push('a zone (a live row names none)');
    const complete = missing.length === 0;
    if (!complete) this.log(`the instance listing missed ${missing.join(', ')}: no launches, and no cleanup by absence, this tick`);
    const rowOf = new Map(rows.map((r) => [r.alloc, r]));

    // Runners are listed for every repo something of ours belongs to: served repos, and every repo with a row in the
    // ledger's window, final or not. A repo being drained stays listed after its last row is final, so a runner left
    // behind (a preempted VM's, still busy until GitHub fails its job) is unregistered once it is free. A failed
    // listing leaves the repo out of `runners`.
    const byLabel = new Map();
    for (const repo of [...served, ...rows.map((r) => r.repo)]) byLabel.set(repoLabel(repo), repo);
    for (const i of instances) if (!byLabel.has(i.repoLabel) && rowOf.get(i.alloc)) byLabel.set(i.repoLabel, rowOf.get(i.alloc).repo);
    const runners = new Map();
    const listings = await Promise.all([...byLabel.values()].map(async (repo) => [repo, await (reads.get(repo)?.runners ?? this.listRunners(repo))]));
    for (const [repo, mine] of listings) if (mine) runners.set(repo, mine);
    // quota: the tick's memory of quota refusals (logic.mjs quotaScope), shared by its launches; launches: the rows they
    // wrote last, which the tick's counts read.
    const seen = { served, instances, complete, disks, builders, rows, rowOf, byLabel, runners, images, quota: [], launches: [] };

    // A VM whose job has ended says so in ci-kit/job before its guest powers off. Read beside the jobs, it serves both
    // the cover (an ended job's VM covers nothing) and the cleanup (the VM goes without waiting for its power-off).
    const reports = this.readReports(seen);
    const demand = new Map();
    const queued = [];
    const jobs = [];
    const runs = [];
    for (const repo of served) {
      const read = await reads.get(repo).jobs;
      if (!read || !runners.has(repo)) continue;
      queued.push(...queuedPoolJobs(read.jobs));
      jobs.push(...read.jobs);
      runs.push(...read.runs);
      demand.set(repo, runners.get(repo));
    }
    seen.reports = await reports;
    await alerted;
    return { ...seen, demand, queued, jobs, runs, claimed: claimedInstances({ jobs, rows, reports: seen.reports }) };
  }

  // A repo's GitHub reads, started together: whether it is private, and its runners, then its queued and running runs
  // ({repo, id, path, attempt}) and their jobs, each with its run's workflow path. Runners are read first: a job taken
  // between the two reads then shows as not queued, never as double demand. The queued runs are listed before the
  // running ones, so a run that starts between the two listings is in the second (listed at once, each could miss it),
  // and a run in both is read once. A failed read resolves to null (visible: to the error), logged.
  readRepo(repo) {
    const visible = this.gh.getRepo(repo).then((r) => r.private === true, (err) => err);
    const runners = this.listRunners(repo);
    const jobs = runners.then(async (mine) => {
      if (!mine) return null;
      try {
        const listed = [...(await this.gh.runsByStatus(repo, 'queued')), ...(await this.gh.runsByStatus(repo, 'in_progress'))];
        const runs = [...new Map(listed.map((run) => [run.id, run])).values()]; // one that started between is in both
        const lists = await Promise.all(runs.map(async (run) => (await this.gh.listJobs(repo, run.id)).map((j) => ({ ...j, repo, workflow: run.path }))));
        return { jobs: lists.flat(), runs: runs.map((run) => ({ repo, id: run.id, path: run.path, attempt: run.run_attempt ?? 1 })) };
      } catch (err) {
        this.log(`jobs of ${repo}: ${err.message}`);
        return null;
      }
    });
    return { visible, runners, jobs };
  }

  async listRunners(repo) {
    try {
      const mine = (await this.gh.runners(repo)).filter((r) => r.name.startsWith('ci-kit-gce-'));
      return new Map(mine.map((r) => [r.name, r]));
    } catch (err) {
      this.log(`runners of ${repo}: ${err.message}`);
      return null;
    }
  }

  // Instance name → its ci-kit/job report (null when none), for the VMs worth reading (reportable()).
  async readReports(seen) {
    const runnersOf = (v) => seen.runners.get(this.repoOf(seen, v));
    return new Map(await Promise.all(reportable(seen.instances, runnersOf).map(async (v) => {
      try {
        return [v.name, await this.gce.guestAttribute(v.zone, v.name, 'ci-kit/job')];
      } catch (err) {
        if (err.status !== 404) this.log(`ci-kit/job of ${v.name}: ${err.message}`);
        return [v.name, null];
      }
    })));
  }

  repoOf(seen, view) {
    return seen.rowOf.get(view.alloc)?.repo ?? seen.byLabel.get(view.repoLabel) ?? null;
  }

  runnerOf(seen, repo, name) {
    return seen.runners.get(repo)?.get(name) ?? null;
  }

  // The job a runner actually held, as its row keeps it (jobRecord): from this tick's listing, else from the repo's
  // runs created since max_run_minutes before the allocation (a job can queue long after its run began, behind slow
  // jobs it needs, but no job this runner took can belong to a run older than that: GitHub would have timed it out on
  // the run's side first).
  async jobOf(seen, row) {
    const hit = seen.jobs.find((j) => j.runner_name === row.instance);
    if (hit) return jobRecord(hit);
    try {
      const since = new Date(Date.parse(row.at) - this.cfg.max_run_minutes * 60_000).toISOString();
      for (const run of (await this.gh.runsCreatedSince(row.repo, since)).slice(0, 100)) {
        const found = (await this.gh.listJobs(row.repo, run.id)).find((j) => j.runner_name === row.instance);
        if (found) return jobRecord({ ...found, workflow: run.path });
      }
    } catch (err) {
      this.log(`job of ${row.instance}: ${err.message}`);
    }
    return null;
  }

  async write(row, opts) {
    try {
      await this.ledger.upsert(row, opts);
      return true;
    } catch (err) {
      this.log(`ledger ${row.alloc}: ${err.message}`);
      return false;
    }
  }

  // A busy runner's job goes on its row as soon as it is seen, with its VM's RUNNING time: a preempted VM is deleted
  // with its labels, so the row is where the job it held survives.
  async recordJobs(seen) {
    for (const row of seen.rows) {
      if (row.state === 'final' || row.job) continue;
      const job = seen.jobs.find((j) => j.runner_name === row.instance);
      if (!job) continue;
      const inst = seen.instances.find((i) => i.alloc === row.alloc);
      const next = withJob(inst && row.state !== 'deleting' ? runningRow(row, inst) : row, job);
      if (await this.write(next)) seen.rowOf.set(row.alloc, next);
    }
  }

  // A row whose insert never settled in its tick (spec M6: unknown outcomes settle after 41-121 s) learns when its
  // operation ended, from the zone's insert operations, so the slow insert's settle time outlives the tick (the
  // launcher's wait is not the operation's), and a refusal joins the row's `refused`. Until it is learned, a launching row
  // whose VM is not listed keeps its vCPUs and covers its job (planLaunches); learned refused, it is abandoned at once
  // and its runner unregistered, since no VM will come. The reads (one per zone, a few zones at once) are bounded by
  // SETTLE_BUDGET_MS, and a zone not read in it, or whose read fails, waits for the next tick; the writes of what was
  // read are then all made before this returns, so no row is finalized ahead of its settlement.
  async settleInserts(seen) {
    const byZone = new Map();
    for (const observed of seen.rows) {
      const insert = unsettledInsert(seen.rowOf.get(observed.alloc) ?? observed);
      if (insert) byZone.set(insert.zone, [...(byZone.get(insert.zone) ?? []), observed.alloc]);
    }
    if (!byZone.size) return;
    const read = new Map(); // zone → its insert operations
    let expired = false;
    const budget = this.after(SETTLE_BUDGET_MS);
    const zones = [...byZone.keys()];
    const worker = async () => {
      while (zones.length && !expired) {
        const zone = zones.shift();
        const ops = await this.insertOperations(seen, zone, byZone.get(zone));
        if (ops && !expired) read.set(zone, ops);
      }
    };
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(SETTLE_PARALLEL, zones.length) }, worker)),
      budget.promise.then(() => { expired = true; }),
    ]);
    budget.cancel();
    if (expired) this.log(`unsettled inserts: not all read in ${SETTLE_BUDGET_MS / 1000} s; the rest wait for the next tick`);
    await Promise.all([...read].flatMap(([zone, ops]) => byZone.get(zone).map((alloc) => this.settleInsert(seen, zone, alloc, ops))));
  }

  async insertOperations(seen, zone, allocs) {
    const names = allocs.map((a) => (seen.rowOf.get(a) ?? seen.rows.find((r) => r.alloc === a)).instance);
    try {
      return await this.gce.zoneOperations(zone, `targetLink eq ".*/instances/(${names.join('|')})"`);
    } catch (err) {
      this.log(`insert operations in ${zone}: ${err.message}; their rows wait for the next tick`);
      return null;
    }
  }

  async settleInsert(seen, zone, alloc, ops) {
    const row = seen.rowOf.get(alloc) ?? seen.rows.find((r) => r.alloc === alloc);
    const insert = unsettledInsert(row);
    if (!insert) return;
    const op = operationOf(ops, row.instance, insert);
    if (op?.status !== 'DONE') return;
    const { outcome, error } = settledAs(op);
    const metric = quotaMetric(error);
    const refused = outcome === 'capacity' || outcome === 'quota' ? [...(row.refused ?? []), { kind: outcome, zone, ...(metric ? { metric } : {}) }] : row.refused;
    let next = { ...row, ...(refused ? { refused } : {}), slow: row.slow.map((s) => (s === insert ? { ...s, outcome, done: op.endTime ?? iso(this.now()) } : s)) };
    if (outcome !== 'created' && row.state === 'launching') {
      const runner = this.runnerOf(seen, row.repo, row.instance);
      if (runner) {
        await this.gh.deleteRunner(row.repo, runner.id).catch((err) => {
          if (err.status !== 404) this.log(`unregister ${row.instance}: ${err.message}; the orphan-runner rule retries`);
        });
      }
      this.log(`${row.instance}: its insert was refused (${outcome}) after its tick; abandoned`);
      next = finalRow(next, { end: 'abandoned', deleted: this.now(), diskGb: this.cfg.disk_gb, egress: this.cfg.egress });
    }
    if (await this.write(next)) seen.rowOf.set(alloc, next);
  }

  // ── cleanup ────────────────────────────────────────────────────────────────────────────────────────────────────

  async cleanInstances(seen, out) {
    const served = new Set(seen.served.map(repoLabel));
    const runnersOf = (v) => seen.runners.get(this.repoOf(seen, v));
    const actions = reviewInstances({ instances: seen.instances, runnersOf, reports: seen.reports, served, now: this.now(), cfg: this.cfg });
    // Each retirement touches only its own VM, runner and row, so they run together: a VM waits for no other.
    await Promise.all(actions.map((a) => this.retire(seen, a, out)));
  }

  // Unregister first (for an idle runner: GitHub refuses a runner that just took a job, and the VM then stays), then
  // the row goes to `deleting` with its end, then the delete call, which is not waited for: the next tick finds the
  // VM gone and finalizes the row.
  async retire(seen, a, out) {
    const v = a.instance;
    const repo = this.repoOf(seen, v);
    const runner = repo && this.runnerOf(seen, repo, v.name);
    if (a.action === 'unregister-delete' || (a.unregister && runner)) {
      try {
        await this.gh.deleteRunner(repo, runner.id);
        out.unregistered.push(v.name);
      } catch (err) {
        if (err.status !== 404 && a.action === 'unregister-delete') {
          this.log(`kept ${v.name}: its runner could not be unregistered (${err.message}); it may have just taken a job`);
          return;
        }
        if (err.status !== 404) this.log(`unregister ${v.name}: ${err.message}`);
      }
    }
    const had = seen.rowOf.get(v.alloc);
    const base = runningRow(had ?? launchRow({ alloc: v.alloc, repo: repo ?? v.repoLabel, cpus: v.cpus, at: v.created, config: v.config ?? '-', egress: v.egress }), v);
    const job = had?.job ?? (await this.jobOf(seen, base));
    let end = a.end;
    if (had?.state === 'deleting') end = had.end;
    else if (!had) end = 'orphan';
    else if (job && end === 'cancelled-idle') end = 'done';
    const deleting = finalRow(base, { end, deleted: this.now(), job, diskGb: this.cfg.disk_gb, egress: this.cfg.egress, state: 'deleting' });
    if (!(await this.write(deleting, { dedupe: !had }))) return; // no row, no delete: the next tick tries again
    seen.rowOf.set(v.alloc, deleting);
    try {
      await this.gce.deleteInstance(v.zone, v.name, { wait: false });
      out.deleted.push(`${v.name} (${a.reason})`);
      this.log(`deleting ${v.name} (${a.reason}, ${end})`);
    } catch (err) {
      this.log(`delete ${v.name}: ${err.message}`);
    }
    if (a.alert) {
      await this.alert({
        title: `ci-kit alert: GCE VM ${v.name} outlived its run limit`,
        body: `${v.name} (${v.machine}@${v.zone}) was older than max_run_minutes + 5 (${this.cfg.max_run_minutes} + 5 min), which Compute Engine ` +
          'should have enforced through maxRunDuration. The launcher deleted it (end max-run).',
      }).catch((err) => this.log(`alert: ${err.message}`));
    }
  }

  async settleRows(seen, out) {
    const pending = seen.rows.filter((r) => r.state !== 'final');
    const live = new Set(seen.instances.map((i) => i.alloc));
    let preempted = new Map();
    if (seen.complete && pending.some((r) => r.state !== 'deleting' && !live.has(r.alloc))) preempted = await this.preemptions();
    const current = pending.map((r) => seen.rowOf.get(r.alloc) ?? r);
    const actions = reviewRows({
      rows: current,
      instances: seen.instances,
      runnerKnown: (row) => seen.runners.has(row.repo),
      runnerOf: (row) => this.runnerOf(seen, row.repo, row.instance),
      preempted: preempted && new Set(preempted.keys()),
      now: this.now(), cfg: this.cfg, complete: seen.complete,
    });
    for (const a of actions) {
      // A VM missing from the listing is confirmed gone before its row is finalized: another launcher may have
      // created it after this tick listed instances.
      if (a.action === 'final' && a.row.zone && (await this.stillThere(a.row))) continue;
      if (a.action === 'running') {
        const next = runningRow(a.row, a.instance);
        if (await this.write(next)) seen.rowOf.set(a.row.alloc, next);
        continue;
      }
      const row = a.row;
      // A deleting row was looked up when it was written; only a VM that vanished on its own is looked up here.
      const job = row.job ?? (row.created && row.state !== 'deleting' ? await this.jobOf(seen, row) : null);
      let deleted = this.now();
      if (row.state === 'deleting') deleted = Date.parse(row.deleted);
      else if (a.end === 'preempted') deleted = preempted?.get(row.instance) ?? deleted;
      else if (a.end === 'max-run' && row.created) deleted = Math.min(deleted, Date.parse(row.created) + this.cfg.max_run_minutes * 60_000);
      const final = finalRow(row, { end: a.end, deleted, job, diskGb: this.cfg.disk_gb, egress: this.cfg.egress });
      if (await this.write(final)) {
        seen.rowOf.set(row.alloc, final);
        out.finalized.push(`${row.alloc} ${a.end}`);
      }
    }
  }

  async stillThere(row) {
    try {
      return Boolean(await this.gce.instance(row.zone, row.instance));
    } catch (err) {
      this.log(`confirm ${row.instance}: ${err.message}`);
      return true; // unknown: leave the row for the next tick
    }
  }

  // Instance name → when GCE preempted it, from its compute.instances.preempted operations; null when that history
  // could not be read (unavailable is not the same as empty: the rows wait for a tick that can read it).
  async preemptions() {
    try {
      const ops = await this.gce.operations('operationType="compute.instances.preempted"');
      return new Map(ops.map((op) => [op.targetLink.split('/').pop(), Date.parse(op.insertTime ?? op.endTime)]));
    } catch (err) {
      this.log(`preemptions unreadable, vanished VMs wait for the next tick: ${err.message}`);
      return null;
    }
  }

  async cleanRunners(seen, out) {
    const names = new Set(seen.instances.map((i) => i.name));
    for (const [repo, runners] of seen.runners) {
      for (const r of orphanRunners({ runners: [...runners.values()], instanceNames: names, now: this.now(), complete: seen.complete })) {
        try {
          await this.gh.deleteRunner(repo, r.id);
          out.unregistered.push(r.name);
          this.log(`unregistered ${r.name} in ${repo}: it has no instance`);
        } catch (err) {
          if (err.status !== 404) this.log(`unregister ${r.name}: ${err.message}`);
        }
      }
    }
  }

  async cleanLeftovers(seen, out) {
    const now = this.now();
    for (const d of orphanDisks(seen.disks, now)) {
      await this.gce.deleteDisk(zoneOf(d), d.name, { wait: false })
        .then(() => out.deleted.push(`disk ${d.name}`), (err) => this.log(`delete disk ${d.name}: ${err.message}`));
    }
    for (const b of staleBakeInstances(seen.builders, now)) {
      await this.gce.deleteInstance(zoneOf(b), b.name, { wait: false })
        .then(() => out.deleted.push(`${b.name} (old builder)`), (err) => this.log(`delete ${b.name}: ${err.message}`));
    }
  }

  // A VM that booted but whose runner never came online covers no job (logic.mjs neverOnline), and is logged at ERROR
  // each tick until the idle rule removes it: its egress may be broken, behind a NAT (egress `nat`) its region's NAT
  // missing, misconfigured or out of ports (spec M6).
  reportNeverOnline(seen) {
    const now = this.now();
    for (const v of runnersNeverOnline({ instances: seen.instances, runners: seen.runners, now, claimed: seen.claimed })) {
      const region = v.zone.replace(/-[a-z]$/, '');
      const runningSeconds = Math.round((now - v.running) / 1000);
      const check = v.egress === 'nat' ? `the Cloud NAT of ${region}` : 'its external address and GitHub\'s status';
      this.error(`runner never online: ${v.name} (${v.machine}@${v.zone}) has run ${runningSeconds} s and its runner is offline; ` +
        `it covers no job. Its egress may be broken: check ${check}`,
      { event: 'runner-never-online', instance: v.name, zone: v.zone, region, runningSeconds });
    }
  }

  // ── launches ───────────────────────────────────────────────────────────────────────────────────────────────────

  async launchAll(seen, out, deadline) {
    this.reportNeverOnline(seen);
    const plan = planLaunches({
      queued: seen.queued, instances: seen.instances, runners: seen.demand, now: this.now(), cfg: this.cfg, complete: seen.complete, claimed: seen.claimed,
      rows: seen.rows,
    });
    for (const job of plan.unservable) this.log(`job ${job.id} in ${job.repo} cannot run on GCE: labels ${job.labels.join(',')}`);
    out.waiting = plan.waiting.length;
    const prelaunches = (inflight) => (!seen.complete ? [] : planPrelaunches({
      runs: seen.runs, jobs: seen.jobs, rows: seen.rows, runners: seen.demand, inflight, waiting: plan.waiting.length, cfg: this.cfg,
    }));
    const ahead = prelaunches(plan.inflight);
    if (plan.launches.length + ahead.length === 0) return;
    const image = newestReadyImage(await seen.images, this.cfg.image_family);
    if (!image) {
      this.log(`no ready image in family ${this.cfg.image_family}; ${plan.launches.length} job(s) wait, ${ahead.length} pre-launch(es) not made`);
      return;
    }
    // A quota refusal stops no launch but the ones it covers (spec 2026-10-21, The launch queue): each launch skips
    // what the tick's memory says is out of quota, and one with nothing left waits in GitHub's queue.
    // The queued jobs' launches run to their end before any pre-launch starts: up to 16 launches mint and insert at
    // once, so a pre-launch beside them could take the quota a waiting job needs (review, M5). And a tick in which any
    // of them stayed unserved (refused, unsettled, raced, or not started by the deadline) pre-launches nothing: it has
    // no spare quota to speculate with, and its job comes first on the next tick.
    // A race (spec M6) starts only once every queued job's launch has made its first attempt (`firstTried`), so it never
    // takes the quota or the vCPUs a job not yet tried needs; it reserves its own in `inflight`, which pre-launch then
    // plans against, and the tick ends when its races have.
    let open;
    const ctx = {
      seen, deadline, out, image, inflight: plan.inflight, races: [],
      untried: new Set(plan.launches), firstTried: new Promise((resolve) => { open = resolve; }),
    };
    const opened = () => {
      ctx.opened = true;
      open();
    };
    ctx.tried = (item) => {
      if (ctx.untried.delete(item) && ctx.untried.size === 0) opened();
    };
    if (ctx.untried.size === 0) opened();
    const served = await this.launchQueue(plan.launches, ctx);
    opened(); // a launch the deadline kept from starting makes no first attempt to wait for
    if (served < plan.launches.length) {
      if (ahead.length) this.log(`no pre-launch this tick: ${plan.launches.length - served} queued job(s) were not served`);
    } else {
      const later = prelaunches(ctx.inflight);
      ctx.inflight += later.reduce((sum, a) => sum + largestMachineCpus(a.cpus, this.cfg), 0);
      await this.launchQueue(later, ctx);
    }
    while (ctx.races.length) await Promise.all(ctx.races.splice(0));
  }

  // Launches `items` with up to PARALLEL_LAUNCHES at once, none started past the deadline. Returns how many made a VM.
  async launchQueue(items, ctx) {
    const queue = [...items];
    let made = 0;
    const worker = async () => {
      while (queue.length && this.now() < ctx.deadline) {
        const item = queue.shift();
        const result = await this.launch(item, ctx).catch((err) => {
          this.log(`launch: ${err.message}`);
          return {};
        });
        ctx.tried(item);
        if (!result.name) continue;
        made += 1;
        ctx.out.launched.push(result.name);
        if (result.prelaunch) ctx.out.prelaunched.push(result.name);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_LAUNCHES, queue.length) }, worker));
    return made;
  }

  // One allocation (spec §3a VM lifecycle 1–2): the launching row, then the JIT config, then the walk over the
  // placements' zones, spot everywhere then on demand; a size the tick's quota memory rules out everywhere makes none.
  // A definite refusal everywhere unregisters the runner and abandons the row at once; an outcome that stays unknown
  // leaves both for the cleanup rules, so a VM that does appear later is still served. For a queued `job`, or for a
  // run's pool jobs to come (`prelaunch`: {run, attempt, workflow}, which its row keeps). A race of another
  // allocation's slow insert (`race`: {of, demand}, spec M6) walks the `attempts` it was given and is never raced
  // itself. Its row keeps its walk's refusals and slow inserts (walkRecord).
  async launch(item, ctx) {
    const { repo, cpus, job, prelaunch, race } = item;
    const { seen, deadline, out, image } = ctx;
    const purpose = job ? `job ${job.id}` : `run ${prelaunch.run}'s cpus-${cpus} pre-launch`;
    const what = race ? `the race of ${instanceName(race.of)} for ${purpose}` : purpose;
    const attempts = item.attempts ?? placements(cpus, this.cfg);
    if (attempts.every((p) => quotaBlocks(seen.quota, p))) {
      this.log(`${what} in ${repo} waits: quota refused every placement for its size this tick`);
      return {};
    }
    const at = this.now();
    let alloc = allocationId(at, this.random);
    while (seen.rowOf.has(alloc)) alloc = allocationId(at, this.random); // ids are random: never reuse one in the ledger
    seen.rowOf.set(alloc, null);
    const name = instanceName(alloc);
    const reserved = item.reserved ?? largestMachineCpus(cpus, this.cfg);
    const row = launchRow({ alloc, repo, cpus, at, config: this.config, egress: this.cfg.egress, prelaunch: race ? undefined : prelaunch, race, reserved });
    await this.ledger.upsert(row); // a launch with no row never happens: this throws, and nothing was created
    let jit;
    try {
      jit = await this.gh.jitConfig(repo, jitRequest(alloc, cpus));
    } catch (err) {
      this.log(`jit for ${what} in ${repo} (${name}): ${err.message}`);
      await this.write(finalRow(row, { end: 'abandoned', deleted: this.now(), diskGb: this.cfg.disk_gb, egress: this.cfg.egress }));
      return {};
    }
    // The tick's deadline stops new attempts; an attempt already started waits for its operation up to its own
    // deadline, since giving up early saves nothing (the operation runs on) and only defers what it decides. An
    // operation that outlives that wait is uncertain, reconciled now, and if still unsettled left for the next tick.
    // An insert still unsettled RACE_AFTER_MS after it was sent may start this allocation's one race (raceSlowInsert);
    // once it has, the walk makes no further attempt. Only a definite outcome settles an insert: one whose wait ended
    // before its operation did (unknown, and still running when reconciled) stays pending, and the launch waits, within
    // the tick, for its race to be decided (unsettled).
    let raced = false;
    // The writes of this row's pending inserts, each made before a race could start, in the order of its attempts: one
    // still in flight when its attempt is refused and the walk sends the next must land before the next one's, and all
    // before the walk's result.
    let marking = Promise.resolve(true);
    let unsettled = null; // {settle, decision, fired}: the last attempt, while its outcome is unknown
    const result = await walkPlacements(attempts, {
      attempt: async (p) => {
        out.firstInsert ??= iso(this.now());
        const sent = this.now();
        const slow = race ? null : this.after(RACE_AFTER_MS);
        const insert = this.gce.insertInstance(p.zone, jobInstance({
          alloc, ...p, repo, cpus, image: image.selfLink, jit: jit.encoded_jit_config, cfg: this.cfg, config: this.config,
        }), { deadlineMs: this.insertDeadlineMs });
        ctx.tried(item);
        let pending = true;
        let decided;
        const decision = new Promise((resolve) => { decided = resolve; });
        const settle = () => {
          pending = false;
          slow?.cancel();
          decided();
        };
        slow?.promise.then(() => this.raceSlowInsert({
          item, row, attempt: p, sent, attempts, stillPending: () => pending && !raced,
          hold: (write) => (marking = marking.then(write)),
          start: () => { raced = true; },
        }, ctx)).catch((err) => this.log(`race of ${name}: ${err.message}`)).finally(decided);
        try {
          const done = await insert;
          settle();
          return done;
        } catch (err) {
          if (race || insertOutcome(err) !== 'unknown') settle();
          else unsettled = { settle, decision, fired: slow.promise };
          throw err;
        }
      },
      reconcile: async (p, err) => {
        const settled = await this.reconcileInsert(p.zone, name, err);
        if (settled.outcome !== 'unknown') unsettled?.settle();
        return settled;
      },
      now: this.now, deadline, quota: seen.quota, raced: () => raced,
    });
    if (unsettled) {
      // Its race is decided by the tick's deadline at the latest; a race that cannot start yet (a queued job not yet
      // tried) is given up rather than holding this launch's place while that job waits for one.
      if (result.stop === 'unknown') {
        const left = this.after(Math.max(0, deadline - this.now()));
        await Promise.race([unsettled.decision, left.promise, unsettled.fired.then(() => (ctx.opened ? NEVER : undefined))]);
        left.cancel();
      }
      unsettled.settle();
    }
    await marking;
    out.inserts.push(...result.tried.map((t) => ({
      zone: t.zone, machine: t.machine, provisioning: t.provisioning, outcome: t.outcome, seconds: t.outcome === 'unknown' ? null : Math.round(t.ms / 100) / 10,
    })));
    const walked = { ...row, ...walkRecord(result.tried) };
    const tried = result.tried.map((t) => `${t.machine}/${t.provisioning}@${t.zone}: ${t.outcome}`).join(', ');
    if (result.placement) {
      const p = result.placement;
      const after = result.tried.length > 1 ? ` after ${tried}` : '';
      if (race) this.log(`raced ${name} (${p.machine}, ${p.provisioning}, ${p.zone}) against ${instanceName(race.of)} for ${purpose} in ${repo}${after}`);
      else if (job) this.log(`launched ${name} (${p.machine}, ${p.provisioning}, ${p.zone}) for job ${job.id} in ${repo}${after}`);
      else this.log(`pre-launched ${name} (${p.machine}, ${p.provisioning}, ${p.zone}) for run ${prelaunch.run} (${prelaunch.workflow}) in ${repo}${after}`);
      const running = runningRow(walked, { ...p, diskType: p.placement.disk_type, created: this.now() });
      await this.write(running);
      seen.launches.push(running);
      return { name, prelaunch: Boolean(prelaunch) && !race };
    }
    if (result.stop === 'unknown') {
      // The row keeps the insert that never settled: until a later tick learns its end (settleInserts), the allocation
      // keeps its vCPUs and covers its job (planLaunches), since its VM may still appear.
      this.log(`${name}: insert outcome unknown (${tried}); the next ticks settle it`);
      await this.write(walked);
      seen.launches.push(walked);
      return {};
    }
    if (raced) this.log(`${name}: not created (${tried}); its race serves ${what}`);
    else this.log(`${name}: not created (${result.stop}: ${tried}); ${what} waits`);
    await this.gh.deleteRunner(repo, jit.runner.id).catch((err) => {
      if (err.status !== 404) this.log(`unregister ${name}: ${err.message}; the orphan-runner rule retries`);
    });
    const abandoned = finalRow(walked, { end: 'abandoned', deleted: this.now(), diskGb: this.cfg.disk_gb, egress: this.cfg.egress });
    await this.write(abandoned);
    seen.launches.push(abandoned);
    return {};
  }

  // The race of an insert still unsettled RACE_AFTER_MS after it was sent (spec M6): once every queued job's launch has
  // made its first attempt, if the insert is still pending, a second allocation of the same size walks the attempts
  // after it in other zones (raceAttempts), another region first and on demand only after spot, reserving its vCPUs
  // like any launch. None starts past the tick's deadline, beyond max_vcpus, or with no attempt left; an allocation
  // races at most once, and a race never races. Before the race's own row, runner and insert, the original's row is
  // written with its pending insert, and the race's row is written before its runner and insert: a launcher that
  // restarts meanwhile counts both (planLaunches, pendingAllocation).
  async raceSlowInsert({ item, row, attempt, sent, attempts, stillPending, hold, start }, ctx) {
    await ctx.firstTried;
    if (!stillPending()) return;
    const name = row.instance;
    const next = raceAttempts(attempts, attempt).filter((p) => !quotaBlocks(ctx.seen.quota, p));
    const need = largestMachineCpus(item.cpus, this.cfg);
    let why = null;
    if (!next.length) why = 'no other zone left to try';
    else if (this.now() >= ctx.deadline) why = 'the tick\'s budget is spent';
    else if (ctx.inflight + need > this.cfg.max_vcpus) why = `max_vcpus ${this.cfg.max_vcpus} has no room for it`;
    const unsettled = `${name}: its insert in ${attempt.zone} is unsettled after ${RACE_AFTER_MS / 1000} s`;
    if (why) {
      this.log(`${unsettled}; no race (${why})`);
      return;
    }
    // Reserved while the original's pending insert is written; without that row, a restarted launcher would not count
    // the original, so no race starts.
    ctx.inflight += need;
    const marked = hold(() => this.write({ ...row, slow: [{ zone: attempt.zone, outcome: 'unknown', sent: iso(sent) }] }));
    if (!(await marked) || !stillPending()) {
      ctx.inflight -= need;
      this.log(`${unsettled}; no race (${stillPending() ? 'its pending insert could not be written to the ledger' : 'it settled meanwhile'})`);
      return;
    }
    start();
    this.log(`${unsettled}; a second allocation races it`);
    const demand = item.job ? { job: item.job.id } : { run: item.prelaunch.run, attempt: item.prelaunch.attempt };
    const racing = {
      repo: item.repo, cpus: item.cpus, job: item.job, prelaunch: item.prelaunch, race: { of: row.alloc, demand }, attempts: next, reserved: need,
    };
    ctx.races.push(this.launch(racing, ctx).then((r) => {
      if (!r.name) return;
      ctx.out.launched.push(r.name);
      ctx.out.raced.push(`${r.name} for ${name}`);
    }, (err) => this.log(`race of ${name}: ${err.message}`)));
  }

  // An insert whose outcome is unknown, settled through its zone operation before another zone is tried: the
  // operation the error carries, else the zone's insert operation for this name; with no operation, the instance
  // itself. Anything still undecided is 'unknown'. Resolves to {outcome, error: the settled operation's, if any}.
  async reconcileInsert(zone, name, err) {
    try {
      const op = err?.operation
        ? await this.gce.operation(err.operation)
        : (await this.gce.zoneOperations(zone, `targetLink eq ".*/instances/${name}"`)).find((o) => o.operationType === 'insert') ?? null;
      if (op) return op.status === 'DONE' ? settledAs(op) : { outcome: 'unknown' };
      return { outcome: (await this.gce.instance(zone, name)) ? 'created' : 'unknown' };
    } catch (e) {
      this.log(`reconcile ${name}: ${e.message}`);
      return { outcome: 'unknown' };
    }
  }

  // ── the daily line ─────────────────────────────────────────────────────────────────────────────────────────────

  // The day's Cloud NAT use per region (ledger.mjs natDay), from Cloud Monitoring: three queries, each aggregated to one
  // point per region for the day. A read that fails leaves it {unread: true}: the line says so rather than guess.
  async natOf(dayIso) {
    const start = `${dayIso}T00:00:00.000Z`;
    const end = iso(Date.parse(start) + 24 * 3600_000);
    const read = (metric, perSeriesAligner) => this.gce.timeSeries(
      `metric.type="router.googleapis.com/nat/${metric}" AND resource.type="nat_gateway" AND resource.labels.gateway_name="${NAT_GATEWAY}"`,
      { start, end, aggregation: { alignmentPeriod: '86400s', perSeriesAligner, crossSeriesReducer: 'REDUCE_SUM', groupByFields: 'resource.labels.region' } },
    );
    try {
      const [sent, received, ports] = await Promise.all([read('sent_bytes_count', 'ALIGN_SUM'), read('received_bytes_count', 'ALIGN_SUM'), read('allocated_ports', 'ALIGN_COUNT')]);
      return natDay({ sent, received, ports });
    } catch (err) {
      this.log(`NAT use of ${dayIso} unread: ${err.message}`);
      return { unread: true };
    }
  }

  async daily(seen) {
    const now = this.now();
    const into = now % (24 * 3600_000);
    if (into < DAILY_AFTER_MS || into >= DAILY_WITHIN_MS) return;
    const yesterday = day(now - 24 * 3600_000);
    try {
      if (this.ledger.hasDaily(yesterday)) return;
      const nat = await this.natOf(yesterday);
      if (await this.ledger.postDaily(dailyLine([...seen.rowOf.values()].filter(Boolean), yesterday, this.config, nat))) this.log(`ledger: daily line for ${yesterday}`);
    } catch (err) {
      this.log(`daily line: ${err.message}`);
    }
  }
}

