// The hourly check reads pinned declarations and ready-image records, never starts a builder on a no-op or a read failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStale, listBakeExecutions } from '../../gce/bake/stale.mjs';
import { createGitHub } from '../../lib/github.mjs';
import { parseConfig } from '../../plan/config.mjs';
import { setupHash } from '../../setup/hash.mjs';

const repo = 'Owner/Project';
const revision = 'a'.repeat(40);
const declaration = 'version: 1\nsetup:\n  apt: [cowsay]\n';
const hash = setupHash(parseConfig(declaration, { isPrivate: true }).setup);
const parent = 'projects/p/locations/us-central1/jobs';
const self = `${parent}/ci-kit-bake-check/executions/check-1`;
const completed = (name, state = 'CONDITION_SUCCEEDED') => ({ name, createTime: '2026-10-25T00:00:00Z', startTime: '2026-10-25T00:00:01Z', completionTime: '2026-10-25T00:01:00Z', conditions: [{ type: 'Completed', state }], runningCount: 0, reconciling: false });
const image = (value = hash, extra = {}) => ({ name: 'gce-new', family: 'ci-kit-runner', status: 'READY', creationTimestamp: '2026-10-25T00:00:00Z', labels: { 'ci-kit': 'gce-image', 'ci-kit-ready': 'true', ...(value === 'none' ? {} : { 'ci-kit-setup-owner-project': value }) }, ...extra });
const ami = (value = hash, extra = {}) => ({ ImageId: 'ami-new', State: 'available', CreationDate: '2026-10-25T00:00:00Z', Tags: Object.entries({ 'ci-kit-pool': 'ec2', 'ci-kit-ready': 'true', ...(value === 'none' ? {} : { [`ci-kit-setup:${repo}`]: value }) }).map(([Key, Value]) => ({ Key, Value })), ...extra });

function fixture({ config = declaration, script = Buffer.from('echo ok\n'), gceImages = [image()], amis = [ami()], executions = [{ name: self }], configError, scriptError, imageError, accounts } = {}) {
  const calls = [], logs = [];
  const gh = createGitHub('contents-read', { fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    calls.push(['github', url, options]);
    if (path.endsWith('/commits/HEAD')) return Response.json({ sha: revision });
    assert.equal(new URL(url).searchParams.get('ref'), revision, 'config and script use the same pinned revision');
    if (path.endsWith('/contents/.github/ci-kit.yml')) return configError ? Response.json({ message: 'not found' }, { status: configError }) : new Response(config);
    if (path.endsWith('/contents/.github/setup%20script.sh')) return scriptError ? Response.json({ message: 'script missing' }, { status: scriptError }) : new Response(script);
    throw new Error(`unexpected GitHub request ${url}`);
  } });
  return {
    calls, logs,
    options: {
      cfg: { project: 'p', image_family: 'ci-kit-runner', repos: [{ repo }] }, gh,
      execution: 'check-1', job: 'ci-kit-bake-check',
      listExecutions: async job => { calls.push(['executions', job]); return executions.filter(e => e.name.startsWith(`${parent}/${job}/`)); },
      gce: { images: async filter => { calls.push(['images', filter]); if (imageError) throw imageError; return gceImages; } },
      accounts: accounts ?? [{ account: '123', enabled: false, region: 'us-east-2', roles: { bake: 'bake-role' } }],
      awsFor: account => ({ ec2: { send: async command => { calls.push(['aws', account, command]); return { Images: amis }; } } }),
      log: line => logs.push(line),
    },
  };
}

test('current images skip, even when a newer image is unready; disabled EC2 accounts are still checked', async () => {
  const f = fixture({ gceImages: [image('old', { creationTimestamp: '2026-10-24T00:00:00Z' }), image(), image('bad', { labels: { 'ci-kit': 'gce-image', 'ci-kit-ready': 'false' }, creationTimestamp: '2026-10-26T00:00:00Z' })], amis: [ami('old', { CreationDate: '2026-10-24T00:00:00Z' }), ami(), ami('bad', { State: 'pending', CreationDate: '2026-10-26T00:00:00Z' })] });
  assert.equal(await checkStale(f.options), false);
  assert.deepEqual(f.logs, ['bake: images current']);
  assert.deepEqual(f.calls.slice(0, 2), [['executions', 'ci-kit-bake'], ['executions', 'ci-kit-bake-check']]);
  const awsCall = f.calls.find(c => c[0] === 'aws');
  assert.equal(awsCall[1].account, '123');
  assert.equal(awsCall[2].constructor.name, 'DescribeImagesCommand');
  assert.deepEqual(awsCall[2].input.Owners, ['self']);
  assert.deepEqual(awsCall[2].input.Filters, [
    { Name: 'tag:ci-kit-pool', Values: ['ec2'] }, { Name: 'tag:ci-kit-ready', Values: ['true'] }, { Name: 'state', Values: ['available'] },
  ]);
});

for (const provider of ['gce', 'ec2']) {
  test(`${provider}: a different hash continues to the bake; an older matching image cannot hide it`, async () => {
    const f = fixture(provider === 'gce' ? { gceImages: [image(hash, { creationTimestamp: '2026-10-24T00:00:00Z' }), image('outdated')] } : { amis: [ami(hash, { CreationDate: '2026-10-24T00:00:00Z' }), ami('outdated')] });
    assert.equal(await checkStale(f.options), true);
    assert.match(f.logs.join('\n'), new RegExp(`bake: stale ${repo} .*outdated.*${hash}`));
    assert.doesNotMatch(f.logs.join('\n'), /images current/);
  });
  test(`${provider}: no ready image is stale, including when every repository has no declaration`, async () => {
    const f = fixture({ configError: 404, gceImages: [image('none')], amis: [ami('none')], ...(provider === 'gce' ? { gceImages: [] } : { amis: [] }) });
    assert.equal(await checkStale(f.options), true);
    assert.match(f.logs.join('\n'), /no ready image/);
  });
}

test('removed and absent declarations match only an image without that repository hash', async () => {
  for (const config of [{ configError: 404 }, { config: 'version: 1\ngates:\n  - name: test\n    run: npm test\n' }]) {
    const current = fixture({ ...config, gceImages: [image('none')], amis: [ami('none')] });
    assert.equal(await checkStale(current.options), false);
    const removed = fixture({ ...config });
    assert.equal(await checkStale(removed.options), true);
    assert.match(removed.logs.join('\n'), /-> none/);
  }
});

test('script bytes, install, node and pnpm change freshness, but package order and fetch_depth do not', async () => {
  const config = 'version: 1\nsetup:\n  apt: [cowsay, hello]\n  script: .github/setup script.sh\n  install: npm ci\n  node: "22"\n  pnpm: true\n';
  const script = Buffer.from([0x65, 0x63, 0x68, 0x6f, 0x20, 0xff]);
  const expected = setupHash(parseConfig(config, { isPrivate: true }).setup, script);
  for (const [change, bytes, stale] of [
    [config, script, false],
    [config.replace('[cowsay, hello]', '[hello, cowsay, hello]') + '  fetch_depth: 99\n', script, false],
    [config, Buffer.from('echo different\n'), true],
    [config.replace('npm ci', 'npm install'), script, true],
    [config.replace('"22"', '"24"'), script, true],
    [config.replace('pnpm: true', 'pnpm: false'), script, true],
  ]) {
    const f = fixture({ config: change, script: bytes, gceImages: [image(expected)], amis: [ami(expected)] });
    assert.equal(await checkStale(f.options), stale);
  }
});

for (const job of ['ci-kit-bake', 'ci-kit-bake-check']) {
  test(`another ${job} execution stops before reading declarations or images, including pending executions`, async () => {
    const f = fixture({ executions: [{ name: self }, { name: `${parent}/${job}/executions/other`, runningCount: 0, reconciling: true }] });
    assert.equal(await checkStale(f.options), false);
    assert.ok(f.calls.every(c => c[0] === 'executions'));
    assert.match(f.logs.join('\n'), /bake: skipped; .*other.*still running/);
  });
}

test('finished successes, failures and cancellations do not block; our own running execution is excluded', async () => {
  const f = fixture({ executions: [
    { name: self, runningCount: 1 }, completed(`${parent}/ci-kit-bake/executions/ok`),
    completed(`${parent}/ci-kit-bake/executions/failed`, 'CONDITION_FAILED'),
    { ...completed(`${parent}/ci-kit-bake-check/executions/cancelled`, 'CONDITION_FAILED'), completionTime: undefined, cancelledCount: 1 },
  ] });
  assert.equal(await checkStale(f.options), false);
  assert.deepEqual(f.logs, ['bake: images current']);
});

test('missing current Cloud Run identity fails rather than skipping itself or baking unguarded', async () => {
  const f = fixture();
  await assert.rejects(checkStale({ ...f.options, execution: undefined }), /Cloud Run execution/);
  assert.deepEqual(f.calls, []);
});

for (const options of [{ configError: 403 }, { config: declaration + '  script: .github/setup script.sh\n', scriptError: 404 }, { config: 'version: 1\nsetup:\n  apt: [bad=version]\n' }, { imageError: new Error('image read denied') }]) {
  test(`a read/validation failure is an error, not an absent declaration or a bake (${JSON.stringify(options)})`, async () => {
    const f = fixture(options);
    await assert.rejects(checkStale(f.options));
    assert.deepEqual(f.logs, []);
  });
}

test('execution listings page through both jobs using the service-account token; a denied listing fails closed', async () => {
  const urls = [];
  const list = job => listBakeExecutions({ project: 'p', job, token: async () => 'service-account-token', fetchImpl: async (url, options) => {
    urls.push(String(url));
    assert.equal(options.headers.authorization, 'Bearer service-account-token');
    assert.ok(options.signal);
    const next = new URL(url).searchParams.get('pageToken');
    return Response.json(next ? { executions: [{ name: 'older-active' }] } : { executions: [completed('done')], nextPageToken: 'page/2' });
  } });
  for (const job of ['ci-kit-bake', 'ci-kit-bake-check']) assert.equal((await list(job))[1].name, 'older-active');
  assert.equal(urls.length, 4);
  assert.match(urls[0], /^https:\/\/run.googleapis.com\/v2\/projects\/p\/locations\/us-central1\/jobs\/ci-kit-bake\/executions\?/);
  assert.equal(new URL(urls[1]).searchParams.get('pageToken'), 'page/2');
  await assert.rejects(listBakeExecutions({ project: 'p', job: 'ci-kit-bake', token: async () => 'token', fetchImpl: async () => new Response('denied', { status: 403 }) }), /ci-kit-bake.*403/);
});

test('all EC2 accounts and image pages participate, with an account-specific stale log', async () => {
  const f = fixture({ accounts: [{ account: '123' }, { account: '456' }] });
  f.options.awsFor = account => ({ ec2: { send: async command => command.input.NextToken ? { Images: [ami(account.account === '456' ? 'outdated' : hash)] } : { Images: [ami(hash, { CreationDate: '2026-10-24T00:00:00Z' })], NextToken: 'next' } } });
  assert.equal(await checkStale(f.options), true);
  assert.match(f.logs.join('\n'), /ec2\/456.*outdated/);
  assert.doesNotMatch(f.logs.join('\n'), /ec2\/123/);
});
