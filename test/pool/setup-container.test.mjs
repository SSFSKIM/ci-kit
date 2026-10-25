import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseConfig } from '../../plan/config.mjs';
import { setupHash } from '../../setup/hash.mjs';
import { retainSmokeSource } from '../../pool/bake/smoke-source.mjs';
const retain = root => retainSmokeSource(root,{exec:async(bin,args)=>execFileSync(bin,args)});
const entry = new URL('../../pool/bake/setup-container.mjs',import.meta.url);

async function fixture(t, { missingPackage = false, extraScript = '' } = {}) {
  const dir=await mkdtemp(join(tmpdir(),'ci-kit-setup-container-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const root=join(dir,'repo'),tools=join(dir,'tools'),bin=join(dir,'bin');
  await mkdir(join(root,'.github'),{recursive:true});
  await mkdir(join(tools,'node','22.1.0','x64','bin'),{recursive:true});
  await mkdir(bin);
  const nodeBin=join(tools,'node','22.1.0','x64','bin');
  await symlink(process.execPath,join(nodeBin,'node'));
  // External corepack boundary: executable shim produced by enable, so PATH must work for both commands.
  await writeFile(join(nodeBin,'corepack'),'#!/bin/sh\ntest "$1" = enable || exit 2\nprintf "#!/bin/sh\\necho pnpm-ok\\n" > "$3/pnpm"\nchmod +x "$3/pnpm"\n',{mode:0o755});
  await writeFile(join(bin,'curl'),'#!/bin/sh\nexit "${METADATA_REACHABLE:-7}"\n',{mode:0o755});
  const script=Buffer.from('set -eu\nnode -p \'"node-ok"\' >> proof\npnpm --version >> proof\n'+extraScript);
  const config='version: 1\nsetup:\n  node: "22"\n  pnpm: true\n  script: .github/setup.sh\n  install: node -p \'"install-node"\' >> proof && pnpm --version >> proof\n' +
    (missingPackage ? '  apt: [fixture-missing]\n  brew: [fixture-missing]\n' : '');
  await writeFile(join(bin,'dpkg-query'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  await writeFile(join(bin,'sudo'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  await writeFile(join(bin,'brew'),'#!/bin/sh\necho \'{"formulae":[]}\'\n',{mode:0o755});
  await writeFile(join(root,'.github/ci-kit.yml'),config);
  await writeFile(join(root,'.github/setup.sh'),script);
  execFileSync('git',['init','--quiet',root]);
  execFileSync('git',['-C',root,'remote','add','origin','https://github.com/SSFSKIM/fixture.git']);
  const hash=setupHash(parseConfig(config,{isPrivate:true}).setup,script);
  return {root,hash,run:(phase,extra={})=>spawnSync(process.execPath,[entry.pathname,phase,root,hash],{
    encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,RUNNER_TOOL_CACHE:tools,
      CI_KIT_SETUP_DPKG_QUERY:join(bin,'dpkg-query'),CI_KIT_SETUP_SUDO:join(bin,'sudo'),CI_KIT_SETUP_BREW:join(bin,'brew'),...extra},timeout:20000,
  })};
}

test('first apply and second install both get declared Node and pnpm; smoke repeats setup without installing',async t=>{
  const f=await fixture(t);
  for (const phase of ['apply','warm','smoke']) {
    const result=f.run(phase,phase==='apply'?{}:{CI_KIT_SETUP_HASH:f.hash});
    assert.equal(result.status,0,result.stderr);
  }
  assert.deepEqual((await readFile(join(f.root,'proof'),'utf8')).trim().split('\n'),[
    'node-ok','pnpm-ok','node-ok','pnpm-ok','install-node','pnpm-ok','node-ok','pnpm-ok',
  ]);
});

test('metadata reachability and credentialed git config stop before repository code runs',async t=>{
  const f=await fixture(t);
  let result=f.run('apply',{METADATA_REACHABLE:'0'});
  assert.notEqual(result.status,0); assert.match(result.stderr,/metadata reachable/);
  await assert.rejects(readFile(join(f.root,'proof')),/ENOENT/);
  execFileSync('git',['-C',f.root,'config','http.https://github.com/.extraheader','AUTHORIZATION: secret']);
  result=f.run('apply');
  assert.notEqual(result.status,0); assert.match(result.stderr,/credential/);
  assert.doesNotMatch(result.stderr,/AUTHORIZATION: secret/);
  await assert.rejects(readFile(join(f.root,'proof')),/ENOENT/);
});

test('credential words in repository paths are harmless with real local git config',async t=>{
  const f=await fixture(t);
  execFileSync('git',['-C',f.root,'config','remote.origin.url','https://github.com/owner/credential-tools']);
  execFileSync('git',['-C',f.root,'config','remote.origin.pushurl','https://github.com/owner/extraheader-tools']);
  execFileSync('git',['-C',f.root,'config','url.https://github.com/owner/credential-tools.insteadOf','https://github.com/owner/extraheader-tools']);
  const result=f.run('apply');
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/clone credentials absent/);
  assert.match(await readFile(join(f.root,'proof'),'utf8'),/node-ok/);
});

for (const [name,key,value] of [
  ['helper','credential.helper','store'],
  ['scoped helper','credential.https://github.com.helper','!echo secret'],
  ['username','credential.https://github.com.username','secret'],
  ['global auth header','http.extraHeader','AUTHORIZATION: secret'],
  ['scoped auth header','http.https://github.com/.extraheader','AUTHORIZATION: secret'],
  ['empty auth header','http.https://github.com/.extraheader',''],
  ['scope containing equals','http.https://github.com/?x=y.extraheader','AUTHORIZATION: secret'],
  ['scope containing carriage return','http.https://github.com/\r.extraheader','AUTHORIZATION: secret'],
  ['username URL','remote.origin.url','https://secret@github.com/owner/repo'],
  ['password URL','remote.origin.pushurl','HTTP://user:secret@github.com/owner/repo'],
  ['rewrite URL key','url.https://secret@github.com/.insteadOf','https://github.com/'],
  ['rewrite URL value','url.https://github.com/.insteadOf','https://secret@github.com/'],
  ['proxy URL','http.proxy','socks5://user:secret@proxy.invalid'],
  ['multiline value','remote.origin.url','https://github.com/owner/repo\nhttps://secret@github.com/owner/repo'],
  ['uninspected include','include.path','/nonexistent/bake-config'],
  ['conditional include','includeIf.gitdir:/other/.path','/nonexistent/bake-config'],
]) {
  test(`local git config rejects ${name} before repository code runs`,async t=>{
    const f=await fixture(t);
    execFileSync('git',['-C',f.root,'config','--local',key,value]);
    for(const phase of ['apply','smoke']) {
      if(phase==='smoke') await retain(f.root);
      const result=f.run(phase,{CI_KIT_SETUP_HASH:f.hash});
      assert.notEqual(result.status,0,result.stdout);
      assert.match(result.stderr,/credential|ambiguous/);
      assert.doesNotMatch(result.stderr,/secret/);
      await assert.rejects(readFile(join(f.root,'proof')),/ENOENT/);
    }
  });
}

test('valueless authentication keys cannot bypass the local config guard',async t=>{
  const f=await fixture(t);
  const path=join(f.root,'.git/config');
  await writeFile(path,await readFile(path,'utf8')+'\n[http]\nextraHeader\n');
  const result=f.run('apply');
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/credential/);
  await assert.rejects(readFile(join(f.root,'proof')),/ENOENT/);
});

test('changed pinned declaration and stale image fail smoke even when packages would be present',async t=>{
  const f=await fixture(t);
  await retain(f.root);
  const stale=f.run('smoke',{CI_KIT_SETUP_HASH:'0'.repeat(16)});
  assert.notEqual(stale.status,0); assert.match(stale.stderr,/hash/);
  await writeFile(join(f.root,'.github/setup.sh'),'echo changed\n');
  const changed=f.run('apply');
  assert.notEqual(changed.status,0); assert.match(changed.stderr,/hash/);
  await assert.rejects(readFile(join(f.root,'proof')),/ENOENT/);
});

test('a matching hash cannot hide a missing package: smoke rejects an install even if it succeeds',async t=>{
  const f=await fixture(t,{missingPackage:true});
  await retain(f.root);
  const result=f.run('smoke',{CI_KIT_SETUP_HASH:f.hash});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/job image is not satisfied: installed (apt|brew):fixture-missing/);
});

test('retained inputs run real job-mode setup, preserve its hash and skip install',async t=>{
  const f=await fixture(t,{extraScript:'test "$CI_KIT_SETUP_MODE" = job\n'});
  await writeFile(join(f.root,'package.json'),'{}');
  await retain(f.root);
  await assert.rejects(readFile(join(f.root,'package.json')),/ENOENT/);
  const result=f.run('smoke',{CI_KIT_SETUP_HASH:f.hash});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/clone credentials absent/);
  assert.match(result.stdout,new RegExp(`image matches setup ${f.hash}`));
  assert.match(result.stdout,/installed nothing/);
  assert.deepEqual((await readFile(join(f.root,'proof'),'utf8')).trim().split('\n'),['node-ok','pnpm-ok']);
});

test('a script needing other repository files fails smoke rather than skipping the script or fetching a clone',async t=>{
  const f=await fixture(t,{extraScript:'cat package.json\n'});
  await writeFile(join(f.root,'package.json'),'{}');
  const apply=f.run('apply');
  assert.equal(apply.status,0,apply.stderr);
  await retain(f.root);
  const result=f.run('smoke',{CI_KIT_SETUP_HASH:f.hash});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/setup.script.*failed.*package.json/);
  assert.doesNotMatch(result.stdout,/installed nothing|smoke setup .*: ok/);
});

test('retention materializes in-tree script symlinks without keeping their unrelated directory',async t=>{
  const f=await fixture(t);
  const bytes=await readFile(join(f.root,'.github/setup.sh'));
  await mkdir(join(f.root,'scripts'));
  await writeFile(join(f.root,'scripts/tooling.sh'),bytes);
  await rm(join(f.root,'.github/setup.sh'));
  await symlink('../scripts/tooling.sh',join(f.root,'.github/setup.sh'));
  await retain(f.root);
  await assert.rejects(readFile(join(f.root,'scripts/tooling.sh')),/ENOENT/);
  assert.deepEqual(await readFile(join(f.root,'.github/setup.sh')),bytes);
  const result=f.run('smoke',{CI_KIT_SETUP_HASH:f.hash});
  assert.equal(result.status,0,result.stderr);
});

for(const path of ['.github/ci-kit.yml','.github/setup.sh']) test(`retention refuses ${path} symlinks outside the clone before reading host bytes`,async t=>{
  const f=await fixture(t);
  await rm(join(f.root,path));
  await symlink(process.execPath,join(f.root,path));
  await assert.rejects(retain(f.root),/smoke input .* escapes the checkout/);
});
