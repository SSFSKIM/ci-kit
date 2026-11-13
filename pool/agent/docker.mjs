// Shared runner container environment for GCE and EC2, and their image bake.
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

// A git transfer that moves under 1000 bytes a second for 60 seconds fails instead of waiting out the job's limit:
// a pool job's checkout fetch once sat silent for 30 minutes on one VM while its neighbours fetched in a second (MAWS
// run 43412123856, 2026-11-13). actions/checkout retries a failed fetch, so the stall costs about a minute.
export const GIT_ENV = { GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '60' };

export const workDir = (name) => `${CACHE}/work/${name}`;

// The cache mount and tool paths, git's stall bound, the JIT config by name, and the job-started hook.
export const jobEnvironmentArgs = () => [
  '--shm-size', '2g',
  '-v', `${CACHE}:${CACHE}`,
  '-e', 'CI_KIT_JIT',
  '-e', 'ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/bin/ci-kit-job-started.sh',
  ...Object.entries({ ...CACHE_ENV, ...GIT_ENV }).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
];
