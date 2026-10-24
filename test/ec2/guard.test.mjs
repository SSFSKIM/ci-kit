import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEc2Guard, readGuardRows, readGuardAccounts, createGuardAws } from '../../ec2/guard.mjs';
import { renderRow } from '../../gce/launcher/ledger.mjs';

const account = '290475840169';
const now = Date.parse('2026-10-24T12:00:00Z');
const minute = 60_000;
const iso = (offset) => new Date(now + offset * minute).toISOString();
const ledger = { repo: 'SSFSKIM/ci-kit-sandbox', issue_title: 'pool ledger' };
const tags = (purpose, deadline = 30, extra = {}) => Object.entries({
  'ci-kit-pool': 'ec2', 'ci-kit-purpose': purpose, 'ci-kit-deadline': iso(deadline), ...extra,
}).map(([Key, Value]) => ({ Key, Value }));
const instance = (id, purpose, { age = 20, state = 'running', deadline = 30, alloc = id, extra = {} } = {}) => ({
  InstanceId: id, LaunchTime: new Date(now - age * minute), State: { Code: 16, Name: state },
  Tags: tags(purpose, deadline, { 'ci-kit-alloc': alloc, ...extra }),
});
const volume = (id, purpose, { deadline = 30, attached = [], extra = {} } = {}) => ({
  VolumeId: id, State: attached.length ? 'in-use' : 'available', CreateTime: new Date(now - minute),
  Attachments: attached.map((InstanceId) => ({ InstanceId, VolumeId: id, State: 'attached', DeleteOnTermination: true })),
  Tags: tags(purpose, deadline, extra),
});
const image = (id, age, ready, snapshots = [`snap-${id}`]) => ({
  ImageId: id, CreationDate: iso(-age), State: 'available', OwnerId: account,
  Tags: tags('builder', -120, { 'ci-kit-ready': String(ready) }),
  BlockDeviceMappings: snapshots.map((SnapshotId) => ({ DeviceName: '/dev/sda1', Ebs: { SnapshotId, VolumeSize: 50, DeleteOnTermination: true } })),
});
const row = (alloc, state = 'running', overrides = {}) => ({ v: 2, provider: 'ec2', account, alloc, state, ...overrides });

// Fake only the external SDK transport: the guard sends real commands and consumes real AWS response shapes.
function fixture({ instances = [], volumes = [], images = [], snapshots, rows = [], fail = {}, pages = {} } = {}) {
  snapshots ??= images.flatMap((i) => i.BlockDeviceMappings.map((d) => ({
    SnapshotId: d.Ebs.SnapshotId, State: 'completed', OwnerId: account, Tags: tags('builder', -120),
  })));
  const calls = [], logs = [], errors = [], terminated = new Set();
  const results = {
    DescribeInstancesCommand: () => ({ Reservations: [{ ReservationId: 'r-pool', OwnerId: account, Instances: instances }] }),
    DescribeVolumesCommand: (input) => ({ Volumes: input.VolumeIds ? volumes.filter((v) => input.VolumeIds.includes(v.VolumeId)).map((v) => {
      const Attachments = v.Attachments.filter((a) => !terminated.has(a.InstanceId));
      return { ...v, Attachments, State: Attachments.length ? 'in-use' : 'available' };
    }) : volumes }),
    DescribeImagesCommand: () => ({ Images: images }),
    DescribeSnapshotsCommand: () => ({ Snapshots: snapshots }),
  };
  const ec2 = { async send(command) {
    const name = command.constructor.name, input = structuredClone(command.input);
    calls.push({ name, input });
    if (fail[name]) throw new Error(`${name} unavailable`);
    if (pages[name]) return pages[name](input);
    if (name === 'TerminateInstancesCommand') for (const id of input.InstanceIds) terminated.add(id);
    return results[name]?.(input) ?? {};
  } };
  const gh = {
    async openIssues() { if (fail.ledger) throw new Error('ledger unavailable'); return [{ number: 1, title: 'pool ledger', comments: rows.length }]; },
    async closedIssuesSince() { return []; },
    async issueComments() { return rows.map((r, id) => ({ id: id + 1, body: renderRow(r) })); },
  };
  return {
    calls, logs, errors, ec2, gh,
    run: () => runEc2Guard({ ec2, gh, ledger, account, now: () => now, log: (m) => logs.push(m), error: (m) => errors.push(m) }),
    mutations: () => calls.filter((c) => !c.name.startsWith('Describe')),
  };
}
const terminatedIds = (f) => f.mutations().filter((c) => c.name === 'TerminateInstancesCommand').flatMap((c) => c.input.InstanceIds).sort();
const deletedVolumes = (f) => f.mutations().filter((c) => c.name === 'DeleteVolumeCommand').map((c) => c.input.VolumeId).sort();

test('job rules reap stopped, missing-at-15m and late-final instances, not active or young allocations', async () => {
  const f = fixture({ instances: [
    instance('missing', 'job', { age: 15 }), instance('young', 'job', { age: 14.99 }),
    instance('stopped-job', 'job', { age: 1, state: 'stopped' }), instance('late-final', 'job', { age: 1 }),
    instance('active', 'job'), instance('gone', 'job', { state: 'terminated' }),
    instance('stopping', 'job', { state: 'shutting-down' }),
  ], rows: [row('active'), row('late-final', 'final')] });
  assert.equal(await f.run(), 0);
  assert.deepEqual(terminatedIds(f), ['late-final', 'missing', 'stopped-job']);
  for (const id of ['late-final', 'missing', 'stopped-job']) assert.ok(f.logs.some((s) => s.includes(id)));
});

test('builder and smoke lifetimes protect stopped and ledgerless resources until their own deadlines', async () => {
  const f = fixture({ instances: [
    instance('builder-waiting-for-image', 'builder', { age: 90, state: 'stopped' }),
    instance('smoke-before', 'smoke', { age: 25, state: 'stopped' }),
    instance('expired-builder', 'builder', { deadline: -1 }), instance('expired-smoke', 'smoke', { deadline: -1 }),
    instance('expired-active-job', 'job', { deadline: -1 }), instance('at-deadline', 'builder', { deadline: 0 }),
    instance('bad-deadline', 'builder', { extra: { 'ci-kit-deadline': 'broken' } }),
    instance('untagged', 'job', { deadline: -1, extra: { 'ci-kit-pool': 'foreign' } }),
  ], rows: [row('expired-active-job')] });
  assert.equal(await f.run(), 0);
  assert.deepEqual(terminatedIds(f), ['expired-active-job', 'expired-builder', 'expired-smoke']);
});

test('only unattached job volumes or expired volumes are removed; builder and smoke volumes are protected', async () => {
  const f = fixture({ volumes: [
    volume('orphan-job', 'job'), volume('builder-before-image', 'builder'), volume('smoke-before', 'smoke'),
    volume('expired-job', 'job', { deadline: -1 }), volume('expired-builder', 'builder', { deadline: -1 }),
    volume('expired-smoke', 'smoke', { deadline: -1 }),
    volume('foreign', 'job', { deadline: -1, extra: { 'ci-kit-pool': 'other' } }),
  ] });
  assert.equal(await f.run(), 0);
  assert.deepEqual(deletedVolumes(f), ['expired-builder', 'expired-job', 'expired-smoke', 'orphan-job']);
});

test('expired attached volumes terminate their pool instance before deletion, never a foreign attachment', async () => {
  const f = fixture({ instances: [instance('builder', 'builder', { deadline: -1 })], volumes: [
    volume('expired-attached', 'builder', { deadline: -1, attached: ['builder'] }),
    volume('foreign-owner-volume', 'job', { deadline: -1, attached: ['outside-pool'] }),
    volume('live-attached', 'job', { attached: ['builder'] }),
  ] });
  assert.equal(await f.run(), 0);
  assert.deepEqual(terminatedIds(f), ['builder']);
  assert.deepEqual(deletedVolumes(f), ['expired-attached']);
  assert.ok(f.mutations().findIndex((c) => c.name === 'TerminateInstancesCommand') <
    f.mutations().findIndex((c) => c.name === 'DeleteVolumeCommand'));
});

test('an expired volume cannot override a builder or smoke instance protected by its own future deadline', async () => {
  const f = fixture({ instances: [instance('builder-before-image', 'builder', { state: 'stopped' }), instance('smoke-before', 'smoke')],
    volumes: [volume('builder-volume', 'builder', { deadline: -1, attached: ['builder-before-image'] }),
      volume('smoke-volume', 'smoke', { deadline: -1, attached: ['smoke-before'] })] });
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.mutations(), []);
});

test('a volume still detaching after termination is deferred, never detached or deleted while in use', async () => {
  const v = volume('slow-volume', 'job', { deadline: -1, attached: ['slow-instance'] });
  const f = fixture({ instances: [instance('slow-instance', 'job', { deadline: -1 })], volumes: [v],
    pages: { DescribeVolumesCommand: () => ({ Volumes: [v] }) } });
  assert.equal(await f.run(), 0);
  assert.deepEqual(terminatedIds(f), ['slow-instance']);
  assert.deepEqual(deletedVolumes(f), []);
  assert.ok(f.logs.some((s) => /slow-volume/.test(s) && /defer/.test(s)));
});

test('a volume already removed by DeleteOnTermination is success, not an inventory failure', async () => {
  const f = fixture({ instances: [instance('expired', 'job', { deadline: -1 })],
    pages: { DescribeVolumesCommand: (input) => {
      if (input.VolumeIds) throw Object.assign(new Error('volume no longer exists'), { name: 'InvalidVolume.NotFound' });
      return { Volumes: [volume('auto-deleted', 'job', { deadline: -1, attached: ['expired'] })] };
    } } });
  assert.equal(await f.run(), 0);
  assert.deepEqual(terminatedIds(f), ['expired']);
  assert.deepEqual(deletedVolumes(f), []);
});

test('failed ledger reads do not prove missing or final rows, but independent stopped/deadline rules still work', async () => {
  const f = fixture({ fail: { ledger: true }, instances: [
    instance('unknown-row', 'job'), instance('final-but-unread', 'job', { age: 1 }),
    instance('stopped', 'job', { state: 'stopped' }), instance('expired', 'smoke', { deadline: -1 }),
  ], rows: [row('final-but-unread', 'final')] });
  assert.equal(await f.run(), 1);
  assert.deepEqual(terminatedIds(f), ['expired', 'stopped']);
  assert.match(f.errors.join('\n'), /ledger/);
});

test('a failed instance listing cannot establish orphan volumes, but volume deadlines remain independent', async () => {
  const f = fixture({ fail: { DescribeInstancesCommand: true }, volumes: [
    volume('not-proven-orphan', 'job'), volume('expired-unattached', 'builder', { deadline: -1 }),
    volume('expired-attached', 'job', { deadline: -1, attached: ['unobserved'] }),
  ] });
  assert.equal(await f.run(), 1);
  assert.deepEqual(terminatedIds(f), []);
  assert.deepEqual(deletedVolumes(f), ['expired-unattached']);
});

test('failed volume inventory cannot supply deletions or terminate its presumed attachment', async () => {
  const f = fixture({ fail: { DescribeVolumesCommand: true }, instances: [instance('builder', 'builder')],
    volumes: [volume('expired', 'builder', { deadline: -1, attached: ['builder'] })] });
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.mutations(), []);
});

test('partial paginated inventories are discarded if any later page fails', async () => {
  const f = fixture({ pages: { DescribeInstancesCommand: ({ NextToken }) => {
    if (NextToken) throw new Error('page two failed');
    return { Reservations: [{ Instances: [instance('not-authoritative', 'job', { state: 'stopped' })] }], NextToken: 'second' };
  } }, volumes: [volume('not-proven-orphan', 'job')] });
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.mutations(), []);
});

test('pool inventories are paged and every list is constrained by pool tags and ownership where supported', async () => {
  const f = fixture({ pages: {
    DescribeInstancesCommand: ({ NextToken }) => NextToken ? { Reservations: [{ Instances: [instance('page-two', 'job', { state: 'stopped' })] }] } : { Reservations: [], NextToken: 'next' },
    DescribeVolumesCommand: ({ NextToken }) => NextToken ? { Volumes: [volume('vol-page-two', 'job')] } : { Volumes: [], NextToken: 'next' },
    DescribeImagesCommand: ({ NextToken }) => NextToken ? { Images: [image('old-unready', 1441, false)] } : { Images: [], NextToken: 'next' },
    DescribeSnapshotsCommand: ({ NextToken }) => NextToken ? { Snapshots: [{ SnapshotId: 'snap-old-unready', Tags: tags('builder') }] } : { Snapshots: [], NextToken: 'next' },
  } });
  assert.equal(await f.run(), 0);
  assert.deepEqual(terminatedIds(f), ['page-two']);
  assert.deepEqual(deletedVolumes(f), ['vol-page-two']);
  assert.ok(f.mutations().some((c) => c.input.SnapshotId === 'snap-old-unready'));
  for (const name of ['DescribeInstancesCommand', 'DescribeVolumesCommand', 'DescribeImagesCommand', 'DescribeSnapshotsCommand']) {
    const input = f.calls.find((c) => c.name === name).input;
    assert.deepEqual(input.Filters, [{ Name: 'tag:ci-kit-pool', Values: ['ec2'] }]);
  }
  assert.deepEqual(f.calls.find((c) => c.name === 'DescribeImagesCommand').input.Owners, ['self']);
  assert.deepEqual(f.calls.find((c) => c.name === 'DescribeSnapshotsCommand').input.OwnerIds, ['self']);
});

test('image policy keeps the newest two ready generations and removes day-old unready images with tagged snapshots only', async () => {
  const images = [image('ready-old', 2000, true), image('ready-new', 2, true), image('ready-second', 100, true),
    image('unready-old', 1441, false, ['snap-owned', 'snap-foreign', 'snap-owned']), image('unready-young', 1439, false),
    { ...image('foreign-image', 2000, false), Tags: [] }];
  const snapshots = ['snap-ready-old', 'snap-owned', 'snap-foreign'].map((SnapshotId) => ({
    SnapshotId, Tags: SnapshotId === 'snap-foreign' ? [] : tags('builder'),
  }));
  const f = fixture({ images, snapshots });
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.mutations().filter((c) => c.name === 'DeregisterImageCommand').map((c) => c.input.ImageId).sort(), ['ready-old', 'unready-old']);
  assert.deepEqual(f.mutations().filter((c) => c.name === 'DeleteSnapshotCommand').map((c) => c.input.SnapshotId).sort(), ['snap-owned', 'snap-ready-old']);
  for (const id of ['ready-old', 'unready-old', 'snap-owned', 'snap-ready-old']) assert.ok(f.logs.some((s) => s.includes(id)));
});

test('retained images protect shared snapshots from the older-generation cleanup', async () => {
  const f = fixture({ images: [image('old', 300, true, ['snap-shared']), image('second', 200, true), image('new', 100, true, ['snap-shared'])] });
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.mutations(), [{ name: 'DeregisterImageCommand', input: { ImageId: 'old' } }]);
});

for (const failed of ['DescribeImagesCommand', 'DescribeSnapshotsCommand']) {
  test(`${failed} failure prevents partial image/snapshot cleanup without blocking independent jobs`, async () => {
    const f = fixture({ fail: { [failed]: true }, images: [image('old', 2000, false)], instances: [instance('stopped', 'job', { state: 'stopped' })] });
    assert.equal(await f.run(), 1);
    assert.deepEqual(terminatedIds(f), ['stopped']);
    assert.equal(f.mutations().filter((c) => /Image|Snapshot/.test(c.name)).length, 0);
  });
}

test('failed termination protects attached volumes and does not stop independent actions', async () => {
  const f = fixture({ fail: { TerminateInstancesCommand: true }, instances: [instance('doomed', 'job', { deadline: -1 })],
    volumes: [volume('attached', 'job', { deadline: -1, attached: ['doomed'] }), volume('orphan', 'job')] });
  assert.equal(await f.run(), 1);
  assert.deepEqual(deletedVolumes(f), ['orphan']);
  assert.match(f.errors.join('\n'), /doomed/);
});

test('ledger matches are scoped to the EC2 account; a different provider/account never finalizes a young VM', async () => {
  const f = fixture({ instances: [instance('other-account', 'job', { age: 1 }), instance('other-provider', 'job', { age: 1 })],
    rows: [row('other-account', 'final', { account: '111122223333' }), row('other-provider', 'final', { provider: 'gce' })] });
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.mutations(), []);
});

test('guard reads historical closed ledger issues without mutating/rotating the ledger and prefers a final duplicate', async () => {
  const calls = [];
  const gh = {
    async openIssues(repo) { calls.push(['open', repo]); return [{ number: 1, title: 'pool ledger' }, { number: 9, title: 'pool ledger unrelated' }, { number: 10, title: 'pool ledger', pull_request: {} }]; },
    async closedIssuesSince(repo, since) { calls.push(['closed', repo, since]); return [{ number: 2, title: 'pool ledger from 2026-10-20' }, { number: 3, title: 'ec2 credit 290475840169' }]; },
    async issueComments(repo, id, opts) {
      calls.push(['comments', repo, id, opts]);
      return [{ id, body: renderRow(row('old-allocation', id === 2 ? 'final' : 'running')) }];
    },
  };
  const rows = await readGuardRows(gh, ledger);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'final');
  assert.deepEqual(calls.filter((c) => c[0] === 'comments').map((c) => c.slice(2)), [[1, undefined], [2, undefined]]);
  assert.equal(calls.find((c) => c[0] === 'closed')[2], '1970-01-01T00:00:00.000Z');
});

test('a failed historical comment page fails the ledger read instead of treating rows as absent', async () => {
  const gh = { async openIssues() { return [{ number: 1, title: ledger.issue_title }]; }, async closedIssuesSince() { return []; },
    async issueComments() { throw new Error('comments unavailable'); } };
  await assert.rejects(readGuardRows(gh, ledger), /comments unavailable/);
});

test('matrix discovery includes disabled accounts, distinguishes absent config from unreadable/invalid config', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ci-kit-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'ec2.json');
  assert.deepEqual(await readGuardAccounts(path), []);
  const cfg = JSON.parse(await readFile(new URL('../../pool/config/ec2.json', import.meta.url), 'utf8'));
  const second = structuredClone(cfg.accounts[0]);
  second.account = '111122223333'; second.enabled = false;
  for (const name of Object.keys(second.roles)) second.roles[name] = second.roles[name].replace(account, second.account);
  cfg.enabled = false;
  cfg.accounts = [{ ...cfg.accounts[0], enabled: false }, second];
  await writeFile(path, JSON.stringify(cfg));
  assert.deepEqual((await readGuardAccounts(path)).map((a) => a.account), [account, second.account]);
  await assert.rejects(readGuardAccounts(dir), /EISDIR/);
  await writeFile(path, '{invalid');
  await assert.rejects(readGuardAccounts(path));
});

test('GitHub OIDC is exchanged with regional STS and credentials stay on the explicit in-memory SDK client', async () => {
  const calls = [], requests = [];
  const roleArn = `arn:aws:iam::${account}:role/ci-kit-ec2-guard`;
  const aws = await createGuardAws({ account, region: 'us-east-2', roles: { guard: roleArn } }, {
    env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/token?api-version=2', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-request-token' },
    now: () => now, log: () => {},
    fetchImpl: async (url, options) => { requests.push({ url: new URL(url), options }); return Response.json({ value: 'github-oidc-token' }); },
    sts: { async send(command) { calls.push({ name: command.constructor.name, input: command.input }); return { Credentials: {
      AccessKeyId: 'temporary-key', SecretAccessKey: 'temporary-secret', SessionToken: 'temporary-session', Expiration: new Date(now + 3600_000),
    } }; } },
  });
  assert.equal(requests[0].url.searchParams.get('audience'), 'sts.amazonaws.com');
  assert.equal(requests[0].url.searchParams.get('api-version'), '2');
  assert.deepEqual(requests[0].options.headers, { Authorization: 'Bearer github-request-token' });
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.deepEqual(calls, [{ name: 'AssumeRoleWithWebIdentityCommand', input: {
    RoleArn: roleArn, RoleSessionName: 'ci-kit-guard', DurationSeconds: 3600, WebIdentityToken: 'github-oidc-token',
  } }]);
  assert.equal(await aws.ec2.config.region(), 'us-east-2');
  const { accessKeyId, secretAccessKey, sessionToken, expiration } = await aws.ec2.config.credentials();
  assert.deepEqual({ accessKeyId, secretAccessKey, sessionToken, expiration }, {
    accessKeyId: 'temporary-key', secretAccessKey: 'temporary-secret', sessionToken: 'temporary-session', expiration: new Date(now + 3600_000),
  });
  aws.ec2.destroy();
});

test('OIDC/authentication errors cannot fall back to ambient AWS keys or Google identity', async () => {
  const cfg = { account, region: 'us-east-2', roles: { guard: `arn:aws:iam::${account}:role/ci-kit-ec2-guard` } };
  await assert.rejects(createGuardAws(cfg, { env: {} }), /OIDC/);
  await assert.rejects(createGuardAws({ ...cfg, region: 'us-west-2' }, { env: {} }), /us-east-2/);
  await assert.rejects(createGuardAws({ ...cfg, roles: { guard: 'arn:aws:iam::111122223333:role/ci-kit-ec2-guard' } }, { env: {} }), /account/);
  const options = { env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.com/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' }, now: () => now };
  await assert.rejects(createGuardAws(cfg, { ...options, fetchImpl: async () => new Response('sensitive body', { status: 403 }) }), /HTTP 403/);
  await assert.rejects(createGuardAws(cfg, { ...options, fetchImpl: async () => Response.json({}), sts: { async send() { throw new Error('must not assume'); } } }), /OIDC/);
  await assert.rejects(createGuardAws(cfg, { ...options, fetchImpl: async () => Response.json({ value: 'token' }), sts: { async send() { return { Credentials: {} }; } } }), /session/);
});
