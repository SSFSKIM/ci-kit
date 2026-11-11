#!/usr/bin/env node
// Apply a repository's CI environment in a job or a bake. No dependencies beyond the kit's vendored parser:
// the action runs on the runner's own Node, before a project has installed any tooling.
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseConfig } from '../plan/config.mjs';
import { setupHash } from './hash.mjs';

// An apt index update the lists on the machine can stand in for is cut here (gates.yml's check step cuts its own at the
// same bound): a healthy one takes seconds, while each try at a mirror name the resolver cannot answer took 40 s, and
// an update of them 6-12.5 min. It leaves a slow mirror's index changes two minutes.
const APT_UPDATE_BOUND_S = 120;
const unique = (list) => [...new Set(list)];
const lines = (text) => text.split(/\r?\n/).filter(Boolean);
const escapeMessage = (text) => text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const annotation = (kind, message) => console.log(`::${kind}::${escapeMessage(message)}`);
export const reportError = (error) => {
  console.error(`::error::${escapeMessage(`ci-kit setup: ${error.message}`)}`);
  process.exitCode = 1;
};

// Presence reads are captured; installs and repository commands stream so a slow installer remains visible.
// stdin is closed: a cask installer cannot wait for a password on the owner's machine.
function command(bin, args, { cwd, env, stream = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stream) process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stream) process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, stdout, stderr, signal }));
  });
}

export async function applySetup({ root = process.env.GITHUB_WORKSPACE || process.cwd(), mode = 'job', install = false, skip = '', platform = process.platform } = {}) {
  if (!['job', 'bake'].includes(mode)) throw new Error(`mode: expected job or bake, got ${mode}`);
  if (!['linux', 'darwin'].includes(platform)) throw new Error(`unsupported setup platform: ${platform}`);
  const start = performance.now();
  root = resolve(root);
  // Lane authorization belongs to the planner. This action can also be called from a repository's own workflow,
  // and validates its declaration without trying to infer visibility from an optional Actions event payload.
  const { setup } = parseConfig(await readFile(resolve(root, '.github/ci-kit.yml'), 'utf8'), { isPrivate: true });
  const skipped = new Set(skip.split(/\s+/).filter(Boolean));
  if (skipped.size && mode !== 'job') throw new Error('skip input: only supported in job mode');
  const declared = new Set(['apt', 'brew', 'cask'].flatMap((kind) => setup[kind].map((name) => `${kind}:${name}`)));
  for (const name of skipped) {
    if (!declared.has(name)) throw new Error(`skip input: ${name} is not a declared apt:name, brew:name or cask:name package`);
  }
  let scriptBytes;
  if (setup.script) {
    try { scriptBytes = await readFile(resolve(root, setup.script)); }
    catch (e) { throw new Error(`setup.script ${setup.script}: ${e.message}`); }
  }
  const hash = setupHash(setup, scriptBytes);
  const image = process.env.CI_KIT_SETUP_HASH || '';
  const stale = Boolean(image && image !== hash);
  if (image === hash) console.log(`ci-kit setup: image matches setup ${hash}`);
  else if (stale) annotation('notice', `ci-kit setup: image setup ${image} differs from commit setup ${hash}; applying declaration`);

  const env = { ...process.env, CI: 'true', CI_KIT_SETUP_MODE: mode, NONINTERACTIVE: '1' };
  const context = { cwd: root, env };
  // Executable overrides, not shell fragments: tests use real subprocesses without invoking apt or Homebrew.
  const bin = (name, fallback) => env[`CI_KIT_SETUP_${name}`] || fallback;
  async function attempt(executable, args, label, stream = false) {
    try { return await command(executable, args, { ...context, stream }); }
    catch (e) { throw new Error(`${label}: ${e.message}`); }
  }
  async function run(executable, args, label, stream = false) {
    const result = await attempt(executable, args, label, stream);
    if (result.code !== 0) {
      throw new Error(`${label} failed (${result.signal || result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result.stdout;
  }

  // Filter only the job's package requests, never the declaration used for image identity.
  const packages = (kind) => unique(setup[kind]).filter((name) => !skipped.has(`${kind}:${name}`));
  const apt = platform === 'linux' ? packages('apt') : [];
  const brew = platform === 'darwin' ? packages('brew') : [];
  const cask = platform === 'darwin' ? packages('cask') : [];
  if (skipped.size) console.log(`ci-kit setup: skipped ${[...skipped].join(' ')}`);
  const installed = [];
  const quarantined = [];
  if (apt.length) {
    // Query the database once (not one potentially failing query per missing package). Residual configuration is
    // not an installed package. ${Package} omits multiarch suffixes, matching the declaration's Debian names.
    const output = await run(bin('DPKG_QUERY', 'dpkg-query'), ['-W', '-f=${Package}\t${db:Status-Status}\t${Provides}\n'], 'apt presence query');
    const present = new Set();
    for (const line of lines(output)) {
      const [name, status, provides = ''] = line.split('\t');
      if (status !== 'installed') continue;
      present.add(name);
      // A virtual dependency is satisfied by its installed provider, including versioned Provides entries.
      for (const entry of provides.split(',')) {
        const provided = entry.trim().split(/[\s(]/)[0];
        if (provided) present.add(provided);
      }
    }
    const missing = apt.filter((name) => !present.has(name));
    if (missing.length) {
      const sudo = bin('SUDO', 'sudo'), aptGet = bin('APT_GET', 'apt-get');
      // A slow mirror otherwise holds the job until its timeout: apt's own default waits on a stalled connection for
      // minutes per file, and retries nothing (a hosted runner's azure.archive.ubuntu.com held two jobs 30 and 45 min).
      const acquire = ['-o', 'Acquire::Retries=3', '-o', 'Acquire::http::Timeout=30', '-o', 'Acquire::https::Timeout=30'];
      const names = missing.join(', ');
      // Offline first: the lists on the machine (a hosted image ships signed ones) usually name every file the install
      // takes, and the package cache (gates.yml) may already hold them all; an index update then only waits on the
      // mirror (unresolvable Ubuntu mirror names held each update 6-12.5 min to fetch nothing: arachne, 2026-11-11). So
      // apt is asked what the install would download with those lists. Nothing: no update. A download: an update, cut
      // at a bound past which the lists present serve the install (in a job: a bake has the time, and an image should
      // carry current versions). A name they do not know (no lists, or lists older than the package): an update with no
      // bound, since there is no install without it.
      const probe = await attempt(sudo, ['-n', aptGet, 'install', '--print-uris', '-qq', '-y', '--no-install-recommends', ...missing], `apt download query for ${names}`);
      if (probe.code !== 0) {
        console.log(`ci-kit setup: the apt lists on this machine cannot place ${names} (${lines(probe.stderr.trim() || probe.stdout.trim()).at(-1) ?? `exit ${probe.signal || probe.code}`}); updating them`);
        await run(sudo, ['-n', aptGet, 'update', ...acquire], `apt update for ${names}`, true);
      } else if (lines(probe.stdout).some((line) => line.startsWith("'"))) {
        const bound = mode === 'job' ? ['timeout', '--kill-after=10', String(APT_UPDATE_BOUND_S)] : [];
        const update = await attempt(sudo, ['-n', ...bound, aptGet, 'update', ...acquire], `apt update for ${names}`, true);
        if (update.code !== 0) {
          const why = update.code === 124 ? `did not finish in ${APT_UPDATE_BOUND_S} s` : `failed (${update.signal || update.code})`;
          annotation('warning', `ci-kit setup: apt's index update for ${names} ${why}; installing against the lists on this machine`);
        }
      } else console.log(`ci-kit setup: with the apt lists on this machine nothing needs downloading for ${names}; no index update`);
      // Set it after sudo, whose normal environment filtering drops DEBIAN_FRONTEND.
      await run(sudo, ['-n', 'env', 'DEBIAN_FRONTEND=noninteractive', aptGet, 'install', ...acquire, '-y', '--no-install-recommends', ...missing], `apt install ${missing.join(', ')}`, true);
      installed.push(...missing.map((name) => `apt:${name}`));
    }
  }

  for (const [kind, names, flag] of [['brew', brew, '--formula'], ['cask', cask, '--cask']]) {
    if (!names.length) continue;
    const executable = bin('BREW', 'brew');
    // Query installed metadata once per list. Querying the declared names instead would let one unknown name
    // abort the whole info read, hiding installed aliases beside it. Unknown names here simply remain missing.
    const output = await run(executable, ['info', '--json=v2', '--installed', flag], `${kind} presence query`);
    const info = JSON.parse(output);
    const present = new Set();
    for (const entry of kind === 'brew' ? info.formulae : info.casks) {
      if (!entry.installed?.length) continue;
      const identities = kind === 'brew'
        ? [entry.name, ...entry.aliases, ...entry.oldnames]
        : [entry.token, ...entry.old_tokens];
      present.add(kind === 'brew' ? entry.full_name : entry.full_token);
      for (const name of identities) {
        present.add(name);
        if (entry.tap && !name.includes('/')) present.add(`${entry.tap}/${name}`);
      }
    }
    const missing = names.filter((name) => !present.has(name));
    if (!missing.length) continue;
    try {
      await run(executable, ['install', ...(kind === 'cask' ? ['--cask'] : []), ...missing], `${kind} install ${missing.join(', ')}`, true);
    } catch (e) {
      if (kind === 'cask' && /sudo|password|a terminal is required/i.test(e.message)) {
        throw new Error(`cask ${missing.join(', ')} needs an administrator to install it on this machine; perform a manual install. ${e.message}`);
      }
      throw e;
    }
    installed.push(...missing.map((name) => `${kind}:${name}`));
    if (kind === 'cask') {
      // brew list <casks> prints artifact paths (possibly Caskroom symlinks), followed by their size in parentheses.
      // Resolve them before inspection and reporting; do not strip quarantine: first-run approval belongs to a human.
      const artifacts = await run(executable, ['list', '--cask', ...missing], `cask artifacts for ${missing.join(', ')}`);
      const apps = unique(lines(artifacts).map((line) => /^(\/.*\.app)(?: \(|$)/.exec(line)?.[1]).filter(Boolean));
      for (const artifact of apps) {
        const app = await realpath(artifact);
        const result = await command(bin('XATTR', 'xattr'), ['-p', 'com.apple.quarantine', app], context);
        if (result.code === 0) {
          quarantined.push(app);
          annotation('warning', `ci-kit setup: ${app} is quarantined; it needs first-run approval on this machine before tests can launch it`);
        }
      }
    }
  }

  if (setup.script) await run('bash', [resolve(root, setup.script)], `setup.script ${setup.script}`, true);
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  const count = (kind) => (kind === 'apt' ? platform === 'linux' : platform === 'darwin') ? unique(setup[kind]).length : 0;
  console.log(`ci-kit setup: declared apt ${count('apt')}, brew ${count('brew')}, cask ${count('cask')}, script ${setup.script ? 'yes' : 'no'}; installed ${installed.join(' ') || 'nothing'} in ${seconds} s`);
  // The install fetches (a registry, a release download), and those fail for a minute at a time: GitHub's release
  // downloads answered 504 for Electron's zip in 3 of 18 hosted Mac jobs over 15 minutes (MAWS run 41995538110). So a
  // failed install is retried once, after a pause; its output above names the first failure, and a second fails the step.
  if (install && setup.install) {
    const installing = () => run('bash', ['-eo', 'pipefail', '-c', setup.install], 'setup.install', true);
    try { await installing(); }
    catch {
      const pause = Number(env.CI_KIT_SETUP_INSTALL_RETRY_S || 30);
      annotation('warning', `ci-kit setup: setup.install failed; retrying it once in ${pause} s (its output above has the failure)`);
      await new Promise((done) => setTimeout(done, pause * 1000));
      await installing();
    }
  }
  return { hash, installed: installed.join(' '), stale, quarantined };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { mode: { type: 'string', default: 'job' }, root: { type: 'string' }, install: { type: 'boolean', default: false } } });
    await applySetup(values);
  } catch (e) { reportError(e); }
}
