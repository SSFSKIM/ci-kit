#!/usr/bin/env node
// Runs inside the unprivileged bake/smoke container, on the runner's bundled Node, not the project's Node.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig } from '../../plan/config.mjs';
import { setupHash } from '../../setup/hash.mjs';
import { applySetup } from '../../setup/apply.mjs';

async function main() {
  const [phase, root, expected] = process.argv.slice(2);
  if (!['apply', 'warm', 'smoke'].includes(phase) || !root || !expected) throw new Error('expected phase, clone and setup hash');
  // HTTP 401 is reachable too: no --fail. Test both metadata routes and the IMDSv2 token endpoint.
  for (const args of [
    ['http://169.254.169.254/'], ['http://[fd00:ec2::254]/'],
    ['-X', 'PUT', '-H', 'X-aws-ec2-metadata-token-ttl-seconds: 60', 'http://169.254.169.254/latest/api/token'],
  ]) {
    const result = spawnSync('curl', ['-s', '--noproxy', '*', '--max-time', '5', '-o', '/dev/null', ...args]);
    if (result.error || ![7, 28].includes(result.status)) throw new Error('metadata reachable or probe failed');
  }
  console.log('ci-kit bake: metadata refused (IPv4, IPv6, IMDSv2)');
  const config = execFileSync('git', ['-C', root, 'config', '--local', '--list'], { encoding: 'utf8' });
  if (/extraheader|credential|https?:\/\/[^/\s]+@/i.test(config)) throw new Error('clone git config contains a credential');
  console.log('ci-kit bake: clone credentials absent');

  const { setup } = parseConfig(await readFile(join(root, '.github/ci-kit.yml'), 'utf8'), { isPrivate: true });
  const hash = setupHash(setup, setup.script ? await readFile(join(root, setup.script)) : undefined);
  if (hash !== expected) throw new Error('clone setup hash differs from resolved manifest');
  if (phase !== 'apply' && process.env.CI_KIT_SETUP_HASH !== expected) throw new Error('image setup hash differs from resolved manifest');
  let shims;
  try {
    if (setup.node) {
      const cache = join(process.env.RUNNER_TOOL_CACHE, 'node');
      // The bake pins/cache-installs Node 22 and 24. Do not quietly use a different version for a declaration.
      const version = (await readdir(cache)).find(v => v === setup.node || v.split('.')[0] === setup.node);
      if (!version) throw new Error(`setup.node ${setup.node}: not in the baked tool cache (22 and 24)`);
      const bin = join(cache, version, 'x64', 'bin');
      process.env.PATH = `${bin}:${process.env.PATH}`;
    }
    if (setup.pnpm) {
      shims = await mkdtemp(join(tmpdir(), 'ci-kit-pnpm-'));
      execFileSync('corepack', ['enable', '--install-directory', shims], { stdio: 'inherit' });
      process.env.PATH = `${shims}:${process.env.PATH}`;
    }
    process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
    const result = await applySetup({ root, mode: phase === 'smoke' ? 'job' : 'bake', install: phase === 'warm' });
    if (phase === 'smoke' && (result.installed || result.stale)) throw new Error(`job image is not satisfied: installed ${result.installed || 'nothing'}`);
    console.log(`ci-kit bake: ${phase} setup ${hash}: ok`);
  } finally {
    if (shims) await rm(shims, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(`ci-kit bake: ${error.message}`); process.exitCode = 1; });
