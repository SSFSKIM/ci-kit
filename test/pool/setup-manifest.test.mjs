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
  maws: {revision,lock_sha256:'c'.repeat(64)}, repos: {'SSFSKIM/MAWS':{revision,setup_hash:hash}} };
const warm = {'maws-files':{ok:true},'pnpm-fetch':{ok:true}};
const built = (bytes = 100, ok = true) => ({...pins,warm,repos:{'SSFSKIM/MAWS':{...pins.repos['SSFSKIM/MAWS'],apply:{ok,image_bytes:bytes},warm:{ok:false}}}});

test('resolve served default revisions once, read declaration and script at those exact revisions, omit undeclared repos', async () => {
  const calls = [];
  const gh = {request:async (_method,path,options) => {
    calls.push(path);
    if (path.endsWith('/commits/HEAD')) return {sha:revision};
    assert.ok(path.endsWith(`?ref=${revision}`),path);
    if (path.includes('pnpm-lock.yaml')) return 'lock';
    if (path.includes('empty/contents/')) throw Object.assign(Error('not found'),{status:404});
    if (path.includes('ci-kit.yml')) return declaration;
    if (path.includes('setup.sh')) { assert.equal(options.bytes,true,'hash the original script bytes'); return script; }
    throw Error(path);
  }};
  const result = await api.resolveManifest({sha,gh,repos:[{repo:'SSFSKIM/MAWS'},{repo:'SSFSKIM/empty'}],fetch:async url => ({ok:true,
    json:async()=>[{version:'v22.1.0'},{version:'v24.1.0'}],text:async()=> 'FROM ghcr.io/actions/actions-runner:2.338.0@sha256:abc'})});
  assert.deepEqual(result.repos,pins.repos);
  assert.equal(calls.filter(p=>p==='/repos/SSFSKIM/MAWS/commits/HEAD').length,1);
  assert.equal(calls.filter(p=>p==='/repos/SSFSKIM/empty/commits/HEAD').length,1);
});

test('missing declared script fails resolution, rather than silently omitting its repository', async () => {
  const gh = {request:async (_m,path) => {
    if (path.endsWith('/commits/HEAD')) return {sha:revision};
    if (path.includes('pnpm-lock.yaml')) return 'lock';
    if (path.includes('ci-kit.yml')) return declaration;
    throw Object.assign(Error('missing script'),{status:404});
  }};
  await assert.rejects(api.resolveManifest({sha,gh,repos:[{repo:'SSFSKIM/MAWS'}],fetch:async()=>({ok:true,json:async()=>[{version:'v22.1.0'},{version:'v24.1.0'}],text:async()=> 'FROM ghcr.io/actions/actions-runner:2.338.0@sha256:abc'})}),/missing script/);
});

test('verification requires every declared apply, keeps legacy warming mandatory, but accepts different image sizes and best-effort repo warms', () => {
  assert.deepEqual(api.verifyManifest(built(),pins),built());
  assert.deepEqual(api.verifyManifest(built(200),built(100)),built(200));
  assert.throws(()=>api.verifyManifest(built(100,false),pins),/apply/);
  for (const value of [undefined,{}, {...pins.repos['SSFSKIM/MAWS'],apply:{ok:true,image_bytes:-1}}]) {
    const actual=built(); actual.repos['SSFSKIM/MAWS']=value;
    assert.throws(()=>api.verifyManifest(actual,pins));
  }
  const changed=built(); changed.repos['SSFSKIM/MAWS'].setup_hash='f'.repeat(16);
  assert.throws(()=>api.verifyManifest(changed,pins),/manifest/);
  assert.throws(()=>api.verifyManifest({...built(),warm:{}},pins),/warm/);
});

test('cloud records include repository setup identities without losing legacy labels', () => {
  assert.equal(api.manifestLabels(built())['ci-kit-setup-ssfskim-maws'],hash);
  assert.equal(api.manifestTags(built())['ci-kit-setup:SSFSKIM/MAWS'],hash);
  assert.equal(api.manifestTags(built())['ci-kit-maws-revision'],revision);
  assert.deepEqual(api.bakeScope([{repo:'SSFSKIM/ci-kit-sandbox'},{repo:'SSFSKIM/MAWS'}]),{
    repositories:['ci-kit-sandbox','MAWS'],permissions:{contents:'read'},
  });
});
