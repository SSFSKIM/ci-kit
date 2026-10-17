#!/usr/bin/env node
// Warms the pool image's caches on a bake's builder, on either backend (spec §3 Caches, §3a Image): for MAWS,
// `pnpm fetch` against its lockfile, and the Playwright browsers and Electron binary at the versions its lockfile
// pins. The lockfile is read with the installation token in CI_KIT_GH_TOKEN (MAWS contents, read: WARM_SCOPE); this
// script never sees an App key. Each step is best effort; what happened goes to /var/lib/ci-kit/cache/warm.json,
// and the exit status is non-zero when any step failed.
// The record is written to the cache directory, so a job on the pool can read it too.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createGitHub } from '../../lib/github.mjs';
import { CACHE, CACHE_ENV } from '../agent/docker.mjs';

const sh = promisify(execFile);
const MAWS = 'SSFSKIM/MAWS';
const FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'];
const env = { ...process.env, ...CACHE_ENV, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', CI: 'true' };
const results = {};

// What the warming token needs, and all a builder's token is given. (The GCE bake's real job has a token of its own,
// scoped to ci-kit-sandbox, which never reaches a VM: gce/bake/plan.mjs CHECK_SCOPE.)
export const WARM_SCOPE = { repositories: ['MAWS'], permissions: { contents: 'read' } };

// The version a lockfile resolved for a root dependency (pnpm lockfile v9: importers['.']), without peer suffixes.
export function lockedVersion(lock, name) {
  const root = lock?.importers?.['.'] ?? {};
  const entry = root.devDependencies?.[name] ?? root.dependencies?.[name];
  return entry?.version ? String(entry.version).split('(')[0] : null;
}

async function step(name, fn) {
  try {
    results[name] = { ok: true, detail: (await fn()) ?? '' };
  } catch (err) {
    results[name] = { ok: false, detail: String(err.message).slice(0, 500) };
  }
  console.log(`warm ${name}: ${results[name].ok ? 'ok' : 'FAILED'} ${results[name].detail}`);
}

async function main() {
  const token = process.env.CI_KIT_GH_TOKEN?.trim();
  if (!token) throw new Error('CI_KIT_GH_TOKEN is not set (an installation token that can read MAWS)');
  const gh = createGitHub(token);
  const dir = await mkdtemp(join(tmpdir(), 'ci-kit-warm-'));
  let lock = null;
  await step('maws-files', async () => {
    for (const file of FILES) {
      try {
        const text = await gh.request('GET', `/repos/${MAWS}/contents/${file}`, { accept: 'application/vnd.github.raw+json', text: true });
        await writeFile(join(dir, file), text);
      } catch (err) {
        if (err.status !== 404 || file === 'package.json' || file === 'pnpm-lock.yaml') throw err;
      }
    }
    lock = parse(await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8'));
    return FILES.join(', ');
  });
  if (lock) {
    await step('pnpm-fetch', async () => {
      await sh('corepack', ['pnpm', 'fetch'], { cwd: dir, env, maxBuffer: 64 << 20, timeout: 20 * 60_000 });
    });
    const playwright = lockedVersion(lock, '@playwright/test') ?? lockedVersion(lock, 'playwright');
    if (playwright) {
      await step('playwright', async () => {
        await sh('npx', ['--yes', `playwright@${playwright}`, 'install', 'chromium'], { cwd: dir, env, maxBuffer: 64 << 20, timeout: 15 * 60_000 });
        return playwright;
      });
    }
    const electron = lockedVersion(lock, 'electron');
    if (electron) {
      await step('electron', async () => {
        const prefix = await mkdtemp(join(tmpdir(), 'ci-kit-electron-'));
        await sh('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', `electron@${electron}`], { cwd: prefix, env, maxBuffer: 64 << 20, timeout: 15 * 60_000 });
        // Electron 44's package has no install script: its binary comes from the `install-electron` bin, which MAWS's
        // postinstall runs, and which is what fills electron_config_cache. So the warm step runs it too.
        await sh(process.execPath, [join(prefix, 'node_modules/electron/install.js')], { cwd: prefix, env, maxBuffer: 64 << 20, timeout: 15 * 60_000 });
        await rm(prefix, { recursive: true, force: true });
        const { stdout } = await sh('find', [CACHE_ENV.electron_config_cache, '-name', `electron-v${electron}-*.zip`]);
        if (!stdout.trim()) throw new Error(`no electron-v${electron} zip under ${CACHE_ENV.electron_config_cache}`);
        return electron;
      });
    }
  }
  await rm(dir, { recursive: true, force: true });
  await writeFile(`${CACHE}/warm.json`, `${JSON.stringify(results, null, 2)}\n`).catch(() => {});
  if (Object.values(results).some((r) => !r.ok)) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`warm: ${err.message}`);
    process.exit(1);
  });
}
