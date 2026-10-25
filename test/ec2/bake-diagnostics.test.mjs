import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEc2Bake } from '../../ec2/bake/bake.mjs';

// Run the real orchestration to a failing builder or smoke boundary. Only external AWS/GitHub effects
// are replaced; failure text is produced by the production bake.
async function failedBake(report, { raw = false, builder = false } = {}) {
  const account = '290475840169', runId = 'diagnostic-test', run = `${runId}-${account}`;
  const tagList = [{ Key: 'ci-kit-pool', Value: 'ec2' }, { Key: 'ci-kit-run', Value: run }];
  const manifest = { v: 1, kit_commit: 'a'.repeat(40), node: { 22: 'v22.23.4', 24: 'v24.22.1' },
    maws: { revision: 'b'.repeat(40), lock_sha256: 'c'.repeat(64) }, runner_version: '2.338.0',
    warm: { 'maws-files': { ok: true }, 'pnpm-fetch': { ok: true } } };
  const image = { ImageId: 'ami-built', State: 'available', CreationDate: '2026-10-24T00:00:00Z', Tags: tagList,
    BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { SnapshotId: 'snap-built' } }] };
  const seen = [];
  const ec2 = { send: async command => {
    const name = command.constructor.name;
    seen.push(name);
    if (name === 'RunInstancesCommand') return { Instances: [{ InstanceId: command.input.InstanceInitiatedShutdownBehavior === 'stop' ? 'i-builder' : 'i-smoke' }] };
    if (name === 'DescribeInstancesCommand') return { Reservations: [{ Instances: (command.input.InstanceIds ?? []).map(InstanceId => ({
      InstanceId, Tags: tagList, State: { Name: InstanceId === 'i-builder' ? 'stopped' : 'terminated' },
      BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeId: 'vol-source' } },
        ...(InstanceId === 'i-builder' ? [{ DeviceName: '/dev/sdf', Ebs: { VolumeId: 'vol-target' } }] : [])],
    })) }] };
    if (name === 'CreateSnapshotCommand') {
      assert.equal(command.input.VolumeId, 'vol-target', 'only the compacted disk is snapshotted');
      return { SnapshotId: 'snap-built' };
    }
    if (name === 'RegisterImageCommand') return { ImageId: image.ImageId };
    if (name === 'DescribeImagesCommand') return { Images: command.input.ImageIds?.includes('ami-canonical')
      ? [{ ImageId: 'ami-canonical', Architecture: 'x86_64', VirtualizationType: 'hvm', RootDeviceName: '/dev/sda1',
        BootMode: 'uefi-preferred', EnaSupport: true, ImdsSupport: 'v2.0' }] : [image] };
    if (name === 'DescribeSnapshotsCommand') return { Snapshots: [{ SnapshotId: 'snap-built', State: 'completed',
      Tags: tagList, FullSnapshotSizeInBytes: 2 ** 30 }] };
    if (['CreateTagsCommand', 'TerminateInstancesCommand', 'DeregisterImageCommand', 'DeleteSnapshotCommand'].includes(name)) return {};
    throw new Error(`unexpected API ${name}`);
  } };
  const aws = { ec2, ssm: { send: async () => ({ Parameter: { Value: 'ami-canonical' } }) },
    presignPut: async ({ key }) => `https://report.example/${key}?signature=not-for-logs`,
    s3: { send: async command => ({ Body: { transformToString: async () => command.input.Key.endsWith('/builder.json')
      ? JSON.stringify(builder ? report : { value: 'ok', manifest }) : raw ? report : JSON.stringify(report) } }) } };
  const cfg = { account, report_bucket: 'report-bucket', security_group: 'sg-pool', disk_gb: 50, initialization_mibps: 200,
    placements: [{ zone: 'us-east-2c', subnet: 'subnet-c' }] };
  let error;
  try { await runEc2Bake(aws, { runtimeAws: aws, cfg, manifest, runId, token: 'private-warm-token', gh: {},
    script: '#!/bin/bash\ntrue', sleep: async () => {}, now: () => Date.parse('2026-10-24T00:00:00Z') }); }
  catch (caught) { error = caught; }
  assert.ok(error, 'reported failure must reject the bake');
  if (builder) {
    assert.ok(!seen.includes('CreateSnapshotCommand'), 'failed self-check prevents snapshot creation');
    assert.ok(!seen.includes('RegisterImageCommand'), 'failed self-check prevents image registration');
  } else {
    assert.ok(seen.includes('RegisterImageCommand'), 'diagnostic tests reach the smoke boundary');
    assert.ok(seen.includes('DeregisterImageCommand'), 'failed image cleanup is preserved');
    assert.ok(seen.includes('DeleteSnapshotCommand'), 'failed snapshot cleanup is preserved');
  }
  return error.message;
}

test('bake failure exposes the controlled guest image reason without requiring another report lookup', async () => {
  const message = await failedBake({ kind: 'terminal', value: 'failed:image',
    diagnostic: { reason: 'cloud-init-state', path: '/var/lib/cloud/data' } });
  assert.match(message, /smoke failed: failed:image/);
  assert.match(message, /cloud-init-state/);
  assert.match(message, /\/var\/lib\/cloud\/data/);
});

test('builder self-check failure reaches the controller with the same safe reason, before image creation', async () => {
  const message = await failedBake({ value: 'failed:image', diagnostic: { reason: 'cloud-init-log', path: '/var/log' } }, { builder: true });
  assert.match(message, /builder failed: failed:image/);
  assert.match(message, /cloud-init-log/); assert.match(message, /\/var\/log/);
  const unsafe = await failedBake({ value: 'jit-private signature=private', diagnostic: { reason: 'not-a-safe-reason' } }, { builder: true });
  assert.ok(!unsafe.includes('jit-private') && !unsafe.includes('signature='), unsafe);
});

test('controller exposes compact phase and numeric exit status but rejects forged compact report fields', async () => {
  const secret = 'jit-private https://report.example/x?signature=private artifact-contents';
  const message = await failedBake({ value: 'failed:compact', diagnostic: {
    reason: 'compact-failed', phase: 'root-copy', exit_status: 124, path: secret, command: secret, stderr: secret, url: secret,
  }, extra: secret, compact: { elapsed_seconds: secret, exit_status: secret, phases: { [secret]: secret } } }, { builder: true });
  assert.equal(message, 'builder failed: failed:compact {"reason":"compact-failed","phase":"root-copy","exit_status":124}');
  for (const diagnostic of [
    { reason: 'compact-failed', phase: secret, exit_status: 1 },
    { reason: 'compact-failed', phase: ['root-copy'], exit_status: 1 },
    { reason: 'compact-failed', phase: 'root-copy', exit_status: secret },
    { reason: 'compact-failed', phase: 'root-copy', exit_status: '124' },
    { reason: 'compact-failed', phase: 'root-copy', exit_status: 256 },
    { reason: secret, phase: 'root-copy', exit_status: 1 },
  ]) {
    assert.equal(await failedBake({ value: 'failed:compact', diagnostic, stderr: secret }, { builder: true }),
      'builder failed: failed:compact {"reason":"unexpected"}');
  }
});

test('malformed report JSON fails without reflecting its body in the bake error', async () => {
  const message = await failedBake('jit-private https://report.example/x?signature=private', { raw: true });
  assert.match(message, /invalid smoke\/exit report JSON/);
  assert.ok(!message.includes('jit-private') && !message.includes('signature='), message);
});

test('bake does not reflect arbitrary report diagnostic, outcome, or smoke contents', async () => {
  const secret = 'jit-private https://report.example/x?signature=private artifact-contents';
  for (const report of [
    { kind: 'terminal', value: 'failed:image', diagnostic: { reason: secret, path: secret, code: secret } },
    { kind: 'terminal', value: secret, smoke: secret, diagnostic: { reason: 'filesystem', path: secret, code: secret } },
    { kind: 'terminal', value: 'exit:0', smoke: secret, diagnostic: { reason: 'manifest-invalid', extra: secret } },
  ]) {
    const message = await failedBake(report);
    assert.match(message, /smoke failed/);
    for (const marker of ['jit-private', 'signature=', 'artifact-contents', 'private-warm-token']) assert.ok(!message.includes(marker), message);
  }
});

test('builder copy refusal exposes only its sanitized tool tail, never the report manifest', async () => {
  const message = await failedBake({value:'failed:compact', diagnostic: {
    reason:'compact-failed', phase:'root-copy', exit_status:1,
    log_tail:'\x1b[31mPartclone: bitmap count mismatch\x1b[0m\nhttps://reports.invalid/?signature=private',
  }, manifest:{secret:'manifest-private'}, stdout:'unrelated-private'}, {builder:true});
  assert.equal(message, 'builder failed: failed:compact '+JSON.stringify({reason:'compact-failed',phase:'root-copy',exit_status:1,
    log_tail:'Partclone: bitmap count mismatch\n[redacted-url]'}));
});
