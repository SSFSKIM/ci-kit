#!/usr/bin/env node
// The guard (spec §3 Guard), run by .github/workflows/pool-guard.yml every 10 minutes. It gathers the pool's state,
// asks guardPlan what to do, and does it: wake a box for stranded jobs, delete a box with a dead agent or past
// 24 h, reap old bake builders, finalize ledger rows, alert, and post the weekly cost summary.
// Env: HCLOUD_TOKEN, CI_KIT_APP_ID, CI_KIT_APP_KEY. Exits 1 when any action failed, after trying them all.
import { readFile } from 'node:fs/promises';
import { createHcloud, serverLocation, serverPriceHourly, waitAction } from '../lib/hcloud.mjs';
import { createGitHub } from '../lib/github.mjs';
import { createAppTokens } from '../lib/github-app.mjs';
import { parsePoolConfig } from './lib/config.mjs';
import { createLedgerStore } from './lib/ledger-store.mjs';
import { makeRow, weeklySummary, rowsOf, lastSummaryAt } from './lib/ledger.mjs';
import { guardPlan } from './lib/guard.mjs';
import { ensure } from './lib/ensure.mjs';
import { queuedPoolJobs } from './agent/logic.mjs';

const ALERT_LABEL = 'ci-kit-alert';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function queuedJobs(gh, cfg) {
  const queued = [];
  for (const { repo } of cfg.repos) {
    const runs = [...(await gh.runsByStatus(repo, 'queued')), ...(await gh.runsByStatus(repo, 'in_progress'))];
    for (const run of runs) queued.push(...queuedPoolJobs(await gh.listJobs(repo, run.id)).map((j) => ({ ...j, repo })));
  }
  return queued;
}

async function main() {
  const cfg = parsePoolConfig(await readFile(new URL('./config/pool.json', import.meta.url), 'utf8'));
  const hc = createHcloud(process.env.HCLOUD_TOKEN?.trim());
  const gh = createGitHub(createAppTokens({ appId: process.env.CI_KIT_APP_ID?.trim(), pem: process.env.CI_KIT_APP_KEY, owner: 'SSFSKIM' }));
  const ledger = createLedgerStore(gh, cfg.ledger);
  const alertsRepo = cfg.ledger.repo;

  const [servers, queued, comments] = await Promise.all([hc.servers('ci-kit'), queuedJobs(gh, cfg), ledger.comments()]);
  const rows = rowsOf(comments);
  const now = Date.now();
  const actions = guardPlan({ now, servers, queued, rows, summaryAt: lastSummaryAt(comments), cfg });
  log(`guard: ${servers.length} labelled servers, ${queued.length} queued pool jobs, ${rows.length} ledger rows; ${actions.length} actions`);

  let openAlerts = null;
  async function alert({ title, body }) {
    openAlerts ??= (await gh.openIssues(alertsRepo, ALERT_LABEL)).filter((i) => !i.pull_request).map((i) => i.title);
    if (openAlerts.includes(title)) return log(`alert already open: ${title}`);
    await gh.ensureLabel(alertsRepo, ALERT_LABEL, 'd73a4a');
    await gh.createIssue(alertsRepo, { title, body, labels: [ALERT_LABEL] });
    openAlerts.push(title);
    log(`alert opened: ${title}`);
  }

  // Row first (deleting), then the delete, then the row finalized once the delete action has finished (I9).
  async function deletePoolServer(server, end) {
    const session = {
      id: server.id, created: server.created, type: server.server_type?.name ?? '?', location: serverLocation(server) ?? '?',
      price: serverPriceHourly(server), jobs: server.labels['ci-kit-jobs'] === undefined ? null : Number(server.labels['ci-kit-jobs']),
    };
    const deleted = Date.now();
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
        await ledger.upsertRow({ ...a.row, state: 'final' });
        log(`finalized the ledger row of server ${a.row.server}`);
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
      console.error(`guard: ${a.kind} failed: ${err.message}`);
    }
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(`guard: ${err.stack ?? err.message}`);
  process.exit(1);
});
