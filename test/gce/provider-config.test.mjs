import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../gce/launcher/config.mjs';
import { NEW_CFG } from './config-fixtures.mjs';

const REPO = 'SSFSKIM/ci-kit-sandbox';
const ACCOUNT = '290475840169';
const OTHER = '123456789012';
const account = (id = ACCOUNT) => ({
  account: id, region: 'us-east-2',
  placements: [{ zone: 'us-east-2c', subnet: 'subnet-0123456789abcdef0', machines: { 2: 'c8a.large', 4: 'c8a.xlarge', 8: 'c8a.2xlarge', 16: 'c8a.4xlarge' } }],
  disk_gb: 50, security_group: 'sg-0123456789abcdef0', report_bucket: `ci-kit-ec2-reports-${id}`,
  roles: Object.fromEntries(['launcher', 'bake', 'guard'].map((role) => [role, `arn:aws:iam::${id}:role/ci-kit-ec2-${role}`])),
});
const ec2 = (accounts = [account()], extra = {}) => config.parseEc2Config(JSON.stringify({ enabled: true, accounts, ...extra }));
const gce = (providers) => config.parseGceConfig(JSON.stringify({ ...NEW_CFG, repos: [{ repo: REPO, ...(providers === undefined ? {} : { providers }) }] }));

// These break when schema validation lets a malformed account reach provider construction, or treats disabled as absent.
test('EC2 parses accounts independently, preserving placement order, roles and optional credit, with enabled default true', () => {
  const first = account();
  first.placements.push({ ...first.placements[0], zone: 'us-east-2a' });
  first.credit = { enabled: false, since: '2026-10-23', until: '2027-04-17', budget_usd: 180 };
  const second = { ...account(OTHER), enabled: false };
  assert.deepEqual(ec2([first, second], { enabled: false }), { enabled: false, accounts: [{ ...first, enabled: true }, second] });
  assert.deepEqual(ec2([]).accounts, []);
});

test('EC2 rejects malformed top-level values, duplicate accounts and removed draft keys', () => {
  for (const text of ['{', 'null', '[]', '1']) assert.throws(() => config.parseEc2Config(text), /ec2 config/);
  assert.throws(() => ec2([account()], { enabled: 'false' }), /enabled must be a boolean/);
  assert.throws(() => ec2(null), /accounts must be a list/);
  assert.throws(() => ec2([account(), account()]), /duplicate account/);
  assert.throws(() => ec2([account()], { repos: [REPO] }), /unknown key "repos"/);
  for (const entry of [null, [], 3, 'account']) assert.throws(() => ec2([entry, entry]), /ci-kit: ec2 config:/);
});

test('EC2 validates disabled accounts too: identity, region, placements, disk, reports and matching role ARNs', () => {
  const bad = (patch, message) => assert.throws(() => ec2([{ ...account(), enabled: false, ...patch }]), message);
  bad({ account: 290475840169 }, /account must be a 12-digit string/);
  bad({ enabled: 0 }, /enabled must be a boolean/);
  bad({ region: 'us-east-1' }, /region must be us-east-2/);
  bad({ placements: [] }, /placements must be a non-empty list/);
  bad({ placements: [{ ...account().placements[0], zone: 'us-east-1a' }] }, /zone must be in us-east-2/);
  bad({ placements: [{ ...account().placements[0], subnet: '' }] }, /subnet/);
  bad({ placements: [{ ...account().placements[0], machines: { 2: 'c8a.large' } }] }, /machines must map each of 2, 4, 8, 16/);
  bad({ disk_gb: 0 }, /disk_gb must be a positive integer/);
  bad({ security_group: '' }, /security_group/);
  bad({ report_bucket: '' }, /report_bucket/);
  bad({ roles: { ...account().roles, launcher: account(OTHER).roles.launcher } }, /roles.launcher must name account 290475840169/);
  bad({ roles: { launcher: account().roles.launcher } }, /roles.bake/);
});

test('EC2 does not admit on-demand job configuration at account or placement level', () => {
  for (const provisioning of ['standard', 'on-demand']) {
    assert.throws(() => ec2([{ ...account(), provisioning }]), /unknown key "provisioning"/);
    assert.throws(() => ec2([{ ...account(), placements: [{ ...account().placements[0], provisioning }] }]), /unknown key "provisioning"/);
  }
  assert.throws(() => ec2([{ ...account(), placements: [{ ...account().placements[0], machines: { ...account().placements[0].machines, standard: 'c8a.large' } }] }]), /machines/);
});

test('optional EC2 credit is complete and validates actual dates and a finite positive budget', () => {
  const credit = { enabled: true, since: '2026-10-23', until: '2027-04-17', budget_usd: 180 };
  for (const patch of [{ enabled: 1 }, { since: '2026-02-30' }, { until: 'not-a-date' }, { since: '2028-01-01' }, { budget_usd: 0 }, { budget_usd: '180' }, { extra: true }]) {
    assert.throws(() => ec2([{ ...account(), credit: { ...credit, ...patch } }]), /credit/);
  }
  assert.throws(() => ec2([{ ...account(), credit: null }]), /credit/);
});

test('repo provider lists resolve in order with physical caps, and absent providers preserve the old repos shape and GCE-only default', () => {
  const cfg = gce([{ provider: 'ec2', max_vcpus: 16 }, { provider: 'gce' }]);
  assert.deepEqual(config.resolveRepoProviders(cfg, ec2()), { [REPO]: [{ provider: 'ec2', account: ACCOUNT, max_vcpus: 16 }, { provider: 'gce', account: NEW_CFG.project }] });
  assert.deepEqual(gce().repos, [{ repo: REPO }]);
  assert.deepEqual(config.resolveRepoProviders(gce(), ec2()), { [REPO]: [{ provider: 'gce', account: NEW_CFG.project }] });
  assert.deepEqual(config.resolveRepoProviders(gce([]), ec2()), { [REPO]: [] });
});

test('configured disabled accounts remain valid references, and count when omitted account is ambiguous', () => {
  const disabled = ec2([{ ...account(), enabled: false }], { enabled: false });
  assert.deepEqual(config.resolveRepoProviders(gce([{ provider: 'ec2' }]), disabled)[REPO], [{ provider: 'ec2', account: ACCOUNT }]);
  const two = ec2([account(), { ...account(OTHER), enabled: false }]);
  assert.throws(() => config.resolveRepoProviders(gce([{ provider: 'ec2' }]), two), /ambiguous.*account/);
  assert.deepEqual(config.resolveRepoProviders(gce([{ provider: 'ec2', account: OTHER }, { provider: 'ec2', account: ACCOUNT }]), two)[REPO], [{ provider: 'ec2', account: OTHER }, { provider: 'ec2', account: ACCOUNT }]);
});

test('provider list validation rejects missing, mismatched and duplicate instances and non-positive caps', () => {
  assert.throws(() => config.resolveRepoProviders(gce([{ provider: 'ec2', account: OTHER }]), ec2()), /unknown ec2 account/);
  assert.throws(() => config.resolveRepoProviders(gce([{ provider: 'ec2' }]), ec2([])), /unknown ec2 account/);
  assert.throws(() => config.resolveRepoProviders(gce([{ provider: 'gce', account: 'wrong-project' }]), ec2()), /gce account must be/);
  assert.throws(() => config.resolveRepoProviders(gce([{ provider: 'ec2' }, { provider: 'ec2', account: ACCOUNT }]), ec2()), /duplicate provider instance/);
  assert.throws(() => config.resolveRepoProviders(gce([{ provider: 'gce' }, { provider: 'gce', account: NEW_CFG.project }]), ec2()), /duplicate provider instance/);
  for (const max_vcpus of [0, -1, 1.5, null, '8']) assert.throws(() => gce([{ provider: 'gce', max_vcpus }]), /max_vcpus must be a positive integer/);
  for (const providers of [null, {}, [{ provider: 'azure' }], [{ provider: 'gce', account: 123 }], [{ provider: 'gce', extra: 1 }]]) {
    assert.throws(() => gce(providers), /providers/);
  }
});

test('absent EC2 skips references without validating account existence, retaining GCE and logging once for the resolution', () => {
  const logs = [];
  const cfg = gce([{ provider: 'ec2', account: OTHER }, { provider: 'ec2' }, { provider: 'gce' }]);
  assert.deepEqual(config.resolveRepoProviders(cfg, null, { log: (line) => logs.push(line) }), { [REPO]: [{ provider: 'gce', account: NEW_CFG.project }] });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ec2.json.*absent/);
  assert.match(logs[0], /SSFSKIM\/ci-kit-sandbox/);
});
