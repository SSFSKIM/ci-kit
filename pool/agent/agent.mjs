#!/usr/bin/env node
// The pool agent (spec §3 Pool agent): a systemd service on the pool box. Every poll it reads GitHub (queued pool
// jobs, watched runs, its runners) and Docker (its job containers), starts a container with a fresh JIT runner for
// each unit of demand that fits, retires containers past their deadlines, and deletes the box when it is idle at
// minute ≥ 50 of its billed hour. Its state is memory plus the server's labels; a restart rebuilds it.
// Decisions are in logic.mjs; this file observes and acts. A failed observation skips the tick (no crash), and only
// a fully successful tick advances the heartbeat.
import { readFile, mkdir, rm, chown, utimes, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { createGitHub } from '../../lib/github.mjs';
import { createAppTokens } from '../../lib/github-app.mjs';
import { createHcloud, serverLocation, serverPriceHourly } from '../../lib/hcloud.mjs';
import { parsePoolConfig } from '../lib/config.mjs';
import { createLedgerStore } from '../lib/ledger-store.mjs';
import { makeRow } from '../lib/ledger.mjs';
import {
  planStarts, reviewContainers, isIdle, watchedRuns, queuedPoolJobs, lifecycleAction, billedMinute, heartbeatDue,
  runnerName, nextCounter,
} from './logic.mjs';
import { listContainers, startContainer, removeContainer, workDir } from './docker.mjs';

const ETC = process.env.CI_KIT_ETC ?? '/etc/ci-kit';
const LAST_SUCCESS = '/var/lib/ci-kit/last-success';
const CONFIG_URL = 'https://raw.githubusercontent.com/SSFSKIM/ci-kit/main/pool/config/pool.json';
const KIT = 'SSFSKIM/ci-kit';
const SCHEDULED = ['pool-guard.yml', 'pool-bake.yml'];
const CONFIG_EVERY = 5 * 60_000;
const RUNNER_UID = 1001; // the actions-runner image's `runner` user
const METADATA = 'http://169.254.169.254/hetzner/v1/metadata';

const sh = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const fetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.text();
};

async function loadConfig(fallback) {
  try {
    return parsePoolConfig(await fetchText(CONFIG_URL));
  } catch (err) {
    log(`config: keeping the last good copy (${err.message})`);
    return fallback;
  }
}

// The host drops container traffic to the metadata address, so job code cannot read the box's user-data.
async function blockMetadata() {
  const rule = ['DOCKER-USER', '-d', '169.254.169.254', '-j', 'DROP'];
  try {
    await sh('iptables', ['-C', ...rule]);
  } catch {
    await sh('iptables', ['-I', ...rule]);
  }
}

async function touch(path) {
  const now = new Date();
  try {
    await utimes(path, now, now);
  } catch {
    await (await open(path, 'a')).close();
  }
}

class Agent {
  constructor({ cfg, gh, hc, serverId }) {
    Object.assign(this, { cfg, gh, hc, serverId });
    this.memory = new Map();
    this.lastBeat = null;
    this.reported = new Set();
    this.served = [];
  }

  async start() {
    const server = await this.hc.server(this.serverId);
    this.server = server;
    this.created = Date.parse(server.created);
    this.labels = { ...server.labels };
    this.totalCores = os.cpus().length;
    log(`server ${this.serverId} (${server.server_type.name}@${serverLocation(server)}), ${this.totalCores} cores, created ${server.created}`);
    await blockMetadata();
    await this.refreshServed();
    // Rebuild the runner counter from what already exists (a restarted agent).
    const containers = await listContainers();
    const names = [...containers.map((c) => c.name)];
    for (const { repo } of this.served) {
      try {
        names.push(...(await this.gh.runners(repo)).map((r) => r.name));
      } catch (err) {
        log(`runners of ${repo}: ${err.message}`);
      }
    }
    this.counter = nextCounter(this.serverId, { label: this.labels['ci-kit-jobs'], names });
    if (this.labels['ci-kit-state'] !== 'draining') this.labels['ci-kit-state'] = 'ready';
    await this.writeLabels();
    log(`state ${this.labels['ci-kit-state']}; next runner ${runnerName(this.serverId, this.counter)}`);
    await this.reenableSchedules();
    await this.finalizeGoneRows();
  }

  // Served repos from the config, minus any the API says is public (spec §3 Public repos).
  async refreshServed() {
    const served = [];
    const unread = [];
    for (const entry of this.cfg.repos) {
      try {
        const repo = await this.gh.getRepo(entry.repo);
        if (repo.private !== true) {
          log(`refusing ${entry.repo}: it is public, and the pool serves private repos only`);
          continue;
        }
        served.push(entry);
      } catch (err) {
        // Unknown visibility is not served; observe() retries, and fails the tick while it stays unknown.
        log(`not serving ${entry.repo} yet: its visibility could not be read (${err.message})`);
        unread.push(entry.repo);
      }
    }
    this.served = served;
    this.unread = unread;
    this.configAt = Date.now();
  }

  async reenableSchedules() {
    for (const file of SCHEDULED) {
      try {
        await this.gh.enableWorkflow(KIT, file);
        log(`enabled ${KIT} ${file}`);
      } catch (err) {
        log(`enable ${KIT} ${file}: ${err.message}`);
      }
    }
  }

  // Rows left `deleting` by an earlier box whose server is now gone are finalized (spec M5 Decisions, Ledger rows).
  async finalizeGoneRows() {
    try {
      const store = createLedgerStore(this.gh, this.cfg.ledger);
      for (const row of await store.rows()) {
        if (row.state !== 'deleting' || row.server === this.serverId) continue;
        try {
          await this.hc.server(row.server);
        } catch (err) {
          if (err.status !== 404) throw err;
          await store.upsertRow({ ...row, state: 'final' });
          log(`ledger: finalized the row of server ${row.server}`);
        }
      }
    } catch (err) {
      log(`ledger: could not finalize earlier rows (${err.message})`);
    }
  }

  async writeLabels() {
    await this.hc.setLabels(this.serverId, this.labels);
  }

  async observe() {
    // A repo that could not be read is a failed listing: the heartbeat must not advance (spec §3 Heartbeat).
    if (this.unread.length) await this.refreshServed();
    if (this.unread.length) throw new Error(`cannot read ${this.unread.join(', ')}`);
    const containers = await listContainers();
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

  async tick() {
    if (Date.now() - this.configAt >= CONFIG_EVERY) {
      this.cfg = await loadConfig(this.cfg);
      await this.refreshServed();
    }
    let seen;
    try {
      seen = await this.observe();
    } catch (err) {
      log(`tick skipped: ${err.message}`);
      return;
    }
    const now = Date.now();

    const review = reviewContainers({ containers: seen.containers, runners: seen.runners, memory: this.memory, now, cfg: this.cfg });
    this.memory = review.memory;
    const retired = new Set();
    for (const a of review.actions) {
      if (a.unregister) await this.gh.deleteRunner(a.container.repo, a.container.runnerId).catch((err) => log(`unregister ${a.container.name}: ${err.message}`));
      try {
        await removeContainer(a.container.name);
        await rm(workDir(a.container.name), { recursive: true, force: true });
        retired.add(a.container.name);
        log(`${a.kind} ${a.container.name} (${a.reason})`);
      } catch (err) {
        log(`${a.kind} ${a.container.name}: ${err.message}`);
      }
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
      if (!this.reported.has(job.id)) log(`job ${job.id} in ${job.repo} cannot run here: ${reason}`);
      this.reported.add(job.id);
    }
    let started = 0;
    if (this.labels['ci-kit-state'] !== 'draining') {
      for (const { job, cores } of plan.starts) {
        if (await this.startJob(job, cores)) started += 1;
      }
    }

    const idle = started === 0 && isIdle({ containers: live, queued: seen.queued, watched: seen.watched });
    const action = lifecycleAction({ state: this.labels['ci-kit-state'], idle, minute: billedMinute(this.created, now), drainMinute: this.cfg.drain_minute });
    if (action === 'drain' || action === 'undrain' || action === 'ready') {
      this.labels['ci-kit-state'] = action === 'drain' ? 'draining' : 'ready';
      log(`state → ${this.labels['ci-kit-state']}`);
      await this.writeLabels().catch((err) => log(`labels: ${err.message}`));
    } else if (action === 'delete') {
      await this.deleteSelf();
      return;
    }

    if (heartbeatDue({ tickOk: true, lastBeat: this.lastBeat, now })) {
      this.lastBeat = now;
      await touch(LAST_SUCCESS).catch((err) => log(`last-success: ${err.message}`));
      this.labels['ci-kit-heartbeat'] = String(Math.floor(now / 1000));
      this.labels['ci-kit-jobs'] = String(this.counter - 1);
      await this.writeLabels().catch((err) => log(`heartbeat: ${err.message}`));
    }
  }

  async startJob(job, cores) {
    const name = runnerName(this.serverId, this.counter);
    this.counter += 1;
    let jit;
    try {
      jit = await this.gh.jitConfig(job.repo, { name, labels: job.labels, work_folder: workDir(name) });
    } catch (err) {
      log(`jit for job ${job.id} (${name}): ${err.message}`);
      return false;
    }
    try {
      await mkdir(workDir(name), { recursive: true });
      await chown(workDir(name), RUNNER_UID, RUNNER_UID);
      await startContainer({ name, repo: job.repo, runnerId: jit.runner.id, labels: job.labels, cores, memoryGbPerCpu: this.cfg.memory_gb_per_cpu }, jit.encoded_jit_config);
      log(`started ${name} for job ${job.id} in ${job.repo} (${job.labels.join(',')}) on cores ${cores.join(',')}`);
      return true;
    } catch (err) {
      log(`start ${name}: ${err.message}`);
      await this.gh.deleteRunner(job.repo, jit.runner.id).catch(() => {});
      await removeContainer(name).catch(() => {});
      return false;
    }
  }

  // The ledger row goes first, marked deleting (I9); without it the box stays up and the next tick retries.
  async deleteSelf() {
    const server = await this.hc.server(this.serverId);
    const row = makeRow(
      { id: this.serverId, created: server.created, type: server.server_type.name, location: serverLocation(server), price: serverPriceHourly(server), jobs: this.counter - 1 },
      { deleted: Date.now(), end: 'idle', state: 'deleting' },
    );
    try {
      await createLedgerStore(this.gh, this.cfg.ledger).upsertRow(row);
    } catch (err) {
      log(`ledger row before delete failed (${err.message}); staying up`);
      return;
    }
    log(`idle at minute ${billedMinute(this.created, Date.now())}: deleting server ${this.serverId}`);
    await this.hc.deleteServer(this.serverId);
    this.deleted = true;
  }
}

async function main() {
  const [appId, pem, token, serverId, baked] = await Promise.all([
    readFile(`${ETC}/app_id`, 'utf8'),
    readFile(`${ETC}/app.pem`, 'utf8'),
    readFile(`${ETC}/hcloud_token`, 'utf8'),
    fetchText(`${METADATA}/instance-id`),
    readFile(`${ETC}/pool.json`, 'utf8'),
  ]);
  let cfg = parsePoolConfig(baked);
  cfg = await loadConfig(cfg);
  const gh = createGitHub(createAppTokens({ appId: appId.trim(), pem, owner: 'SSFSKIM' }));
  const hc = createHcloud(token.trim());
  const agent = new Agent({ cfg, gh, hc, serverId: Number(serverId.trim()) });
  for (;;) {
    try {
      await agent.start();
      break;
    } catch (err) {
      log(`start failed, retrying in ${cfg.poll_seconds} s: ${err.message}`);
      await sleep(cfg.poll_seconds * 1000);
    }
  }
  while (!agent.deleted) {
    const began = Date.now();
    try {
      await agent.tick();
    } catch (err) {
      log(`tick failed: ${err.stack ?? err.message}`);
    }
    await sleep(Math.max(1000, agent.cfg.poll_seconds * 1000 - (Date.now() - began)));
  }
  log('server deleted; waiting for shutdown');
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`agent: ${err.stack ?? err.message}`);
  process.exit(1);
});
