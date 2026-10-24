import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { githubMainSubject, readGuardSubject } from '../../ec2/github-oidc.mjs';
import { buildRoles, ensureRole, setupAccount } from '../../ec2/setup-lib.mjs';

const repository = { id: 1421334468, name: 'ci-kit', full_name: 'SSFSKIM/ci-kit', owner: { login: 'SSFSKIM', id: 145154405 } };
const immutable = { use_default: true, use_immutable_subject: true, sub_claim_prefix: 'repo:SSFSKIM@145154405/ci-kit@1421334468' };
const subject = 'repo:SSFSKIM@145154405/ci-kit@1421334468:ref:refs/heads/main';
const legacy = 'repo:SSFSKIM/ci-kit:ref:refs/heads/main';
const config = { account: '290475840169', region: 'us-east-2', report_bucket: 'ci-kit-reports', security_group: 'sg-pool',
  placements: [{ zone: 'us-east-2c', subnet: 'subnet-pool' }],
  roles: Object.fromEntries(['launcher', 'bake', 'guard'].map(name => [name, `arn:aws:iam::290475840169:role/ci-kit-ec2-${name}`])) };
const claims = { sub: '123', azp: '123', aud: 'https://ci-kit/290475840169/ec2' };
const subjectOf = role => role.trust.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:sub'];

test('default immutable and legacy subjects derive from repository metadata, not configured IDs or creation dates', () => {
  assert.equal(githubMainSubject(repository, immutable), subject);
  assert.equal(githubMainSubject(repository, { use_default: true, use_immutable_subject: false }), legacy);
  const other = { id: 987, name: 'renamed', full_name: 'other/renamed', owner: { login: 'other', id: 654 } };
  assert.equal(githubMainSubject(other, { use_default: true, use_immutable_subject: true }), 'repo:other@654/renamed@987:ref:refs/heads/main');
  assert.equal(githubMainSubject(other, { use_default: true, use_immutable_subject: false, include_claim_keys: ['repo', 'context'] }), 'repo:other/renamed:ref:refs/heads/main');
});

test('custom/unknown claim templates, mismatched prefixes and incomplete identities fail closed', () => {
  for (const patch of [{ use_default: false }, { use_default: undefined }, { use_immutable_subject: undefined },
    { use_immutable_subject: 'true' }, { include_claim_keys: ['repo', 'job_workflow_ref'] },
    { include_claim_keys: ['context', 'repo'] }, { sub_claim_prefix: 'repo:attacker/ci-kit' }]) {
    assert.throws(() => githubMainSubject(repository, { ...immutable, ...patch }), /OIDC|subject|template/);
  }
  for (const repo of [{ ...repository, id: undefined }, { ...repository, owner: { login: 'SSFSKIM', id: 0 } },
    { ...repository, full_name: 'other/repo' }, { ...repository, name: '*' }]) {
    assert.throws(() => githubMainSubject(repo, immutable), /repository|identity/);
  }
});

test('setup reads both GitHub endpoints and refuses unavailable customization rather than falling back', async () => {
  const paths = [];
  const gh = async path => { paths.push(path); return path.endsWith('/sub') ? immutable : repository; };
  assert.equal(await readGuardSubject(gh), subject);
  assert.deepEqual(paths.sort(), ['repos/SSFSKIM/ci-kit', 'repos/SSFSKIM/ci-kit/actions/oidc/customization/sub']);
  await assert.rejects(readGuardSubject(async () => { throw new Error('GitHub unavailable'); }), /unavailable/);
});

test('desired guard trust uses the derived subject with exact issuer/audience; Google and FIS trust stay unchanged', () => {
  const next = buildRoles(config, claims, subject), old = buildRoles(config, claims, legacy);
  assert.equal(subjectOf(next.guard), subject);
  assert.equal(next.guard.trust.Statement[0].Principal.Federated, 'arn:aws:iam::290475840169:oidc-provider/token.actions.githubusercontent.com');
  assert.equal(next.guard.trust.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com');
  for (const name of ['launcher', 'bake', 'fis']) assert.deepEqual(next[name], old[name]);
  assert.throws(() => buildRoles(config, claims), /subject/);
});

function fixture(name = 'guard') {
  const expected = buildRoles(config, claims, subject)[name];
  const state = { role: { Arn: expected.arn, MaxSessionDuration: expected.duration,
    AssumeRolePolicyDocument: structuredClone(buildRoles(config, claims, legacy)[name].trust) },
    policy: structuredClone(expected.policy), attached: [], names: ['ci-kit-pool'] };
  const events = [];
  const aws = async (service, op, input) => {
    events.push({ service, op, input });
    if (op === 'get-role') return { Role: structuredClone(state.role) };
    if (op === 'list-attached-role-policies') return { AttachedPolicies: state.attached };
    if (op === 'list-role-policies') return { PolicyNames: state.names };
    if (op === 'get-role-policy') return { PolicyDocument: structuredClone(state.policy) };
    if (op === 'update-assume-role-policy') { state.role.AssumeRolePolicyDocument = JSON.parse(input.PolicyDocument); return {}; }
    throw new Error(`unexpected operation ${op}`);
  };
  return { expected, state, events, aws, log: text => events.push({ log: text }) };
}
const writes = f => f.events.filter(e => e.op && !/^(get|list)-/.test(e.op));

test('explicit trust repair prints a reconstructable diff, writes only guard trust and verifies a new read', async () => {
  const f = fixture(); const before = structuredClone(f.state.role.AssumeRolePolicyDocument);
  assert.equal(await ensureRole(f.aws, f.expected, f.log, { repairTrust: true }), true);
  assert.deepEqual(writes(f), [{ service: 'iam', op: 'update-assume-role-policy', input: {
    RoleName: 'ci-kit-ec2-guard', PolicyDocument: JSON.stringify(f.expected.trust),
  } }]);
  const diffIndex = f.events.findIndex(e => e.log?.includes('---') && e.log.includes('+++'));
  const writeIndex = f.events.indexOf(writes(f)[0]);
  assert.ok(diffIndex >= 0 && diffIndex < writeIndex);
  const diff = f.events[diffIndex].log;
  const side = prefix => JSON.parse(diff.split('\n').filter(l => l.startsWith(prefix) && !l.startsWith(prefix.repeat(3))).map(l => l.slice(1)).join('\n'));
  assert.deepEqual(side('-'), before); assert.deepEqual(side('+'), f.expected.trust);
  assert.ok(f.events.slice(writeIndex + 1).some(e => e.op === 'get-role'));
  assert.deepEqual(f.state.policy, f.expected.policy);
  f.events.length = 0;
  assert.equal(await ensureRole(f.aws, f.expected, f.log, { repairTrust: true }), false);
  assert.equal(writes(f).length, 0);
});

test('default and permissions-only update modes refuse trust drift without writes', async () => {
  for (const options of [{}, { updatePolicies: true }]) {
    const f = fixture();
    await assert.rejects(ensureRole(f.aws, f.expected, f.log, options), /trust.*mismatch/);
    assert.equal(writes(f).length, 0);
  }
});

test('trust repair cannot change Google/FIS roles or replace an unknown guard identity provider', async () => {
  for (const name of ['launcher', 'bake', 'fis', 'guard']) {
    const f = fixture(name);
    f.state.role.AssumeRolePolicyDocument.Statement[0].Principal = { Federated: 'accounts.example.com' };
    await assert.rejects(ensureRole(f.aws, f.expected, f.log, { repairTrust: true }), /trust.*mismatch|GitHub/);
    assert.equal(writes(f).length, 0, name);
  }
});

test('trust repair validates all protected role and permission attributes before any mutation', async () => {
  for (const drift of ['arn', 'duration', 'boundary', 'attached', 'inline-name', 'permissions']) {
    const f = fixture();
    if (drift === 'arn') f.state.role.Arn = 'arn:aws:iam::111111111111:role/ci-kit-ec2-guard';
    if (drift === 'duration') f.state.role.MaxSessionDuration = 14400;
    if (drift === 'boundary') f.state.role.PermissionsBoundary = { PermissionsBoundaryArn: 'boundary' };
    if (drift === 'attached') f.state.attached = [{ PolicyArn: 'unexpected' }];
    if (drift === 'inline-name') f.state.names.push('other');
    if (drift === 'permissions') f.state.policy.Statement = [];
    await assert.rejects(ensureRole(f.aws, f.expected, f.log, { repairTrust: true }), /mismatch|unexpected/);
    assert.equal(writes(f).length, 0, drift);
  }
});

test('repair readback mismatch fails and combined repair modes are rejected', async () => {
  const f = fixture();
  await assert.rejects(ensureRole(async (s, op, input) => op === 'update-assume-role-policy' ? {} : f.aws(s, op, input), f.expected, f.log, { repairTrust: true }), /trust.*readback.*mismatch/);
  assert.ok(!f.events.some(e => e.log?.includes('verified trust')));
  const other = fixture();
  await assert.rejects(ensureRole(other.aws, other.expected, other.log, { repairTrust: true, updatePolicies: true }), /separate|combine|choose/);
  assert.equal(writes(other).length, 0);
});

test('account trust repair visits only the existing managed GitHub role, with no resource creation', async () => {
  const f = fixture();
  const aws = async (s, op, input) => op === 'get-caller-identity' ? { Account: config.account } : f.aws(s, op, input);
  const result = await setupAccount({ config, claims, guardSubject: subject, aws, log: f.log, repairTrust: true });
  assert.equal(result.changed, true);
  assert.ok(f.events.filter(e => e.op).every(e => e.service === 'iam' && e.input.RoleName === 'ci-kit-ec2-guard'));
  assert.equal(writes(f).length, 1);
  f.events.length = 0;
  assert.equal((await setupAccount({ config, claims, guardSubject: subject, aws, log: f.log, repairTrust: true })).changed, false);
  assert.equal(writes(f).length, 0);
});

test('repair cannot create missing roles and unsupported subject cannot reach any resource writes', async () => {
  const f = fixture();
  await assert.rejects(ensureRole(async (_, op) => {
    assert.equal(op, 'get-role'); throw Object.assign(new Error('missing'), { code: 'NoSuchEntity' });
  }, f.expected, f.log, { repairTrust: true }), /existing|missing/);
  const calls = [];
  await assert.rejects(setupAccount({ config, claims, guardSubject: 'repo:*', repairTrust: true,
    aws: async (_s, op) => { calls.push(op); return { Account: config.account }; } }), /subject/);
  assert.ok(calls.every(op => op === 'get-caller-identity'));
});

test('CLI exposes explicit trust repair while invalid combinations stop before config or cloud reads', () => {
  const cli = fileURLToPath(new URL('../../ec2/setup-cli.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--repair-trust', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /repair-trust/);
  const invalid = spawnSync(process.execPath, [cli, '--repair-trust', '--update-policies', '--config', '/nonexistent/config'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /separate|combine|choose/); assert.doesNotMatch(invalid.stderr, /ENOENT/);
});
