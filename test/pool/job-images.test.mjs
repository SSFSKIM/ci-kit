import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, readlink, readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseConfig } from '../../plan/config.mjs';
import { setupHash } from '../../setup/hash.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as api from '../../pool/bake/job-images.mjs';

async function fixture(t,failPhase,{ script = true } = {}) {
  const dir=await mkdtemp(join(tmpdir(),'ci-kit-job-images-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls=[],logs=[];
  const config='version: 1\nsetup:\n  apt: [zsh]\n  install: cat package.json\n'+(script?'  script: ci/bootstrap.sh\n':'');
  const scriptBytes=Buffer.from('set -eu\ncommand -v bash\n');
  const hash=setupHash(parseConfig(config,{isPrivate:true}).setup,script?scriptBytes:undefined);
  const manifest={repos:{'SSFSKIM/one':{revision:'a'.repeat(40),setup_hash:hash}}};
  const exec=async(bin,args,options={})=>{
    calls.push({bin,args,options});
    if(bin==='git' && (args[0]==='init' || args.includes('remote'))) execFileSync(bin,args);
    if(bin==='git' && args.includes('checkout')) {
      const source=args[1];
      await mkdir(join(source,'.github'),{recursive:true});
      await writeFile(join(source,'.github/ci-kit.yml'),config);
      if(script) {
        await mkdir(join(source,'ci'));
        await writeFile(join(source,'ci/bootstrap.sh'),scriptBytes);
      }
      await writeFile(join(source,'source'),'pinned');
      await symlink('source',join(source,'source-link'));
      await writeFile(join(source,'package.json'),'{"private":true}');
      await writeFile(join(source,'.git/objects/pack/fixture.pack'),Buffer.alloc(1024*1024));
    }
    if(bin==='docker' && args[0]==='run') {
      const root=join(dir,'cache','work','ci-kit-setup-ssfskim-one');
      if(!args.includes('--setup')) {
        assert.equal(await readlink(join(root,'source-link')),'source',
          'relative links must still resolve inside the full disposable work copy');
        assert.equal(await readFile(join(root,'package.json'),'utf8'),'{"private":true}');
        assert.equal((await readFile(join(root,'.git/objects/pack/fixture.pack'))).length,1024*1024);
        // Repository commands may mutate the work tree, but never the retained declaration.
        await writeFile(join(root,'.github/ci-kit.yml'),'modified by install');
      }
    }
    if(bin==='docker' && args[0]==='run' && args.includes(failPhase)) throw Error('fixture failure');
    if(bin==='docker' && args[0]==='image') {
      if(args.includes('{{.Size}}')) return args.at(-1)==='ci-kit-runner:latest'?'1000':'1250';
      return hash;
    }
    return '';
  };
  return {calls,logs,manifest,config,scriptBytes,hash,options:{manifest,exec,token:'installation-secret',kit:join(dir,'kit'),cache:join(dir,'cache'),sources:join(dir,'sources'),log:m=>logs.push(m)}};
}

test('build clones exact pins behind metadata firewall, scopes token to fetch, commits only apply and retains legacy entrypoint',async t=>{
  const f=await fixture(t); await api.bakeJobImages(f.options);
  const firstGit=f.calls.findIndex(c=>c.bin==='git');
  assert.ok(f.calls.slice(0,firstGit).some(c=>c.bin==='iptables' && c.args.includes('DOCKER-USER')));
  assert.ok(f.calls.slice(0,firstGit).some(c=>c.bin==='ip6tables' && c.args.includes('fd00:ec2::254/128')));
  const fetch=f.calls.find(c=>c.bin==='git' && c.args.includes('fetch'));
  assert.equal(fetch.args.at(-1),'a'.repeat(40));
  assert.ok(fetch.options.env.GIT_CONFIG_VALUE_0.includes(Buffer.from('x-access-token:installation-secret').toString('base64')));
  assert.ok(!JSON.stringify(f.calls.map(c=>c.args)).includes('installation-secret'));
  const runs=f.calls.filter(c=>c.bin==='docker' && c.args[0]==='run');
  assert.equal(runs.length,2);
  assert.ok(runs[0].args.includes('apply')); assert.ok(runs[1].args.includes('warm'));
  assert.ok(runs[1].args.includes('ci-kit-job/ssfskim-one:latest'));
  for(const {args} of runs) {
    assert.equal(args[args.indexOf('--user')+1],'runner');
    assert.ok(args.includes('/home/runner/externals/node24/bin/node'));
    assert.ok(!args.join(' ').includes('/etc/ci-kit'));
    assert.ok(!args.join(' ').includes('docker.sock'));
  }
  const commits=f.calls.filter(c=>c.bin==='docker' && c.args[0]==='commit');
  assert.equal(commits.length,1);
  assert.ok(commits[0].args.includes('ENTRYPOINT ["/usr/local/bin/ci-kit-entrypoint"]'));
  assert.ok(commits[0].args.includes('CMD []'));
  assert.ok(commits[0].args.includes('WORKDIR /home/runner'));
  assert.ok(commits[0].args.includes('ENV CI_KIT_SETUP_HASH='+ f.hash));
  assert.ok(commits[0].args.includes('LABEL CI_KIT_REPO=SSFSKIM/one'));
  assert.deepEqual(f.manifest.repos['SSFSKIM/one'].apply,{ok:true,image_bytes:250});
  assert.deepEqual(f.manifest.repos['SSFSKIM/one'].warm,{ok:true});
  assert.match(f.logs.join('\n'),/250 bytes above base/);
});

test('failed apply aborts before any commit; failed warm remains recorded and best effort',async t=>{
  const failed=await fixture(t,'apply');
  await assert.rejects(api.bakeJobImages(failed.options),/SSFSKIM\/one.*apply/);
  assert.equal(failed.calls.filter(c=>c.args[0]==='commit').length,0);
  const warm=await fixture(t,'warm'); await api.bakeJobImages(warm.options);
  assert.deepEqual(warm.manifest.repos['SSFSKIM/one'].warm,{ok:false});
});

test('boot smoke runs every job image without committing, and propagates a failing declaration check',async t=>{
  const f=await fixture(t); await api.bakeJobImages(f.options); f.calls.length=0;
  await api.smokeJobImages(f.options);
  const run=f.calls.find(c=>c.bin==='docker' && c.args[0]==='run');
  assert.ok(run.args.includes('ci-kit-job/ssfskim-one:latest'));
  assert.ok(run.args.includes('--setup'));
  assert.equal(f.calls.filter(c=>c.args[0]==='commit').length,0);
  await assert.rejects(api.smokeJobImages({...f.options,exec:async(bin,args,opts)=>{
    if(bin==='docker' && args[0]==='run') throw Error('installed apt:new');
    return f.options.exec(bin,args,opts);
  }}),/SSFSKIM\/one.*smoke/);
});

for(const script of [false,true]) test(`retains only pristine smoke inputs and credential-audit metadata (script ${script})`,async t=>{
  const f=await fixture(t,undefined,{script}); await api.bakeJobImages(f.options);
  const source=join(f.options.sources,'ssfskim-one');
  assert.deepEqual((await readdir(source)).sort(),script?['.git','.github','ci']:['.git','.github']);
  assert.equal(await readFile(join(source,'.github/ci-kit.yml'),'utf8'),f.config);
  if(script) assert.deepEqual(await readFile(join(source,'ci/bootstrap.sh')),f.scriptBytes);
  assert.deepEqual(await readdir(join(source,'.git/objects/pack')),[],'no cloned packs survive');
  assert.equal(execFileSync('git',['-C',source,'config','--local','remote.origin.url'],{encoding:'utf8'}).trim(),
    'https://github.com/SSFSKIM/one.git');
  assert.deepEqual(await readdir(join(f.options.cache,'work')),[],'full work copy is disposable');
  const log=f.logs.find(line=>line.includes('retained smoke inputs'));
  assert.ok(log,'report retained and removed source bytes in the bake log');
  const [,retained,original,removed]=/retained smoke inputs: (\d+) bytes \(was (\d+); removed (\d+)\)/.exec(log);
  assert.ok(Number(retained)<4096,log);
  assert.ok(Number(removed)>=1024*1024,log);
  assert.equal(Number(original)-Number(retained),Number(removed));
  await api.smokeJobImages(f.options);
  assert.match(f.logs.at(-1),new RegExp(`setup ${f.hash}: installed nothing`));
});
