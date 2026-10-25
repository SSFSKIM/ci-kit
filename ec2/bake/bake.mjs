// One account's AMI stage. All AWS calls use federated clients; nothing reads an operator profile.
import {
  RunInstancesCommand, DescribeInstancesCommand, TerminateInstancesCommand, CreateSnapshotCommand, RegisterImageCommand,
  DescribeImagesCommand, DescribeSnapshotsCommand, CreateTagsCommand, DeregisterImageCommand, DeleteSnapshotCommand,
} from '@aws-sdk/client-ec2';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { manifestTags, verifyManifest, logRepoResults } from '../../pool/bake/manifest.mjs';
import { CHECK, checkJitRequest, checkOutcome } from '../../gce/bake/plan.mjs';
import { formatDiagnostic } from '../vm/diagnostics.mjs';

const MINUTE = 60_000;
const UBUNTU = '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id';
const tagsOf = (x) => Object.fromEntries((x.Tags ?? []).map(({ Key, Value }) => [Key, Value]));
const tags = (obj) => Object.entries(obj).map(([Key, Value]) => ({ Key, Value: String(Value) }));
const filters = (obj) => Object.entries(obj).map(([key, value]) => ({ Name: `tag:${key}`, Values: [String(value)] }));
const owned = (x, run) => tagsOf(x)['ci-kit-pool'] === 'ec2' && tagsOf(x)['ci-kit-run'] === run;
const failureStages = new Set(['userdata', 'deadline', 'prepare', 'image', 'container', 'unit',
  'start', 'apt', 'kit', 'node', 'deps', 'warm', 'warm-check', 'boot', 'clean', 'compact', 'finalizer', 'report-input', 'report']);
const safeOutcome = value => typeof value === 'string' && (/^exit:-?\d{1,3}$/.test(value)
  || (value.startsWith('failed:') && failureStages.has(value.slice(7)))) ? value : 'invalid report';

export function fillEc2Builder(template, { manifest, token, report }) {
  const replacements = {
    __KIT_SHA__: manifest.kit_commit,
    __MANIFEST__: Buffer.from(JSON.stringify(manifest)).toString('base64'),
    __TOKEN__: Buffer.from(token).toString('base64'),
    __REPORT__: Buffer.from(report).toString('base64'),
  };
  const script = template.replace(/__[A-Z_]+__/g, (key) => {
    if (!(key in replacements)) throw new Error(`unknown builder placeholder ${key}`);
    return replacements[key];
  });
  if (Buffer.byteLength(script) > 16384) throw new Error('EC2 builder user-data exceeds 16 KiB');
  return script;
}

export function imagesToPrune(images, now) {
  const ours = images.filter((i) => tagsOf(i)['ci-kit-pool'] === 'ec2');
  return [
    ...ours.filter((i) => tagsOf(i)['ci-kit-ready'] === 'true').sort((a,b) => Date.parse(b.CreationDate)-Date.parse(a.CreationDate)).slice(2),
    ...ours.filter((i) => tagsOf(i)['ci-kit-ready'] !== 'true' && now - Date.parse(i.CreationDate) > 86400_000),
  ];
}

async function list(client, Command, input, field) {
  const items = []; let NextToken;
  do { const res = await client.send(new Command({ ...input, ...(NextToken ? { NextToken } : {}) })); items.push(...(res[field] ?? [])); NextToken = res.NextToken; } while (NextToken);
  return items;
}

export async function removeImage(ec2, image) {
  if (tagsOf(image)['ci-kit-pool'] !== 'ec2') throw new Error('refusing to delete foreign image');
  const snapshots = [...new Set((image.BlockDeviceMappings ?? []).map((d) => d.Ebs?.SnapshotId).filter(Boolean))];
  await ec2.send(new DeregisterImageCommand({ ImageId: image.ImageId }));
  for (const SnapshotId of snapshots) await ec2.send(new DeleteSnapshotCommand({ SnapshotId }));
}

// promote:false retains a smoke/job-passed candidate without selecting it for production or pruning other images.
// The ordinary unready-image guard still expires that candidate after one day.
export async function runEc2Bake(aws, { runtimeAws, cfg, manifest, runId, token, gh, script, sleep, promote = true, now = Date.now, log = () => {} }) {
  const run = `${runId}-${cfg.account}`;
  const prefix = `reports/bake-${run}`;
  const ec2 = aws.ec2;
  let image, checked = false, runner, runnerName, checkRun;
  const pool = { 'ci-kit-pool': 'ec2', 'ci-kit-run': run };
  const wait = async (label, timeout, fn) => {
    const start = now();
    for (;;) {
      const result = await fn();
      if (result) return result;
      if (now() - start >= timeout) throw new Error(`${label}: timeout`);
      await sleep(15_000);
    }
  };
  const report = async (key) => {
    let text;
    try { const res = await aws.s3.send(new GetObjectCommand({ Bucket: cfg.report_bucket, Key: `${prefix}/${key}.json` })); text = await res.Body.transformToString(); }
    catch (error) { if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return null; throw error; }
    // JSON parser messages can quote the input; the report body never belongs in controller logs.
    try { return JSON.parse(text); } catch { throw new Error(`invalid ${key} report JSON`); }
  };
  const url = (key) => aws.presignPut({ bucket: cfg.report_bucket, key: `${prefix}/${key}.json` });
  const instance = async (id) => (await list(ec2, DescribeInstancesCommand, { InstanceIds: [id] }, 'Reservations')).flatMap((r) => r.Instances ?? [])[0];
  const launch = async (purpose, imageId, userData, builder = false) => {
    if (Buffer.byteLength(userData) > 16384) throw new Error('EC2 user-data exceeds 16 KiB');
    const labels = { ...pool, 'ci-kit-purpose': purpose, 'ci-kit-deadline': new Date(now() + (builder ? 120 : 30) * MINUTE).toISOString() };
    const client = builder ? ec2 : runtimeAws.ec2;
    for (const [attempt, placement] of cfg.placements.entries()) {
      let res;
      try { res = await client.send(new RunInstancesCommand({
      ImageId: imageId, InstanceType: 'c8a.2xlarge', MinCount: 1, MaxCount: 1,
      ClientToken: `bake-${run}-${builder ? 'builder' : JSON.parse(userData).alloc.split('-').pop()}-${attempt}`,
      NetworkInterfaces: [{DeviceIndex:0,SubnetId:placement.subnet,Groups:[cfg.security_group],AssociatePublicIpAddress:true}],
      ...(!builder ? {InstanceMarketOptions:{MarketType:'spot',SpotOptions:{SpotInstanceType:'one-time',InstanceInterruptionBehavior:'terminate'}}} : {}),
      MetadataOptions: { HttpTokens:'required', HttpPutResponseHopLimit:1, HttpEndpoint:'enabled', HttpProtocolIpv6:'disabled' },
      InstanceInitiatedShutdownBehavior: builder ? 'stop' : 'terminate',
      BlockDeviceMappings: [{DeviceName:'/dev/sda1',Ebs:{VolumeType:'gp3',VolumeSize:cfg.disk_gb,Encrypted:true,DeleteOnTermination:true,
        ...(!builder ? {VolumeInitializationRate:cfg.initialization_mibps} : {})}},
        ...(builder ? [{DeviceName:'/dev/sdf',Ebs:{VolumeType:'gp3',VolumeSize:cfg.disk_gb,Encrypted:true,DeleteOnTermination:true}}] : [])],
      TagSpecifications: ['instance','volume'].map((ResourceType) => ({ ResourceType, Tags:tags(labels) })),
      UserData: Buffer.from(userData).toString('base64'),
      })); } catch (error) {
        // Only definite zonal refusals permit another send. Transport ambiguity exits to tag-based cleanup.
        if (!['InsufficientInstanceCapacity','SpotMaxPriceTooLow','Unsupported'].includes(error.name)) throw error;
        log(`${cfg.account}: ${purpose} refused ${placement.zone}: ${error.name}`);
        continue;
      }
      const id = res.Instances?.[0]?.InstanceId;
      if (!id) throw new Error('RunInstances returned no instance');
      log(`${cfg.account}: ${purpose} ${id} launched (${builder ? 'Canonical on-demand builder' : 'pool image spot'})`);
      return id;
    }
    throw new Error(`${cfg.account}: no zone took ${purpose}`);
  };
  const guestData = async (kind, extra) => ({ v:1,alloc:`bake-${run}-${kind}`,deadline:new Date(now()+20*MINUTE).toISOString(), ...extra,
    report:Object.fromEntries(await Promise.all(['boot','notice','exit'].map(async (event) => [event,await url(`${kind}/${event}`)]))) });
  const terminal = async (id, kind) => {
    const i = await instance(id);
    if (!i || !owned(i, run)) throw new Error(`${kind} instance missing or no longer owned`);
    const r = await report(`${kind}/exit`);
    if (r && (r.kind !== 'terminal' || r.value !== 'exit:0' || (kind === 'smoke' && r.smoke !== 'ok'))) {
      // Reports cross a storage boundary: reflect only known outcomes and the shared bounded diagnostic vocabulary.
      const value = r.kind === 'terminal' ? safeOutcome(r.value) : 'invalid terminal report';
      throw new Error(`${kind} failed: ${value} ${formatDiagnostic(r.diagnostic)}`);
    }
    // S3 reports and EC2 state arrive independently. Missing terminal evidence never implies success.
    return r && i.State.Name === 'terminated' ? r : null;
  };
  const cleanupStep = async (label, fn) => { try { await fn(); } catch (error) { log(`cleanup ${cfg.account} ${label}: ${error.message}`); } };
  try {
    const base = await aws.ssm.send(new GetParameterCommand({Name:UBUNTU}));
    const baseImage = (await ec2.send(new DescribeImagesCommand({ImageIds:[base.Parameter.Value]}))).Images?.[0];
    if (!baseImage) throw new Error('Canonical image attributes unavailable');
    const builderScript = fillEc2Builder(script, {manifest,token,report:await url('builder')});
    const builder = await launch('builder',base.Parameter.Value,builderScript,true);
    const built = await wait('builder',30*MINUTE,async () => {
      const i = await instance(builder), r = await report('builder');
      if (!i || !owned(i,run)) throw new Error('builder missing or no longer owned');
      if (r && r.value !== 'ok') throw new Error(`builder failed: ${safeOutcome(r.value)} ${formatDiagnostic(r.diagnostic)}`);
      if (i.State.Name === 'terminated') throw new Error('builder terminated before snapshot');
      return i.State.Name === 'stopped' && r ? {report:r,instance:i} : null;
    });
    const actual = verifyManifest(built.report.manifest,manifest);
    logRepoResults(actual, log);
    const labels = { ...pool,...manifestTags(actual),'ci-kit-ready':'false' };
    const target = built.instance.BlockDeviceMappings?.find(d => d.DeviceName === '/dev/sdf')?.Ebs?.VolumeId;
    if (!target) throw new Error('builder compacted destination volume missing');
    const snapshot = await ec2.send(new CreateSnapshotCommand({VolumeId:target,Description:`ci-kit compacted root ${run}`,
      TagSpecifications:[{ResourceType:'snapshot',Tags:tags(labels)}]}));
    await wait('snapshot',30*MINUTE,async () => {
      const s = (await ec2.send(new DescribeSnapshotsCommand({SnapshotIds:[snapshot.SnapshotId]}))).Snapshots?.[0];
      if (s && !owned(s,run)) throw new Error('snapshot no longer owned');
      if (s?.State === 'error') throw new Error('CreateSnapshot failed');
      return s?.State === 'completed' ? s : null;
    });
    const made = await ec2.send(new RegisterImageCommand({Name:`ci-kit-${run}`,
      Architecture:baseImage.Architecture,VirtualizationType:baseImage.VirtualizationType,RootDeviceName:baseImage.RootDeviceName,
      EnaSupport:baseImage.EnaSupport,BootMode:baseImage.BootMode,ImdsSupport:baseImage.ImdsSupport,
      ...(baseImage.TpmSupport ? {TpmSupport:baseImage.TpmSupport} : {}),
      BlockDeviceMappings:[{DeviceName:baseImage.RootDeviceName,Ebs:{SnapshotId:snapshot.SnapshotId,VolumeSize:cfg.disk_gb,VolumeType:'gp3',DeleteOnTermination:true}}],
      TagSpecifications:[{ResourceType:'image',Tags:tags(labels)}]}));
    image = made.ImageId;
    const available = await wait('image',30*MINUTE,async () => {
      const i = (await ec2.send(new DescribeImagesCommand({ImageIds:[image]}))).Images?.[0];
      if (i && !owned(i,run)) throw new Error('image no longer owned');
      if (i?.State === 'failed') throw new Error('RegisterImage failed');
      return i?.State === 'available' ? i : null;
    });
    await ec2.send(new TerminateInstancesCommand({InstanceIds:[builder]}));
    const snapshotIds = available.BlockDeviceMappings.map((d) => d.Ebs?.SnapshotId).filter(Boolean);
    const snapshots = (await ec2.send(new DescribeSnapshotsCommand({SnapshotIds:snapshotIds}))).Snapshots ?? [];
    if (!snapshotIds.length || snapshots.length !== snapshotIds.length || snapshots.some((s) => !Number.isFinite(s.FullSnapshotSizeInBytes) || s.FullSnapshotSizeInBytes <= 0)) throw new Error('snapshot full written size unavailable');
    const snapshotGiB = snapshots.reduce((sum,s) => sum+s.FullSnapshotSizeInBytes,0)/2**30;
    const initializationUsd = snapshotGiB*0.0024;
    await ec2.send(new CreateTagsCommand({Resources:[image],Tags:tags({'ci-kit-snapshot-gib':snapshotGiB,'ci-kit-initialization-usd':initializationUsd})}));
    log(`${cfg.account}: ${image} snapshot full written size ${snapshotGiB} GiB; initialization 200 MiB/s costs $${initializationUsd} per volume, including failed boots`);
    const smoke = await launch('smoke',image,JSON.stringify(await guestData('smoke',{smoke:8})));
    await wait('smoke',20*MINUTE,() => terminal(smoke,'smoke'));
    log(`${cfg.account}: common smoke suite passed (${smoke})`);
    if ((await gh.getRepo(CHECK.repo)).private !== true) throw new Error('bake check repository must be private');
    runnerName = `ci-kit-bake-${run}`;
    const jit = await gh.jitConfig(CHECK.repo,checkJitRequest({runner:runnerName,check:`bake-${run}-check`}));
    runner = jit.runner.id;
    const dispatched = await gh.dispatchWorkflow(CHECK.repo,CHECK.workflow,{ref:CHECK.ref,inputs:{bake:run}});
    checkRun = dispatched?.workflow_run_id;
    if (!checkRun) throw new Error('sandbox dispatch returned no run');
    const check = await launch('smoke',image,JSON.stringify(await guestData('check',{jit:jit.encoded_jit_config})));
    await wait('real sandbox job',20*MINUTE,async () => {
      const r = await terminal(check,'check'), state = await gh.getRun(CHECK.repo,checkRun);
      const outcome = checkOutcome({vm:r ? {done:true,ok:true} : {done:false},run:state,jobs:state.status === 'completed' ? await gh.listJobs(CHECK.repo,checkRun) : [],runner:runnerName,elapsedMs:0,timeoutMs:Infinity});
      if (outcome.done && !outcome.ok) throw new Error(`real sandbox job failed: ${outcome.reason}`);
      return outcome.ok;
    });
    if (promote) await ec2.send(new CreateTagsCommand({Resources:[image],Tags:tags({'ci-kit-ready':'true'})}));
    checked = true;
    log(`${cfg.account}: ${image} ${promote ? 'ready' : 'candidate (unready)'}, real sandbox job ${dispatched.html_url}`);
    return {image,manifest:actual,snapshotGiB,initializationUsd,check:dispatched.html_url};
  } finally {
    if (checkRun) await cleanupStep('run',async () => { if ((await gh.getRun(CHECK.repo,checkRun)).status !== 'completed') await gh.cancelRun(CHECK.repo,checkRun); });
    await cleanupStep('instances',async () => {
      const all = (await list(ec2,DescribeInstancesCommand,{Filters:filters(pool)},'Reservations')).flatMap((r) => r.Instances ?? []).filter((i) => owned(i,run) && i.State.Name !== 'terminated');
      for (const i of all) await ec2.send(new TerminateInstancesCommand({InstanceIds:[i.InstanceId]}));
    });
    if (runnerName) await cleanupStep('runner',async () => {
      const id = runner ?? (await gh.runners(CHECK.repo)).find((r) => r.name === runnerName)?.id;
      if (!id) return;
      for (let n=0;;n++) { try { await gh.deleteRunner(CHECK.repo,id); return; } catch (e) { if (e.status===404) return; if (e.status!==422 || n>=12) throw e; await sleep(30_000); } }
    });
    await cleanupStep('images and snapshots',async () => {
      const all = await list(ec2,DescribeImagesCommand,{Owners:['self'],Filters:filters({'ci-kit-pool':'ec2'})},'Images');
      // Tag lookup also recovers a RegisterImage response lost in transit.
      const doomed = new Map([...(!checked ? all.filter((i) => owned(i,run)) : []),...(promote ? imagesToPrune(all,now()) : [])].map((i) => [i.ImageId,i]));
      for (const i of doomed.values()) { await removeImage(ec2,i); log(`${cfg.account}: removed ${i.ImageId} and its snapshots`); }
      // A failed/lost snapshot or registration response may leave a snapshot with no AMI mapping.
      if (!checked) {
        const removed = new Set([...doomed.values()].flatMap(i => (i.BlockDeviceMappings ?? []).map(d => d.Ebs?.SnapshotId)));
        const orphaned = await list(ec2,DescribeSnapshotsCommand,{OwnerIds:['self'],Filters:filters(pool)},'Snapshots');
        for (const s of orphaned.filter(s => owned(s,run) && !removed.has(s.SnapshotId))) await ec2.send(new DeleteSnapshotCommand({SnapshotId:s.SnapshotId}));
      }
    });
  }
}
