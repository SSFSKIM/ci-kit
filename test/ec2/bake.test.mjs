import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as manifestApi from '../../pool/bake/manifest.mjs';

import * as warmApi from '../../pool/bake/warm.mjs';

const sha = 'a'.repeat(40), revision = 'b'.repeat(40);
const lock = 'lockfileVersion: 9\n';
const hash = createHash('sha256').update(lock).digest('hex');
const base = { v: 1, kit_commit: sha, node: { 22: 'v22.20.0', 24: 'v24.10.0' }, maws: { revision, lock_sha256: hash }, runner_version: '2.338.0' };
const warm = { 'maws-files': { ok: true, detail: 'package.json, pnpm-lock.yaml, pnpm-workspace.yaml, .npmrc' }, 'pnpm-fetch': { ok: true, detail: '' } };

test('one manifest resolves moving inputs once and fetches the lock at the resolved revision', async () => {
  const paths = [];
  const gh = { request: async (_method, path) => {
    paths.push(path);
    if (path.endsWith('/commits/HEAD')) return { sha: revision };
    if (path.includes('pnpm-lock.yaml')) { assert.ok(path.endsWith(`?ref=${revision}`)); return lock; }
    throw Error(path);
  } };
  const reads = [];
  const manifest = await manifestApi.resolveManifest({ sha, gh, fetch: async (url, options) => {
    reads.push(url);
    assert.equal(options.headers?.authorization, undefined, 'public reads must not use the MAWS-only token');
    return { ok: true, json: async () => [{version:'v24.10.0'}, {version:'v22.20.0'}, {version:'v22.19.0'}], text: async () => 'FROM ghcr.io/actions/actions-runner:2.338.0@sha256:deadbeef\n' };
  } });
  assert.deepEqual(manifest, base);
  assert.deepEqual(reads, ['https://nodejs.org/dist/index.json',`https://raw.githubusercontent.com/SSFSKIM/ci-kit/${sha}/pool/image/Dockerfile`]);
  assert.equal(paths.length, 2);
});

test('warm evidence rejects changed pins, failed warming and parity mismatch before promotion', () => {
  const actual = { ...base, warm };
  assert.deepEqual(manifestApi.verifyManifest(actual, base), actual);
  assert.throws(() => manifestApi.verifyManifest({ ...actual, kit_commit: 'c'.repeat(40) }, base), /manifest/);
  assert.throws(() => manifestApi.verifyManifest({ ...actual, warm: { ...warm, electron: {ok:false} } }, base), /warm/);
  assert.throws(() => manifestApi.verifyManifest(actual, { ...base, warm: { ...warm, electron: {ok:true, detail:'44'} } }), /warm/);
  assert.throws(() => manifestApi.verifyManifest({ ...base, warm: {} }, base), /warm/);
});

test('cloud labels preserve full hashes, match across providers and change with warm results', () => {
  const labels = manifestApi.manifestLabels({ ...base, warm });
  assert.equal(labels['ci-kit-commit'], sha);
  assert.equal(labels['ci-kit-maws-lock-a'] + labels['ci-kit-maws-lock-b'], hash);
  for (const [key,value] of Object.entries(labels)) { assert.ok(key.length <= 63); assert.match(value, /^[a-z0-9_-]{1,63}$/); }
  const changed = manifestApi.manifestLabels({ ...base, warm: { ...warm, electron: {ok:true,detail:'44'} } });
  assert.notEqual(labels['ci-kit-warm-a'], changed['ci-kit-warm-a']);
});

test('warm reads every file at one revision and refuses a changed lock before fetching packages', async () => {
  const paths = [];
  const gh = { request: async (_method, path) => { paths.push(path); return path.includes('pnpm-lock.yaml') ? lock : '{}'; } };
  const files = await warmApi.warmFiles(gh, base);
  assert.equal(files['pnpm-lock.yaml'], lock);
  assert.equal(paths.length, 4);
  assert.ok(paths.every((p) => p.endsWith(`?ref=${revision}`)));
  await assert.rejects(warmApi.warmFiles(gh, { ...base, maws: { ...base.maws, lock_sha256: '0'.repeat(64) } }), /lockfile/);
});

test('provider stages share one resolution, including after a provider fails', async () => {
  let resolutions = 0;
  const inputs = [], actual = { ...base, warm };
  await assert.rejects(manifestApi.bakeProviders({
    resolve: async () => { resolutions++; return base; },
    gce: async (m) => { inputs.push(m); return { manifest: actual }; },
    accounts: ['a', 'b'], ec2: async (account, m) => { inputs.push(m); if (account === 'a') throw Error('account a'); return {manifest:m}; },
  }), /account a/);
  assert.equal(resolutions, 1);
  assert.deepEqual(inputs, [base, actual, actual]);
});

// Fake only the external SDK boundary; the bake performs its own polling, promotion and cleanup.
async function ec2Fixture({ smoke = 'ok', job = 'success', warmResult = warm, lostLaunch = false, refuseFirstSmoke = false, reportMissing = false, snapshotBytes = 12 * 2**30 } = {}) {
  const api = await import('../../ec2/bake/bake.mjs');
  const calls = [], instances = [], images = [];
  const tags = (x) => Object.fromEntries((x.Tags ?? []).map((t) => [t.Key,t.Value]));
  const send = async (command, role = 'bake') => {
    const name = command.constructor.name, input = command.input;
    calls.push([name, input, role]);
    if (name === 'GetParameterCommand') return { Parameter: { Value: 'ami-canonical' } };
    if (name === 'RunInstancesCommand') {
      if (refuseFirstSmoke && input.ImageId !== 'ami-canonical' && input.NetworkInterfaces[0].SubnetId === 'subnet-c') throw Object.assign(Error('no capacity'),{name:'InsufficientInstanceCapacity'});
      const i = { InstanceId: `i-${instances.length}`, State: { Name: input.ImageId === 'ami-canonical' ? 'stopped' : 'terminated' }, Tags: input.TagSpecifications[0].Tags };
      instances.push(i);
      if (lostLaunch) throw Error('connection lost');
      return { Instances: [i] };
    }
    if (name === 'DescribeInstancesCommand') return { Reservations: [{ Instances: input.InstanceIds ? instances.filter((i) => input.InstanceIds.includes(i.InstanceId)) : instances }] };
    if (name === 'CreateImageCommand') { images.push({ ImageId: 'ami-new', State:'available', CreationDate:'2026-10-23T12:00:00Z', Tags: input.TagSpecifications[0].Tags, BlockDeviceMappings:[{DeviceName:'/dev/sda1',Ebs:{SnapshotId:'snap-new'}}] }); return {ImageId:'ami-new'}; }
    if (name === 'DescribeImagesCommand') return { Images: images };
    if (name === 'DescribeSnapshotsCommand') return {Snapshots:[{SnapshotId:'snap-new',State:'completed',FullSnapshotSizeInBytes: snapshotBytes,VolumeSize:50}]};
    if (name === 'GetObjectCommand') {
      if (reportMissing && input.Key.includes('smoke/exit')) throw Object.assign(Error('missing'),{name:'NoSuchKey'});
      let data;
      if (input.Key.endsWith('/builder.json')) data = { value:'ok', manifest:{...base,warm:warmResult} };
      else data = {kind:'terminal',value:'exit:0',smoke};
      return { Body: { transformToString: async () => JSON.stringify(data) } };
    }
    if (name === 'CreateTagsCommand') { for (const i of images) if (input.Resources.includes(i.ImageId)) i.Tags = [...i.Tags.filter((t) => !input.Tags.some((v) => v.Key === t.Key)), ...input.Tags]; return {}; }
    if (['TerminateInstancesCommand','DeregisterImageCommand','DeleteSnapshotCommand'].includes(name)) return {};
    throw Error(name);
  };
  const aws = {ec2:{send},ssm:{send},s3:{send},presignPut: async ({key}) => `https://reports.invalid/${key}`};
  let runner;
  const gh = {
    getRepo: async () => ({private:true}), jitConfig: async (_repo, body) => { runner=body.name; return {runner:{id:1},encoded_jit_config:'secret-jit'}; },
    dispatchWorkflow: async () => ({workflow_run_id:8,html_url:'https://job'}), getRun: async () => ({status:'completed',conclusion:job}),
    listJobs: async () => [{runner_name:runner,conclusion:job}], deleteRunner: async () => {}, runners: async () => [], cancelRun: async () => {},
  };
  const cfg = {account:'123456789012',region:'us-east-2',disk_gb:50,initialization_mibps:200,security_group:'sg-pool',report_bucket:'reports',placements:[{zone:'us-east-2c',subnet:'subnet-c'},{zone:'us-east-2a',subnet:'subnet-a'},{zone:'us-east-2b',subnet:'subnet-b'}]};
  let time = 0;
  const run = () => api.runEc2Bake(aws, { runtimeAws:{ec2:{send:(c)=>send(c,'launcher')}}, cfg, manifest:base, runId:'20261023-120000-abcd',token:'warm-token',gh,script:'#!/bin/bash\n__MANIFEST__\n__TOKEN__\n__REPORT__\n__KIT_SHA__',now:()=>time,sleep:async (ms)=>{time+=ms;} });
  return {run,calls,images,tags};
}

test('EC2 bake stops an on-demand Canonical builder, proves smoke and real job, then promotes with full snapshot cost', async () => {
  const f = await ec2Fixture();
  const result = await f.run();
  const launches = f.calls.filter(([n]) => n === 'RunInstancesCommand').map(([,v]) => v);
  assert.equal(launches.length,3);
  assert.deepEqual(f.calls.filter(([n]) => n === 'RunInstancesCommand').map((c) => c[2]), ['bake','launcher','launcher']);
  assert.equal(launches[0].ImageId,'ami-canonical');
  assert.equal(launches[0].InstanceMarketOptions,undefined);
  assert.equal(launches[0].InstanceInitiatedShutdownBehavior,'stop');
  assert.equal(launches[0].IamInstanceProfile,undefined);
  assert.equal(launches[0].MetadataOptions.HttpTokens,'required');
  assert.equal(launches[1].BlockDeviceMappings[0].Ebs.VolumeInitializationRate,200);
  assert.equal(launches[1].InstanceInitiatedShutdownBehavior,'terminate');
  assert.deepEqual(launches[1].InstanceMarketOptions,{MarketType:'spot',SpotOptions:{SpotInstanceType:'one-time',InstanceInterruptionBehavior:'terminate'}});
  for (const input of launches) {
    assert.equal(input.TagSpecifications.length,2);
    assert.deepEqual(input.TagSpecifications[0].Tags,input.TagSpecifications[1].Tags);
  }
  const ready = f.calls.findIndex(([n,v]) => n === 'CreateTagsCommand' && v.Tags.some((t) => t.Key==='ci-kit-ready' && t.Value==='true'));
  const lastLaunch = f.calls.findLastIndex(([n]) => n === 'RunInstancesCommand');
  assert.ok(ready > lastLaunch);
  assert.equal(f.tags(f.images[0])['ci-kit-snapshot-gib'],'12');
  assert.equal(result.initializationUsd,0.0288);
  assert.deepEqual(result.manifest,{...base,warm});
});

for (const failure of [{smoke:'failed:metadata'}, {job:'failure'}, {warmResult:{...warm,'pnpm-fetch':{ok:false}}}]) test(`EC2 failed proof leaves image unready and deletes its snapshots: ${JSON.stringify(failure)}`, async () => {
  const f = await ec2Fixture(failure);
  await assert.rejects(f.run());
  assert.ok(!f.calls.some(([n,v]) => n === 'CreateTagsCommand' && v.Tags.some((t) => t.Key==='ci-kit-ready' && t.Value==='true')));
  if (f.images.length) {
    assert.ok(f.calls.some(([n]) => n === 'DeregisterImageCommand'));
    assert.ok(f.calls.some(([n,v]) => n === 'DeleteSnapshotCommand' && v.SnapshotId==='snap-new'));
  }
});

test('lost launch response is not replayed and owned builder is cleaned by tag', async () => {
  const f = await ec2Fixture({lostLaunch:true});
  await assert.rejects(f.run(),/connection lost/);
  assert.equal(f.calls.filter(([n]) => n === 'RunInstancesCommand').length,1);
  assert.ok(f.calls.some(([n,v]) => n === 'TerminateInstancesCommand' && v.InstanceIds.includes('i-0')));
});

test('GCE images carry the same manifest labels and reject a mismatched builder before imaging', async () => {
  const { runBake } = await import('../../gce/bake/bake.mjs');
  const { fakeGce, fakeSandbox } = await import('../gce/fake-gce.mjs');
  const { ONE_REGION_CFG } = await import('../gce/config-fixtures.mjs');
  const runId='20261023-120000-abcd';
  for (const actual of [{...base,warm},{...base,kit_commit:'d'.repeat(40),warm}]) {
    const gce = fakeGce({scripts:{builder:[{status:'TERMINATED',attrs:{'ci-kit/bake':'ok','ci-kit/manifest':JSON.stringify(actual)}}],smoke:[{status:'TERMINATED',attrs:{'ci-kit/smoke':'ok'}}],check:[{status:'TERMINATED',attrs:{'ci-kit/job':'exit:0'}}]}});
    const gh = fakeSandbox({run:[{status:'completed',conclusion:'success',ranOn:true}]});
    let time=0;
    const pending = runBake(gce,{cfg:ONE_REGION_CFG,sha,runId,token:'token',gh,script:'#!/bin/bash',manifest:base,now:()=>time,sleep:async(ms)=>{time+=ms;}});
    if (actual.kit_commit !== sha) await assert.rejects(pending,/manifest/);
    else {
      const result=await pending;
      assert.deepEqual(result.manifest,actual);
      const image=await gce.image(result.image);
      for (const [k,v] of Object.entries(manifestApi.manifestLabels(actual))) assert.equal(image.labels[k],v);
    }
  }
});

test('deployment uploads the whole checkout and budgets each configured account, with no AWS secret environment', async () => {
  const {mkdtemp,mkdir,writeFile,copyFile,readFile,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {execFileSync} = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(),'ci-kit-bake-deploy-'));
  try {
    await Promise.all(['gce','pool/config','bin'].map((p)=>mkdir(join(root,p),{recursive:true})));
    await copyFile(new URL('../../gce/deploy.sh',import.meta.url),join(root,'gce/deploy.sh'));
    await writeFile(join(root,'bin/git'),'#!/bin/sh\necho aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',{mode:0o755});
    await writeFile(join(root,'bin/gcloud'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n',{mode:0o755});
    const deadlines=[];
    for (const count of [0,2]) {
      await writeFile(join(root,'pool/config/ec2.json'),JSON.stringify({enabled:false,accounts:Array.from({length:count},()=>({enabled:false}))}));
      await writeFile(join(root,'calls'),'');
      execFileSync('bash',[join(root,'gce/deploy.sh'),'bake'],{env:{...process.env,PATH:`${root}/bin:${process.env.PATH}`,CALLS:join(root,'calls')}});
      const command=(await readFile(join(root,'calls'),'utf8')).split('\n').find((s)=>s.includes('jobs deploy'));
      assert.ok(command.includes(`--source=${root}`));
      assert.doesNotMatch(command,/AWS_ACCESS_KEY|AWS_SECRET|EC2_.*ROLES/);
      deadlines.push(Number(/--task-timeout=(\d+)m/.exec(command)[1]));
    }
    assert.ok(deadlines[0]>=180);
    assert.ok(deadlines[1]>=deadlines[0]+200,'two accounts need their own bounded build/smoke/check time');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('retention leaves two ready generations and recent failures, deleting snapshots with each older image', async () => {
  const {imagesToPrune,removeImage} = await import('../../ec2/bake/bake.mjs');
  const now=Date.parse('2026-10-23T12:00:00Z');
  const image=(id,created,ready,pool='ec2')=>({ImageId:id,CreationDate:created,Tags:[{Key:'ci-kit-pool',Value:pool},{Key:'ci-kit-ready',Value:String(ready)}],BlockDeviceMappings:[{Ebs:{SnapshotId:`snap-${id}`}}]});
  const images=[image('old','2026-10-10',true),image('mid','2026-10-20',true),image('new','2026-10-23',true),image('failed','2026-10-21',false),image('building','2026-10-23',false),image('foreign','2026-10-10',false,'elsewhere')];
  const doomed=imagesToPrune(images,now);
  assert.deepEqual(doomed.map((i)=>i.ImageId),['old','failed']);
  const calls=[];
  for (const i of doomed) await removeImage({send:async(c)=>calls.push([c.constructor.name,c.input])},i);
  assert.deepEqual(calls,[['DeregisterImageCommand',{ImageId:'old'}],['DeleteSnapshotCommand',{SnapshotId:'snap-old'}],['DeregisterImageCommand',{ImageId:'failed'}],['DeleteSnapshotCommand',{SnapshotId:'snap-failed'}]]);
  await assert.rejects(removeImage({send:async()=>assert.fail('foreign mutation')},images.at(-1)),/foreign/);
});

test('shipped builder script fits raw user-data and preparation consumes pinned Node versions without resolving latest', async () => {
  const {fillEc2Builder}=await import('../../ec2/bake/bake.mjs');
  const {readFile,mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {execFileSync}=await import('node:child_process');
  const template=await readFile(new URL('../../ec2/bake/builder.sh',import.meta.url),'utf8');
  const script=fillEc2Builder(template,{manifest:base,token:'one-hour-token',report:'https://example.invalid/signed?token=x&part=1'});
  assert.ok(Buffer.byteLength(script)<=16384);
  execFileSync('bash',['-n'],{input:script});
  assert.throws(()=>fillEc2Builder(template,{manifest:base,token:'x'.repeat(16000),report:'url'}),/16 KiB/);
  const dir=await mkdtemp(join(tmpdir(),'ci-kit-prepare-'));
  try {
    await writeFile(join(dir,'manifest'),JSON.stringify(base));
    const driver=`set -euo pipefail
CACHE=/unused
warm_token() { echo token; }
curl() { printf '%s\\n' "$*"; }
mkdir() { :; }; tar() { :; }; touch() { :; }; rm() { :; }; cp() { :; }; ln() { :; }
cd() { :; }; npm() { :; }; docker() { :; }; node() { :; }; chown() { :; }
. "$1"
`;
    const output=execFileSync('bash',['-c',driver,'test',new URL('../../pool/bake/prepare.sh',import.meta.url).pathname],{env:{...process.env,CI_KIT_BAKE_MANIFEST:join(dir,'manifest')},encoding:'utf8'});
    assert.match(output,/\/v22\.20\.0\/node-v22\.20\.0-linux-x64.tar.xz/);
    assert.match(output,/\/v24\.10\.0\/node-v24\.10\.0-linux-x64.tar.xz/);
    assert.doesNotMatch(output,/index.json/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});


test('smoke and real check walk capacity-refused zones on spot with fresh zonal client tokens', async () => {
  const f=await ec2Fixture({refuseFirstSmoke:true});
  await f.run();
  const launches=f.calls.filter(([n,v])=>n==='RunInstancesCommand' && v.ImageId!=='ami-canonical').map(([,v])=>v);
  assert.deepEqual(launches.map((v)=>v.NetworkInterfaces[0].SubnetId),['subnet-c','subnet-a','subnet-c','subnet-a']);
  assert.equal(new Set(launches.map((v)=>v.ClientToken)).size,4);
});

test('a terminated smoke with no terminal object times out instead of becoming ready',async()=>{
  const f=await ec2Fixture({reportMissing:true});
  await assert.rejects(f.run(),/smoke: timeout/);
  assert.ok(f.calls.some(([n])=>n==='DeleteSnapshotCommand'));
});

test('unknown full snapshot size fails closed rather than charging the volume allocation size',async()=>{
  const f=await ec2Fixture({snapshotBytes:null});
  await assert.rejects(f.run(),/full written size/);
  assert.ok(!f.calls.some(([n,v])=>n==='CreateTagsCommand' && v.Tags.some((t)=>t.Key==='ci-kit-ready' && t.Value==='true')));
});

test('GCE stage refuses an absent manifest before launching a builder',async()=>{
  const {runBake}=await import('../../gce/bake/bake.mjs');
  await assert.rejects(runBake({}, {sha,runId:'test'}),/manifest/);
});

test('builder finalizes only after cloud-final late writes, and the resulting disk passes the unchanged host smoke', async () => {
  const {readFile,writeFile,mkdtemp,mkdir,symlink,rm,access} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {execFileSync} = await import('node:child_process');
  const {fillEc2Builder} = await import('../../ec2/bake/bake.mjs');
  const {checkImage} = await import('../../ec2/vm/job.mjs');
  const root = await mkdtemp(join(tmpdir(),'ci-kit-finalize-'));
  const present = async (p) => access(join(root,p)).then(()=>true,()=>false);
  // Relocate the real shell's filesystem operations; cloud tools are stubbed, not its cleanup commands.
  const relocate = (s) => s.replace(/\/(etc|opt|var|root|run|tmp|snap)(?=\/|\s|$)/g,`${root}/$1`).replace('await checkImage();','await checkImage(process.env.TEST_ROOT);');
  const driver = `set -euo pipefail
apt-get() { :; }; git() { :; }; docker() { :; }; journalctl() { :; }; fstrim() { :; }; sync() { :; }
cloud-init() { :; }
systemctl() { printf '%s\\n' "$*" >> "$TEST_ROOT/systemctl"; }
poweroff() { echo poweroff >> "$TEST_ROOT/poweroff"; }
curl() { if [[ "$*" == *'--data-binary @-'* ]]; then cat >> "$TEST_ROOT/report.jsonl"; else printf '%s\\n' "$*" >> "$TEST_ROOT/curl-calls"; fi; }
. "$1"
`;
  const run = (file) => execFileSync('bash',['-c',driver,'fixture',file],{env:{...process.env,TEST_ROOT:root},encoding:'utf8'});
  try {
    for (const p of ['etc/apt/preferences.d','etc/systemd/system','etc/netplan','etc/cloud','var/log','var/lib/ci-kit','opt/ci-kit/pool/bake','opt/ci-kit/ec2','run/systemd/system','tmp']) await mkdir(join(root,p),{recursive:true});
    await symlink(new URL('../../ec2/vm',import.meta.url).pathname,join(root,'opt/ci-kit/ec2/vm'));
    await writeFile(join(root,'opt/ci-kit/pool/bake/prepare.sh'),'WARM_OK=1\n');
    const template=await readFile(new URL('../../ec2/bake/builder.sh',import.meta.url),'utf8');
    const builder=join(root,'builder.sh');
    await writeFile(builder,relocate(fillEc2Builder(template,{manifest:{...base,warm},token:'fixture-token',report:'https://reports.invalid/builder'})));
    run(builder);
    assert.equal(await present('report.jsonl'),false,'userdata must not report success before cloud-final exits');
    assert.equal(await present('poweroff'),false,'userdata must return, not interrupt cloud-final');
    const calls=await readFile(join(root,'systemctl'),'utf8');
    assert.match(calls,/--no-block start ci-kit-bake-finalize.service/,'synchronous start would deadlock against the running cloud-final');
    const unit=await readFile(join(root,'run/systemd/system/ci-kit-bake-finalize.service'),'utf8');
    assert.match(unit,/^After=.*\bcloud-final.service\b/m,'the enqueued service must wait for the complete final stage');
    // Canonical 26.2 status_wrapper writes these after scripts-user; atomic_helper recreates data/.
    await mkdir(join(root,'var/lib/cloud/data'),{recursive:true});
    await writeFile(join(root,'var/lib/cloud/data/status.json'),'late status');
    await writeFile(join(root,'var/lib/cloud/data/result.json'),'late result');
    await writeFile(join(root,'var/log/cloud-init.log'),'late final-message log');
    await assert.rejects(checkImage(root),/cloud-init/);
    const finalizer=join(root,'opt/ci-kit/ec2/bake/finalize.sh');
    await mkdir(join(root,'opt/ci-kit/ec2/bake'),{recursive:true});
    await writeFile(finalizer,relocate(await readFile(new URL('../../ec2/bake/finalize.sh',import.meta.url),'utf8')));
    run(finalizer);
    await checkImage(root);
    const report=JSON.parse(await readFile(join(root,'report.jsonl'),'utf8'));
    assert.equal(report.value,'ok');
    assert.deepEqual(report.manifest,{...base,warm});
    assert.equal(await present('poweroff'),true);
    assert.equal(await present('run/ci-kit-bake'),false,'finalizer removes its temporary report capability');

    // A failed preparation must still power off and report, never enqueue a success finalizer.
    for (const p of ['report.jsonl','poweroff','systemctl','curl-calls']) await rm(join(root,p),{force:true});
    await writeFile(join(root,'opt/ci-kit/pool/bake/prepare.sh'),'WARM_OK=0\n');
    assert.throws(()=>run(builder));
    assert.equal(await present('poweroff'),true);
    assert.equal(await present('report.jsonl'),false);
    assert.match(await readFile(join(root,'curl-calls'),'utf8'),/failed:warm-check/);
    assert.doesNotMatch(await readFile(join(root,'systemctl'),'utf8'),/start ci-kit-bake-finalize/);

    // The finalizer's self-check is authoritative: a bad manifest cannot produce ok, even with clean state.
    for (const p of ['report.jsonl','poweroff','curl-calls']) await rm(join(root,p),{force:true});
    await mkdir(join(root,'run/ci-kit-bake'),{recursive:true});
    await writeFile(join(root,'run/ci-kit-bake/report-url'),'https://reports.invalid/builder');
    await writeFile(join(root,'etc/ci-kit/bake-manifest.json'),'{}');
    assert.throws(()=>run(finalizer));
    assert.equal(await present('poweroff'),true);
    assert.deepEqual(JSON.parse(await readFile(join(root,'report.jsonl'),'utf8')), {
      value:'failed:image',diagnostic:{reason:'manifest-incomplete',path:'/etc/ci-kit/bake-manifest.json'},
    });
    assert.equal(await present('run/ci-kit-bake'),false);
  } finally { await rm(root,{recursive:true,force:true}); }
});
