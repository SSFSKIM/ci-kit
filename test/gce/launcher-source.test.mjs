// Where the launcher's config comes from (gce/launcher/source.mjs, spec §3a Which backend serves a repo): gce.json and
// pool.json on the kit's main, each at the newest commit that changed it; a failed refresh keeps the last good copy
// (and its commit, which the launcher writes on every VM it creates: a stale `ci-kit-config` is how a move sees it);
// before the first success, the copies bundled with the deployed code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConfigSource } from '../../gce/launcher/source.mjs';

const GCE = JSON.parse(readFileSync(new URL('../../pool/config/gce.json', import.meta.url), 'utf8'));
const SBX = 'SSFSKIM/ci-kit-sandbox';
const MAWS = 'SSFSKIM/MAWS';
const withRepos = (cfg, repos) => JSON.stringify({ ...cfg, repos });

function source({ main, bundled = {} }) {
  const reads = [];
  const logs = [];
  const gh = {
    lastCommit: async (_repo, path) => {
      const f = main()[path];
      if (f instanceof Error) throw f;
      return f ? { sha: f.sha } : null;
    },
  };
  const fetchText = async (url) => {
    reads.push(url);
    const [, sha, path] = /ci-kit\/([0-9a-f]+)\/(.+)$/.exec(url);
    const f = main()[path];
    if (f instanceof Error || f.sha !== sha || f.fetchError) throw new Error('raw read failed');
    return f.text;
  };
  return { reads, logs, load: createConfigSource({ gh, fetchText, readBundled: async (name) => {
    const text = bundled[name];
    if (text instanceof Error) throw text;
    return text ?? null;
  }, bundledCommit: 'b0000000bundled', log: (line) => logs.push(line) }) };
}
const sha = (n) => String(n).repeat(40).slice(0, 40);

test('the configs come from main, at the commit that last changed each; a commit already read is not fetched again', async () => {
  const files = {
    'pool/config/gce.json': { sha: sha(1), text: withRepos(GCE, [{ repo: SBX }]) },
    'pool/config/pool.json': { sha: sha(2), text: JSON.stringify({ repos: [{ repo: MAWS, workflows: ['gate.yml'] }] }) },
  };
  const s = source({ main: () => files });
  const got = await s.load();
  assert.deepEqual([got.cfg.repos, got.config, got.poolRepos], [[{ repo: SBX }], sha(1), [MAWS]]);
  await s.load();
  assert.equal(s.reads.length, 2);
});

test('a failed refresh keeps the last good copy and its commit (the stale ci-kit-config a move waits on)', async () => {
  let files = {
    'pool/config/gce.json': { sha: sha(1), text: withRepos(GCE, [{ repo: SBX }]) },
    'pool/config/pool.json': { sha: sha(2), text: JSON.stringify({ repos: [] }) },
  };
  const s = source({ main: () => files });
  await s.load();
  // main moves the sandbox out of gce.json, but this launcher cannot read main.
  files = { 'pool/config/gce.json': new Error('502'), 'pool/config/pool.json': new Error('502') };
  const stale = await s.load();
  assert.deepEqual([stale.cfg.repos, stale.config, stale.poolRepos], [[{ repo: SBX }], sha(1), []]);
});

test('a copy on main that does not parse is not run: the last good copy stays', async () => {
  let files = {
    'pool/config/gce.json': { sha: sha(1), text: withRepos(GCE, [{ repo: SBX }]) },
    'pool/config/pool.json': { sha: sha(2), text: JSON.stringify({ repos: [] }) },
  };
  const s = source({ main: () => files });
  await s.load();
  files = { ...files, 'pool/config/gce.json': { sha: sha(3), text: '{"repos": [' } };
  assert.equal((await s.load()).config, sha(1));
});

test('before any success, the bundled copies, labelled with the deployed commit', async () => {
  const s = source({
    main: () => ({ 'pool/config/gce.json': new Error('down'), 'pool/config/pool.json': new Error('down') }),
    bundled: { 'gce.json': withRepos(GCE, [{ repo: SBX }]), 'pool.json': JSON.stringify({ repos: [{ repo: MAWS, workflows: ['gate.yml'] }] }) },
  });
  const got = await s.load();
  assert.deepEqual([got.cfg.repos, got.config, got.poolRepos], [[{ repo: SBX }], 'b0000000bundled', [MAWS]]);
});

test('a file main does not have (no commit ever changed it) lists no repos', async () => {
  const s = source({ main: () => ({ 'pool/config/gce.json': { sha: sha(1), text: withRepos(GCE, []) }, 'pool/config/pool.json': null }) });
  assert.deepEqual((await s.load()).poolRepos, []);
});

const EC2_PATH = 'pool/config/ec2.json';
const ACCOUNT = '290475840169';
const OTHER = '123456789012';
const account = (id = ACCOUNT) => ({
  account: id, region: 'us-east-2', placements: [{ zone: 'us-east-2c', subnet: 'subnet-1234', machines: { 2: 'c8a.large', 4: 'c8a.xlarge', 8: 'c8a.2xlarge', 16: 'c8a.4xlarge' } }],
  disk_gb: 50, security_group: 'sg-1234', report_bucket: `ci-kit-ec2-reports-${id}`,
  roles: Object.fromEntries(['launcher', 'bake', 'guard'].map((role) => [role, `arn:aws:iam::${id}:role/ci-kit-ec2-${role}`])),
});
const ec2Text = (enabled = true, accounts = [account()]) => JSON.stringify({ enabled, accounts });
const repoEntry = { repo: SBX, providers: [{ provider: 'ec2', account: ACCOUNT, max_vcpus: 16 }, { provider: 'gce' }] };
const gceFile = (repos = [repoEntry], commit = sha(1)) => ({ sha: commit, text: withRepos(GCE, repos) });

// The production source, not a directly supplied cfg, must distinguish a valid disable/delete from a bad refresh.
test('real source reloads enabled -> disabled -> deleted while lists still reference EC2; skip logs once per snapshot', async () => {
  const files = { 'pool/config/gce.json': gceFile(), [EC2_PATH]: { sha: sha(2), text: ec2Text() } };
  const s = source({ main: () => files });
  const enabled = await s.load();
  assert.equal(enabled.ec2.enabled, true);
  assert.deepEqual(enabled.repoProviders[SBX], [{ provider: 'ec2', account: ACCOUNT, max_vcpus: 16 }, { provider: 'gce', account: GCE.project }]);
  files[EC2_PATH] = { sha: sha(3), text: ec2Text(false) };
  const disabled = await s.load();
  assert.equal(disabled.ec2.enabled, false);
  assert.deepEqual(disabled.repoProviders, enabled.repoProviders, 'disabled instances are valid and remain resolvable for management');
  files[EC2_PATH] = { sha: sha(4), text: null }; // deletion commit is found, but raw content returns confirmed 404/null
  const deleted = await s.load();
  assert.equal(deleted.ec2, null, 'confirmed deletion never restores the last enabled or disabled file');
  assert.deepEqual(deleted.repoProviders[SBX], [{ provider: 'gce', account: GCE.project }]);
  assert.equal(deleted.config, sha(1));
  await s.load();
  await s.load();
  assert.equal(s.logs.filter((line) => /ec2.json absent/.test(line)).length, 1);
  files['pool/config/gce.json'] = gceFile([repoEntry, { repo: MAWS, providers: [{ provider: 'ec2' }] }], sha(5));
  assert.deepEqual((await s.load()).repoProviders[MAWS], []);
  assert.equal(s.logs.filter((line) => /ec2.json absent/.test(line)).length, 2, 'a changed config gets one new skip log');
  files[EC2_PATH] = { sha: sha(6), text: ec2Text(false) };
  assert.equal((await s.load()).ec2.enabled, false, 'restoring a disabled account restores management without enabling launches');
});

test('account disable is a valid reload and leaves the other configured account enabled and resolvable', async () => {
  const entries = [{ repo: SBX, providers: [{ provider: 'ec2', account: ACCOUNT }, { provider: 'ec2', account: OTHER }] }];
  const files = { 'pool/config/gce.json': gceFile(entries), [EC2_PATH]: { sha: sha(2), text: ec2Text(true, [account(), account(OTHER)]) } };
  const s = source({ main: () => files });
  await s.load();
  files[EC2_PATH] = { sha: sha(3), text: ec2Text(true, [{ ...account(), enabled: false }, account(OTHER)]) };
  const got = await s.load();
  assert.deepEqual(got.ec2.accounts.map((a) => [a.account, a.enabled]), [[ACCOUNT, false], [OTHER, true]]);
  assert.deepEqual(got.repoProviders[SBX], [{ provider: 'ec2', account: ACCOUNT }, { provider: 'ec2', account: OTHER }]);
});

test('an EC2 read failure or invalid schema retains last good state, while confirmed absence stays absent through a later outage', async () => {
  const files = { 'pool/config/gce.json': gceFile(), [EC2_PATH]: { sha: sha(2), text: ec2Text() } };
  const s = source({ main: () => files });
  const good = await s.load();
  files[EC2_PATH] = { sha: sha(3), fetchError: true };
  assert.deepEqual((await s.load()).ec2, good.ec2, 'a transport failure is not deletion');
  files[EC2_PATH] = new Error('commit lookup unavailable');
  assert.deepEqual((await s.load()).ec2, good.ec2);
  files[EC2_PATH] = { sha: sha(4), text: JSON.stringify({ enabled: false, accounts: [{ account: ACCOUNT }] }) };
  assert.deepEqual((await s.load()).ec2, good.ec2, 'a malformed disabled file is not a valid off switch');
  files[EC2_PATH] = null; // never existed, or history lookup confirms no file
  assert.equal((await s.load()).ec2, null);
  files[EC2_PATH] = new Error('down');
  assert.equal((await s.load()).ec2, null, 'an outage after confirmed absence cannot resurrect enabled config');
});

test('bundled EC2 is used on initial fetch failure, but not for confirmed absence; bundled ENOENT means absent', async () => {
  const files = { 'pool/config/gce.json': gceFile(), [EC2_PATH]: new Error('offline') };
  const s = source({ main: () => files, bundled: { 'ec2.json': ec2Text(false) } });
  assert.equal((await s.load()).ec2.enabled, false);
  const absent = source({ main: () => ({ ...files, [EC2_PATH]: { sha: sha(3), text: null } }), bundled: { 'ec2.json': ec2Text() } });
  assert.equal((await absent.load()).ec2, null);
  const noBundle = source({ main: () => files, bundled: { 'ec2.json': Object.assign(new Error('missing'), { code: 'ENOENT' }) } });
  assert.equal((await noBundle.load()).ec2, null);
});

test('cross-file reference errors keep the previous coherent config snapshot rather than publishing invalid fresh config', async () => {
  const files = { 'pool/config/gce.json': gceFile(), [EC2_PATH]: { sha: sha(2), text: ec2Text() } };
  const s = source({ main: () => files });
  const good = await s.load();
  files['pool/config/gce.json'] = gceFile([{ repo: MAWS, providers: [{ provider: 'ec2', account: OTHER }] }], sha(3));
  const badRepo = await s.load();
  assert.deepEqual([badRepo.cfg, badRepo.ec2, badRepo.repoProviders, badRepo.config], [good.cfg, good.ec2, good.repoProviders, good.config]);
  files['pool/config/gce.json'] = gceFile();
  files[EC2_PATH] = { sha: sha(4), text: ec2Text(true, [account(OTHER)]) };
  const badAccount = await s.load();
  assert.deepEqual([badAccount.cfg, badAccount.ec2, badAccount.repoProviders, badAccount.config], [good.cfg, good.ec2, good.repoProviders, good.config]);
  files['pool/config/gce.json'] = gceFile([{ repo: SBX, providers: [{ provider: 'ec2', account: OTHER }, { provider: 'gce' }] }], sha(5));
  assert.equal((await s.load()).repoProviders[SBX][0].account, OTHER, 'a later coherent pair can replace the fallback');
  assert.ok(s.logs.some((line) => /unknown ec2 account/.test(line)));
});

test('a rejected repo-reference edit cannot prevent a subsequent valid disable or deletion', async () => {
  const files = { 'pool/config/gce.json': gceFile(), [EC2_PATH]: { sha: sha(2), text: ec2Text() } };
  const s = source({ main: () => files });
  await s.load();
  files['pool/config/gce.json'] = gceFile([{ repo: SBX, providers: [{ provider: 'ec2', account: OTHER }, { provider: 'gce' }] }], sha(3));
  await s.load();
  files[EC2_PATH] = { sha: sha(4), text: ec2Text(false) };
  const disabled = await s.load();
  assert.equal(disabled.ec2.enabled, false);
  assert.equal(disabled.config, sha(1), 'use the last good repo references with the latest valid disable');
  files[EC2_PATH] = { sha: sha(5), text: null };
  const deleted = await s.load();
  assert.equal(deleted.ec2, null);
  assert.deepEqual(deleted.repoProviders[SBX], [{ provider: 'gce', account: GCE.project }]);
});
