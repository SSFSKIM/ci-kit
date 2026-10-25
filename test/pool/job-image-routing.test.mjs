import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as container from '../../pool/vm/container.mjs';
import { jobRunArgs } from '../../pool/vm/run.mjs';

for (const [scenario, repo, present, expected, label = repo] of [
  ['repository image baked', 'SSFSKIM/MAWS', true, 'ci-kit-job/ssfskim-maws:latest'],
  ['repository without a baked declaration', 'SSFSKIM/ci-kit-sandbox', false, 'ci-kit-runner:latest'],
  ['launcher first, image predates repository images', 'SSFSKIM/MAWS', false, 'ci-kit-runner:latest'],
  ['image first, old launcher omits repository', undefined, true, 'ci-kit-runner:latest'],
  ['GCE metadata 404 from old launcher', null, true, 'ci-kit-runner:latest'],
  ['a normalized alias cannot use another repository image', 'SSFSKIM/tool-box', true, 'ci-kit-runner:latest', 'SSFSKIM/tool.box'],
  ['an unlabeled old image falls back to base', 'SSFSKIM/MAWS', true, 'ci-kit-runner:latest', ''],
  ['GitHub repository identity is case insensitive', 'SSFSKIM/MAWS', true, 'ci-kit-job/ssfskim-maws:latest', 'ssfskim/maws'],
]) {
  test(scenario, async () => {
    const calls = [], logs = [];
    const image = await container.selectJobImage(repo, { exec: async (cmd, args, options) => {
      calls.push([cmd, ...args]);
      assert.ok(options.timeout > 0);
      if (!present) throw new Error('No such image');
      return { stdout: `${label}\n` };
    }, log: message => logs.push(message) });
    assert.equal(image, expected);
    assert.ok(logs.some(line => line.startsWith(`job image ${expected}`)));
    if (repo && present && label?.toLowerCase() !== repo.toLowerCase()) assert.match(logs[0], /lacks matching CI_KIT_REPO/);
    assert.deepEqual(calls, repo ? [['docker', 'image', 'inspect', '--format', '{{index .Config.Labels "CI_KIT_REPO"}}', `ci-kit-job/${repo.toLowerCase().replace('/', '-')}:latest`]] : []);
    const args = jobRunArgs({ name: 'job', cpus: 2, image });
    assert.equal(args.at(-1), expected);
    assert.ok(!args.some(arg => arg.startsWith('CI_KIT_SETUP_HASH')), 'inherit hash from the selected image, not the host');
    assert.ok(!args.includes('--pull'), 'only baked local images are eligible');
  });
}

test('repository punctuation uses the same identity as the bake', async () => {
  const calls = [];
  assert.equal(await container.selectJobImage('Owner/Some.Repo_name', {
    exec: async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: 'Owner/Some.Repo_name' }; },
    log: () => {},
  }), 'ci-kit-job/owner-some-repo-name:latest');
  assert.deepEqual(calls, [['docker', 'image', 'inspect', '--format', '{{index .Config.Labels "CI_KIT_REPO"}}', 'ci-kit-job/owner-some-repo-name:latest']]);
});

for (const [scenario, repo, present, smoke, expected, label = repo] of [
  ['both deployed', 'SSFSKIM/MAWS', true, undefined, 'ci-kit-job/ssfskim-maws:latest'],
  ['image first', undefined, true, undefined, 'ci-kit-runner:latest'],
  ['launcher first', 'SSFSKIM/MAWS', false, undefined, 'ci-kit-runner:latest'],
  ['smoke', 'SSFSKIM/MAWS', true, { expectCpus: 2 }, 'ci-kit-runner:latest'],
  ['alias image', 'SSFSKIM/tool-box', true, undefined, 'ci-kit-runner:latest', 'SSFSKIM/tool.box'],
  ['unlabeled image', 'SSFSKIM/MAWS', true, undefined, 'ci-kit-runner:latest', ''],
]) {
  test(`EC2 container ${scenario}: lookup, log, start, attach and wait keep the selected image`, async () => {
    const calls = [];
    const result = await container.runContainer({ name: 'job', repo, jit: 'secret-jit', cpus: 2, smoke,
      log: message => calls.push(['log', message]), onStarted: async () => calls.push(['started']),
    }, {
      exec: async (cmd, args, options) => {
        calls.push([cmd, args]);
        if (args[0] === 'image') {
          if (!present) throw new Error('No such image');
          return { stdout: `${label}\n` };
        }
        if (args[0] === 'run') {
          assert.equal(args.at(-1), expected);
          assert.equal(options.env.CI_KIT_JIT, 'secret-jit');
          assert.ok(!args.includes('secret-jit'));
          return { stdout: 'container-id\n' };
        }
        assert.equal(args[0], 'wait');
        return { stdout: '7\n' };
      },
      runDocker: async args => { calls.push(['attach', args]); return { code: 0, out: 'output' }; },
    });
    assert.deepEqual(result, { code: 7, out: 'output' });
    const runIndex = calls.findIndex(c => c[0] === 'docker' && c[1][0] === 'run');
    const logIndex = calls.findIndex(c => c[0] === 'log' && c[1].startsWith(`job image ${expected}`));
    assert.ok(logIndex >= 0 && logIndex < runIndex);
    if (repo && present && !smoke && label?.toLowerCase() !== repo.toLowerCase()) assert.match(calls[logIndex][1], /lacks matching CI_KIT_REPO/);
    assert.ok(calls.findIndex(c => c[0] === 'started') > runIndex);
    assert.ok(calls.findIndex(c => c[0] === 'attach') > runIndex);
    if (smoke || !repo) assert.ok(!calls.some(c => c[0] === 'docker' && c[1][0] === 'image'));
  });
}
