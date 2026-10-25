// Host effects shared by ephemeral VM guests. Secrets reach Docker by environment, never by command line.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, chown } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { workDir, IMAGE } from '../agent/docker.mjs';
import { jobImage } from '../bake/manifest.mjs';
import { jobRunArgs, METADATA_BLOCK } from './run.mjs';

const sh = promisify(execFile);
// Tags are normalized, so only an explicit repository label establishes which repository owns the image.
export async function selectJobImage(repo, { exec = sh, log = console.log } = {}) {
  const selected = (image, reason = '') => {
    log(`job image ${image}${reason ? ` (${reason})` : ''}`);
    return image;
  };
  if (!repo) return selected(IMAGE, 'no repository supplied');
  const image = jobImage(repo);
  let label;
  try {
    const result = await exec('docker', ['image', 'inspect', '--format', '{{index .Config.Labels "CI_KIT_REPO"}}', image], { timeout: 10_000 });
    label = result.stdout.trim();
  } catch { return selected(IMAGE, 'repository image unavailable'); }
  if (label.toLowerCase() !== repo.toLowerCase()) return selected(IMAGE, 'repository image lacks matching CI_KIT_REPO');
  return selected(image);
}

export async function prepareContainer(name, { exec = sh, makeDir = mkdir, own = chown, blockIpv6 = false } = {}) {
  for (const rule of METADATA_BLOCK) {
    try { await exec('iptables', ['-C', ...rule]); }
    catch { await exec('iptables', ['-I', ...rule]); }
  }
  if (blockIpv6) {
    // FORWARD exists even when Docker's IPv6 network (and therefore its IPv6 DOCKER-USER chain) is disabled.
    const rule = ['FORWARD', '-d', 'fd00:ec2::254/128', '-j', 'DROP'];
    try { await exec('ip6tables', ['-C', ...rule]); }
    catch { await exec('ip6tables', ['-I', ...rule]); }
  }
  const work = workDir(name);
  await makeDir(work, { recursive: true });
  await own(work, 1001, 1001);
}

export function docker(args, { env = {}, capture = false, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('docker', args, { env: { ...process.env, ...env }, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    let out = '';
    child.stdout?.on('data', d => { out += d; process.stdout.write(d); });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, out }));
  });
}

// Detached creation lets the EC2 guest distinguish a real container start from a Docker CLI spawn failure.
// Attach preserves the job's serial-console output; wait supplies its actual exit status even on attach errors.
export async function runContainer({ name, repo, jit, smoke, onStarted, log = console.log, cpus = availableParallelism() },
  { exec = sh, runDocker = docker } = {}) {
  const image = smoke ? IMAGE : await selectJobImage(repo, { exec, log });
  if (smoke) log(`job image ${image}`);
  const args = jobRunArgs({ name, cpus, smoke, image });
  args.splice(args.indexOf('--rm'), 1, '--detach');
  const started = await exec('docker', args, { env: { ...process.env, CI_KIT_JIT: jit ?? '' }, timeout: 60_000 });
  if (!started.stdout.trim()) throw new Error('container did not start');
  await onStarted();
  // The container can exit between run and attach. Logs still retains its complete output in that case.
  const result = await runDocker(['logs', '--follow', name], { capture: Boolean(smoke) });
  const waited = await exec('docker', ['wait', name], { timeout: 10_000 });
  const code = Number(waited.stdout.trim());
  if (!Number.isInteger(code) || waited.stdout.trim() === '') throw new Error('invalid container exit');
  return { code, out: result.out };
}
