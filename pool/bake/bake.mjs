#!/usr/bin/env node
// The bake (spec §3 Bake), run by .github/workflows/pool-bake.yml. No inbound network or ssh: the builder does its
// work through cloud-init, marks the result on its own labels and powers off; this script snapshots it.
//   node pool/bake/bake.mjs bake      create builder → wait for off (≤ 30 min) → snapshot → delete builder → prune
//   node pool/bake/bake.mjs cleanup   delete this run's builders and unfinished snapshots (runs on every exit)
// Env: HCLOUD_TOKEN, CI_KIT_APP_ID, CI_KIT_APP_KEY, GITHUB_SHA (the kit commit baked), GITHUB_RUN_ID.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHcloud, waitAction } from '../../lib/hcloud.mjs';
import { createGitHub } from '../../lib/github.mjs';
import { createAppTokens } from '../../lib/github-app.mjs';
import { parsePoolConfig } from '../lib/config.mjs';
import { createAlerts } from '../lib/alerts.mjs';
import { bakeLeftovers, ownsBuilder, snapshotsToPrune, builderUserData, createBuilder, BakeBlockedError, BUILDER_TYPES } from './plan.mjs';

const BUILDER = { types: BUILDER_TYPES, locations: ['hel1', 'fsn1', 'nbg1'] };
const OFF_TIMEOUT = 30 * 60_000;
const KEEP = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const env = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`ci-kit: ${name} is not set`);
  return v;
};

// A bake kept from starting (a pool box up, or the core limit) fails loudly: an alert issue, besides the red run.
async function alertBlocked(message, runId) {
  try {
    const cfg = parsePoolConfig(await readFile(new URL('../config/pool.json', import.meta.url), 'utf8'));
    const gh = createGitHub(createAppTokens({ appId: env('CI_KIT_APP_ID').trim(), pem: env('CI_KIT_APP_KEY'), owner: 'SSFSKIM' }));
    await createAlerts(gh, cfg.ledger.repo, { log })({
      title: 'ci-kit alert: the bake could not create its builder',
      body: `${message}. Bake run ${runId} (https://github.com/SSFSKIM/ci-kit/actions/runs/${runId}) created no builder; the previous pool snapshots stay in use. The project's core limit leaves no room for a builder while a pool box is up (docs/pool.md); dispatch the bake again when the pool is idle.`,
    });
  } catch (err) {
    log(`alert not opened: ${err.message}`);
  }
}

async function bake(hc) {
  const sha = env('GITHUB_SHA');
  const runId = env('GITHUB_RUN_ID');
  const template = await readFile(new URL('./builder.sh', import.meta.url), 'utf8');
  const userData = builderUserData(template, { sha, runId, appId: env('CI_KIT_APP_ID'), appKey: env('CI_KIT_APP_KEY'), hcloudToken: env('HCLOUD_TOKEN') });
  let builder;
  try {
    builder = await createBuilder(hc, { userData, runId, builder: BUILDER, sleep, log });
  } catch (err) {
    if (err instanceof BakeBlockedError) await alertBlocked(err.message, runId);
    throw err;
  }

  await snapshotBuilder(hc, builder, { sha, runId, sleep, log });
}

// The fresh server behind a builder, or a failed bake when it is no longer this run's: the bake waits long enough
// for an operator to relabel the machine to keep it for debugging, and a relabelled machine is left as it is.
async function ownedBuilder(hc, id, runId) {
  const s = await hc.server(id);
  if (!ownsBuilder(s, runId)) {
    throw new Error(`ci-kit: server ${id} is no longer this bake's builder (labels ${JSON.stringify(s.labels ?? {})}); left untouched`);
  }
  return s;
}

// Wait for the builder to power off, snapshot it, delete it, prune. Ownership is revalidated on every fetch and
// immediately before the snapshot and the delete, so nothing here acts on a server the bake no longer owns.
export async function snapshotBuilder(hc, builder, { sha, runId, sleep, log, now = Date.now }) {
  const start = now();
  let s;
  for (;;) {
    await sleep(15_000);
    s = await ownedBuilder(hc, builder.id, runId);
    if (s.status === 'off' && now() - start > 60_000) break;
    if (now() - start > OFF_TIMEOUT) throw new Error(`ci-kit: builder ${builder.id} did not power off within 30 min`);
  }
  const mark = s.labels['ci-kit-bake'];
  log(`builder off after ${Math.round((now() - start) / 1000)} s, marked ${mark ?? '(nothing)'}; caches warmed: ${s.labels['ci-kit-warm'] ?? 'unknown'}; peak memory + swap ${s.labels['ci-kit-mem-peak'] ?? '?'} MB`);
  if (mark !== 'ok') throw new Error(`ci-kit: the builder did not finish (${mark ?? 'no mark: it failed before it could label itself'})`);

  await ownedBuilder(hc, builder.id, runId);
  const { image, action } = await hc.createImage(builder.id, {
    type: 'snapshot',
    description: `ci-kit pool image ${sha.slice(0, 8)}`,
    labels: { 'ci-kit': 'pool-image', 'ci-kit-commit': sha, 'ci-kit-run': String(runId) },
  });
  await waitAction(hc, action.id, { sleep, timeoutMs: 30 * 60_000, interval: 10_000 });
  const made = await hc.image(image.id);
  log(`snapshot ${made.id}: ${made.status}, ${made.image_size} GB compressed, disk ${made.disk_size} GB`);
  await ownedBuilder(hc, builder.id, runId);
  await hc.deleteServer(builder.id);
  log(`builder ${builder.id} deleted`);

  for (const old of snapshotsToPrune(await hc.images('ci-kit=pool-image'), KEEP)) {
    await hc.deleteImage(old.id);
    log(`pruned snapshot ${old.id} (${old.labels['ci-kit-commit']?.slice(0, 8)}, ${old.created})`);
  }
}

// A builder or snapshot mid-snapshot is `locked`; cleanup waits that out (at most 10 min) rather than leaving it.
async function untilUnlocked(fn) {
  const start = Date.now();
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err.code !== 'locked' || Date.now() - start > 10 * 60_000) throw err;
      await sleep(15_000);
    }
  }
}

// Deletes this run's builders and unfinished snapshots, and nothing else (selected by plan.mjs bakeLeftovers).
export async function cleanup(hc, runId, { log: say = log } = {}) {
  const log = say;
  const left = bakeLeftovers({ servers: await hc.servers('ci-kit=builder'), images: await hc.images('ci-kit=pool-image'), runId });
  for (const s of left.servers) {
    await untilUnlocked(() => hc.deleteServer(s.id));
    log(`cleanup: deleted builder ${s.id}`);
  }
  for (const i of left.images) {
    await untilUnlocked(() => hc.deleteImage(i.id));
    log(`cleanup: deleted unfinished snapshot ${i.id} (${i.status})`);
  }
  if (!left.servers.length && !left.images.length) log('cleanup: nothing left behind');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  const hc = createHcloud(process.env.HCLOUD_TOKEN?.trim());
  const run = { bake, cleanup: (h) => cleanup(h, env('GITHUB_RUN_ID')) }[command];
  if (!run) {
    console.error('usage: bake.mjs bake|cleanup');
    process.exit(2);
  }
  run(hc).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
