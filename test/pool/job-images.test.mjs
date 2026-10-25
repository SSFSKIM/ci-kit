import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as api from '../../pool/bake/job-images.mjs';

async function fixture(t,failPhase) {
  const dir=await mkdtemp(join(tmpdir(),'ci-kit-job-images-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls=[],logs=[];
  const manifest={repos:{'SSFSKIM/one':{revision:'a'.repeat(40),setup_hash:'b'.repeat(16)}}};
  const exec=async(bin,args,options={})=>{
    calls.push({bin,args,options});
    if(bin==='git' && args[0]==='init') {
      await mkdir(args.at(-1),{recursive:true}); await writeFile(join(args.at(-1),'source'),'pinned');
      await symlink('source',join(args.at(-1),'source-link'));
    }
    if(bin==='docker' && args[0]==='run') {
      assert.equal(await readlink(join(dir,'cache','work','ci-kit-setup-ssfskim-one','source-link')),'source',
        'relative links must still resolve inside the mounted work copy, not to a host-only source path');
    }
    if(bin==='docker' && args[0]==='run' && args.includes(failPhase)) throw Error('fixture failure');
    if(bin==='docker' && args[0]==='image') {
      if(args.includes('{{.Size}}')) return args.at(-1)==='ci-kit-runner:latest'?'1000':'1250';
      return 'b'.repeat(16);
    }
    return '';
  };
  return {calls,logs,manifest,options:{manifest,exec,token:'installation-secret',kit:join(dir,'kit'),cache:join(dir,'cache'),sources:join(dir,'sources'),log:m=>logs.push(m)}};
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
  assert.ok(commits[0].args.includes('ENV CI_KIT_SETUP_HASH='+ 'b'.repeat(16)));
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
