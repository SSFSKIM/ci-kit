// Setup's AWS CLI boundary takes service, operation and the operation's JSON input. Existing resources are
// validated by default. Explicit policy repair replaces only ci-kit-pool after validating the role's identity,
// trust, duration and other policy attachments; it logs the replacement and verifies the resulting permissions.
import { isDeepStrictEqual } from 'node:util';

const VERSION = '2012-10-17';
const TAGS = [{ Key: 'ci-kit-pool', Value: 'ec2' }];
const REGION = 'us-east-2';
const fixtureTags = { 'ci-kit-pool': 'ec2', 'ci-kit-purpose': 'job', 'ci-kit-repo': 'SSFSKIM--ci-kit-sandbox', 'ci-kit-fis-fixture': 'true' };
export const publicAccessBlock = { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true };
export const reportLifecycle = { Rules: [{ ID: 'ci-kit-reports', Status: 'Enabled', Filter: { Prefix: 'reports/' }, Expiration: { Days: 7 } }] };

const document = Statement => ({ Version: VERSION, Statement });
const statement = (Action, Resource, Condition) => ({ Effect: 'Allow', Action, Resource, ...(Condition ? { Condition } : {}) });
const regionCondition = extra => ({ StringEquals: { 'aws:RequestedRegion': REGION, ...extra } });
const pooled = { 'ec2:ResourceTag/ci-kit-pool': 'ec2' };
const missing = async (fn, codes = ['NoSuchEntity']) => {
  try { return await fn(); } catch (error) { if (codes.includes(error.code)) return null; throw error; }
};
const parseDocument = value => typeof value === 'string' ? JSON.parse(value.startsWith('%') ? decodeURIComponent(value) : value) : value;
// AWS preserves policy semantics, not object order. Statement/action/resource ordering is immaterial here.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const matches = (actual, expected) => isDeepStrictEqual(canonical(actual), canonical(expected));
function equal(actual, expected, label) {
  if (!matches(actual, expected)) throw new Error(`setup: ${label} mismatch; existing resource left unchanged`);
}

export function identityClaims(token, account) {
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { throw new Error('setup: unreadable Google ID token claims'); }
  if (claims.aud !== `https://ci-kit/${account}/ec2`) throw new Error('setup: Google token audience mismatch');
  if (!/^\d+$/.test(claims.sub) || !claims.azp) throw new Error('setup: Google token must contain numeric sub and observed azp');
  return { sub: claims.sub, azp: claims.azp, aud: claims.aud };
}

function validateConfig(config) {
  if (!/^\d{12}$/.test(config.account) || config.region !== REGION) throw new Error('setup: expected a 12-digit account and region us-east-2');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.report_bucket ?? '')) throw new Error('setup: report_bucket is required');
  if (!config.placements?.length || config.placements.some(p => !p.subnet || !p.zone?.startsWith('us-east-2'))) throw new Error('setup: explicit regional subnet placements are required');
  for (const name of ['launcher', 'bake', 'guard']) {
    equal(config.roles?.[name], `arn:aws:iam::${config.account}:role/ci-kit-ec2-${name}`, `${name} role ARN`);
  }
}

export function buildRoles(config, claims) {
  validateConfig(config);
  if (claims.aud !== `https://ci-kit/${config.account}/ec2` || !claims.sub || !claims.azp) throw new Error('setup: Google identity claims mismatch');
  const { account, security_group: sg, report_bucket: bucket } = config;
  if (!sg) throw new Error('setup: security group must be resolved before building policies');
  const arn = (type, id = '*') => `arn:aws:ec2:${REGION}:${['image', 'snapshot'].includes(type) ? '' : account}:${type}/${id}`;
  const regional = (actions, resources, conditions = {}) => statement(actions, resources, regionCondition(conditions));
  const reads = regional([
    'ec2:DescribeInstances', 'ec2:DescribeImages', 'ec2:DescribeInstanceTypes', 'ec2:DescribeInstanceTypeOfferings',
    'ec2:DescribeAvailabilityZones', 'ec2:DescribeSpotPriceHistory', 'ec2:DescribeVolumes', 'ec2:DescribeSnapshots',
  ], '*');
  const cleanup = [regional('ec2:TerminateInstances', arn('instance'), pooled), regional('ec2:DeleteVolume', arn('volume'), pooled)];
  const imageCleanup = [regional('ec2:DeregisterImage', arn('image'), pooled), regional('ec2:DeleteSnapshot', arn('snapshot'), pooled)];
  // GetObject returns 403 instead of NoSuchKey without ListBucket, making an absent report indistinguishable
  // from broken access. Only this dedicated bucket's names are listable; object access stays under reports/.
  const reports = [statement(['s3:PutObject', 's3:GetObject'], `arn:aws:s3:::${bucket}/reports/*`),
    statement('s3:ListBucket', `arn:aws:s3:::${bucket}`)];
  const launch = purposes => [
    regional('ec2:RunInstances', arn('image'), { 'ec2:Owner': account, ...pooled }),
    regional('ec2:RunInstances', [...new Set(config.placements.map(p => arn('subnet', p.subnet))), arn('security-group', sg), arn('network-interface')]),
    { ...regional('ec2:RunInstances', arn('instance'), { 'aws:RequestTag/ci-kit-pool': 'ec2', 'aws:RequestTag/ci-kit-purpose': purposes }),
      Condition: { ...regionCondition({ 'aws:RequestTag/ci-kit-pool': 'ec2', 'aws:RequestTag/ci-kit-purpose': purposes }), Null: { 'ec2:InstanceProfile': 'true' } } },
    regional('ec2:RunInstances', arn('volume'), { 'aws:RequestTag/ci-kit-pool': 'ec2', 'aws:RequestTag/ci-kit-purpose': purposes }),
    regional('ec2:CreateTags', [arn('instance'), arn('volume')], { 'ec2:CreateAction': 'RunInstances', 'aws:RequestTag/ci-kit-pool': 'ec2' }),
  ];
  const googleTrust = document([{
    Effect: 'Allow', Principal: { Federated: 'accounts.google.com' }, Action: 'sts:AssumeRoleWithWebIdentity',
    Condition: { StringEquals: { 'accounts.google.com:sub': claims.sub, 'accounts.google.com:aud': claims.azp, 'accounts.google.com:oaud': claims.aud } },
  }]);
  const role = (name, trust, policy, duration = 3600) => ({ name: `ci-kit-ec2-${name}`, arn: `arn:aws:iam::${account}:role/ci-kit-ec2-${name}`, trust, policy: document(policy), duration });
  return {
    launcher: role('launcher', googleTrust, [reads, ...cleanup, ...launch(['job', 'smoke']), ...reports,
      statement('servicequotas:GetServiceQuota', `arn:aws:servicequotas:${REGION}:${account}:ec2/*`, regionCondition()),
      statement('ce:GetCostAndUsage', '*', { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } }),
    ], 14400),
    // RunInstances evaluates image and created-resource contexts independently. An image has no RequestTag
    // key. Builder-only here plus pool-image-only launcher smoke enforces Canonical => builder at IAM itself.
    bake: role('bake', googleTrust, [reads, ...cleanup, ...launch(['builder']), ...reports,
      // Public Canonical AMIs use the amazon owner alias. Bind it to Canonical's numeric resource account,
      // rather than granting every publisher that shares that alias (verified with positive/negative DryRuns).
      regional('ec2:RunInstances', arn('image'), { 'ec2:Owner': 'amazon', 'aws:ResourceAccount': '099720109477' }),
      regional(['ec2:StopInstances', 'ec2:CreateImage'], arn('instance'), { ...pooled, 'ec2:ResourceTag/ci-kit-purpose': 'builder' }),
      regional('ec2:CreateImage', [arn('image'), arn('snapshot')], { 'aws:RequestTag/ci-kit-pool': 'ec2' }),
      regional('ec2:CreateTags', [arn('image'), arn('snapshot')], { 'ec2:CreateAction': 'CreateImage', 'aws:RequestTag/ci-kit-pool': 'ec2' }),
      regional('ec2:CreateTags', [arn('image'), arn('snapshot')], pooled), ...imageCleanup,
      statement('ssm:GetParameter', `arn:aws:ssm:${REGION}::parameter/aws/service/canonical/ubuntu/*`, regionCondition()),
    ], 14400),
    guard: role('guard', document([{
      Effect: 'Allow', Principal: { Federated: `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com` }, Action: 'sts:AssumeRoleWithWebIdentity',
      Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:SSFSKIM/ci-kit:ref:refs/heads/main' } },
    }]), [reads, ...cleanup, ...imageCleanup]),
    fis: role('fis', document([{
      Effect: 'Allow', Principal: { Service: 'fis.amazonaws.com' }, Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'aws:SourceAccount': account }, ArnLike: { 'aws:SourceArn': `arn:aws:fis:${REGION}:${account}:experiment/*` } },
    }]), [regional(['ec2:DescribeInstances'], '*'), regional('ec2:SendSpotInstanceInterruptions', arn('instance'),
      Object.fromEntries(Object.entries(fixtureTags).map(([k,v]) => [`ec2:ResourceTag/${k}`, v])))]),
  };
}

export function fisTemplate(config) {
  return {
    description: 'ci-kit isolated sandbox spot interruption',
    roleArn: `arn:aws:iam::${config.account}:role/ci-kit-ec2-fis`,
    stopConditions: [{ source: 'none' }],
    targets: { fixture: { resourceType: 'aws:ec2:spot-instance', resourceTags: fixtureTags,
      filters: [{ path: 'State.Name', values: ['running'] }], selectionMode: 'COUNT(1)' } },
    actions: { interrupt: { actionId: 'aws:ec2:send-spot-instance-interruptions', parameters: { durationBeforeInterruption: 'PT2M' }, targets: { SpotInstances: 'fixture' } } },
    tags: { 'ci-kit-pool': 'ec2', 'ci-kit-purpose': 'fis-fixture' },
  };
}

export async function ensureRole(aws, expected, log = console.log, { updatePolicies = false } = {}) {
  const RoleName = expected.name;
  const existing = await missing(() => aws('iam', 'get-role', { RoleName }));
  if (existing) {
    equal(existing.Role.Arn, expected.arn, `${RoleName} ARN`);
    equal(existing.Role.MaxSessionDuration, expected.duration, `${RoleName} MaxSessionDuration`);
    equal(parseDocument(existing.Role.AssumeRolePolicyDocument), expected.trust, `${RoleName} trust`);
    if (existing.Role.PermissionsBoundary) throw new Error(`setup: ${RoleName} unexpected permissions boundary; left unchanged`);
    equal((await aws('iam', 'list-attached-role-policies', { RoleName })).AttachedPolicies, [], `${RoleName} attached policies`);
    equal((await aws('iam', 'list-role-policies', { RoleName })).PolicyNames, ['ci-kit-pool'], `${RoleName} inline policy names`);
    const policyInput = { RoleName, PolicyName: 'ci-kit-pool' };
    const current = parseDocument((await aws('iam', 'get-role-policy', policyInput)).PolicyDocument);
    if (matches(current, expected.policy)) return false;
    if (!updatePolicies) equal(current, expected.policy, `${RoleName} permissions`);
    const diffLines = (value, prefix) => JSON.stringify(value, null, 2).split('\n').map(line => prefix + line).join('\n');
    log(`setup: policy replacement\n--- ${RoleName}/ci-kit-pool (current)\n+++ ${RoleName}/ci-kit-pool (desired)\n${diffLines(current, '-')}\n${diffLines(expected.policy, '+')}`);
    await aws('iam', 'put-role-policy', { ...policyInput, PolicyDocument: JSON.stringify(expected.policy) });
    const applied = parseDocument((await aws('iam', 'get-role-policy', policyInput)).PolicyDocument);
    if (!matches(applied, expected.policy)) throw new Error(`setup: ${RoleName} permissions readback mismatch after update; inspect the live policy`);
    log(`setup: updated ${RoleName}/ci-kit-pool and verified permissions`);
    return true;
  }
  await aws('iam', 'create-role', { RoleName, AssumeRolePolicyDocument: JSON.stringify(expected.trust), MaxSessionDuration: expected.duration, Tags: TAGS });
  await aws('iam', 'put-role-policy', { RoleName, PolicyName: 'ci-kit-pool', PolicyDocument: JSON.stringify(expected.policy) });
  log(`setup: created ${RoleName}`);
  return true;
}

export async function setupAccount({ config, claims, aws, log = console.log, updatePolicies = false }) {
  validateConfig(config);
  const who = await aws('sts', 'get-caller-identity', {});
  if (who.Account !== config.account) throw new Error(`setup: operator account mismatch: expected ${config.account}, got ${who.Account}`);
  let changed = false;
  const create = async (service, operation, input, label) => {
    const result = await aws(service, operation, input); changed = true; log(`setup: created ${label}`); return result;
  };
  if (!await missing(() => aws('iam', 'get-role', { RoleName: 'AWSServiceRoleForEC2Spot' }))) {
    await create('iam', 'create-service-linked-role', { AWSServiceName: 'spot.amazonaws.com' }, 'Spot service-linked role');
  }
  const vpcs = (await aws('ec2', 'describe-vpcs', { Filters: [{ Name: 'is-default', Values: ['true'] }] })).Vpcs;
  if (vpcs.length !== 1) throw new Error('setup: exactly one default VPC required');
  const VpcId = vpcs[0].VpcId;
  const subnets = (await aws('ec2', 'describe-subnets', { SubnetIds: [...new Set(config.placements.map(p => p.subnet))] })).Subnets;
  for (const p of config.placements) {
    const subnet = subnets.find(s => s.SubnetId === p.subnet);
    if (!subnet || subnet.VpcId !== VpcId || subnet.AvailabilityZone !== p.zone) throw new Error(`setup: subnet ${p.subnet} must match default VPC and placement zone`);
  }
  const groups = (await aws('ec2', 'describe-security-groups', { Filters: [{ Name: 'vpc-id', Values: [VpcId] }, { Name: 'group-name', Values: ['ci-kit-pool'] }] })).SecurityGroups;
  if (groups.length > 1) throw new Error('setup: multiple ci-kit-pool security groups');
  let sg = groups[0]?.GroupId;
  if (sg) {
    equal(groups[0].IpPermissions, [], 'ci-kit-pool inbound rules');
    if (!groups[0].IpPermissionsEgress?.some(r => r.IpProtocol === '-1' && r.IpRanges?.some(range => range.CidrIp === '0.0.0.0/0'))) throw new Error('setup: ci-kit-pool requires outbound internet access; left unchanged');
  } else {
    if (config.security_group) throw new Error('setup: configured security group does not exist; clear the stale ID explicitly before creating one');
    sg = (await create('ec2', 'create-security-group', { GroupName: 'ci-kit-pool', Description: 'ci-kit outbound-only pool', VpcId,
      TagSpecifications: [{ ResourceType: 'security-group', Tags: TAGS }] }, 'security group')).GroupId;
  }
  if (config.security_group) equal(sg, config.security_group, 'configured security group');
  config = { ...config, security_group: sg };
  const bucket = { Bucket: config.report_bucket, ExpectedBucketOwner: config.account };
  const exists = await missing(() => aws('s3api', 'head-bucket', bucket), ['404', 'NoSuchBucket', 'NotFound']);
  if (exists === null) {
    await create('s3api', 'create-bucket', { Bucket: config.report_bucket, CreateBucketConfiguration: { LocationConstraint: REGION }, ObjectOwnership: 'BucketOwnerEnforced' }, 'report bucket');
    await aws('s3api', 'put-public-access-block', { ...bucket, PublicAccessBlockConfiguration: publicAccessBlock });
    await aws('s3api', 'put-bucket-lifecycle-configuration', { ...bucket, LifecycleConfiguration: reportLifecycle });
  } else {
    equal((await aws('s3api', 'get-bucket-location', bucket)).LocationConstraint, REGION, 'report bucket region');
    equal((await aws('s3api', 'get-public-access-block', bucket)).PublicAccessBlockConfiguration, publicAccessBlock, 'report bucket public access block');
    const lifecycle = await aws('s3api', 'get-bucket-lifecycle-configuration', bucket);
    equal(lifecycle.Rules, reportLifecycle.Rules, 'report bucket lifecycle');
  }
  const providerArn = `arn:aws:iam::${config.account}:oidc-provider/token.actions.githubusercontent.com`;
  const oidc = await missing(() => aws('iam', 'get-open-id-connect-provider', { OpenIDConnectProviderArn: providerArn }));
  if (oidc) {
    equal(oidc.Url.replace(/^https:\/\//, ''), 'token.actions.githubusercontent.com', 'GitHub OIDC URL');
    if (!oidc.ClientIDList.includes('sts.amazonaws.com')) throw new Error('setup: existing GitHub OIDC provider lacks sts.amazonaws.com; left unchanged');
  } else {
    await create('iam', 'create-open-id-connect-provider', { Url: 'https://token.actions.githubusercontent.com', ClientIDList: ['sts.amazonaws.com'], Tags: TAGS }, 'GitHub OIDC provider');
  }
  const roles = buildRoles(config, claims);
  for (const role of Object.values(roles)) changed = (await ensureRole(aws, role, log, { updatePolicies })) || changed;
  const desired = fisTemplate(config);
  const templates = (await aws('fis', 'list-experiment-templates', {})).experimentTemplates.filter(t => t.tags?.['ci-kit-pool'] === 'ec2' && t.tags?.['ci-kit-purpose'] === 'fis-fixture');
  if (templates.length > 1) throw new Error('setup: multiple pool FIS templates; select one explicitly before setup');
  let templateId;
  if (templates.length) {
    const actual = (await aws('fis', 'get-experiment-template', { id: templates[0].id })).experimentTemplate;
    for (const key of Object.keys(desired)) equal(actual[key], desired[key], `FIS template ${key}`);
    templateId = actual.id;
  } else {
    templateId = (await create('fis', 'create-experiment-template', desired, 'isolated FIS template')).experimentTemplate.id;
  }
  log(`setup: security_group=${sg} report_bucket=${config.report_bucket} fis_template=${templateId}`);
  if (!changed) log('setup: nothing to change');
  return { config, changed, templateId };
}
