// M2's boundary: richer data must not change the GCE walk or its refusal semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ledger from '../../gce/launcher/ledger.mjs';
import { placements, viewInstance, jobInstance, quotaScope, quotaBlocks, stockoutMemory, STOCKOUT_TTL_MS } from '../../gce/launcher/logic.mjs';
import { createRoom } from '../../gce/launcher/room.mjs';
import { NEW_CFG, CENTRAL } from './config-fixtures.mjs';

const T0 = Date.parse('2026-10-23T12:00:00Z');
const base = { alloc: 'tb0abc0001', repo: 'SSFSKIM/ci-kit-sandbox', cpus: 2, at: T0, config: 'abcdef012345', reserved: 4 };
const legacy = { ...base, at: new Date(T0).toISOString(), instance: 'ci-kit-gce-tb0abc0001', state: 'running',
  machine: 'c3d-highcpu-4', zone: 'us-central1-a', provisioning: 'spot', created: new Date(T0).toISOString(), job: { id: 42, name: 'unit' } };
const marked = (row) => `<!-- ci-kit-gce-ledger ${JSON.stringify(row)} -->`;

test('unversioned and explicit v1 rows read as GCE and legacy jobs stay generic, without changing the stored comment', () => {
  for (const row of [legacy, { ...legacy, v: 1 }]) {
    const body = marked(row);
    const read = ledger.parseRow(body);
    assert.equal(read.v, 1);
    assert.equal(read.provider, 'gce');
    assert.equal(read.account, null, 'old rows cannot supply a project that was never stored');
    assert.deepEqual(read.job, { id: 42, name: 'unit', labels: [], required_provider: 'any' });
    assert.equal(read.reserved, 4);
    assert.equal(ledger.parseRow(ledger.renderRow(read)).v, 2, 'an explicit new write uses v2');
  }
});

test('new GCE rows preserve placement provenance and physical reservation through finalization', () => {
  const launching = ledger.launchRow({ ...base, account: NEW_CFG.project, image: 'image-1', image_commit: 'image-sha' });
  assert.equal(launching.v, 2);
  assert.equal(launching.provider, 'gce');
  assert.equal(launching.account, NEW_CFG.project);
  const running = ledger.runningRow(launching, {
    id: '1234567890123456789', zone: 'us-central1-a', region: 'us-central1', machine: 'c3d-highcpu-4',
    provisioning: 'spot', diskType: 'pd-balanced', created: T0, price: { source: 'gce-catalog', at: '2026-10-21T00:00:00Z' },
  });
  const done = ledger.finalRow(running, { end: 'done', deleted: T0 + 180_000, diskGb: 50 });
  assert.equal(done.instance_id, '1234567890123456789');
  assert.equal(done.region, 'us-central1');
  assert.equal(done.image, 'image-1');
  assert.equal(done.image_commit, 'image-sha');
  assert.equal(done.price.source, 'gce-catalog');
  assert.equal(done.credit_policy, 'off');
  const offset = ledger.runningRow(launching, { ...running, createdAt: '2026-10-23T05:00:00-07:00' });
  assert.equal(offset.created, '2026-10-23T12:00:00.000Z', 'ledger times stay UTC even with an offset in a provider timestamp');
  assert.deepEqual([done.cpus, done.reserved], [2, 4]);
  assert.deepEqual(ledger.parseRow(ledger.renderRow(done)), done);
  assert.equal(done.dollars, Math.round(ledger.dollars({ machine: done.machine, zone: done.zone, provisioning: 'spot', seconds: 180, diskGb: 50 }) * 1e4) / 1e4);
});

test('EC2 attempt persistence retains only reconciliation coordinates, not a secret-bearing request', () => {
  const launching = ledger.launchRow({ ...base, provider: 'ec2', account: '290475840169', reserved: 2, credit_policy: 'on' });
  assert.equal(launching.instance, 'ci-kit-ec2-tb0abc0001');
  const row = ledger.attemptRow(launching, {
    zone: 'us-east-2c', client_token: 'tb0abc0001-1', sent_at: new Date(T0).toISOString(),
    request: { UserData: 'SECRET-JIT' }, jit: 'SECRET-JIT', report: 'SECRET-PRESIGNED-URL',
  });
  const stored = ledger.parseRow(ledger.renderRow(row));
  assert.deepEqual(stored, { ...launching, zone: 'us-east-2c', client_token: 'tb0abc0001-1', sent_at: new Date(T0).toISOString() });
  assert.doesNotMatch(ledger.renderRow(row), /SECRET|UserData|request|report/);
  const running = ledger.runningRow(stored, {
    provider: 'ec2', id: 'i-1234', alloc: base.alloc, runner: launching.instance, size: 2,
    labels: ['self-hosted', 'ci-kit-pool', 'cpus-2', 'ci-kit-ec2'], state: 'running', createdAt: new Date(T0).toISOString(),
    candidate: { provider: 'ec2', account: '290475840169', region: 'us-east-2', zone: 'us-east-2c', zoneId: 'use2-az3',
      size: 2, labels: ['self-hosted', 'ci-kit-pool', 'cpus-2', 'ci-kit-ec2'], machine: 'c8a.large', vcpus: 2, memoryGiB: 4, arch: 'x86_64',
      provisioning: 'spot', subnet: 'subnet-test', disk: { type: 'gp3', sizeGB: 50 },
      price: { source: 'spot-history', at: new Date(T0).toISOString(), initializationUsd: 0.027504 } },
  });
  assert.deepEqual([running.region, running.zone_id, running.instance_id, running.price.initializationUsd], ['us-east-2', 'use2-az3', 'i-1234', 0.027504]);
  assert.deepEqual(ledger.parseRow(ledger.renderRow(running)), running);
  const refused = ledger.finalRow(row, { end: 'refused', deleted: T0 + 1_000, diskGb: 50 });
  assert.deepEqual([refused.state, refused.end, refused.reserved], ['final', 'refused', 2]);
});

test('job records keep demand labels rather than the cloud that happened to serve them', () => {
  for (const [labels, required] of [
    [['ci-kit-pool', 'cpus-2'], 'any'], [['CI-KIT-GCE', 'cpus-2'], 'gce'], [['ci-kit-ec2', 'cpus-2'], 'ec2'],
  ]) {
    const recorded = ledger.jobRecord({ id: 42, labels });
    assert.deepEqual(recorded.labels, labels);
    assert.equal(recorded.required_provider, required);
    const row = ledger.withJob(ledger.launchRow({ ...base, provider: 'ec2', account: '290475840169' }), { id: 42, labels });
    assert.deepEqual(ledger.parseRow(ledger.renderRow(row)).job, recorded);
  }
});

test('attaching an observed job upgrades a legacy row before its new labels are serialized', () => {
  const row = ledger.parseRow(marked(legacy));
  const updated = ledger.withJob(row, { id: 43, labels: ['ci-kit-pool', 'cpus-2', 'ci-kit-gce'] });
  const stored = ledger.parseRow(ledger.renderRow(updated));
  assert.equal(stored.v, 2);
  assert.deepEqual(stored.job.labels, ['ci-kit-pool', 'cpus-2', 'ci-kit-gce']);
  assert.equal(stored.job.required_provider, 'gce');
});

test('GCE candidates and observed instances retain size-2 versus size-4 labels on the same four-vCPU machine', () => {
  for (const size of [2, 4]) {
    const candidate = placements(size, NEW_CFG).find((p) => p.placement === NEW_CFG.placements[1]);
    assert.deepEqual({ provider: candidate.provider, account: candidate.account, region: candidate.region,
      size: candidate.size, labels: candidate.labels, vcpus: candidate.vcpus, memoryGiB: candidate.memoryGiB,
      arch: candidate.arch, subnet: candidate.subnet, disk: candidate.disk }, {
      provider: 'gce', account: NEW_CFG.project, region: 'us-central1', size,
      labels: ['self-hosted', 'ci-kit-pool', `cpus-${size}`, 'ci-kit-gce'], vcpus: 4, memoryGiB: 8,
      arch: 'x86_64', subnet: CENTRAL.subnetwork, disk: { type: 'pd-balanced', sizeGB: 50 },
    });
    assert.equal(candidate.machine, 'c3d-highcpu-4');
    assert.equal(candidate.family, 'c3d');
    assert.deepEqual(candidate.price, { source: 'gce-catalog', at: '2026-10-16T00:00:00Z' });
    const resource = jobInstance({ alloc: base.alloc, ...candidate, repo: base.repo, cpus: size, image: 'image-1', jit: 'secret', cfg: NEW_CFG, config: base.config });
    const observed = viewInstance({ ...resource, id: '123', selfLink: `https://www.googleapis.com/compute/v1/projects/${NEW_CFG.project}/zones/${candidate.zone}/instances/${resource.name}`,
      zone: candidate.zone, status: 'RUNNING', creationTimestamp: new Date(T0).toISOString() });
    assert.deepEqual([observed.size, observed.labels, observed.vcpus], [size, candidate.labels, 4]);
    assert.equal(observed.provider, 'gce');
    assert.equal(observed.id, '123');
    assert.equal(observed.account, NEW_CFG.project);
    assert.equal(observed.state, 'running');
    assert.equal(observed.createdAt, new Date(T0).toISOString());
    assert.deepEqual(observed.candidate, Object.fromEntries(Object.entries(candidate).filter(([k]) => k !== 'placement')));
    const recovered = ledger.runningRow(ledger.parseRow(marked(legacy)), observed);
    assert.equal(recovered.account, NEW_CFG.project, 'an observed VM supplies provenance missing from a v1 row');
  }
});

test('stock-outs are isolated by provider, account and region and retain their expiry and provisioning scope', () => {
  const p = placements(4, NEW_CFG)[0];
  const memory = stockoutMemory();
  memory.add(p, T0);
  assert.equal(memory.has(p, T0 + 1), true);
  for (const other of [{ provider: 'ec2' }, { account: 'other-project' }, { region: 'other-region' }, { provisioning: 'standard' }]) {
    assert.equal(memory.has({ ...p, ...other }, T0 + 1), false, JSON.stringify(other));
  }
  assert.equal(memory.has(p, T0 + STOCKOUT_TTL_MS), false);
});

test('even a global quota refusal belongs to just one provider and account', () => {
  const p = placements(8, NEW_CFG)[0];
  const refusal = quotaScope(new Error("Quota 'CPUS_ALL_REGIONS' exceeded globally."), p);
  assert.equal(refusal.provider, 'gce');
  assert.equal(refusal.account, NEW_CFG.project);
  assert.equal(quotaBlocks([refusal], p), true);
  for (const other of [{ provider: 'ec2' }, { account: 'other-project' }]) assert.equal(quotaBlocks([refusal], { ...p, ...other }), false);
  assert.equal(quotaBlocks([refusal], placements(4, NEW_CFG)[0]), false, 'a smaller GCE request still fits');
});

test('room holds and refusals cannot consume or close a different provider/account namespace', () => {
  const p = placements(4, NEW_CFG)[0];
  const room = createRoom({ provider: 'gce', account: NEW_CFG.project, instances: [], egress: 'external', limits: { addresses: { 'us-west4': 1 } } });
  for (const other of [{ provider: 'ec2' }, { account: 'other-project' }]) {
    const foreign = { ...p, ...other };
    room.take(foreign);
    room.refused(foreign, 'IN_USE_ADDRESSES');
    assert.equal(room.fits(p), true);
  }
  room.take(p);
  assert.equal(room.fits(p), false);
  assert.equal(room.why(p), 'us-west4 addresses 1/1', 'existing GCE log remains unchanged');
});
