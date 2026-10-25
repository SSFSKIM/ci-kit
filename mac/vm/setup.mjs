#!/usr/bin/env node
// The guest bake's adapter: the shared applier plus records consumed by provision.sh and the first-run step.
// The installed kit carries setup/, plan/ and vendor/ beside mac/'s contents, not a full repository checkout.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function bakeSetup(kit, root) {
  if (!kit || !root) throw new Error('usage: setup.mjs <installed kit> <scratch clone>');
  const { applySetup } = await import(pathToFileURL(resolve(kit, 'setup/apply.mjs')));
  const { parseConfig, hasDeclaration } = await import(pathToFileURL(resolve(kit, 'plan/config.mjs')));
  const config = await readFile(join(root, '.github/ci-kit.yml'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const setup = config === null ? null : parseConfig(config, { isPrivate: true }).setup;
  const state = join(process.env.HOME, '.ci-kit');
  if (!setup || !hasDeclaration(setup)) {
    throw new Error('setup declaration required in .github/ci-kit.yml to bake the guest');
  }
  const { hash, quarantined } = await applySetup({ root, mode: 'bake', install: true });
  const apps = new Set(quarantined);
  // The applier reports newly installed casks. A base image or an earlier provision step may already have installed
  // one without approving it, so inspect every declared cask as well.
  if (setup.cask.length) {
    const artifacts = execFileSync('brew', ['list', '--cask', ...new Set(setup.cask)], { encoding: 'utf8' });
    for (const line of artifacts.split(/\r?\n/)) {
      const artifact = /^((?:\/|~\/).*\.app)(?: \(|$)/.exec(line)?.[1];
      if (!artifact) continue;
      // Homebrew's printable_target abbreviates an app installed beneath the user's home.
      // Homebrew 7 may list a Caskroom symlink rather than the installed app.
      const app = await realpath(artifact.startsWith('~/') ? join(process.env.HOME, artifact.slice(2)) : artifact);
      const attrs = execFileSync('xattr', [app], { encoding: 'utf8' });
      if (attrs.split(/\r?\n/).includes('com.apple.quarantine')) apps.add(app);
    }
  }
  await mkdir(state, { recursive: true });
  for (const [name, value] of [['quarantined-apps', [...apps].sort().map((app) => `${app}\n`).join('')], ['setup-hash', `${hash}\n`]]) {
    await writeFile(join(state, `${name}.tmp`), value);
    await rename(join(state, `${name}.tmp`), join(state, name));
  }
  console.log(`provision: setup ${hash} applied with install; records in ${state}`);
  for (const app of [...apps].sort()) console.log(`provision: first-run approval check: ${app}`);
}

try {
  await bakeSetup(...process.argv.slice(2));
} catch (error) {
  console.error(`provision: setup failed: ${error.message}`);
  process.exitCode = 1;
}
