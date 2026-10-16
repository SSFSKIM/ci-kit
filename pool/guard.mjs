#!/usr/bin/env node
// The guard (spec §3 Guard), run by .github/workflows/pool-guard.yml every 10 minutes. It gathers the pool's state,
// asks guardPlan what to do, and does it: wake a box for stranded jobs, delete a box with a dead agent or past
// 24 h, reap old bake builders, finalize ledger rows, alert, and post the weekly cost summary.
// Env: HCLOUD_TOKEN, CI_KIT_APP_ID, CI_KIT_APP_KEY. Exits 1 when any action failed, after trying them all.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHcloud, serverLocation, serverPriceHourly, waitAction } from '../lib/hcloud.mjs';
import { createGitHub } from '../lib/github.mjs';
import { createAppTokens } from '../lib/github-app.mjs';
import { parsePoolConfig } from './lib/config.mjs';
import { createLedgerStore } from './lib/ledger-store.mjs';
import { makeRow, weeklySummary, rowsOf, lastSummaryAt } from './lib/ledger.mjs';
import { guardPlan } from './lib/guard.mjs';
import { ensure } from './lib/ensure.mjs';
import { queuedPoolJobs } from './agent/logic.mjs';
import { createAlerts } from './lib/alerts.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const sessionOf = (server) => ({
  id: server.id, created: server.created, type: server.server_type?.name ?? '?', location: serverLocation(server) ?? '?',
  price: serverPriceHourly(server), jobs: server.labels['ci-kit-jobs'] === undefined ? null : Number(server.labels['ci-kit-jobs']),
});

async function queuedJobs(gh, cfg) {
  const queued = [];
  for (const { repo } of cfg.repos) {
    const runs = [...(await gh.runsByStatus(repo, 'queued')), ...(await gh.runsByStatus(repo, 'in_progress'))];
    for (const run of runs) queued.push(...queuedPoolJobs(await gh.listJobs(repo, run.id)).map((j) => ({ ...j, repo })));
  }
  return queued;
}

// One guard cycle against the given clients. Returns the number of actions that failed.
export async function runGuard({ hc, gh, cfg, now: clock = Date.now, sleep: wait = sleep, log: say = log, error = (m) => console.error(m) }) {
  const log = say;
  const sleep = wait;
  const ledger = createLedgerStore(gh, cfg.ledger);
  const alertsRepo = cfg.ledger.repo;

  const [servers, queued, comments] = await Promise.all([hc.servers('ci-kit'), queuedJobs(gh, cfg), ledger.comments()]);
  const rows = rowsOf(comments);
  const now = clock();
  const actions = guardPlan({ now, servers, queued, rows, summaryAt: lastSummaryAt(comments), cfg });
  log(`guard: ${servers.length} labelled servers, ${queued.length} queued pool jobs, ${rows.length} ledger rows; ${actions.length} actions`);

  const alert = createAlerts(gh, alertsRepo, { log });

  // Row first (deleting), then the delete, then the row finalized once the delete action has finished (I9).
  async function deletePoolServer(server, end) {
    const session = sessionOf(server);
    const deleted = clock();
    await ledger.upsertRow(makeRow(session, { deleted, end, state: 'deleting' }));
    const action = await hc.deleteServer(server.id);
    await waitAction(hc, action.id, { sleep });
    await ledger.upsertRow(makeRow(session, { deleted, end, state: 'final' }));
    log(`deleted pool server ${server.id} (${end})`);
  }

  let failed = 0;
  for (const a of actions) {
    try {
      if (a.kind === 'delete') {
        await deletePoolServer(a.server, a.end);
        await alert(a.alert);
      } else if (a.kind === 'delete-builder') {
        await hc.deleteServer(a.server.id);
        log(`deleted builder ${a.server.id}`);
        await alert(a.alert);
      } else if (a.kind === 'finalize') {
        await ledger.upsertRow(a.row);
        log(`finalized the ledger row of server ${a.row.server} (${a.row.end})`);
      } else if (a.kind === 'record') {
        await ledger.upsertRow(makeRow(sessionOf(a.server), { state: 'running', at: clock() }));
      } else if (a.kind === 'alert') {
        await alert(a);
      } else if (a.kind === 'ensure') {
        log(`wake: ${a.reason}`);
        log(`ensure: ${await ensure(hc, cfg, { sleep, log })}`);
      } else if (a.kind === 'summary') {
        const s = weeklySummary(rows, now);
        await ledger.postSummary(s);
        log(`weekly summary: ${JSON.stringify(s)}`);
      }
    } catch (err) {
      failed += 1;
      error(`guard: ${a.kind} failed: ${err.message}`);
    }
  }
  return failed;
}

async function main() {
  const cfg = parsePoolConfig(await readFile(new URL('./config/pool.json', import.meta.url), 'utf8'));
  const hc = createHcloud(process.env.HCLOUD_TOKEN?.trim());
  const gh = createGitHub(createAppTokens({ appId: process.env.CI_KIT_APP_ID?.trim(), pem: process.env.CI_KIT_APP_KEY, owner: 'SSFSKIM' }));
  if (await runGuard({ hc, gh, cfg })) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`guard: ${err.stack ?? err.message}`);
    process.exit(1);
  });
}
