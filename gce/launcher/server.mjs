#!/usr/bin/env node
// The Cloud Run service ci-kit-launcher (spec §3a The launcher, I12; 2026-10-21 M4): no public ingress, and every
// caller is checked by Cloud Run against the service's invokers before this code runs.
//   POST /tick     Cloud Scheduler's ci-kit-launcher-tick, every minute, with an OIDC token: answered with the outcome
//                  of the tick that serves it. A tick that cannot read Compute Engine or the ledger answers 500, which
//                  Cloud Scheduler logs as a failed execution and the Monitoring alert counts.
//   POST /request  the Pub/Sub push subscription ci-kit-tick-requests-launcher, one message per job queued in a
//                  served repo (gce/webhook): answered when the tick that serves it has ended, so the request keeps the
//                  instance's CPU allocated (request-based billing) for that tick's whole run.
// Both are the same full tick (launcher.mjs), run one at a time with at most one pending (ticker.mjs).
// It runs as ci-kit-launcher@: Compute Engine through the metadata server's token, the App's id and key from Secret
// Manager, and the configs from the kit's main (source.mjs). Clients live as long as the instance, so their ETags
// and installation token carry from tick to tick.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createGce, accessToken } from '../../lib/gce.mjs';
import { createGitHub } from '../../lib/github.mjs';
import { createAppTokens } from '../../lib/github-app.mjs';
import { createConfigSource } from './source.mjs';
import { createGceLedger } from './ledger-store.mjs';
import { Launcher } from './launcher.mjs';
import { createTicker } from './ticker.mjs';
import { createHandler } from './routes.mjs';

const bundled = (name) => readFile(new URL(`../../pool/config/${name}`, import.meta.url), 'utf8');
const say = (severity, message, extra = {}) => console.log(JSON.stringify({ severity, message, ...extra }));
const log = (message) => say('INFO', message);
const LOW_BUDGET = 0.2; // requested ticks stop while the App's remaining GitHub budget is under this share

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.text();
}

let setup = null;
let github = null; // the App's client once set up: its budget gates requested ticks
async function deps() {
  const { project } = JSON.parse(await bundled('gce.json'));
  const gce = createGce({ project, token: accessToken() });
  const [appId, pem] = await Promise.all([gce.secret('ci-kit-app-id'), gce.secret('ci-kit-app-key')]);
  const gh = createGitHub(createAppTokens({ appId: appId.trim(), pem, owner: 'SSFSKIM' }));
  const source = createConfigSource({ gh, fetchText, readBundled: bundled, bundledCommit: process.env.CI_KIT_COMMIT || 'bundled', log });
  github = gh;
  return { gce, gh, source, ledgers: new Map() };
}

async function reconcile() {
  const d = await (setup ??= deps().catch((err) => {
    setup = null;
    throw err;
  }));
  const { cfg, config, poolRepos } = await d.source();
  const key = `${cfg.ledger.repo}#${cfg.ledger.issue_title}`;
  if (!d.ledgers.has(key)) d.ledgers.set(key, createGceLedger(d.gh, cfg.ledger, { log }));
  const launcher = new Launcher({ gce: d.gce, gh: d.gh, ledger: d.ledgers.get(key), cfg, config, poolRepos, log });
  return { config: config.slice(0, 8), repos: cfg.repos.map((r) => r.repo), ...(await launcher.tick()), github: d.gh.stats() };
}

// One tick, logged once whoever asked for it. `started` and the launcher's `firstInsert` time the tick's own share of
// a job's wait (gce/latency-report.mjs); `trigger` and `requests` say what it served.
async function tick({ trigger, requests }) {
  const began = Date.now();
  const served = { trigger, requests, started: new Date(began).toISOString() };
  try {
    const out = await reconcile();
    const ahead = out.prelaunched.length ? ` (${out.prelaunched.length} pre-launched)` : '';
    say('INFO', `tick: ${out.launched.length} launched${ahead}, ${out.deleted.length} deleted, ${out.finalized.length} finalized`,
      { ...out, ...served, ms: Date.now() - began });
    return out;
  } catch (err) {
    say('ERROR', `tick failed: ${err.stack ?? err.message}`, { ...served, ms: Date.now() - began });
    throw err;
  }
}

function budgetLow() {
  const { remaining, limit } = github?.stats() ?? {};
  const low = remaining != null && limit != null && remaining < LOW_BUDGET * limit;
  if (low) say('WARNING', `requested tick dropped: GitHub budget ${remaining}/${limit}, under ${LOW_BUDGET * 100}%; the minute tick serves`);
  return low;
}

http.createServer(createHandler({ serve: createTicker({ tick, budgetLow }), say }))
  .listen(Number(process.env.PORT) || 8080, () => log(`ci-kit-launcher listening, kit ${(process.env.CI_KIT_COMMIT || 'bundled').slice(0, 8)}`));
