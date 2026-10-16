// The agent's Docker side: the job container's run arguments (pure) and a thin CLI wrapper.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatCpuset, parseCpuset } from './logic.mjs';

const run = promisify(execFile);
export const CACHE = '/var/lib/ci-kit/cache';
export const IMAGE = 'ci-kit-runner:latest';

// Tools pointed at the baked caches (spec §3 Caches). The work directory lives under CACHE too, inside the same
// bind mount as the pnpm store, so pnpm hardlinks (link(2) fails across mount points, even of one filesystem).
export const CACHE_ENV = {
  RUNNER_TOOL_CACHE: `${CACHE}/toolcache`,
  AGENT_TOOLSDIRECTORY: `${CACHE}/toolcache`,
  npm_config_cache: `${CACHE}/npm`,
  // pnpm ≤ 10 reads npm_config_*; pnpm 11 reads only pnpm_config_* (its migration guide).
  npm_config_store_dir: `${CACHE}/pnpm-store`,
  pnpm_config_store_dir: `${CACHE}/pnpm-store`,
  COREPACK_HOME: `${CACHE}/corepack`,
  PLAYWRIGHT_BROWSERS_PATH: `${CACHE}/ms-playwright`,
  // @electron/get reads electron_config_cache; ELECTRON_CACHE is the older electron-download's name.
  electron_config_cache: `${CACHE}/electron`,
  ELECTRON_CACHE: `${CACHE}/electron`,
};

export const workDir = (name) => `${CACHE}/work/${name}`;

// `docker run` arguments for one job container. The JIT config is passed by name (-e CI_KIT_JIT) and its value
// comes from the docker CLI's environment, so it is not on any command line.
// Every container announces its cores in its job's log through the runner's job-started hook (pool/image), and a
// job clamped to a smaller box (it asked for `clamped` cores) says so there.
export function runArgs({ name, repo, runnerId, labels, cores, memoryGbPerCpu, clamped, image = IMAGE }) {
  const gb = cores.length * memoryGbPerCpu;
  const labelArgs = {
    'ci-kit-job': name,
    'ci-kit-repo': repo,
    'ci-kit-runner-id': String(runnerId),
    'ci-kit-labels': labels.join(','),
    'ci-kit-cpuset': formatCpuset(cores),
  };
  return [
    'run', '--detach', '--name', name,
    ...Object.entries(labelArgs).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    '--cpuset-cpus', formatCpuset(cores),
    '--memory', `${gb}g`, '--memory-swap', `${gb}g`,
    '--shm-size', '2g',
    '-v', `${CACHE}:${CACHE}`,
    '-e', 'CI_KIT_JIT',
    '-e', 'ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/bin/ci-kit-job-started',
    '-e', `CI_KIT_CORES=${formatCpuset(cores)}`,
    ...(clamped ? ['-e', `CI_KIT_CLAMPED=${clamped}`] : []),
    ...Object.entries(CACHE_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    image,
  ];
}

export function fromInspect(c) {
  const l = c.Config.Labels ?? {};
  const cores = parseCpuset(l['ci-kit-cpuset'] ?? '');
  return {
    id: c.Id,
    name: c.Name.replace(/^\//, ''),
    running: c.State.Running === true,
    created: Date.parse(c.Created),
    repo: l['ci-kit-repo'],
    runnerId: Number(l['ci-kit-runner-id']),
    labels: (l['ci-kit-labels'] ?? '').split(',').filter(Boolean),
    cpus: cores.length,
    cores,
  };
}

const docker = async (args, env) => (await run('docker', args, { timeout: 20_000, maxBuffer: 16 << 20, env: { ...process.env, ...env } })).stdout;

export async function listContainers() {
  const ids = (await docker(['ps', '-aq', '--no-trunc', '--filter', 'label=ci-kit-job'])).split('\n').filter(Boolean);
  if (ids.length === 0) return [];
  return JSON.parse(await docker(['inspect', ...ids])).map(fromInspect);
}

export async function startContainer(spec, jit) {
  return (await docker(runArgs(spec), { CI_KIT_JIT: jit })).trim();
}

export async function removeContainer(name) {
  await docker(['rm', '--force', name]);
}
