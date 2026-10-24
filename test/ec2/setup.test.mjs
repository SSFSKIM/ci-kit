import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoles, fisTemplate, ensureRole, setupAccount, identityClaims, publicAccessBlock, reportLifecycle } from '../../ec2/setup-lib.mjs';
import { billingInput, dryRunInput, selectAccount } from '../../ec2/setup-proof.mjs';

const config = {
  account: '290475840169', region: 'us-east-2', security_group: 'sg-pool', report_bucket: 'ci-kit-ec2-reports-290475840169',
  placements: [{ subnet: 'subnet-pool', zone: 'us-east-2c' }],
  roles: Object.fromEntries(['launcher', 'bake', 'guard'].map(name => [name, `arn:aws:iam::290475840169:role/ci-kit-ec2-${name}`])),
};
const guardSubject = 'repo:SSFSKIM/ci-kit:ref:refs/heads/main';
const claims = { sub: '1234567890', azp: '1234567890', aud: 'https://ci-kit/290475840169/ec2' };
const missing = () => Object.assign(new Error('missing'), { code: 'NoSuchEntity' });
const glob = (pattern, value) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(value);
// Exercise the emitted IAM request at its authorization boundary, including per-resource context. This is a
// deliberately small Allow evaluator for the condition operators the policy uses, not an AWS simulator.
function allowed(policy, action, resource, context = {}) {
  return policy.Statement.some(s => s.Effect === 'Allow' && [s.Action].flat().some(a => glob(a, action)) &&
    [s.Resource].flat().some(r => glob(r, resource)) && Object.entries(s.Condition ?? {}).every(([op, entries]) =>
      Object.entries(entries).every(([key, values]) => op === 'StringEquals'
        ? [values].flat().includes(context[key])
        : op === 'Null' ? (context[key] === undefined) === (values === 'true')
          : op === 'ArnLike' ? [values].flat().some(v => glob(v, context[key] ?? '')) : false)));
}
const arn = (kind, id = '*') => `arn:aws:ec2:us-east-2:${['image','snapshot'].includes(kind) ? '' : config.account}:${kind}/${id}`;
const ctx = (more = {}) => ({ 'aws:RequestedRegion': 'us-east-2', ...more });

test('launcher cannot launch foreign images or untagged resources; bake Canonical permission cannot launch jobs or smoke', () => {
  const roles = buildRoles(config, claims, guardSubject);
  const launcher = roles.launcher.policy, bake = roles.bake.policy;
  const imageContext = ctx({ 'ec2:Owner': config.account, 'ec2:ResourceTag/ci-kit-pool': 'ec2' });
  assert.equal(allowed(launcher, 'ec2:RunInstances', arn('image', 'ami-pool'), imageContext), true);
  assert.equal(allowed(launcher, 'ec2:RunInstances', arn('image', 'ami-foreign'), ctx({ 'ec2:Owner': 'amazon', 'aws:ResourceAccount': '099720109477' })), false);
  assert.equal(allowed(bake, 'ec2:RunInstances', arn('image', 'ami-canonical'), ctx({ 'ec2:Owner': 'amazon', 'aws:ResourceAccount': '099720109477' })), true);
  for (const purpose of ['job', 'smoke', 'builder']) {
    const tags = ctx({ 'aws:RequestTag/ci-kit-pool': 'ec2', 'aws:RequestTag/ci-kit-purpose': purpose });
    for (const resource of ['instance', 'volume']) {
      assert.equal(allowed(launcher, 'ec2:RunInstances', arn(resource), tags), purpose !== 'builder');
      assert.equal(allowed(bake, 'ec2:RunInstances', arn(resource), tags), purpose === 'builder');
      assert.equal(allowed(bake, 'ec2:RunInstances', arn(resource), ctx()), false);
    }
  }
  assert.equal(allowed(launcher, 'ec2:RunInstances', arn('subnet', 'subnet-other'), ctx()), false);
  assert.equal(allowed(launcher, 'ec2:RunInstances', arn('subnet', 'subnet-pool'), ctx()), true);
  assert.equal(allowed(launcher, 'ec2:RunInstances', arn('security-group', 'sg-other'), ctx()), false);
  assert.equal(allowed(launcher, 'ec2:RunInstances', arn('instance'), ctx({ 'aws:RequestTag/ci-kit-pool': 'ec2', 'aws:RequestTag/ci-kit-purpose': 'job', 'ec2:InstanceProfile': 'some-profile' })), false);
  assert.equal(allowed(launcher, 'ec2:CreateTags', arn('instance'), ctx()), false);
  assert.equal(allowed(launcher, 'ec2:CreateTags', arn('instance'), ctx({ 'ec2:CreateAction': 'RunInstances', 'aws:RequestTag/ci-kit-pool': 'ec2' })), true);
  assert.equal(allowed(launcher, 'iam:PassRole', '*', {}), false);
  assert.equal(allowed(launcher, 's3:PutObject', `arn:aws:s3:::${config.report_bucket}/reports/a/exit.json`), true);
  assert.equal(allowed(launcher, 's3:PutObject', `arn:aws:s3:::${config.report_bucket}/other/a`), false);
  assert.equal(allowed(launcher, 'ce:GetCostAndUsage', '*', ctx({ 'aws:RequestedRegion': 'us-east-1' })), true);
  assert.equal(allowed(launcher, 'ec2:DescribeInstances', '*', ctx({ 'aws:RequestedRegion': 'us-east-1' })), false);
});

test('report readers can distinguish missing reports without reading or listing another bucket', () => {
  const roles = buildRoles(config, claims, guardSubject);
  for (const role of [roles.launcher, roles.bake]) {
    assert.equal(allowed(role.policy, 's3:ListBucket', `arn:aws:s3:::${config.report_bucket}`), true);
    assert.equal(allowed(role.policy, 's3:ListBucket', 'arn:aws:s3:::another-bucket'), false);
    assert.equal(allowed(role.policy, 's3:GetObject', `arn:aws:s3:::${config.report_bucket}/outside-reports/secret`), false);
  }
});

test('image creation requires tagged builder and tagged outputs; guard cannot launch; FIS targets only isolated sandbox fixtures', () => {
  const roles = buildRoles(config, claims, guardSubject);
  const pool = ctx({ 'ec2:ResourceTag/ci-kit-pool': 'ec2', 'ec2:ResourceTag/ci-kit-purpose': 'builder' });
  assert.equal(allowed(roles.bake.policy, 'ec2:CreateImage', arn('instance'), pool), true);
  assert.equal(allowed(roles.bake.policy, 'ec2:CreateImage', arn('instance'), ctx()), false);
  assert.equal(allowed(roles.bake.policy, 'ec2:CreateImage', arn('image'), ctx({ 'aws:RequestTag/ci-kit-pool': 'ec2' })), true);
  assert.equal(allowed(roles.bake.policy, 'ec2:CreateImage', arn('snapshot'), ctx()), false);
  assert.equal(allowed(roles.bake.policy, 'ec2:CreateTags', arn('image'), ctx({ 'ec2:ResourceTag/ci-kit-pool': 'ec2' })), true);
  assert.equal(allowed(roles.bake.policy, 'ec2:CreateTags', arn('image'), ctx()), false);
  assert.equal(allowed(roles.guard.policy, 'ec2:RunInstances', arn('instance'), pool), false);
  assert.equal(allowed(roles.guard.policy, 'ec2:TerminateInstances', arn('instance'), pool), true);
  const experiment = fisTemplate(config);
  assert.equal(experiment.targets.fixture.selectionMode, 'COUNT(1)');
  assert.equal(experiment.targets.fixture.resourceType, 'aws:ec2:spot-instance');
  const targetTags = experiment.targets.fixture.resourceTags;
  assert.equal(targetTags['ci-kit-fis-fixture'], 'true');
  assert.equal(targetTags['ci-kit-repo'], 'SSFSKIM--ci-kit-sandbox');
  const fisContext = ctx(Object.fromEntries(Object.entries(targetTags).map(([k,v]) => [`ec2:ResourceTag/${k}`,v])));
  assert.equal(allowed(roles.fis.policy, 'ec2:SendSpotInstanceInterruptions', arn('instance'), fisContext), true);
  delete fisContext['ec2:ResourceTag/ci-kit-fis-fixture'];
  assert.equal(allowed(roles.fis.policy, 'ec2:SendSpotInstanceInterruptions', arn('instance'), fisContext), false);
});

test('trust binds observed Google azp/sub and account audience, GitHub main, and FIS source account', () => {
  const roles = buildRoles(config, claims, guardSubject);
  assert.deepEqual(roles.launcher.trust.Statement[0].Condition.StringEquals, {
    'accounts.google.com:sub': claims.sub, 'accounts.google.com:aud': claims.azp, 'accounts.google.com:oaud': claims.aud,
  });
  assert.equal(roles.launcher.duration, 14400);
  assert.equal(roles.bake.duration, 14400);
  assert.equal(roles.guard.trust.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:sub'], 'repo:SSFSKIM/ci-kit:ref:refs/heads/main');
  assert.equal(roles.fis.trust.Statement[0].Condition.StringEquals['aws:SourceAccount'], config.account);
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  assert.deepEqual(identityClaims(token, config.account), claims);
  assert.throws(() => identityClaims(token, '111122223333'), /audience/);
});

test('existing role duration, trust or policy drift fails without any mutation', async () => {
  const expected = buildRoles(config, claims, guardSubject).launcher;
  for (const drift of ['duration', 'trust', 'policy', 'attached']) {
    const calls = [];
    const aws = async (service, operation) => {
      calls.push(operation);
      if (operation === 'get-role') return { Role: { Arn: expected.arn, MaxSessionDuration: drift === 'duration' ? 3600 : 14400, AssumeRolePolicyDocument: drift === 'trust' ? { Statement: [] } : expected.trust } };
      if (operation === 'list-role-policies') return { PolicyNames: ['ci-kit-pool'] };
      if (operation === 'get-role-policy') return { PolicyDocument: drift === 'policy' ? { Statement: [] } : expected.policy };
      if (operation === 'list-attached-role-policies') return { AttachedPolicies: drift === 'attached' ? [{ PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }] : [] };
      throw new Error(`unexpected mutation: ${service} ${operation}`);
    };
    await assert.rejects(ensureRole(aws, expected), /mismatch|differs|unexpected/);
    assert.ok(calls.every(c => /^(get|list)-/.test(c)));
  }
});

test('role creation sets four-hour maximum and re-run validates without mutating', async () => {
  const expected = buildRoles(config, claims, guardSubject).launcher;
  let stored, policy;
  const changes = [];
  const aws = async (_, operation, input) => {
    if (operation === 'get-role') { if (!stored) throw missing(); return { Role: stored }; }
    if (operation === 'create-role') { changes.push(operation); stored = { Arn: expected.arn, MaxSessionDuration: input.MaxSessionDuration, AssumeRolePolicyDocument: JSON.parse(input.AssumeRolePolicyDocument) }; return { Role: stored }; }
    if (operation === 'put-role-policy') { changes.push(operation); policy = JSON.parse(input.PolicyDocument); return {}; }
    if (operation === 'list-role-policies') return { PolicyNames: ['ci-kit-pool'] };
    if (operation === 'get-role-policy') return { PolicyDocument: policy };
    if (operation === 'list-attached-role-policies') return { AttachedPolicies: [] };
    throw new Error(operation);
  };
  assert.equal(await ensureRole(aws, expected, () => {}), true);
  assert.equal(stored.MaxSessionDuration, 14400);
  assert.equal(await ensureRole(aws, expected, () => {}), false);
  assert.deepEqual(changes, ['create-role', 'put-role-policy']);
});

test('operator profile account mismatch stops before any resource read or change', async () => {
  const calls = [];
  await assert.rejects(setupAccount({ config, claims, guardSubject, aws: async (s, op) => {
    calls.push(`${s} ${op}`); return { Account: '111122223333' };
  } }), /account.*mismatch/);
  assert.deepEqual(calls, ['sts get-caller-identity']);
});

test('permission denied fetching an existing role is not misread as missing', async () => {
  const calls = [];
  await assert.rejects(ensureRole(async (_, op) => { calls.push(op); throw Object.assign(new Error('denied'), { code: 'AccessDenied' }); }, buildRoles(config, claims, guardSubject).launcher), /denied/);
  assert.deepEqual(calls, ['get-role']);
});

function accountFixture() {
  const state = { roles: new Map(), policies: new Map(), bucket: false, oidc: null, sg: null, template: null, block: null, lifecycle: null };
  const mutations = [], calls = [];
  const aws = async (service, op, input) => {
    calls.push({ service, op, input });
    if (/^(create|put)-/.test(op)) mutations.push({ service, op, input });
    if (op === 'get-caller-identity') return { Account: config.account };
    if (op === 'get-role') { if (!state.roles.has(input.RoleName)) throw missing(); return { Role: state.roles.get(input.RoleName) }; }
    if (op === 'create-service-linked-role') { state.roles.set('AWSServiceRoleForEC2Spot', {}); return {}; }
    if (op === 'describe-vpcs') return { Vpcs: [{ VpcId: 'vpc-default' }] };
    if (op === 'describe-subnets') return { Subnets: [{ SubnetId: 'subnet-pool', VpcId: 'vpc-default', AvailabilityZone: 'us-east-2c' }] };
    if (op === 'describe-security-groups') return { SecurityGroups: state.sg ? [state.sg] : [] };
    if (op === 'create-security-group') { state.sg = { GroupId: 'sg-pool', IpPermissions: [], IpPermissionsEgress: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }; return { GroupId: 'sg-pool' }; }
    if (op === 'head-bucket') { if (!state.bucket) throw Object.assign(new Error('absent'), { code: '404' }); return {}; }
    if (op === 'create-bucket') { state.bucket = true; return {}; }
    if (op === 'put-public-access-block') { state.block = input.PublicAccessBlockConfiguration; return {}; }
    if (op === 'get-public-access-block') return { PublicAccessBlockConfiguration: state.block };
    if (op === 'get-bucket-location') return { LocationConstraint: 'us-east-2' };
    if (op === 'put-bucket-lifecycle-configuration') { state.lifecycle = input.LifecycleConfiguration; return {}; }
    if (op === 'get-bucket-lifecycle-configuration') return state.lifecycle;
    if (op === 'get-open-id-connect-provider') { if (!state.oidc) throw missing(); return state.oidc; }
    if (op === 'create-open-id-connect-provider') { state.oidc = { Url: input.Url, ClientIDList: input.ClientIDList }; return {}; }
    if (op === 'create-role') { state.roles.set(input.RoleName, { Arn: `arn:aws:iam::${config.account}:role/${input.RoleName}`, MaxSessionDuration: input.MaxSessionDuration, AssumeRolePolicyDocument: JSON.parse(input.AssumeRolePolicyDocument) }); return {}; }
    if (op === 'put-role-policy') { state.policies.set(input.RoleName, JSON.parse(input.PolicyDocument)); return {}; }
    if (op === 'list-role-policies') return { PolicyNames: ['ci-kit-pool'] };
    if (op === 'list-attached-role-policies') return { AttachedPolicies: [] };
    if (op === 'get-role-policy') return { PolicyDocument: state.policies.get(input.RoleName) };
    if (op === 'list-experiment-templates') return { experimentTemplates: state.template ? [state.template] : [] };
    if (op === 'create-experiment-template') { state.template = { ...input, id: 'EXT-fixture' }; return { experimentTemplate: state.template }; }
    if (op === 'get-experiment-template') return { experimentTemplate: state.template };
    throw new Error(`unexpected ${service} ${op}`);
  };
  return { state, mutations, calls, aws };
}

test('account setup creates missing resources then validates an unchanged second run; drift is not silently repaired', async () => {
  const f = accountFixture(), logs = [];
  const input = { config: { ...config, security_group: undefined }, claims, guardSubject, aws: f.aws, log: line => logs.push(line) };
  const created = await setupAccount(input);
  assert.equal(created.config.security_group, 'sg-pool');
  assert.equal(created.changed, true);
  assert.deepEqual(f.state.block, publicAccessBlock);
  assert.deepEqual(f.state.lifecycle, reportLifecycle);
  assert.equal(f.state.roles.size, 5);
  assert.equal(f.state.template.targets.fixture.resourceTags['ci-kit-fis-fixture'], 'true');
  const count = f.mutations.length;
  const existing = await setupAccount({ ...input, config: created.config });
  assert.equal(existing.changed, false);
  assert.equal(f.mutations.length, count);
  assert.ok(logs.includes('setup: nothing to change'));
  f.state.block = { ...publicAccessBlock, BlockPublicPolicy: false };
  await assert.rejects(setupAccount({ ...input, config: created.config }), /public access block mismatch/);
  assert.equal(f.mutations.length, count);
});

test('setup refuses unsafe existing ingress and templates that can target the ordinary pool', async () => {
  const f = accountFixture();
  const input = { config: { ...config, security_group: undefined }, claims, guardSubject, aws: f.aws, log: () => {} };
  const { config: resolved } = await setupAccount(input);
  const count = f.mutations.length;
  f.state.sg.IpPermissions = [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }];
  await assert.rejects(setupAccount({ ...input, config: resolved }), /inbound rules mismatch/);
  f.state.sg.IpPermissions = [];
  f.state.template = structuredClone(f.state.template);
  delete f.state.template.targets.fixture.resourceTags['ci-kit-fis-fixture'];
  await assert.rejects(setupAccount({ ...input, config: resolved }), /FIS template targets mismatch/);
  assert.equal(f.mutations.length, count);
});

test('proof inputs are always DryRun and billing includes gross EC2 compute and other costs, never credentials', () => {
  const input = dryRunInput(config, { image: 'ami-proof', purpose: 'builder' });
  assert.equal(input.DryRun, true);
  assert.equal(input.MinCount, 1);
  assert.equal(input.MaxCount, 1);
  assert.equal(input.InstanceMarketOptions, undefined);
  assert.equal(input.InstanceInitiatedShutdownBehavior, 'stop');
  assert.equal(input.IamInstanceProfile, undefined);
  assert.equal(input.MetadataOptions.HttpTokens, 'required');
  assert.equal(input.TagSpecifications[0].Tags.find(t => t.Key === 'ci-kit-purpose').Value, 'builder');
  const smoke = dryRunInput(config, { image: 'ami-proof', purpose: 'smoke' });
  assert.equal(smoke.InstanceMarketOptions.MarketType, 'spot');
  assert.equal(smoke.InstanceInitiatedShutdownBehavior, 'terminate');
  assert.deepEqual(billingInput(config, { since: '2026-10-23', through: '2026-10-24' }), {
    TimePeriod: { Start: '2026-10-23', End: '2026-10-24' }, Granularity: 'DAILY', Metrics: ['UnblendedCost'],
    Filter: { Dimensions: { Key: 'SERVICE', Values: ['Amazon Elastic Compute Cloud - Compute', 'EC2 - Other'] } },
    GroupBy: [{ Type: 'DIMENSION', Key: 'RECORD_TYPE' }],
  });
  assert.throws(() => selectAccount({ accounts: [config, { ...config, account: '111122223333' }] }), /choose.*account/);
  assert.equal(selectAccount({ accounts: [config] }).account, config.account);
  assert.throws(() => selectAccount({ accounts: [config] }, '111122223333'), /not configured/);
});

for (const script of ['setup-cli.mjs', 'setup-proof.mjs', 'setup.sh']) {
  for (const [flag, expectedStatus, message] of [['--help', 0, /Usage:/], ['--unknown', 1, /Unknown option/]]) {
    test(`${script} through a symlink handles ${flag} rather than silently exiting`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'ci-kit-setup-entry-'));
      try {
        const link = join(dir, 'ec2');
        symlinkSync(fileURLToPath(new URL('../../ec2/', import.meta.url)), link);
        const path = join(link, script);
        const result = spawnSync(script.endsWith('.sh') ? '/bin/bash' : process.execPath, [path, flag], { encoding: 'utf8', timeout: 10_000 });
        assert.equal(result.status, expectedStatus, result.stderr);
        assert.match(`${result.stdout}${result.stderr}`, message);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}


test('Canonical alias must match its numeric owner; another amazon-owned AMI and absent ownership fail closed', () => {
  const { bake, launcher } = buildRoles(config, claims, guardSubject);
  const canonical = ctx({ 'ec2:Owner': 'amazon', 'aws:ResourceAccount': '099720109477' });
  // The controller established this global key with live positive/negative DryRuns. Decoded legacy
  // authorization context spells it aws:Account, not literally aws:ResourceAccount.
  assert.equal(allowed(bake.policy, 'ec2:RunInstances', arn('image', 'ami-0fc53b217ec1ad816'), canonical), true);
  assert.equal(allowed(launcher.policy, 'ec2:RunInstances', arn('image', 'ami-0fc53b217ec1ad816'), canonical), false);
  assert.equal(allowed(bake.policy, 'ec2:RunInstances', arn('image', 'ami-053ef5d7ebe355f4a'), ctx({ 'ec2:Owner': 'amazon', 'aws:ResourceAccount': '137112412989' })), false);
  assert.equal(allowed(bake.policy, 'ec2:RunInstances', arn('image', 'ami-unknown'), ctx({ 'ec2:Owner': 'amazon' })), false);
  assert.equal(allowed(bake.policy, 'ec2:RunInstances', arn('image', 'ami-unknown'), ctx({ 'aws:ResourceAccount': '099720109477' })), false);
  assert.equal(allowed(bake.policy, 'ec2:RunInstances', arn('image', 'ami-unknown'), ctx({ 'ec2:Owner': 'someone-else', 'aws:ResourceAccount': '099720109477' })), false);
});

function roleFixture() {
  const expected = buildRoles(config, claims, guardSubject).bake;
  const state = {
    role: { Arn: expected.arn, MaxSessionDuration: expected.duration, AssumeRolePolicyDocument: structuredClone(expected.trust) },
    policy: structuredClone(expected.policy), attached: [], names: ['ci-kit-pool'],
  };
  const events = [];
  const aws = async (service, operation, input) => {
    events.push({ service, operation, input });
    if (operation === 'get-role') return { Role: state.role };
    if (operation === 'list-attached-role-policies') return { AttachedPolicies: state.attached };
    if (operation === 'list-role-policies') return { PolicyNames: state.names };
    if (operation === 'get-role-policy') return { PolicyDocument: structuredClone(state.policy) };
    if (operation === 'put-role-policy') { state.policy = JSON.parse(input.PolicyDocument); return {}; }
    throw new Error(`unexpected ${service} ${operation}`);
  };
  return { expected, state, aws, events, log: line => events.push({ log: line }) };
}

function driftPolicy(fixture) {
  fixture.state.policy.Statement[0].Action = ['ec2:DescribeInstances'];
  return structuredClone(fixture.state.policy);
}

test('explicit policy update logs both policies before the only write and verifies a fresh readback', async () => {
  const f = roleFixture();
  const before = driftPolicy(f);
  assert.equal(await ensureRole(f.aws, f.expected, f.log, { updatePolicies: true }), true);
  const writes = f.events.filter(e => e.operation && !/^(get|list)-/.test(e.operation));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { service: 'iam', operation: 'put-role-policy', input: {
    RoleName: 'ci-kit-ec2-bake', PolicyName: 'ci-kit-pool', PolicyDocument: JSON.stringify(f.expected.policy),
  } });
  const diffIndex = f.events.findIndex(e => e.log?.includes('---') && e.log.includes('+++'));
  const putIndex = f.events.indexOf(writes[0]);
  assert.ok(diffIndex >= 0 && diffIndex < putIndex, 'auditable diff must be printed before writing');
  const diff = f.events[diffIndex].log;
  assert.match(diff, /ci-kit-ec2-bake\/ci-kit-pool.*current/);
  assert.match(diff, /ci-kit-ec2-bake\/ci-kit-pool.*desired/);
  // A complete before/after diff must reconstruct the actual old and desired policies, not just claim change.
  const deleted = diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).map(line => line.slice(1)).join('\n');
  const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
  assert.deepEqual(JSON.parse(deleted), before);
  assert.deepEqual(JSON.parse(added), f.expected.policy);
  assert.ok(f.events.slice(putIndex + 1).some(e => e.operation === 'get-role-policy'), 'must verify the applied permissions');
  assert.deepEqual(f.state.policy, f.expected.policy);
});

test('default mode refuses changed permissions and explicit mode leaves matching roles alone', async () => {
  const f = roleFixture();
  driftPolicy(f);
  await assert.rejects(ensureRole(f.aws, f.expected, f.log), /permissions mismatch/);
  assert.ok(f.events.every(e => e.operation && /^(get|list)-/.test(e.operation)));
  const clean = roleFixture();
  assert.equal(await ensureRole(clean.aws, clean.expected, clean.log, { updatePolicies: true }), false);
  assert.ok(clean.events.every(e => e.operation && /^(get|list)-/.test(e.operation)));
});

test('explicit mode cannot repair protected role attributes or unexpected policy attachments/names', async () => {
  for (const drift of ['identity', 'duration', 'trust', 'boundary', 'attached', 'extra-policy', 'missing-policy']) {
    const f = roleFixture();
    driftPolicy(f);
    if (drift === 'identity') f.state.role.Arn = 'arn:aws:iam::111122223333:role/ci-kit-ec2-bake';
    if (drift === 'duration') f.state.role.MaxSessionDuration = 3600;
    if (drift === 'trust') f.state.role.AssumeRolePolicyDocument.Statement = [];
    if (drift === 'boundary') f.state.role.PermissionsBoundary = { PermissionsBoundaryArn: 'arn:aws:iam::290475840169:policy/boundary' };
    if (drift === 'attached') f.state.attached = [{ PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }];
    if (drift === 'extra-policy') f.state.names.push('unrelated-policy');
    if (drift === 'missing-policy') f.state.names = [];
    await assert.rejects(ensureRole(f.aws, f.expected, f.log, { updatePolicies: true }), /mismatch|unexpected/);
    assert.ok(f.events.every(e => e.operation && /^(get|list)-/.test(e.operation)), `${drift} must stop before writes or a repair diff`);
  }
});

test('policy update fails if the readback does not match the intended permissions', async () => {
  const f = roleFixture();
  driftPolicy(f);
  const aws = async (service, operation, input) => {
    if (operation === 'put-role-policy') { f.events.push({ service, operation, input }); return {}; }
    return f.aws(service, operation, input);
  };
  await assert.rejects(ensureRole(aws, f.expected, f.log, { updatePolicies: true }), /readback.*mismatch/);
  const put = f.events.findIndex(e => e.operation === 'put-role-policy');
  assert.ok(put >= 0);
  assert.ok(f.events.slice(put + 1).some(e => e.operation === 'get-role-policy'));
  assert.ok(!f.events.some(e => e.log?.startsWith('setup: updated')));
});

test('account setup forwards explicit policy repair and reports an unchanged next run', async () => {
  const f = accountFixture(), logs = [];
  const input = { config: { ...config, security_group: undefined }, claims, guardSubject, aws: f.aws, log: line => logs.push(line) };
  const { config: resolved } = await setupAccount(input);
  f.state.policies.get('ci-kit-ec2-bake').Statement[0].Action = ['ec2:DescribeInstances'];
  const count = f.mutations.length;
  const updated = await setupAccount({ ...input, config: resolved, updatePolicies: true });
  assert.equal(updated.changed, true);
  assert.deepEqual(f.mutations.slice(count).map(({ service, op, input }) => [service, op, input.RoleName, input.PolicyName]), [
    ['iam', 'put-role-policy', 'ci-kit-ec2-bake', 'ci-kit-pool'],
  ]);
  assert.equal((await setupAccount({ ...input, config: resolved, updatePolicies: true })).changed, false);
  assert.equal(f.mutations.length, count + 1);
  assert.equal(logs.at(-1), 'setup: nothing to change');
});

test('CLI accepts explicit policy repair before reading config and cannot treat it as an unknown flag', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../ec2/setup-cli.mjs', import.meta.url)), '--update-policies', '--config', '/ci-kit-no-such-config/file.json'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stderr, /Unknown option/);
});
