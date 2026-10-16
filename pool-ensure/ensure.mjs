#!/usr/bin/env node
// The ensure action's step: wakes the Hetzner pool box for a calling repo the pool serves, and writes `result`.
// Which backend serves the repo comes from the kit's main (pool.json and gce.json), falling back to the copies
// bundled with this version (spec §3a, I12): a repo moved between backends on main is honoured before `v1` moves.
// Needs only Node (no packages), so any runner with `node` can run it.
import { readFile, appendFile } from 'node:fs/promises';
import { createHcloud } from '../lib/hcloud.mjs';
import { parsePoolConfig } from '../pool/lib/config.mjs';
import { ensure, backendOf, kitConfig } from '../pool/lib/ensure.mjs';

const MAIN = 'https://raw.githubusercontent.com/SSFSKIM/ci-kit/main/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const source = (path) => ({
  fetchMain: async () => {
    const res = await fetch(MAIN + path, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    return res.text();
  },
  readBundled: () => readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
});
// Only gce.json's repo list matters here; its full schema is the launcher's (I12).
const gceRepos = (text) => {
  const repos = JSON.parse(text).repos;
  if (!Array.isArray(repos)) throw new Error('gce.json: repos must be a list');
  return repos.map((r) => r.repo);
};

async function setResult(result) {
  console.log(`ci-kit pool: ${result}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `result=${result}\n`);
}

try {
  if (!process.env.HCLOUD_TOKEN?.trim()) throw new Error('ci-kit: the pool needs the HCLOUD_TOKEN secret (pool-ensure input hcloud-token)');
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('ci-kit: ensure needs GITHUB_REPOSITORY, the calling repo');
  const cfg = await kitConfig(parsePoolConfig, source('pool/config/pool.json'));
  if (!cfg) throw new Error('ci-kit: the pool config could not be read from the kit\'s main or its bundled copy');
  const backend = backendOf(repo, cfg.repos.map((r) => r.repo), (await kitConfig(gceRepos, source('pool/config/gce.json'))) ?? []);
  if (backend !== 'hetzner') {
    // Not a Hetzner pool repo: no box is created or stamped for it (spec §3a, Moving a repo between backends).
    await setResult(backend);
  } else {
    await setResult(await ensure(createHcloud(process.env.HCLOUD_TOKEN.trim()), cfg, {
      sleep,
      log: (m) => console.log(m),
      warn: (m) => console.log(`::warning::${m.replaceAll('%', '%25')}`),
    }));
  }
} catch (err) {
  console.log(`::error::${String(err.message).replaceAll('%', '%25')}`);
  process.exit(1);
}
