import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../pool/bake/manifest.mjs';
import { parseConfig } from '../../plan/config.mjs';
import { setupHash } from '../../setup/hash.mjs';

const revision = 'b'.repeat(40), sha = 'a'.repeat(40);
const declaration = 'version: 1\nsetup:\n  node: "22"\n  pnpm: true\n  apt: [zsh]\n  script: .github/setup.sh\n';
const script = Buffer.from('node --version\npnpm --version\n');
const hash = setupHash(parseConfig(declaration, {isPrivate:true}).setup, script);
const pins = { v: 1, kit_commit: sha, node: {22:'v22.1.0',24:'v24.1.0'}, runner_version: '2.338.0',
  repos: {'owner/project':{revision,setup_hash:hash}} };
const built = (bytes = 100, ok = true) => ({...pins,repos:{'owner/project':{...pins.repos['owner/project'],apply:{ok,image_bytes:bytes},warm:{ok:false}}}});

test('resolve served default revisions once, read declaration and script at those exact revisions, omit undeclared repos', async () => {
  const calls = [];
  const gh = {request:async (_method,path,options) => {
    calls.push(path);
    if (path.endsWith('/commits/HEAD')) return {sha:revision};
    assert.ok(path.endsWith(`?ref=${revision}`),path);
    if (path.includes('empty/contents/')) throw Object.assign(Error('not found'),{status:404});
    if (path.includes('ci-kit.yml')) return declaration;
    if (path.includes('setup.sh')) { assert.equal(options.bytes,true,'hash the original script bytes'); return script; }
    throw Error(path);
  }};
  const result = await api.resolveManifest({sha,gh,repos:[{repo:'owner/project'},{repo:'SSFSKIM/empty'}],fetch:async url => ({ok:true,
    json:async()=>[{version:'v22.1.0'},{version:'v24.1.0'}],text:async()=> 'FROM ghcr.io/actions/actions-runner:2.338.0@sha256:abc'})});
  assert.deepEqual(result,pins);
  assert.equal(calls.filter(p=>p==='/repos/owner/project/commits/HEAD').length,1);
  assert.equal(calls.filter(p=>p==='/repos/SSFSKIM/empty/commits/HEAD').length,1);
});

test('missing declared script fails resolution, rather than silently omitting its repository', async () => {
  const gh = {request:async (_m,path) => {
    if (path.endsWith('/commits/HEAD')) return {sha:revision};
    if (path.includes('ci-kit.yml')) return declaration;
    throw Object.assign(Error('missing script'),{status:404});
  }};
  await assert.rejects(api.resolveManifest({sha,gh,repos:[{repo:'owner/project'}],fetch:async()=>({ok:true,json:async()=>[{version:'v22.1.0'},{version:'v24.1.0'}],text:async()=> 'FROM ghcr.io/actions/actions-runner:2.338.0@sha256:abc'})}),/missing script/);
});

test('verification requires every declared apply, but accepts different image sizes and best-effort warms', () => {
  assert.deepEqual(api.verifyManifest(built(),pins),built());
  assert.deepEqual(api.verifyManifest(built(200),built(100)),built(200));
  assert.throws(()=>api.verifyManifest(built(100,false),pins),/apply/);
  for (const value of [undefined,{}, {...pins.repos['owner/project'],apply:{ok:true,image_bytes:-1}}]) {
    const actual=built(); actual.repos['owner/project']=value;
    assert.throws(()=>api.verifyManifest(actual,pins));
  }
  const changed=built(); changed.repos['owner/project'].setup_hash='f'.repeat(16);
  assert.throws(()=>api.verifyManifest(changed,pins),/manifest/);
});

test('cloud records contain only infrastructure pins and declared repository identities', () => {
  assert.equal(api.manifestLabels(built())['ci-kit-setup-owner-project'],hash);
  assert.equal(api.manifestTags(built())['ci-kit-setup:owner/project'],hash);
  assert.deepEqual(Object.keys(api.manifestLabels(built())).sort(), ['ci-kit-commit', 'ci-kit-node-22', 'ci-kit-node-24', 'ci-kit-runner', 'ci-kit-setup-owner-project']);
  assert.deepEqual(api.bakeScope([{repo:'SSFSKIM/ci-kit-sandbox'},{repo:'owner/project'}]),{
    ssfskim: { repo: 'SSFSKIM/ci-kit-sandbox', scope: { repositories: ['ci-kit-sandbox'], permissions: { contents: 'read' } } },
    owner: { repo: 'owner/project', scope: { repositories: ['project'], permissions: { contents: 'read' } } },
  });
});

test('bake scope groups repositories by owner, preserving same-named repositories in different installations', () => {
  assert.deepEqual(api.bakeScope([{repo:'SSFSKIM/MAWS'}, {repo:'neworg/MAWS'}, {repo:'ssfskim/ci-kit-sandbox'}, {repo:'SSFSKIM/MAWS'}]), {
    ssfskim: { repo:'SSFSKIM/MAWS', scope:{repositories:['MAWS','ci-kit-sandbox'],permissions:{contents:'read'}} },
    neworg: { repo:'neworg/MAWS', scope:{repositories:['MAWS'],permissions:{contents:'read'}} },
  });
});
