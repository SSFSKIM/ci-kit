#!/usr/bin/env node
// The Cloud Run service ci-kit-launcher (spec §3a The launcher, I12): Cloud Scheduler's ci-kit-launcher-tick POSTs
// here every minute with an OIDC token (Cloud Run checks it; the service has no public ingress), and each request is
// one reconciliation (launcher.mjs). A tick that cannot read Compute Engine or the ledger answers 500, which Cloud
// Scheduler logs as a failed execution and the Monitoring alert counts.
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

const bundled = (name) => readFile(new URL(`../../pool/config/${name}`, import.meta.url), 'utf8');
const say = (severity, message, extra = {}) => console.log(JSON.stringify({ severity, message, ...extra }));
const log = (message) => say('INFO', message);

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.text();
}

let setup = null;
async function deps() {
  const { project } = JSON.parse(await bundled('gce.json'));
  const gce = createGce({ project, token: accessToken() });
  const [appId, pem] = await Promise.all([gce.secret('ci-kit-app-id'), gce.secret('ci-kit-app-key')]);
  const gh = createGitHub(createAppTokens({ appId: appId.trim(), pem, owner: 'SSFSKIM' }));
  const source = createConfigSource({ gh, fetchText, readBundled: bundled, bundledCommit: process.env.CI_KIT_COMMIT || 'bundled', log });
  return { gce, gh, source, ledgers: new Map() };
}

async function tick() {
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

let running = false;
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  if (running) {
    // Concurrency is 1, so this is a second request reaching a busy instance: the running tick covers it.
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"skipped":"a tick is running"}\n');
    return;
  }
  running = true;
  const began = Date.now();
  try {
    const out = await tick();
    // `started` and the launcher's `firstInsert` time the tick's own share of a job's wait (gce/latency-report.mjs).
    say('INFO', `tick: ${out.launched.length} launched, ${out.deleted.length} deleted, ${out.finalized.length} finalized`,
      { ...out, started: new Date(began).toISOString(), ms: Date.now() - began });
    res.writeHead(200, { 'content-type': 'application/json' }).end(`${JSON.stringify(out)}\n`);
  } catch (err) {
    say('ERROR', `tick failed: ${err.stack ?? err.message}`, { ms: Date.now() - began });
    res.writeHead(500, { 'content-type': 'application/json' }).end(`${JSON.stringify({ error: err.message })}\n`);
  } finally {
    running = false;
  }
});

server.listen(Number(process.env.PORT) || 8080, () => log(`ci-kit-launcher listening, kit ${(process.env.CI_KIT_COMMIT || 'bundled').slice(0, 8)}`));
