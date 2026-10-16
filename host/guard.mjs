#!/usr/bin/env node
// The pool's guard as the mini runs it: the LaunchAgent com.ssfskim.ci-kit.guard runs this every 10 minutes
// (host/guard-install.sh), beside GitHub's schedule for pool-guard.yml, which fired once in 6 hours (spec Decision
// Log). It is pool/guard.mjs's cycle with its credentials read from files rather than the environment:
//
//   ~/.config/ci-kit/hcloud_token   the Hetzner token (required)
//   ~/.config/ci-kit/app_id         the GitHub App's id      } both or neither; without them only the Hetzner
//   ~/.config/ci-kit/app.pem        the GitHub App's key     } half runs
//
// Every file must be 0600 (no access for group or others). CI_KIT_CONFIG_DIR replaces the directory.
//
// Without the App's files it runs the Hetzner half alone: it deletes a pool box whose heartbeat is stale or that
// has been up 24 h, and a bake builder older than 2 h, exactly as guardPlan decides, but it writes no ledger row and
// opens no alert, and it cannot see queued jobs to wake a box for. Stopping a box that bills without limit comes
// first; the next guard that has GitHub finalizes a vanished box's row from its last sighting.
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHcloud, waitAction } from '../lib/hcloud.mjs';
import { createGitHub } from '../lib/github.mjs';
import { createAppTokens } from '../lib/github-app.mjs';
import { parsePoolConfig } from '../pool/lib/config.mjs';
import { guardPlan } from '../pool/lib/guard.mjs';
import { runGuard } from '../pool/guard.mjs';

async function secretFile(dir, name) {
  const path = join(dir, name);
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const mode = info.mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
  return (await readFile(path, 'utf8')).trim();
}

export async function loadCredentials(dir) {
  const hcloudToken = await secretFile(dir, 'hcloud_token');
  if (!hcloudToken) throw new Error(`no Hetzner token at ${join(dir, 'hcloud_token')}`);
  const [appId, pem] = [await secretFile(dir, 'app_id'), await secretFile(dir, 'app.pem')];
  if (Boolean(appId) !== Boolean(pem)) throw new Error(appId ? `app_id without app.pem in ${dir}` : `app.pem without app_id in ${dir}`);
  return { hcloudToken, app: appId ? { appId, pem: `${pem}\n` } : null };
}

// The Hetzner half of a guard cycle: guardPlan's deletes, with no GitHub input (no queued jobs, no ledger rows, no
// summary due) and no GitHub output. Returns the number of actions that failed, after trying them all.
export async function runHetznerOnly({ hc, cfg, now = Date.now, sleep, log = console.log, error = console.error }) {
  const servers = await hc.servers('ci-kit');
  const at = now();
  const actions = guardPlan({ now: at, servers, queued: [], rows: [], summaryAt: at, cfg }).filter(
    (a) => a.kind === 'delete' || a.kind === 'delete-builder',
  );
  log(`guard (Hetzner only): ${servers.length} labelled servers; ${actions.length} actions`);
  let failed = 0;
  for (const a of actions) {
    try {
      const action = await hc.deleteServer(a.server.id);
      if (a.kind === 'delete') {
        await waitAction(hc, action.id, { sleep });
        log(`no GitHub credentials: deleted pool server ${a.server.id} (${a.end}) with no ledger row and no alert`);
      } else {
        log(`deleted builder ${a.server.id}`);
      }
    } catch (err) {
      failed += 1;
      error(`guard: ${a.kind} failed: ${err.message}`);
    }
  }
  return failed;
}

async function main() {
  const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const log = (...a) => console.log(stamp(), ...a);
  const error = (m) => console.error(stamp(), m);
  const dir = process.env.CI_KIT_CONFIG_DIR ?? join(homedir(), '.config', 'ci-kit');
  const { hcloudToken, app } = await loadCredentials(dir);
  const cfg = parsePoolConfig(await readFile(new URL('../pool/config/pool.json', import.meta.url), 'utf8'));
  const hc = createHcloud(hcloudToken);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let failed;
  if (app) {
    const gh = createGitHub(createAppTokens({ appId: app.appId, pem: app.pem, owner: 'SSFSKIM' }));
    failed = await runGuard({ hc, gh, cfg, log, error });
  } else {
    failed = await runHetznerOnly({ hc, cfg, sleep, log, error });
  }
  if (failed) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(new Date().toISOString(), `guard: ${err.message}`);
    process.exit(1);
  });
}
