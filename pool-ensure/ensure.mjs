#!/usr/bin/env node
// The ensure action's step: wakes the Hetzner pool box for a calling repo the pool serves, and writes `result`.
// Which backend serves the repo comes from the kit's main (pool.json and gce.json), and from the copies bundled with
// this version only when main cannot be reached (spec §3a, I12): a repo moved between backends on main is honoured
// before `v1` moves. A caller the Hetzner pool does not serve needs no Hetzner token.
// Needs only Node (no packages), so any runner with `node` can run it.
import { readFile, appendFile } from 'node:fs/promises';
import { createHcloud } from '../lib/hcloud.mjs';
import { parsePoolConfig } from '../pool/lib/config.mjs';
import { ensureForCaller } from '../pool/lib/ensure.mjs';

const MAIN = 'https://raw.githubusercontent.com/SSFSKIM/ci-kit/main/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One file's two copies. Main's is fetched once and shared by the membership and the operational reads.
const source = (path) => {
  let main;
  return {
    fetchMain: () => (main ??= (async () => {
      const res = await fetch(MAIN + path, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw Object.assign(new Error(`GET ${path}: ${res.status}`), { status: res.status });
      return res.text();
    })()),
    readBundled: async () => {
      try {
        return await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
  };
};

try {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('ci-kit: ensure needs GITHUB_REPOSITORY, the calling repo');
  const result = await ensureForCaller({
    repo,
    token: process.env.HCLOUD_TOKEN,
    pool: source('pool/config/pool.json'),
    gce: source('pool/config/gce.json'),
    parsePool: parsePoolConfig,
    createHcloud,
    opts: {
      sleep,
      log: (m) => console.log(m),
      warn: (m) => console.log(`::warning::${m.replaceAll('%', '%25')}`),
    },
  });
  console.log(`ci-kit pool: ${result}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `result=${result}\n`);
} catch (err) {
  console.log(`::error::${String(err.message).replaceAll('%', '%25')}`);
  process.exit(1);
}
