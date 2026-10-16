// The GCE launcher's reconciliation (spec §3a The launcher): one tick, with every outside effect injected so the
// orchestration is testable. server.mjs runs a tick per Cloud Scheduler call. The decisions are in logic.mjs; this
// file observes (Compute Engine, GitHub, the ledger), decides through logic.mjs, and acts.
// Nothing is kept between ticks: state lives in GCE labels, the ledger and GitHub, so every tick can act as the
// first, and two overlapping ticks (Cloud Run can briefly run two) stay correct: deletes and unregisters treat 404
// as done, ledger rows are keyed by allocation and only move forward, and an over-launch leaves idle runners that the
// idle rule removes. The project's vCPU quota is the hard cap; a quota refusal ends the tick's launches.
import { GceError } from '../../lib/gce.mjs';
import { createAlerts } from '../../pool/lib/alerts.mjs';
import { queuedPoolJobs } from '../../pool/agent/logic.mjs';
import { staleBakeInstances } from '../bake/plan.mjs';
import { servedRepos } from './config.mjs';
import {
  allocationId, instanceName, repoLabel, viewInstance, isGce, planLaunches, placements, insertOutcome, walkPlacements,
  jobInstance, jitRequest, newestReadyImage, reviewInstances, reviewRows, orphanRunners, orphanDisks,
} from './logic.mjs';
import { launchRow, runningRow, withJob, finalRow, dailyLine } from './ledger.mjs';

export const TICK_BUDGET_MS = 45_000;
const INSERT_DEADLINE_MS = 40_000;
const PARALLEL_LAUNCHES = 6;
const DAILY_WITHIN_MS = 2 * 3600_000; // the 26 h ledger window holds all of yesterday only early in the day
const zoneOf = (r) => r.zone.split('/').pop();
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// deps: {gce, gh, ledger, cfg, config, poolRepos, now, log, random, alert}
// cfg: the gce.json it runs, config: that file's commit; poolRepos: the repo names in pool.json (one file per repo).
export class Launcher {
  constructor(deps) {
    Object.assign(this, deps);
    this.now ??= Date.now;
    this.log ??= () => {};
    this.alert ??= createAlerts(this.gh, this.cfg.ledger.repo, { log: this.log });
    this.budgetMs ??= TICK_BUDGET_MS;
    this.insertDeadlineMs ??= INSERT_DEADLINE_MS;
  }

  // One reconciliation. Throws only when Compute Engine or the ledger cannot be read (the tick then did nothing).
  async tick() {
    const deadline = this.now() + this.budgetMs;
    const out = { launched: [], deleted: [], unregistered: [], finalized: [], waiting: 0 };
    const seen = await this.observe();

    await this.recordJobs(seen);
    await this.cleanInstances(seen, out);
    await this.settleRows(seen, out);
    await this.cleanRunners(seen, out);
    await this.cleanLeftovers(seen, out);
    if (this.now() < deadline) await this.launchAll(seen, out, deadline);
    await this.daily(seen);
    return out;
  }

  // ── observation ────────────────────────────────────────────────────────────────────────────────────────────────

  async observe() {
    const { served: listed, both } = servedRepos(this.cfg.repos, this.poolRepos);
    for (const repo of both) {
      this.log(`refusing ${repo}: it is in gce.json and pool.json, and a repo is served by one backend only`);
      await this.alert({
        title: `ci-kit alert: ${repo} is in both gce.json and pool.json`,
        body: `The GCE launcher serves neither copy of ${repo} until one file lists it (spec §3a, one file per repo).`,
      }).catch((err) => this.log(`alert: ${err.message}`));
    }
    // Public repos are refused, as on the Hetzner box; a repo whose visibility cannot be read is not served this tick.
    const served = [];
    for (const repo of listed) {
      try {
        if ((await this.gh.getRepo(repo)).private === true) served.push(repo);
        else this.log(`refusing ${repo}: it is public, and the pool serves private repos only`);
      } catch (err) {
        this.log(`not serving ${repo} this tick: its visibility could not be read (${err.message})`);
      }
    }
    // The ledger is read before the instances: a row seen running was written after its insert, so its VM is in the
    // listing that follows unless it is gone. (A row whose VM is missing is confirmed with a direct read anyway.)
    await this.ledger.read();
    const rows = await this.ledger.rows();
    const [rawInstances, disks, builders] = await Promise.all([
      this.gce.instances('labels.ci-kit=gce'),
      this.gce.disks('labels.ci-kit=gce'),
      this.gce.instances('labels.ci-kit=gce-builder'),
    ]);
    const instances = rawInstances.filter(isGce).map(viewInstance);
    const rowOf = new Map(rows.map((r) => [r.alloc, r]));

    // Runners are listed for every repo something of ours belongs to: served repos, and repos being drained (a row
    // not yet final, or an instance of a repo no longer served). A failed listing leaves the repo out of `runners`.
    const byLabel = new Map();
    for (const repo of [...served, ...rows.filter((r) => r.state !== 'final').map((r) => r.repo)]) byLabel.set(repoLabel(repo), repo);
    for (const i of instances) if (!byLabel.has(i.repoLabel) && rowOf.get(i.alloc)) byLabel.set(i.repoLabel, rowOf.get(i.alloc).repo);
    const runners = new Map();
    const demand = new Map();
    const queued = [];
    const jobs = [];
    for (const repo of byLabel.values()) {
      try {
        const mine = (await this.gh.runners(repo)).filter((r) => r.name.startsWith('ci-kit-gce-'));
        runners.set(repo, new Map(mine.map((r) => [r.name, r])));
      } catch (err) {
        this.log(`runners of ${repo}: ${err.message}`);
        continue;
      }
      if (!served.includes(repo)) continue;
      try {
        // Runners were read first: a job taken between the two reads then shows as not queued, never as double demand.
        const runs = [...(await this.gh.runsByStatus(repo, 'queued')), ...(await this.gh.runsByStatus(repo, 'in_progress'))];
        const repoJobs = [];
        for (const run of runs) repoJobs.push(...(await this.gh.listJobs(repo, run.id)).map((j) => ({ ...j, repo })));
        queued.push(...queuedPoolJobs(repoJobs));
        jobs.push(...repoJobs);
        demand.set(repo, runners.get(repo));
      } catch (err) {
        this.log(`jobs of ${repo}: ${err.message}`);
      }
    }
    return { served, instances, disks, builders, rows, rowOf, byLabel, runners, demand, queued, jobs };
  }

  repoOf(seen, view) {
    return seen.rowOf.get(view.alloc)?.repo ?? seen.byLabel.get(view.repoLabel) ?? null;
  }

  runnerOf(seen, repo, name) {
    return seen.runners.get(repo)?.get(name) ?? null;
  }

  // The job a runner actually held: from this tick's listing, else from the repo's runs since the allocation began.
  async jobOf(seen, row) {
    const hit = seen.jobs.find((j) => j.runner_name === row.instance);
    if (hit) return hit;
    try {
      const since = new Date(Date.parse(row.at) - 10 * 60_000).toISOString();
      for (const run of (await this.gh.runsCreatedSince(row.repo, since)).slice(0, 30)) {
        const found = (await this.gh.listJobs(row.repo, run.id)).find((j) => j.runner_name === row.instance);
        if (found) return found;
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

  // A busy runner's job goes on its row as soon as it is seen: a preempted VM is deleted with its labels, so the row
  // is where the job it held survives.
  async recordJobs(seen) {
    for (const row of seen.rows) {
      if (row.state === 'final' || row.job) continue;
      const job = seen.jobs.find((j) => j.runner_name === row.instance);
      if (!job) continue;
      const inst = seen.instances.find((i) => i.alloc === row.alloc);
      const next = withJob(row.state === 'launching' && inst ? runningRow(row, inst) : row, job);
      if (await this.write(next)) seen.rowOf.set(row.alloc, next);
    }
  }

  // ── cleanup ────────────────────────────────────────────────────────────────────────────────────────────────────

  async cleanInstances(seen, out) {
    const served = new Set(seen.served.map(repoLabel));
    const actions = reviewInstances({
      instances: seen.instances,
      runnersOf: (v) => seen.runners.get(this.repoOf(seen, v)),
      served, now: this.now(), cfg: this.cfg,
    });
    for (const a of actions) await this.retire(seen, a, out);
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
    const base = runningRow(had ?? launchRow({ alloc: v.alloc, repo: repo ?? v.repoLabel, cpus: v.cpus, at: v.created, config: v.config ?? '-' }), v);
    const job = had?.job ?? (await this.jobOf(seen, base));
    let end = a.end;
    if (had?.state === 'deleting') end = had.end;
    else if (!had) end = 'orphan';
    else if (job && end === 'cancelled-idle') end = 'done';
    const deleting = finalRow(base, { end, deleted: this.now(), job, diskGb: this.cfg.disk_gb, state: 'deleting' });
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
    if (pending.some((r) => r.state !== 'deleting' && !live.has(r.alloc))) preempted = await this.preemptions();
    const current = pending.map((r) => seen.rowOf.get(r.alloc) ?? r);
    const actions = reviewRows({
      rows: current,
      instances: seen.instances,
      runnerKnown: (row) => seen.runners.has(row.repo),
      runnerOf: (row) => this.runnerOf(seen, row.repo, row.instance),
      preempted: new Set(preempted.keys()),
      now: this.now(), cfg: this.cfg,
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
      else if (a.end === 'preempted') deleted = preempted.get(row.instance) ?? deleted;
      else if (a.end === 'max-run' && row.created) deleted = Math.min(deleted, Date.parse(row.created) + this.cfg.max_run_minutes * 60_000);
      const final = finalRow(row, { end: a.end, deleted, job, diskGb: this.cfg.disk_gb });
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

  // Instance name → when GCE preempted it, from its compute.instances.preempted operations.
  async preemptions() {
    try {
      const ops = await this.gce.operations('operationType="compute.instances.preempted"');
      return new Map(ops.map((op) => [op.targetLink.split('/').pop(), Date.parse(op.insertTime ?? op.endTime)]));
    } catch (err) {
      this.log(`preemptions: ${err.message}`);
      return new Map();
    }
  }

  async cleanRunners(seen, out) {
    const names = new Set(seen.instances.map((i) => i.name));
    for (const [repo, runners] of seen.runners) {
      for (const r of orphanRunners({ runners: [...runners.values()], instanceNames: names, now: this.now() })) {
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

  // ── launches ───────────────────────────────────────────────────────────────────────────────────────────────────

  async launchAll(seen, out, deadline) {
    const plan = planLaunches({ queued: seen.queued, instances: seen.instances, runners: seen.demand, now: this.now(), cfg: this.cfg });
    for (const job of plan.unservable) this.log(`job ${job.id} in ${job.repo} cannot run on GCE: labels ${job.labels.join(',')}`);
    out.waiting = plan.waiting.length;
    if (plan.launches.length === 0) return;
    const image = newestReadyImage(await this.gce.images('labels.ci-kit=gce-image'), this.cfg.image_family);
    if (!image) {
      this.log(`no ready image in family ${this.cfg.image_family}; ${plan.launches.length} job(s) wait`);
      return;
    }
    const queue = [...plan.launches];
    let stop = false;
    const worker = async () => {
      while (queue.length && !stop && this.now() < deadline) {
        const result = await this.launch(queue.shift(), image).catch((err) => {
          this.log(`launch: ${err.message}`);
          return {};
        });
        if (result.name) out.launched.push(result.name);
        if (result.quota) stop = true; // the region is out of quota: the rest wait in GitHub's queue
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_LAUNCHES, queue.length) }, worker));
  }

  // One allocation (spec §3a VM lifecycle 1–2): the launching row, then the JIT config, then the walk over zones,
  // spot then on demand. A definite refusal everywhere unregisters the runner and abandons the row at once; an
  // outcome that stays unknown leaves both for the cleanup rules, so a VM that does appear later is still served.
  async launch({ repo, cpus, job }, image) {
    const at = this.now();
    const alloc = allocationId(at, this.random);
    const name = instanceName(alloc);
    const row = launchRow({ alloc, repo, cpus, at, config: this.config });
    await this.ledger.upsert(row); // a launch with no row never happens: this throws, and nothing was created
    let jit;
    try {
      jit = await this.gh.jitConfig(repo, jitRequest(alloc, cpus));
    } catch (err) {
      this.log(`jit for job ${job.id} in ${repo} (${name}): ${err.message}`);
      await this.write(finalRow(row, { end: 'abandoned', deleted: this.now(), diskGb: this.cfg.disk_gb }));
      return {};
    }
    const result = await walkPlacements(placements(cpus, this.cfg), {
      attempt: (p) => this.gce.insertInstance(p.zone, jobInstance({
        alloc, ...p, repo, cpus, image: image.selfLink, jit: jit.encoded_jit_config, cfg: this.cfg, config: this.config,
      }), { deadlineMs: this.insertDeadlineMs }),
      reconcile: (p, err) => this.reconcileInsert(p.zone, name, err),
    });
    const tried = result.tried.map((t) => `${t.machine}/${t.provisioning}@${t.zone}: ${t.outcome}`).join(', ');
    if (result.placement) {
      const p = result.placement;
      this.log(`launched ${name} (${p.machine}, ${p.provisioning}, ${p.zone}) for job ${job.id} in ${repo}${result.tried.length > 1 ? ` after ${tried}` : ''}`);
      await this.write(runningRow(row, { ...p, created: this.now() }));
      return { name, quota: result.quota };
    }
    if (result.stop === 'unknown') {
      this.log(`${name}: insert outcome unknown (${tried}); the next ticks settle it`);
      return { quota: result.quota };
    }
    this.log(`${name}: not created (${result.stop}: ${tried}); job ${job.id} waits`);
    await this.gh.deleteRunner(repo, jit.runner.id).catch((err) => {
      if (err.status !== 404) this.log(`unregister ${name}: ${err.message}; the orphan-runner rule retries`);
    });
    await this.write(finalRow(row, { end: 'abandoned', deleted: this.now(), diskGb: this.cfg.disk_gb }));
    return { quota: result.quota };
  }

  // An insert whose outcome is unknown, settled through its zone operation before another zone is tried: the
  // operation the error carries, else the zone's insert operation for this name; with no operation, the instance
  // itself. Anything still undecided is 'unknown'.
  async reconcileInsert(zone, name, err) {
    try {
      const op = err?.operation
        ? await this.gce.operation(err.operation)
        : (await this.gce.zoneOperations(zone, `targetLink eq ".*/instances/${name}"`)).find((o) => o.operationType === 'insert') ?? null;
      if (op) {
        if (op.status !== 'DONE') return 'unknown';
        if (!op.error?.errors?.length) return 'created';
        return insertOutcome(new GceError(op.httpErrorStatusCode ?? 200, 'insert operation', op.error.errors.map((e) => e.code), { accepted: true, finished: true }));
      }
      return (await this.gce.instance(zone, name)) ? 'created' : 'unknown';
    } catch (e) {
      this.log(`reconcile ${name}: ${e.message}`);
      return 'unknown';
    }
  }

  // ── the daily line ─────────────────────────────────────────────────────────────────────────────────────────────

  async daily(seen) {
    const now = this.now();
    if (now % (24 * 3600_000) >= DAILY_WITHIN_MS) return;
    const yesterday = day(now - 24 * 3600_000);
    try {
      if (await this.ledger.postDaily(dailyLine([...seen.rowOf.values()], yesterday, this.config))) this.log(`ledger: daily line for ${yesterday}`);
    } catch (err) {
      this.log(`daily line: ${err.message}`);
    }
  }
}

