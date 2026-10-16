// The pool agent's reconciler (spec §3 Pool agent): what one agent does at start and on every tick, with every
// outside effect injected so the orchestration is testable. agent.mjs wires it to the real GitHub, Hetzner, Docker
// and filesystem. The decisions themselves are in logic.mjs; this file observes, decides through logic.mjs, and acts.
// A failed observation skips the tick (no crash), and only a fully successful tick advances the heartbeat.
import { serverLocation, serverPriceHourly } from '../../lib/hcloud.mjs';
import { createLedgerStore } from '../lib/ledger-store.mjs';
import { makeRow } from '../lib/ledger.mjs';
import { createAlerts } from '../lib/alerts.mjs';
import {
  planStarts, reviewContainers, isIdle, watchedRuns, queuedPoolJobs, lifecycleAction, billedMinute, heartbeatDue,
  runnerName, nextCounter,
} from './logic.mjs';

const KIT = 'SSFSKIM/ci-kit';
const SCHEDULED = ['pool-guard.yml', 'pool-bake.yml'];
const CONFIG_EVERY = 5 * 60_000;

export class NotAPoolBox extends Error {}

// Only a server carrying ci-kit=pool is the agent's to label or delete (the project holds other work's servers).
function assertPoolBox(server, serverId) {
  if (server?.labels?.['ci-kit'] !== 'pool') {
    throw new NotAPoolBox(`ci-kit: server ${serverId} does not carry ci-kit=pool; this agent will not label or delete it`);
  }
}

// deps: {cfg, gh, hc, serverId, totalCores, docker: {list, start, remove}, work: {make, remove}, touchLastSuccess,
//        blockMetadata, loadConfig, now, log}
export class Agent {
  constructor(deps) {
    Object.assign(this, deps);
    this.now ??= Date.now;
    this.log ??= () => {};
    this.memory = new Map();
    this.lastBeat = null;
    this.reported = new Set();
    this.served = [];
    this.unread = [];
  }

  ledger() {
    return createLedgerStore(this.gh, this.cfg.ledger);
  }

  session(server, jobs = this.counter - 1) {
    return { id: this.serverId, created: server.created, type: server.server_type.name, location: serverLocation(server), price: serverPriceHourly(server), jobs };
  }

  async start() {
    const server = await this.hc.server(this.serverId);
    assertPoolBox(server, this.serverId);
    this.server = server;
    this.created = Date.parse(server.created);
    this.labels = { ...server.labels };
    this.log(`server ${this.serverId} (${server.server_type.name}@${serverLocation(server)}), ${this.totalCores} cores, created ${server.created}`);
    await this.blockMetadata();
    await this.refreshServed();
    // Rebuild the runner counter from what already exists (a restarted agent).
    const names = (await this.docker.list()).map((c) => c.name);
    for (const { repo } of this.served) {
      try {
        names.push(...(await this.gh.runners(repo)).map((r) => r.name));
      } catch (err) {
        this.log(`runners of ${repo}: ${err.message}`);
      }
    }
    this.counter = nextCounter(this.serverId, { label: this.labels['ci-kit-jobs'], names });
    if (this.labels['ci-kit-state'] !== 'draining') this.labels['ci-kit-state'] = 'ready';
    await this.writeLabels();
    this.log(`state ${this.labels['ci-kit-state']}; next runner ${runnerName(this.serverId, this.counter)}`);
    await this.reenableSchedules();
    await this.ledgerAtBoot(server);
    await this.alertFallback(server);
  }

  // Served repos from the config, minus any the API says is public (spec §3 Public repos).
  async refreshServed() {
    const served = [];
    const unread = [];
    for (const entry of this.cfg.repos) {
      try {
        const repo = await this.gh.getRepo(entry.repo);
        if (repo.private !== true) {
          this.log(`refusing ${entry.repo}: it is public, and the pool serves private repos only`);
          continue;
        }
        served.push(entry);
      } catch (err) {
        // Unknown visibility is not served; observe() retries, and fails the tick while it stays unknown.
        this.log(`not serving ${entry.repo} yet: its visibility could not be read (${err.message})`);
        unread.push(entry.repo);
      }
    }
    this.served = served;
    this.unread = unread;
    this.configAt = this.now();
  }

  async reenableSchedules() {
    for (const file of SCHEDULED) {
      try {
        await this.gh.enableWorkflow(KIT, file);
        this.log(`enabled ${KIT} ${file}`);
      } catch (err) {
        this.log(`enable ${KIT} ${file}: ${err.message}`);
      }
    }
  }

  // This session's provisional `running` row, so a deleter always has a row to finalize (spec Decision Log, ledger
  // coverage); and rows an earlier box left `deleting` whose server is now gone, finalized.
  async ledgerAtBoot(server) {
    try {
      const store = this.ledger();
      await store.upsertRow(makeRow(this.session(server), { state: 'running', at: this.now() }));
      for (const row of await store.rows()) {
        if (row.state !== 'deleting' || row.server === this.serverId) continue;
        try {
          await this.hc.server(row.server);
        } catch (err) {
          if (err.status !== 404) throw err;
          await store.upsertRow({ ...row, state: 'final' });
          this.log(`ledger: finalized the row of server ${row.server}`);
        }
      }
    } catch (err) {
      this.log(`ledger at boot: ${err.message}`);
    }
  }

  // A box ensure made smaller because of the project's core limit says so in an alert (spec Decision Log).
  async alertFallback(server) {
    if (this.labels['ci-kit-fallback'] !== 'core-limit') return;
    try {
      await createAlerts(this.gh, this.cfg.ledger.repo, { log: this.log })({
        title: `ci-kit alert: pool server ${this.serverId} is a smaller ${server.server_type.name} (core limit)`,
        body: `The Hetzner project's core limit refused the preferred pool types, so ensure created ${server.server_type.name} ` +
          `(${this.totalCores} cores) in ${serverLocation(server)}. A gate asking for more cores runs on all ${this.totalCores}, ` +
          'and its log says it was clamped. Raising the project limit removes the fallback (docs/pool.md).',
      });
    } catch (err) {
      this.log(`alert for the fallback box: ${err.message}`);
    }
  }

  async writeLabels() {
    await this.hc.setLabels(this.serverId, this.labels);
  }

  async observe() {
    // A repo that could not be read is a failed listing: the heartbeat must not advance (spec §3 Heartbeat).
    if (this.unread.length) await this.refreshServed();
    if (this.unread.length) throw new Error(`cannot read ${this.unread.join(', ')}`);
    const containers = await this.docker.list();
    const runners = new Map();
    const queued = [];
    const watched = [];
    for (const { repo, workflows } of this.served) {
      // Runners first: a job taken between the two reads then shows as not queued, never as double demand.
      const mine = (await this.gh.runners(repo)).filter((r) => r.name.startsWith('ci-kit-pool-'));
      runners.set(repo, new Map(mine.map((r) => [r.id, r])));
      const runs = [...(await this.gh.runsByStatus(repo, 'queued')), ...(await this.gh.runsByStatus(repo, 'in_progress'))];
      watched.push(...watchedRuns(runs, workflows));
      for (const run of runs) {
        queued.push(...queuedPoolJobs(await this.gh.listJobs(repo, run.id)).map((j) => ({ ...j, repo })));
      }
    }
    return { containers, runners, queued, watched };
  }

  // An idle runner is retired only once GitHub has let go of it: unregistered, or already gone (404). If the
  // unregister fails (the runner may have just taken a job, which GitHub refuses with 422, or the call failed),
  // its container stays, and the next tick looks again.
  async retire(a) {
    if (a.unregister) {
      try {
        await this.gh.deleteRunner(a.container.repo, a.container.runnerId);
      } catch (err) {
        if (a.reason === 'idle-runner' && err.status !== 404) {
          this.log(`kept ${a.container.name}: its runner could not be unregistered (${err.message}); looking again next tick`);
          return false;
        }
        if (err.status !== 404) this.log(`unregister ${a.container.name}: ${err.message}`);
      }
    }
    try {
      await this.docker.remove(a.container.name);
      await this.work.remove(a.container.name);
      this.log(`${a.kind} ${a.container.name} (${a.reason})`);
      return true;
    } catch (err) {
      this.log(`${a.kind} ${a.container.name}: ${err.message}`);
      return false;
    }
  }

  async tick() {
    if (this.now() - this.configAt >= CONFIG_EVERY) {
      this.cfg = await this.loadConfig(this.cfg);
      await this.refreshServed();
    }
    let seen;
    try {
      seen = await this.observe();
    } catch (err) {
      this.log(`tick skipped: ${err.message}`);
      return;
    }
    const now = this.now();

    const review = reviewContainers({ containers: seen.containers, runners: seen.runners, memory: this.memory, now, cfg: this.cfg });
    this.memory = review.memory;
    const retired = new Set();
    for (const a of review.actions) {
      if (await this.retire(a)) retired.add(a.container.name);
    }
    const live = seen.containers.filter((c) => c.running && !retired.has(c.name));

    const idleRunners = live
      .filter((c) => {
        const r = seen.runners.get(c.repo)?.get(c.runnerId);
        return r && !r.busy;
      })
      .map((c) => ({ repo: c.repo, labels: c.labels }));
    const plan = planStarts({ queued: seen.queued, idleRunners, totalCores: this.totalCores, usedCores: new Set(live.flatMap((c) => c.cores)) });
    for (const { job, reason } of plan.unservable) {
      if (!this.reported.has(job.id)) this.log(`job ${job.id} in ${job.repo} cannot run here: ${reason}`);
      this.reported.add(job.id);
    }
    let started = 0;
    if (this.labels['ci-kit-state'] !== 'draining') {
      for (const start of plan.starts) {
        if (await this.startJob(start)) started += 1;
      }
    }

    const idle = started === 0 && isIdle({ containers: live, queued: seen.queued, watched: seen.watched });
    const action = lifecycleAction({ state: this.labels['ci-kit-state'], idle, minute: billedMinute(this.created, now), drainMinute: this.cfg.drain_minute });
    if (action === 'drain' || action === 'undrain' || action === 'ready') {
      this.labels['ci-kit-state'] = action === 'drain' ? 'draining' : 'ready';
      this.log(`state → ${this.labels['ci-kit-state']}`);
      await this.writeLabels().catch((err) => this.log(`labels: ${err.message}`));
    } else if (action === 'delete') {
      await this.deleteSelf();
      return;
    }

    if (heartbeatDue({ tickOk: true, lastBeat: this.lastBeat, now })) {
      this.lastBeat = now;
      await this.touchLastSuccess().catch((err) => this.log(`last-success: ${err.message}`));
      this.labels['ci-kit-heartbeat'] = String(Math.floor(now / 1000));
      this.labels['ci-kit-jobs'] = String(this.counter - 1);
      await this.writeLabels().catch((err) => this.log(`heartbeat: ${err.message}`));
    }
  }

  async startJob({ job, cores, clamped }) {
    const name = runnerName(this.serverId, this.counter);
    this.counter += 1;
    let jit;
    try {
      jit = await this.gh.jitConfig(job.repo, { name, labels: job.labels, work_folder: this.work.dir(name) });
    } catch (err) {
      this.log(`jit for job ${job.id} (${name}): ${err.message}`);
      return false;
    }
    try {
      await this.work.make(name);
      await this.docker.start(
        { name, repo: job.repo, runnerId: jit.runner.id, labels: job.labels, cores, clamped, memoryGbPerCpu: this.cfg.memory_gb_per_cpu },
        jit.encoded_jit_config,
      );
      this.log(`started ${name} for job ${job.id} in ${job.repo} (${job.labels.join(',')}) on cores ${cores.join(',')}${clamped ? ` (asked for ${clamped}: clamped)` : ''}`);
      return true;
    } catch (err) {
      this.log(`start ${name}: ${err.message}`);
      await this.gh.deleteRunner(job.repo, jit.runner.id).catch(() => {});
      await this.docker.remove(name).catch(() => {});
      return false;
    }
  }

  // Ownership is checked again on the server as it is now, then the ledger row goes first, marked deleting (I9);
  // without the row the box stays up and the next tick retries.
  async deleteSelf() {
    const server = await this.hc.server(this.serverId);
    assertPoolBox(server, this.serverId);
    const row = makeRow(this.session(server), { deleted: this.now(), end: 'idle', state: 'deleting' });
    try {
      await this.ledger().upsertRow(row);
    } catch (err) {
      this.log(`ledger row before delete failed (${err.message}); staying up`);
      return;
    }
    this.log(`idle at minute ${billedMinute(this.created, this.now())}: deleting server ${this.serverId}`);
    await this.hc.deleteServer(this.serverId);
    this.deleted = true;
  }
}
