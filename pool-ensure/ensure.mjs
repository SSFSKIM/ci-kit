#!/usr/bin/env node
// The ensure action's step: runs ensure with the kit's pool config (types and locations) and writes `result`.
// Needs only Node (no packages), so any runner with `node` can run it.
import { readFile, appendFile } from 'node:fs/promises';
import { createHcloud } from '../lib/hcloud.mjs';
import { parsePoolConfig } from '../pool/lib/config.mjs';
import { ensure } from '../pool/lib/ensure.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  if (!process.env.HCLOUD_TOKEN?.trim()) throw new Error('ci-kit: the pool needs the HCLOUD_TOKEN secret (pool-ensure input hcloud-token)');
  const cfg = parsePoolConfig(await readFile(new URL('../pool/config/pool.json', import.meta.url), 'utf8'));
  const result = await ensure(createHcloud(process.env.HCLOUD_TOKEN.trim()), cfg, {
    sleep,
    log: (m) => console.log(m),
    warn: (m) => console.log(`::warning::${m.replaceAll('%', '%25')}`),
  });
  console.log(`ci-kit pool: ${result}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `result=${result}\n`);
} catch (err) {
  console.log(`::error::${String(err.message).replaceAll('%', '%25')}`);
  process.exit(1);
}
