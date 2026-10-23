// The GCE launcher's reconciliation (spec §3a The launcher): one tick, with every outside effect injected so the
// orchestration is testable. server.mjs runs ticks for Cloud Scheduler and the webhook (ticker.mjs). The decisions
// are in logic.mjs; this file observes (Compute Engine, GitHub, the ledger), decides through logic.mjs, and acts.
// Durable state lives in provider instances, the ledger and GitHub; refusal/outage memory is process-local.
// Two overlapping ticks (Cloud Run can briefly run two) converge: deletes and unregisters treat 404
// as done, ledger rows are keyed by allocation and only move forward, and an over-launch leaves idle runners that the
// idle rule removes. Quota is the hard cap: a refusal is remembered for the rest of the tick, scoped to what ran out
// (logic.mjs quotaScope), and later launches skip what it covers; one with nothing left to try waits in GitHub's queue.
// A tick reads everything it can at once and launches before it cleans up (spec M3): a job's wait for its VM is
// mostly the time to its first insert. A run that has begun before its pool jobs are queued gets their VMs launched
// ahead of them (spec M5, prelaunch.mjs), after the queued jobs' launches and with what they leave of max_vcpus.
// An insert still unsettled RACE_AFTER_MS after it was sent is raced by a second allocation of its size in another zone
// (spec M6), while the first keeps waiting on its own operation and is never moved; whichever VM's runner a job takes
// first serves it, and the other is an ordinary unclaimed VM the idle rule removes.
import { providerKey, providerRunnerName } from './providers/contracts.mjs';
import { keyOf, providerWalk, createAdmission, schedulingView } from './scheduling.mjs';
import { createProvider, gceWalkResult } from './providers/gce.mjs';
import { createAlerts } from '../../pool/lib/alerts.mjs';
import { queuedPoolJobs } from '../../pool/agent/logic.mjs';
import { servedRepos } from './config.mjs';
import {
  allocationId, repoLabel, planLaunches, runnersNeverOnline, quotaBlocks, insertOutcome, walkPlacements, stockoutMemory,
  jitRequest, reviewInstances, reviewRows, orphanRunners, reportable, claimedInstances,
  raceAttempts, walkRecord, unsettledInsert, quotaMetric, RACE_AFTER_MS,
} from './logic.mjs';
import { planPrelaunches } from './prelaunch.mjs';
import { createPreparation } from './preparation.mjs';
import { launchRow, runningRow, withJob, jobRecord, finalRow, dailyLine, launchCounts } from './ledger.mjs';

export const TICK_BUDGET_MS = 45_000;
const INSERT_DEADLINE_MS = 40_000;
const PARALLEL_LAUNCHES = 16; // a burst launches in one round: each insert waits ~10–20 s for its operation
const DAILY_WITHIN_MS = 2 * 3600_000; // the 26 h ledger window holds all of yesterday only early in the day
// Cloud NAT's samples take up to 225 s to be readable: the day's line, which reads its NAT once, waits past that.
const DAILY_AFTER_MS = 5 * 60_000;
// How long a launch waits for the placements' limits (room.mjs) when the cache must read them: the read runs beside the
// tick's other reads and is done long before, so this only bounds a slow one, after which the walk runs without them.
const LIMITS_WAIT_MS = 3_000;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const iso = (ms) => new Date(ms).toISOString();
const NEVER = new Promise(() => {});

// deps: {provider, gh, ledger, cfg, config, poolRepos, now, log, error, random, alert, after, stockouts}. A caller may
// supply gce/limits instead of provider to construct the same GCE adapter. error(message, fields) logs at ERROR
// what a log-based alert watches (gce/deploy.sh alert), log otherwise.
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
    this.stockouts ??= stockoutMemory(); // the server passes one kept across ticks (logic.mjs stockoutMemory)
    this.after ??= (ms) => {
      let timer;
      const promise = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
      return { promise, cancel: () => clearTimeout(timer) };
    };
    this.providerState ??= new Map();
    this.creditPreference ??= (account) => account.credit?.enabled !== false;
    this.provider ??= createProvider({ gce: this.gce, cfg: this.cfg, config: this.config, now: this.now, log: this.log,
      after: this.after, limits: this.limits, insertDeadlineMs: this.insertDeadlineMs });
    this.providers = new Map((deps.providers ?? [this.provider]).filter((p) => p.name !== 'ec2' || this.ec2?.accounts.some((a) => a.account === p.account)).map((p) => [keyOf(p, this.cfg.project), p]));
  }

  providerOf(value) { return this.providers.get(keyOf(value, this.cfg.project)); }
  known(seen, value) { return seen.inventories.get(keyOf(value, this.cfg.project))?.complete === true; }
  partitions(seen) {
    return [...seen.inventories].filter(([key, inventory]) => inventory.complete || JSON.parse(key)[0] === 'gce').map(([key, inventory]) => ({
      ...seen, ...inventory, rows: seen.rows.filter((r) => keyOf(r, this.cfg.project) === key),
      instances: seen.instances.filter((i) => keyOf(i, this.cfg.project) === key), api: this.providers.get(key),
    })).filter((part) => part.api);
  }

  // One reconciliation. Throws only when Compute Engine or the ledger cannot be read (the tick then did nothing), or
  // when the image list cannot be read for a launch. out.firstInsert: when the tick sent its first insert, or null;
  // out.prelaunched: the VMs of out.launched launched ahead of a run's pool jobs; out.raced: those that race another's
  // slow insert (`<race> for <original>`). The walks' counts (spec M6): out.inserts, every insert sent, {zone, machine,
  // provisioning, outcome, seconds from send to settle, null when it never settled}; and of the rows the launches wrote,
  // out.refusals, out.slow and out.onDemand (ledger.mjs launchCounts). out.full: the attempts skipped for want of room,
  // by the limit each would pass (room.mjs); out.cut: the launches the tick's deadline cut off, which the server runs a
  // follow-up tick for (ticker.mjs). out.preparation: call spans (preparation.mjs), including the server's setup and
  // config reads when it passes the tick's recorder.
  async tick(preparation = createPreparation({ now: this.now })) {
    const deadline = this.now() + this.budgetMs;
    const out = {
      launched: [], prelaunched: [], raced: [], deleted: [], unregistered: [], finalized: [], waiting: 0, firstInsert: null, inserts: [], full: {}, cut: 0,
      preparation: preparation.calls,
    };
    const seen = await preparation.time('observe', () => this.observe(preparation));
    // Launches start first, and the cleanup runs beside them: neither waits for the other. Launching before cleaning
    // up can only under-admit for a tick (a VM about to be deleted still counts against max_vcpus), never over-admit.
    seen.cleaning = this.cleanUp(seen, out);
    const done = await Promise.allSettled([this.launchAll(seen, out, deadline, preparation), seen.cleaning]);
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
  async observe(preparation) {
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
    const rowsRead = (async () => {
      await preparation.time('ledger.read', () => this.ledger.read());
      return preparation.time('ledger.rows', () => this.ledger.rows());
    })();
    const store = Promise.all([...this.providers].map(async ([key, api]) => {
      const ownRows = rowsRead.then((rows) => rows.filter((r) => keyOf(r, this.cfg.project) === key));
      try {
        const [inventory, awaitRows] = await Promise.all([api.observe({ rows: ownRows, preparation }), ownRows]);
        return [key, { ...inventory, instances: inventory.instances.map((i) => schedulingView(i, awaitRows)), api }];
      } catch (err) {
        if (api.name === 'gce') throw err;
        this.log(`inventory ${key}: ${err.message}`);
        return [key, { instances: [], complete: false, api }];
      }
    }));
    // Images are read beside inventory, separately per instance; a failed image does not stop other providers.
    const images = new Map([...this.providers].map(([key, api]) => {
      const image = api.readyImage(preparation).catch((err) => { this.log(`image ${key}: ${err.message}`); return null; });
      return [key, image];
    }));
    const reads = new Map(listed.map((repo) => [repo, this.readRepo(repo, preparation)]));

    // Awaited first: it is the one read whose failure fails the tick, and a rejection nobody awaits yet would end the
    // process. Every other read resolves, whatever happens to it.
    const inventories = new Map(await store);
    const rows = await rowsRead;
    for (const r of rows) if (r.state !== 'final' && !inventories.has(keyOf(r, this.cfg.project))) inventories.set(keyOf(r, this.cfg.project), { instances: [], complete: false });
    const unknown = new Set();
    for (const [key, inventory] of inventories) {
      const state = this.providerState.get(key) ?? {};
      if (!inventory.complete) {
        unknown.add(key);
        state.unknownSince ??= this.now();
        if (!state.outageLogged && this.now() - state.unknownSince >= 30 * 60_000) {
          this.error(`inventory unknown for 30 min: ${key}; reservations remain held`);
          state.outageLogged = true;
        }
      } else { delete state.unknownSince; delete state.outageLogged; }
      this.providerState.set(key, state);
    }
    const instances = [...inventories.values()].flatMap((v) => v.instances);
    const complete = inventories.get(providerKey({ provider: 'gce', account: this.cfg.project }))?.complete !== false;
    // Public repos are refused, as on the Hetzner box; a repo whose visibility cannot be read is not served this tick.
    const served = [];
    for (const [repo, read] of reads) {
      const visible = await read.visible;
      if (visible === true) served.push(repo);
      else if (visible === false) this.log(`refusing ${repo}: it is public, and the pool serves private repos only`);
      else this.log(`not serving ${repo} this tick: its visibility could not be read (${visible.message})`);
    }
    const rowOf = new Map(rows.map((r) => [r.alloc, r]));

    // Runners are listed for every repo something of ours belongs to: served repos, and every repo with a row in the
    // ledger's window, final or not. A repo being drained stays listed after its last row is final, so a runner left
    // behind (a preempted VM's, still busy until GitHub fails its job) is unregistered once it is free. A failed
    // listing leaves the repo out of `runners`.
    const byLabel = new Map();
    for (const repo of [...served, ...rows.map((r) => r.repo)]) byLabel.set(repoLabel(repo), repo);
    for (const i of instances) if (!byLabel.has(i.repoLabel) && rowOf.get(i.alloc)) byLabel.set(i.repoLabel, rowOf.get(i.alloc).repo);
    const runners = new Map();
    const listings = await Promise.all([...byLabel.values()].map(async (repo) => [repo, await (reads.get(repo)?.runners ?? this.listRunners(repo, preparation))]));
    for (const [repo, mine] of listings) if (mine) runners.set(repo, mine);
    // quota: the tick's memory of quota refusals (logic.mjs quotaScope), shared by its launches; launches: the rows they
    // wrote last, which the tick's counts read.
    const seen = { served, instances, complete, inventories, unknown, rows, rowOf, byLabel, runners, images, quota: [], launches: [] };

    // A VM whose job has ended says so in ci-kit/job before its guest powers off. Read beside the jobs, it serves both
    // the cover (an ended job's VM covers nothing) and the cleanup (the VM goes without waiting for its power-off).
    const reports = this.readReports(seen, preparation);
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
  readRepo(repo, preparation) {
    const visible = preparation.time('github.getRepo', () => this.gh.getRepo(repo), { repo }).then((r) => r.private === true, (err) => err);
    const runners = this.listRunners(repo, preparation);
    const jobs = runners.then(async (mine) => {
      if (!mine) return null;
      try {
        const listed = [...(await preparation.time('github.runs.queued', () => this.gh.runsByStatus(repo, 'queued'), { repo })),
          ...(await preparation.time('github.runs.in_progress', () => this.gh.runsByStatus(repo, 'in_progress'), { repo }))];
        const runs = [...new Map(listed.map((run) => [run.id, run])).values()]; // one that started between is in both
        const lists = await Promise.all(runs.map(async (run) => {
          const jobs = await preparation.time('github.listJobs', () => this.gh.listJobs(repo, run.id), { repo, run: run.id });
          return jobs.map((j) => ({ ...j, repo, workflow: run.path }));
        }));
        return { jobs: lists.flat(), runs: runs.map((run) => ({ repo, id: run.id, path: run.path, attempt: run.run_attempt ?? 1 })) };
      } catch (err) {
        this.log(`jobs of ${repo}: ${err.message}`);
        return null;
      }
    });
    return { visible, runners, jobs };
  }

  async listRunners(repo, preparation) {
    try {
      const mine = (await preparation.time('github.runners', () => this.gh.runners(repo), { repo })).filter((r) => /^ci-kit-(gce|ec2)-/.test(r.name));
      return new Map(mine.map((r) => [r.name, r]));
    } catch (err) {
      this.log(`runners of ${repo}: ${err.message}`);
      return null;
    }
  }

  // The legacy decisions consume only terminal evidence, keyed by runner name. A bundle's telemetry (including
  // a guest claim signal) is deliberately not a claim or retirement signal. M4 consumes the allocation-keyed map.
  async readReports(seen, preparation) {
    const runnersOf = (v) => seen.runners.get(this.repoOf(seen, v));
    const result = new Map();
    await Promise.all(this.partitions(seen).map(async (part) => {
      const allocs = reportable(part.instances, runnersOf).map((v) => ({ ...(seen.rowOf.get(v.alloc) ?? {}), alloc: v.alloc, instance: v.name, zone: v.zone }));
      const reports = await part.api.readReports(allocs, preparation);
      for (const a of allocs) result.set(a.instance, reports.get(a.alloc)?.terminal ?? null);
    }));
    return result;
  }

  repoOf(seen, view) {
    return seen.rowOf.get(view.alloc)?.repo ?? view.repo ?? seen.byLabel.get(view.repoLabel) ?? null;
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
  // the provider's settlement budget, and a zone not read in it, or whose read fails, waits for the next tick; the writes of what was
  // read are then all made before this returns, so no row is finalized ahead of its settlement.
  async settleInserts(seen) {
    await Promise.all(this.partitions(seen).map(async (part) => {
      const rows = part.rows.map((r) => seen.rowOf.get(r.alloc) ?? r);
      if (part.api.name === 'gce' && part.api.reconcileLaunches) {
        const settled = await part.api.reconcileLaunches(rows);
        await Promise.all([...settled].map(([alloc, result]) => this.settleInsert(seen, alloc, result)));
      } else for (const row of rows.filter((r) => r.state === 'launching')) {
        const inst = part.instances.find((i) => i.alloc === row.alloc);
        if (inst) { const next = runningRow(row, inst); if (await this.write(next)) seen.rowOf.set(row.alloc, next); continue; }
        const result = await part.api.reconcileLaunch(row);
        if (result.outcome === 'uncertain' || result.outcome === 'accepted') continue; // accepted is recorded from inventory
        const next = finalRow(row, { end: result.outcome === 'abandoned' ? 'abandoned' : 'refused', deleted: this.now(), diskGb: this.cfg.disk_gb });
        if (await this.write(next)) {
          seen.rowOf.set(row.alloc, next);
          const runner = this.runnerOf(seen, row.repo, row.instance);
          if (runner && !runner.busy) await this.gh.deleteRunner(row.repo, runner.id).catch((err) => this.log(`unregister ${row.instance}: ${err.message}`));
        }
      }
    }));
  }

  async settleInsert(seen, alloc, result) {
    const row = seen.rowOf.get(alloc) ?? seen.rows.find((r) => r.alloc === alloc);
    const insert = unsettledInsert(row);
    if (!insert || result.outcome === 'uncertain') return;
    const zone = insert.zone;
    const { outcome, error } = gceWalkResult(result);
    const metric = quotaMetric(error);
    const refused = outcome === 'capacity' || outcome === 'quota' ? [...(row.refused ?? []), { kind: outcome, zone, ...(metric ? { metric } : {}) }] : row.refused;
    let next = { ...row, ...(refused ? { refused } : {}), slow: row.slow.map((s) => (s === insert ? { ...s, outcome, done: result.done } : s)) };
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
    const actions = reviewInstances({ instances: seen.instances.filter((i) => i.provider === 'gce' || this.known(seen, i)), runnersOf, reports: seen.reports, served, now: this.now(), cfg: this.cfg });
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
    const base = runningRow(had ?? launchRow({ alloc: v.alloc, repo: repo ?? v.repoLabel, cpus: v.cpus, at: v.created, config: v.config ?? '-', egress: v.egress, provider: v.provider, account: v.account ?? this.cfg.project, reserved: v.vcpus }), v);
    const job = had?.job ?? (await this.jobOf(seen, base));
    let end = a.end;
    if (had?.state === 'deleting') end = had.end;
    else if (!had) end = 'orphan';
    else if (job && end === 'cancelled-idle') end = 'done';
    const deleting = finalRow(base, { end, deleted: this.now(), job, diskGb: this.cfg.disk_gb, egress: this.cfg.egress, state: 'deleting' });
    if (!(await this.write(deleting, { dedupe: !had }))) return; // no row, no delete: the next tick tries again
    seen.rowOf.set(v.alloc, deleting);
    try {
      await this.providerOf(v).terminate(v);
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
    for (const part of this.partitions(seen)) await this.settleProviderRows(part, out);
  }

  async settleProviderRows(seen, out) {
    const pending = seen.rows.filter((r) => r.state !== 'final' && !(r.provider === 'ec2' && r.state === 'launching' && !seen.instances.some((i) => i.alloc === r.alloc)));
    const live = new Set(seen.instances.map((i) => i.alloc));
    let preempted = new Map();
    if (seen.complete && pending.some((r) => r.state !== 'deleting' && !live.has(r.alloc))) preempted = (seen.api.preemptions ? await seen.api.preemptions() : new Map());
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
      if (a.action === 'final' && a.row.zone && (await seen.api.stillThere?.(a.row))) continue;
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

  async cleanRunners(seen, out) {
    const names = new Set(seen.instances.map((i) => i.name));
    for (const [repo, runners] of seen.runners) {
      for (const r of orphanRunners({ runners: [...runners.values()].filter((r) => {
        const row = [...seen.rowOf.values()].find((row) => row?.instance === r.name);
        if (row) return this.known(seen, row) && !(row.provider === 'ec2' && row.state === 'launching');
        const provider = r.name.startsWith('ci-kit-ec2-') ? 'ec2' : 'gce';
        const matching = [...seen.inventories].filter(([key]) => JSON.parse(key)[0] === provider);
        return matching.length > 0 && matching.every(([, i]) => i.complete);
      }), instanceNames: names, now: this.now(), complete: seen.complete })) {
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
    for (const part of this.partitions(seen)) out.deleted.push(...await part.api.cleanupOrphans(part, this.ledger));
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

  async launchAll(seen, out, deadline, preparation) {
    this.reportNeverOnline(seen);
    const plan = planLaunches({
      queued: seen.queued, instances: seen.instances, runners: seen.demand, now: this.now(), cfg: this.cfg, complete: seen.complete, claimed: seen.claimed,
      rows: seen.rows, unknown: seen.unknown, admission: false,
    });
    for (const job of plan.unservable) this.log(`job ${job.id} in ${job.repo} cannot run on GCE: labels ${job.labels.join(',')}`);
    out.waiting = plan.waiting.length;
    const prelaunches = (inflight) => (!seen.complete ? [] : planPrelaunches({
      runs: seen.runs, jobs: seen.jobs, rows: seen.rows, runners: seen.demand, inflight, waiting: plan.waiting.length, cfg: this.cfg, admission: false,
    }));
    const ahead = prelaunches(plan.inflight);
    if (plan.launches.length + ahead.length === 0) return;
    const rooms = new Map();
    await Promise.all([...seen.inventories].map(async ([key, inventory]) => {
      const wait = this.after(LIMITS_WAIT_MS);
      const room = await preparation.time('limits.wait', () => Promise.race([inventory.room ?? null, wait.promise.then(() => null)]));
      wait.cancel();
      rooms.set(key, room);
    }));
    let open;
    const ctx = {
      seen, deadline, out, rooms, preparation, admission: createAdmission(seen, this.cfg), races: [], blocked: new Set(),
      untried: new Set(plan.launches), firstTried: new Promise((resolve) => { open = resolve; }),
    };
    ctx.root = ctx;
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
      const later = prelaunches(ctx.admission.total());
      await this.launchQueue(later, ctx);
    }
    while (ctx.races.length) await Promise.all(ctx.races.splice(0));
    for (const room of rooms.values()) if (room) for (const [key, value] of Object.entries(room.skipped())) out.full[key] = (out.full[key] ?? 0) + value;
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
        if (!result.name) { if (item.job) ctx.out.waiting += 1; continue; }
        made += 1;
        ctx.out.launched.push(result.name);
        if (result.prelaunch) ctx.out.prelaunched.push(result.name);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_LAUNCHES, queue.length) }, worker));
    ctx.out.cut += queue.length; // never started: the deadline came first
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
    const walk = providerWalk({ ...item, cfg: this.cfg, repoProviders: this.repoProviders, providers: this.providers, ec2: this.ec2, creditPreference: this.creditPreference });
    if (walk.unlisted) {
      const key = `unservable:${item.repo}:${item.job.id}`;
      if (!this.providerState.has(key)) { this.log(`unservable: ${item.repo} lists no ${walk.unlisted}`); this.providerState.set(key, true); }
      return {};
    }
    const groups = item.groups ?? walk.groups;
    let budgetBlocked = false;
    for (let index = 0; index < groups.length; index += 1) {
      if (this.now() >= ctx.deadline) break;
      const group = groups[index];
      const key = providerKey(group);
      if (!this.known(ctx.seen, group)) continue;
      const state = this.providerState.get(key) ?? {};
      if (state.deniedUntil > this.now() || ctx.blocked?.has(key)) continue;
      const room = ctx.rooms.get(key);
      const attempts = group.candidates.filter((p) => !quotaBlocks(ctx.seen.quota, p) && !this.stockouts.has(p, this.now()) && (!room || room.fits(p)));
      if (!attempts.length) {
        for (const p of group.candidates) room?.skip(p);
        this.log(`${item.job ? `job ${item.job.id}` : `run ${item.prelaunch.run}`} in ${item.repo} waits: every placement for its size is full, out of quota this tick, or recently stocked out on ${key}`);
        continue;
      }
      const image = await ctx.preparation.time('images.wait', () => ctx.seen.images.get(key));
      if (!image) { this.log(`no ready image in family ${this.cfg.image_family}; demand in ${item.repo} waits on ${key}`); continue; }
      const alloc = this.newAllocation(ctx.seen);
      const reserved = ctx.admission.acquire(alloc, item.repo, { ...group, candidates: attempts });
      if (reserved === null) { budgetBlocked = true; continue; }
      // The first admitted allocation identifies a speculative demand, including every later fallback and race.
      if (item.prelaunch && !item.prelaunch.group) item.prelaunch = { ...item.prelaunch, group: alloc };
      const result = await this.launchAllocation({ ...item, admissionItem: item.admissionItem ?? item, alloc, reserved, attempts }, { ...ctx, image, room, group, remaining: groups.slice(index + 1) });
      if (result.name || result.held || result.raced) return result;
    }
    // Cleanup runs beside launches. Only demands declined by a budget wait for it, then retry admission once:
    // a row finalized in this tick releases both debits without delaying the first launches that already fit.
    if (budgetBlocked && !item.afterCleanup) {
      await ctx.seen.cleaning;
      return this.launch({ ...item, admissionItem: item.admissionItem ?? item, afterCleanup: true }, ctx);
    }
    return {};
  }

  newAllocation(seen) {
    let alloc;
    do { alloc = allocationId(this.now(), this.random); } while (seen.rowOf.has(alloc));
    seen.rowOf.set(alloc, null);
    return alloc;
  }

  async launchAllocation(item, ctx) {
    const { repo, cpus, job, prelaunch, race } = item;
    const { seen, deadline, out, image, preparation } = ctx;
    const purpose = job ? `job ${job.id}` : `run ${prelaunch.run}'s cpus-${cpus} pre-launch`;
    const what = race ? `the race of ${seen.rowOf.get(race.of)?.instance ?? race.of} for ${purpose}` : purpose;
    const attempts = item.attempts;
    const { group } = ctx;
    const api = group.api;
    const at = this.now();
    const alloc = item.alloc;
    const name = providerRunnerName(group.provider, alloc);
    const reserved = item.reserved;
    let row = launchRow({ alloc, repo, cpus, at, config: this.config, egress: this.cfg.egress, prelaunch, race, reserved,
      provider: group.provider, account: group.account, image: image.id, image_commit: image.manifest['ci-kit-commit'], credit_policy: group.creditPolicy });
    // Acquire happened synchronously before entering this function. Do not release a reservation after an
    // ambiguous ledger failure: its row may have landed, and a later tick must count the same allocation once.
    seen.rowOf.set(alloc, row);
    await preparation.time('ledger.launching', () => this.ledger.upsert(row), { repo, instance: name });
    let jit;
    try {
      jit = await preparation.time('github.jitConfig', () => this.gh.jitConfig(repo, jitRequest(alloc, cpus, group.provider)), { repo, instance: name });
    } catch (err) {
      this.log(`jit for ${what} in ${repo} (${name}): ${err.message}`);
      const final = finalRow(row, { end: 'abandoned', deleted: this.now(), diskGb: this.cfg.disk_gb, egress: this.cfg.egress });
      if (await this.write(final)) { seen.rowOf.set(alloc, final); ctx.admission.release(alloc); }
      return { held: seen.rowOf.get(alloc).state !== 'final' };
    }
    // The tick's deadline stops new attempts; an attempt already started waits for its operation up to its own
    // deadline, since giving up early saves nothing (the operation runs on) and only defers what it decides. An
    // operation that outlives that wait is uncertain, reconciled now, and if still unsettled left for the next tick.
    // An insert still unsettled RACE_AFTER_MS after it was sent may start this allocation's one race (raceSlowInsert);
    // once it has, the walk makes no further attempt. Only a definite outcome settles an insert: one whose wait ended
    // before its operation did (unknown, and still running when reconciled) stays pending, and the launch waits, within
    // the tick, for its race to be decided (unsettled).
    let raced = false;
    let acceptedId;
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
        if (group.provider === 'ec2') {
          row = { ...row, zone: p.zone, client_token: `${alloc}-${attempts.indexOf(p) + 1}`, sent_at: iso(sent) };
          await this.ledger.upsert(row);
          seen.rowOf.set(alloc, row);
        }
        const insert = api.launch(row, p, jit.encoded_jit_config).then((result) => {
          if (result.outcome === 'denied') {
            const key = providerKey(group);
            this.providerState.set(key, { ...this.providerState.get(key), deniedUntil: this.now() + 10 * 60_000 });
            this.error(`denied ${key}: ${result.detail}`);
          }
          if (result.outcome === 'throttled') ctx.blocked.add(providerKey(group));
          if (result.outcome === 'accepted') acceptedId = result.id;
          if (result.outcome !== 'accepted') throw Object.assign(result.error ?? new Error(result.detail), { launchResult: result });
        });
        ctx.tried(item.admissionItem ?? item);
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
        const settled = gceWalkResult(await api.reconcileLaunch({ ...row, zone: p.zone, operation: err?.operation }));
        if (settled.outcome !== 'unknown') unsettled?.settle();
        return settled;
      },
      now: this.now, deadline, quota: seen.quota, stockouts: this.stockouts, raced: () => raced, room: ctx.room,
    });
    if (result.stop === 'deadline') out.cut += 1;
    if (unsettled) {
      // Its race is decided by the tick's deadline at the latest; a race that cannot start yet (a queued job not yet
      // tried) is given up rather than holding this launch's place while that job waits for one.
      if (result.stop === 'unknown') {
        const left = this.after(Math.max(0, deadline - this.now()));
        await Promise.race([unsettled.decision, left.promise, unsettled.fired.then(() => (ctx.root.opened ? NEVER : undefined))]);
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
      if (race) this.log(`raced ${name} (${p.machine}, ${p.provisioning}, ${p.zone}) against ${seen.rowOf.get(race.of)?.instance ?? race.of} for ${purpose} in ${repo}${after}`);
      else if (job) this.log(`launched ${name} (${p.machine}, ${p.provisioning}, ${p.zone}) for job ${job.id} in ${repo}${after}`);
      else this.log(`pre-launched ${name} (${p.machine}, ${p.provisioning}, ${p.zone}) for run ${prelaunch.run} (${prelaunch.workflow}) in ${repo}${after}`);
      const running = runningRow(walked, { ...p, id: acceptedId, diskType: p.disk?.type ?? p.placement?.disk_type, created: this.now() });
      if (await this.write(running)) seen.rowOf.set(alloc, running);
      seen.launches.push(running);
      this.log(`placed ${name} ${group.provider}/${group.account} for ${purpose} in ${repo}`);
      return { name, prelaunch: Boolean(prelaunch) && !race };
    }
    if (result.stop === 'unknown') {
      // The row keeps the insert that never settled: until a later tick learns its end (settleInserts), the allocation
      // keeps its vCPUs and covers its job (planLaunches), since its VM may still appear.
      this.log(`${name}: insert outcome unknown (${tried}); the next ticks settle it`);
      if (await this.write(walked)) seen.rowOf.set(alloc, walked);
      seen.launches.push(walked);
      return { held: true };
    }
    if (raced) this.log(`${name}: not created (${tried}); its race serves ${what}`);
    else this.log(`${name}: not created (${result.stop}: ${tried}); ${what} waits`);
    await this.gh.deleteRunner(repo, jit.runner.id).catch((err) => {
      if (err.status !== 404) this.log(`unregister ${name}: ${err.message}; the orphan-runner rule retries`);
    });
    const abandoned = finalRow(walked, { end: result.stop === 'exhausted' || result.stop === 'failed' ? 'refused' : 'abandoned', deleted: this.now(), diskGb: this.cfg.disk_gb, egress: this.cfg.egress });
    if (await this.write(abandoned)) { seen.rowOf.set(alloc, abandoned); ctx.admission.release(alloc); }
    seen.launches.push(abandoned);
    return { held: seen.rowOf.get(alloc).state !== 'final', raced };
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
    const next = raceAttempts(attempts, attempt).filter((p) => !quotaBlocks(ctx.seen.quota, p) && !this.stockouts.has(p, this.now()) && (!ctx.room || ctx.room.fits(p)));
    const groups = [...(next.length ? [{ ...ctx.group, candidates: next }] : []), ...ctx.remaining];
    const unsettled = `${name}: its insert in ${attempt.zone} is unsettled after ${RACE_AFTER_MS / 1000} s`;
    if (!groups.length || this.now() >= ctx.deadline) {
      this.log(`${unsettled}; no race (${!groups.length ? 'no other zone left to try' : 'the tick\'s budget is spent'})`);
      return;
    }
    const pending = { ...row, slow: [{ zone: attempt.zone, outcome: 'unknown', sent: iso(sent) }] };
    const marked = hold(async () => { const written = await this.write(pending); if (written) ctx.seen.rowOf.set(row.alloc, pending); return written; });
    if (!(await marked) || !stillPending()) { this.log(`${unsettled}; no race (its pending insert could not be written or settled meanwhile)`); return; }
    start();
    const demand = item.job ? { job: item.job.id } : { run: item.prelaunch.run, attempt: item.prelaunch.attempt };
    const racing = { repo: item.repo, cpus: item.cpus, job: item.job, prelaunch: item.prelaunch, race: { of: row.alloc, demand }, groups };

    ctx.races.push(this.launch(racing, ctx).then((r) => {
      if (!r.name) { this.log(`${unsettled}; no race (no placement admitted or accepted)`); return; }
      ctx.out.launched.push(r.name);
      ctx.out.raced.push(`${r.name} for ${name}`);
    }, (err) => this.log(`race of ${name}: ${err.message}`)));
  }

  // ── the daily line ─────────────────────────────────────────────────────────────────────────────────────────────

  async daily(seen) {
    const now = this.now();
    const into = now % (24 * 3600_000);
    if (into < DAILY_AFTER_MS || into >= DAILY_WITHIN_MS) return;
    const yesterday = day(now - 24 * 3600_000);
    try {
      if (this.ledger.hasDaily(yesterday)) return;
      const nat = await this.provider.natOf?.(yesterday);
      if (await this.ledger.postDaily(dailyLine([...seen.rowOf.values()].filter(Boolean), yesterday, this.config, nat))) this.log(`ledger: daily line for ${yesterday}`);
    } catch (err) {
      this.log(`daily line: ${err.message}`);
    }
  }
}

