#!/usr/bin/env node
// The pool agent (spec §3 Pool agent): a systemd service on the pool box. Every poll it reads GitHub (queued pool
// jobs, watched runs, its runners) and Docker (its job containers), starts a container with a fresh JIT runner for
// each unit of demand that fits, retires containers past their deadlines, and deletes the box when it is idle at
// minute ≥ 50 of its billed hour. Its state is memory plus the server's labels; a restart rebuilds it.
// The reconciler (reconciler.mjs) does the work; this file wires it to the box. On a server that does not carry
// ci-kit=pool it exits 78, which its unit does not restart.
import { readFile, mkdir, rm, chown, utimes, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { createGitHub } from '../../lib/github.mjs';
import { createAppTokens } from '../../lib/github-app.mjs';
import { createHcloud } from '../../lib/hcloud.mjs';
import { parsePoolConfig } from '../lib/config.mjs';
import { Agent, NotAPoolBox } from './reconciler.mjs';
import { listContainers, startContainer, removeContainer, workDir } from './docker.mjs';

const ETC = process.env.CI_KIT_ETC ?? '/etc/ci-kit';
const LAST_SUCCESS = '/var/lib/ci-kit/last-success';
const CONFIG_URL = 'https://raw.githubusercontent.com/SSFSKIM/ci-kit/main/pool/config/pool.json';
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
  const agent = new Agent({
    cfg, gh, hc,
    serverId: Number(serverId.trim()),
    totalCores: os.cpus().length,
    docker: { list: listContainers, start: startContainer, remove: removeContainer },
    work: {
      dir: workDir,
      make: async (name) => {
        await mkdir(workDir(name), { recursive: true });
        await chown(workDir(name), RUNNER_UID, RUNNER_UID);
      },
      remove: (name) => rm(workDir(name), { recursive: true, force: true }),
    },
    touchLastSuccess: () => touch(LAST_SUCCESS),
    blockMetadata,
    loadConfig,
    log,
  });
  for (;;) {
    try {
      await agent.start();
      break;
    } catch (err) {
      if (err instanceof NotAPoolBox) {
        console.error(err.message);
        process.exit(78);
      }
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
