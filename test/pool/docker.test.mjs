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
  for (const env of ['RUNNER_TOOL_CACHE', 'npm_config_cache', 'npm_config_store_dir', 'PLAYWRIGHT_BROWSERS_PATH', 'ELECTRON_CACHE']) {
    assert.ok(args.includes(`${env}=${CACHE}/${{ RUNNER_TOOL_CACHE: 'toolcache', npm_config_cache: 'npm', npm_config_store_dir: 'pnpm-store', PLAYWRIGHT_BROWSERS_PATH: 'ms-playwright', ELECTRON_CACHE: 'electron' }[env]}`), env);
  }
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
