// The job container's shape (spec §3 Job containers, Caches, Isolation) and the agent's reading of `docker inspect`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runArgs, fromInspect, CACHE } from '../../pool/agent/docker.mjs';

const spec = { name: 'ci-kit-pool-55-3', repo: 'SSFSKIM/ci-kit-sandbox', runnerId: 901, labels: ['self-hosted', 'ci-kit-pool', 'cpus-4'], cores: [4, 5, 6, 7], memoryGbPerCpu: 2, image: 'ci-kit-runner:latest' };

test('a job container gets exactly its cores as a cpuset and 2N GB, the caches, and no Docker socket or /etc/ci-kit', () => {
  const args = runArgs(spec);
  const joined = args.join(' ');
  assert.equal(args[0], 'run');
  assert.match(joined, /--cpuset-cpus 4-7 /);
  assert.match(joined, /--memory 8g --memory-swap 8g /);
  assert.match(joined, new RegExp(`-v ${CACHE}:${CACHE} `));
  assert.doesNotMatch(joined, /docker\.sock|\/etc\/ci-kit|--privileged|--cpus /);
  assert.match(joined, /--label ci-kit-job=ci-kit-pool-55-3 /);
  assert.match(joined, /--label ci-kit-runner-id=901 /);
  assert.match(joined, /--label ci-kit-labels=self-hosted,ci-kit-pool,cpus-4 /);
  assert.match(joined, /-e CI_KIT_JIT /); // the value comes from the environment, not the command line
  assert.ok(!args.some((a) => a.startsWith('CI_KIT_JIT=')));
  const dirs = {
    RUNNER_TOOL_CACHE: 'toolcache', npm_config_cache: 'npm', npm_config_store_dir: 'pnpm-store', pnpm_config_store_dir: 'pnpm-store',
    PLAYWRIGHT_BROWSERS_PATH: 'ms-playwright', electron_config_cache: 'electron', ELECTRON_CACHE: 'electron',
  };
  for (const [env, dir] of Object.entries(dirs)) assert.ok(args.includes(`${env}=${CACHE}/${dir}`), env);
  assert.equal(args.at(-1), 'ci-kit-runner:latest');
});

test('docker inspect is read back into the agent\'s container record', () => {
  // The fields the agent reads, as `docker inspect` prints them.
  const inspected = {
    Id: 'abc', Name: '/ci-kit-pool-55-3', Created: '2026-10-15T12:00:00.123456789Z',
    State: { Running: true, Status: 'running', ExitCode: 0 },
    Config: { Labels: { 'ci-kit-job': 'ci-kit-pool-55-3', 'ci-kit-repo': 'SSFSKIM/ci-kit-sandbox', 'ci-kit-runner-id': '901', 'ci-kit-labels': 'self-hosted,ci-kit-pool,cpus-4', 'ci-kit-cpuset': '4-7' } },
  };
  assert.deepEqual(fromInspect(inspected), {
    id: 'abc', name: 'ci-kit-pool-55-3', running: true, created: Date.parse('2026-10-15T12:00:00.123Z'),
    repo: 'SSFSKIM/ci-kit-sandbox', runnerId: 901, labels: ['self-hosted', 'ci-kit-pool', 'cpus-4'], cpus: 4, cores: [4, 5, 6, 7],
  });
});

test('every job container announces its cores in the job log, and a clamped one says so', () => {
  const plain = runArgs(spec);
  // The runner accepts a hook only by its extension (.sh, .ps1 or .js); seen live: 'is not a valid path to a script'.
  assert.ok(plain.includes('ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/bin/ci-kit-job-started.sh'));
  assert.ok(plain.includes('CI_KIT_CORES=4-7'));
  assert.ok(!plain.some((a) => a.startsWith('CI_KIT_CLAMPED=')));
  const clamped = runArgs({ ...spec, labels: ['self-hosted', 'ci-kit-pool', 'cpus-16'], cores: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], clamped: 16 });
  assert.ok(clamped.includes('CI_KIT_CLAMPED=16'));
  assert.match(clamped.join(' '), /--cpuset-cpus 0-11 --memory 24g/);
});
