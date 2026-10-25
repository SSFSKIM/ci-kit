#!/usr/bin/env node
// Host side of per-repository images. No repository command runs here: only git, filesystem work and Docker.
import { spawn } from 'node:child_process';
import { mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CACHE, CACHE_ENV, IMAGE } from '../agent/docker.mjs';
import { METADATA_BLOCK } from '../vm/run.mjs';
import { repoSlug, jobImage } from './manifest.mjs';
import { retainSmokeSource } from './smoke-source.mjs';

const KIT = '/opt/ci-kit', SOURCES = '/var/lib/ci-kit/setup-sources';
const NODE = '/home/runner/externals/node24/bin/node';
async function command(bin, args, { env = {}, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${bin} exited ${code}`)));
  });
}

async function blockMetadata(exec) {
  for (const [bin, rules] of [
    ['iptables', METADATA_BLOCK], ['ip6tables', [['FORWARD', '-d', 'fd00:ec2::254/128', '-j', 'DROP']]],
  ]) for (const rule of rules) {
    try { await exec(bin, ['-C', ...rule]); } catch { await exec(bin, ['-I', ...rule]); }
  }
}

function containerArgs({ repo, phase, hash, kit, cache }) {
  const name = `ci-kit-setup-${repoSlug(repo)}`;
  const root = `${CACHE}/work/${name}`;
  return ['run', '--name', name, '--user', 'runner', '--shm-size', '2g',
    '-v', `${cache}:${CACHE}`, '--workdir', root,
    ...['setup', 'plan', 'vendor', 'pool/bake/setup-container.mjs'].flatMap(path => ['-v', `${kit}/${path}:${KIT}/${path}:ro`]),
    ...Object.entries(CACHE_ENV).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    ...(phase === 'smoke'
      ? ['-v', `${kit}/gce/vm/smoke.sh:/usr/local/bin/ci-kit-smoke:ro`, '--entrypoint', '/usr/local/bin/ci-kit-smoke', jobImage(repo), '--setup', root, hash]
      : ['--entrypoint', NODE, phase === 'apply' ? IMAGE : jobImage(repo), `${KIT}/pool/bake/setup-container.mjs`, phase, root, hash]),
  ];
}

async function workCopy(repo, { sources, cache, exec }) {
  const root = join(cache, 'work', `ci-kit-setup-${repoSlug(repo)}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(join(cache, 'work'), { recursive: true });
  await cp(join(sources, repoSlug(repo)), root, { recursive: true, verbatimSymlinks: true });
  await exec('chown', ['-R', '1001:1001', cache]);
  return root;
}

export async function bakeJobImages({ manifest, token, kit = KIT, cache = CACHE, sources = SOURCES, exec = command, log = console.log }) {
  // This precedes every clone, even when there are no declarations yet.
  await blockMetadata(exec);
  await mkdir(sources, { recursive: true });
  const baseBytes = Number(await exec('docker', ['image', 'inspect', '--format', '{{.Size}}', IMAGE], { capture: true }));
  for (const [repo, entry] of Object.entries(manifest.repos ?? {})) {
    const name = `ci-kit-setup-${repoSlug(repo)}`, source = join(sources, repoSlug(repo));
    let root, step = 'clone';
    // Results handed over by another provider are evidence, never this builder's results.
    delete entry.apply; delete entry.warm;
    try {
      await exec('git', ['init', '--quiet', source]);
      await exec('git', ['-C', source, 'remote', 'add', 'origin', `https://github.com/${repo}.git`]);
      await exec('git', ['-C', source, 'fetch', '--quiet', '--depth', '1', 'origin', entry.revision], { env: {
        GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      } });
      await exec('git', ['-C', source, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
      // Apply and warm keep the full clone; only pristine declaration inputs survive on the VM image.
      root = await workCopy(repo, { sources, cache, exec });
      step = 'retain smoke inputs';
      const { before, after } = await retainSmokeSource(source, { exec });
      log(`ci-kit bake: ${repo} retained smoke inputs: ${after} bytes (was ${before}; removed ${before - after})`);
      step = 'apply';
      log(`ci-kit bake: ${repo} apply ${entry.setup_hash}`);
      await exec('docker', containerArgs({ repo, phase: 'apply', hash: entry.setup_hash, kit, cache }));
      await exec('docker', ['commit', '--change', `ENV CI_KIT_SETUP_HASH=${entry.setup_hash}`,
        '--change', `LABEL CI_KIT_SETUP_HASH=${entry.setup_hash}`,
        '--change', `LABEL CI_KIT_REPO=${repo}`,
        '--change', 'ENTRYPOINT ["/usr/local/bin/ci-kit-entrypoint"]', '--change', 'CMD []',
        '--change', 'WORKDIR /home/runner', name, jobImage(repo)]);
      await exec('docker', ['rm', name]);
      const bytes = Number(await exec('docker', ['image', 'inspect', '--format', '{{.Size}}', jobImage(repo)], { capture: true }));
      if (!Number.isSafeInteger(bytes) || bytes < baseBytes) throw new Error('invalid image size');
      entry.apply = { ok: true, image_bytes: bytes - baseBytes };
      log(`ci-kit bake: ${repo} job image ${jobImage(repo)}: ${bytes} bytes, ${bytes - baseBytes} bytes above base`);
      if (bytes - baseBytes > 2 ** 30) log(`ci-kit bake: ${repo} layer exceeds 1 GiB; evaluate separate VM images`);
      step = 'warm';
      try {
        await exec('docker', containerArgs({ repo, phase: 'warm', hash: entry.setup_hash, kit, cache }));
        entry.warm = { ok: true };
      } catch {
        entry.warm = { ok: false };
      }
      log(`ci-kit bake: ${repo} warm: ${entry.warm.ok ? 'ok' : 'FAILED (best effort)'}`);
    } catch (error) {
      throw new Error(`${repo} ${step}: ${error.message}`);
    } finally {
      await exec('docker', ['rm', '--force', name]).catch(() => {});
      if (root) await rm(root, { recursive: true, force: true });
    }
  }
}

// Called only on smoke VMs. Normal jobs keep the base image until the separate launcher/image-choice milestone.
export async function smokeJobImages({ manifest, kit = KIT, cache = CACHE, sources = SOURCES, exec = command, log = console.log } = {}) {
  manifest ??= JSON.parse(await readFile('/etc/ci-kit/bake-manifest.json', 'utf8'));
  for (const [repo, entry] of Object.entries(manifest.repos ?? {})) {
    const name = `ci-kit-setup-${repoSlug(repo)}`;
    const root = await workCopy(repo, { sources, cache, exec });
    try {
      const label = await exec('docker', ['image', 'inspect', '--format', '{{index .Config.Labels "CI_KIT_SETUP_HASH"}}', jobImage(repo)], { capture: true });
      if (label !== entry.setup_hash) throw new Error('image setup label mismatch');
      await exec('docker', containerArgs({ repo, phase: 'smoke', hash: entry.setup_hash, kit, cache }));
      log(`ci-kit smoke: ${repo} setup ${entry.setup_hash}: installed nothing`);
    } catch (error) {
      throw new Error(`${repo} smoke: ${error.message}; smoke retains only .github/ci-kit.yml and setup.script (no other repository files)`);
    } finally {
      await exec('docker', ['rm', '--force', name]).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.env.CI_KIT_BAKE_MANIFEST;
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const token = process.env.CI_KIT_GH_TOKEN;
    if (!token) throw new Error('missing builder GitHub token');
    delete process.env.CI_KIT_GH_TOKEN;
    await bakeJobImages({ manifest, token });
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) { console.error(`ci-kit bake: ${error.message}`); process.exitCode = 1; }
}
