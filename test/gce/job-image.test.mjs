import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGuest } from '../../gce/vm/job.mjs';
import { selectJobImage } from '../../pool/vm/container.mjs';

function fixture({ repo, present = true, smoke = null, jit = 'secret-jit' } = {}) {
  const calls = [];
  const values = { name: 'ci-kit-gce-test', 'attributes/ci-kit-jit': jit, 'attributes/ci-kit-smoke': smoke,
    'attributes/ci-kit-repo': repo ?? null };
  return { calls, deps: {
    meta: async key => { calls.push(['metadata', key]); return values[key]; },
    report: async (...args) => calls.push(['report', ...args]),
    log: text => calls.push(['log', text]),
    prepareContainer: async name => calls.push(['prepare', name]),
    smokeJobImages: async () => calls.push(['smoke-images']),
    cpus: 4,
    selectJobImage: repo => selectJobImage(repo, { exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (!present) throw new Error('No such image');
    } }),
    docker: async (args, options) => {
      calls.push(['run', args, options]);
      return { code: 0, out: 'ci-kit smoke: ok\n' };
    },
  } };
}

for (const [scenario, repo, present, expected] of [
  ['both deployed', 'SSFSKIM/MAWS', true, 'ci-kit-job/ssfskim-maws:latest'],
  ['image first, old launcher', undefined, true, 'ci-kit-runner:latest'],
  ['launcher first, no repository image yet', 'SSFSKIM/MAWS', false, 'ci-kit-runner:latest'],
]) {
  test(`GCE ${scenario}: the actual startup selects and announces its image before Docker`, async () => {
    const f = fixture({ repo, present });
    await runGuest(f.deps);
    const runIndex = f.calls.findIndex(c => c[0] === 'run');
    const [, args, options] = f.calls[runIndex];
    assert.equal(args.at(-1), expected);
    const logIndex = f.calls.findIndex(c => c[0] === 'log' && c[1] === `job image ${expected}`);
    assert.ok(logIndex >= 0 && logIndex < runIndex);
    assert.deepEqual(options.env, { CI_KIT_JIT: 'secret-jit' });
    assert.ok(!args.includes('secret-jit'));
    assert.deepEqual(f.calls.at(-1), ['report', 'job', 'exit:0']);
  });
}

test('GCE smoke stays on the base and checks every baked repository image separately', async () => {
  const f = fixture({ repo: 'SSFSKIM/MAWS', smoke: '4', jit: null });
  await runGuest(f.deps);
  assert.ok(f.calls.some(c => c[0] === 'smoke-images'));
  assert.equal(f.calls.find(c => c[0] === 'run')[1].at(-1), 'ci-kit-runner:latest');
  assert.ok(!f.calls.some(c => c[0] === 'docker'));
  assert.deepEqual(f.calls.at(-1), ['report', 'smoke', 'ok']);
});
