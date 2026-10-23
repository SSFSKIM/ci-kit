import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalRow, runningRow, launchRow } from '../../gce/launcher/ledger.mjs';

import { start, account, fixture, prepared, instance } from './fake-ec2.mjs';

test('enumeration keeps physical capacity, zone identity and snapshot initialization cost per account', async () => {
  const f = fixture(); const c = await prepared(f);
  assert.equal(c.account, account.account); assert.equal(c.zoneId, 'use2-az3'); assert.equal(c.vcpus, 8); assert.equal(c.memoryGiB, 16);
  assert.deepEqual(c.labels, ['self-hosted', 'ci-kit-pool', 'cpus-8', 'ci-kit-ec2']);
  assert.equal(c.price.computeHourlyUsd, 0.12); assert.equal(c.price.initializationUsd, 11.46 * 0.0024);
  const other = f.make({ ...account, account: '111111111111' }); await other.observe(); await other.readyImage();
  assert.equal(other.candidates(account, 8)[0].account, '111111111111');
});

test('RunInstances sends only one spot VM with immutable coordinates, hardened metadata, tagged disk and JSON user-data', async () => {
  const f = fixture(); const c = await prepared(f); const before = structuredClone(f.row);
  assert.deepEqual(await f.provider.launch(f.row, c, 'jit-secret'), { outcome: 'accepted', id: 'i-123', detail: '' });
  const body = f.calls.find(([n]) => n === 'RunInstances')[1];
  assert.equal(body.ClientToken, 'alloc1-1'); assert.equal(body.MinCount, 1); assert.equal(body.MaxCount, 1);
  assert.equal(body.InstanceInitiatedShutdownBehavior, 'terminate'); assert.equal(body.IamInstanceProfile, undefined);
  assert.deepEqual(body.MetadataOptions, { HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpEndpoint: 'enabled', HttpProtocolIpv6: 'disabled' });
  assert.deepEqual(body.InstanceMarketOptions, { MarketType: 'spot', SpotOptions: { SpotInstanceType: 'one-time', InstanceInterruptionBehavior: 'terminate' } });
  assert.deepEqual(body.BlockDeviceMappings, [{ DeviceName: '/dev/sda1', Ebs: { VolumeType: 'gp3', VolumeSize: 50, Encrypted: true, DeleteOnTermination: true, VolumeInitializationRate: 200 } }]);
  assert.equal(body.NetworkInterfaces[0].SubnetId, 'subnet-123'); assert.equal(body.NetworkInterfaces[0].AssociatePublicIpAddress, true);
  for (const t of body.TagSpecifications) { const value = Object.fromEntries(t.Tags.map(({ Key, Value }) => [Key, Value])); assert.equal(value['ci-kit-pool'], 'ec2'); assert.equal(value['ci-kit-purpose'], 'job'); assert.equal(value['ci-kit-deadline'], '2026-10-23T14:15:00.000Z'); }
  const data = JSON.parse(Buffer.from(body.UserData, 'base64').toString());
  assert.equal(data.jit, 'jit-secret'); assert.equal(data.alloc, 'alloc1'); assert.equal(data.deadline, '2026-10-23T14:00:00.000Z'); assert.ok(data.report.exit.includes('/reports/alloc1/exit.json'));
  assert.deepEqual(f.row, before, 'no request, JIT or URL retained on row');
});

test('oversized user-data and mismatched attempt zone never send RunInstances', async () => {
  const f = fixture(); const c = await prepared(f);
  assert.equal((await f.provider.launch(f.row, c, 'x'.repeat(17000))).outcome, 'denied');
  assert.equal((await f.provider.launch({ ...f.row, zone: 'us-east-2a' }, c, 'jit')).outcome, 'denied');
  assert.equal(f.calls.filter(([n]) => n === 'RunInstances').length, 0);
});

test('AWS refusal table distinguishes capacity/quota/denied/throttled from transport uncertainty without retries', async () => {
  for (const [name, expected] of [['InsufficientInstanceCapacity', 'capacity'], ['SpotMaxPriceTooLow', 'capacity'], ['Unsupported', 'capacity'], ['MaxSpotInstanceCountExceeded', 'quota'], ['VcpuLimitExceeded', 'quota'], ['UnauthorizedOperation', 'denied'], ['AuthFailure', 'denied'], ['InvalidIdentityToken', 'denied'], ['RequestLimitExceeded', 'throttled'], ['TimeoutError', 'uncertain']]) {
    const f = fixture(); const c = await prepared(f); f.handlers.RunInstances = () => { throw Object.assign(new Error(name), { name }); };
    const r = await f.provider.launch(f.row, c, 'jit'); assert.equal(r.outcome, expected, name);
    assert.equal(f.calls.filter(([n]) => n === 'RunInstances').length, 1);
    if (expected === 'quota') assert.equal(r.scope, `ec2/${account.account}/us-east-2/spot-standard-family`);
  }
});

test('cold recovery queries tag and client token in recorded zone, never replays, and waits ten minutes before abandonment', async () => {
  const f = fixture(); f.advance(9 * 60_000);
  assert.equal((await f.make().reconcileLaunch(f.row)).outcome, 'uncertain');
  f.advance(60_000); assert.equal((await f.make().reconcileLaunch(f.row)).outcome, 'abandoned');
  const reads = f.calls.filter(([n]) => n === 'DescribeInstances');
  assert.ok(reads.some(([, q]) => q.Filters.some((x) => x.Name === 'client-token' && x.Values[0] === 'alloc1-1')));
  assert.ok(reads.some(([, q]) => q.Filters.some((x) => x.Name === 'tag:ci-kit-alloc' && x.Values[0] === 'alloc1')));
  assert.ok(reads.every(([, q]) => q.Filters.some((x) => x.Name === 'availability-zone' && x.Values[0] === 'us-east-2c')));
  assert.equal(f.calls.filter(([n]) => n === 'RunInstances').length, 0);
  f.instances.push(instance()); assert.equal((await f.make().reconcileLaunch(f.row)).outcome, 'accepted');
  f.handlers.DescribeInstances = () => { throw new Error('network down'); };
  assert.equal((await f.make().reconcileLaunch(f.row)).outcome, 'uncertain', 'failed observation cannot establish absence');
});

test('inventory handles pagination and observes pool jobs only; stopped jobs remain managed, gone jobs do not', async () => {
  const f = fixture();
  f.handlers.DescribeInstances = ({ NextToken }) => NextToken ? { Reservations: [{ Instances: [instance({ InstanceId: 'i-stopped', State: { Name: 'stopped' } }), instance({ InstanceId: 'i-gone', State: { Name: 'terminated' } })] }] } : { Reservations: [{ Instances: [instance(), instance({ InstanceId: 'foreign', Tags: [] })] }], NextToken: 'next' };
  const seen = await f.provider.observe(); assert.equal(seen.complete, true);
  assert.deepEqual(seen.instances.map((i) => i.id), ['i-123', 'i-stopped']);
  assert.equal(seen.instances[0].repo, 'SSFSKIM/ci-kit-sandbox'); assert.equal(seen.instances[0].runner, 'ci-kit-ec2-alloc1');
  assert.equal(seen.instances[0].candidate.zoneId, 'use2-az3');
  assert.ok(f.calls.filter(([n]) => n === 'DescribeInstances').every(([, q]) => q.Filters.some((x) => x.Name === 'tag:ci-kit-pool' && x.Values[0] === 'ec2')));
  f.handlers.DescribeInstances = () => { throw new Error('inventory outage'); };
  await assert.rejects(f.provider.observe(), /inventory outage/);
});

test('boot and notice are telemetry, only valid terminal exit is retirement evidence', async () => {
  const f = fixture(); f.objects.set('reports/alloc1/boot.json', { v: 1, alloc: 'alloc1', outcome: 'boot' });
  f.objects.set('reports/alloc1/notice.json', { v: 1, alloc: 'alloc1', outcome: 'notice' });
  let bundle = (await f.provider.readReports([f.row])).get('alloc1');
  assert.equal(bundle.telemetry.length, 2); assert.equal(bundle.terminal, undefined);
  f.objects.set('reports/alloc1/exit.json', { kind: 'terminal', event: 'exit', alloc: 'alloc1', value: 'exit:1', at: '2026-10-23T12:10:00Z' });
  bundle = (await f.provider.readReports([f.row])).get('alloc1'); assert.equal(bundle.terminal.kind, 'terminal'); assert.equal(bundle.terminal.value, 'exit:1');
  f.objects.set('reports/alloc1/exit.json', { outcome: 'notice' });
  assert.equal((await f.provider.readReports([f.row])).get('alloc1').terminal, undefined);
});

test('a missing report is pending while denied access is logged as unavailable; neither supplies terminal evidence', async () => {
  const f = fixture();
  assert.equal((await f.provider.readReports([f.row])).get('alloc1').terminal, undefined);
  assert.equal(f.logs.length, 0);
  f.handlers.GetObject = () => { throw Object.assign(new Error('signed URL must not leak'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }); };
  assert.equal((await f.provider.readReports([f.row])).get('alloc1').terminal, undefined);
  assert.equal(f.logs.length, 3); assert.ok(f.logs.every((line) => line.includes('AccessDenied') && !line.includes('signed URL')));
});

test('initialization charges accrue for failed and idle boots, not refused allocations; interruption waives only compute', async () => {
  const f = fixture(); const c = await prepared(f);
  const row = runningRow(launchRow({ ...f.row, provider: 'ec2', account: account.account, at: start, config: 'abc', reserved: 8 }), { id: 'i-123', candidate: c, createdAt: new Date(start).toISOString() });
  for (const end of ['done', 'idle', 'failed']) {
    const final = finalRow(row, { end, deleted: start + 10_000, diskGb: 50 });
    assert.equal(final.dollars, 0.0296, end); // 0.027504 init + 0.002 compute + 60s disk minimum + 10s IPv4
  }
  const interrupted = finalRow(row, { end: 'preempted', deleted: start + 10_000, diskGb: 50 });
  assert.equal(interrupted.dollars, 0.0276); assert.equal(interrupted.price.source, 'interrupted-free');
  const later = finalRow(row, { end: 'preempted', deleted: start + 5400_000, diskGb: 50 });
  assert.equal(later.dollars, 0.2233, 'Linux interruption after first hour bills all seconds used');
  assert.equal(later.price.source, 'ec2-spot');
  const refused = finalRow({ ...launchRow({ ...f.row, provider: 'ec2', account: account.account, at: start, config: 'abc' }), price: c.price, disk_gb: 50 }, { end: 'refused', deleted: start + 10_000, diskGb: 50 });
  assert.equal(refused.dollars, null);
});
