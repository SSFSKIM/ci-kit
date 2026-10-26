import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, account, start as fakeStart } from './fake-ec2.mjs';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createPreparation } from '../../gce/launcher/preparation.mjs';
import { createProviders } from '../../gce/launcher/providers/index.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { launchRow, finalRow } from '../../gce/launcher/ledger.mjs';
import { world } from '../gce/fake-world.mjs';
import { ONE_REGION_CFG } from '../gce/config-fixtures.mjs';

// Exact sanitized projections from the live 2026-10-24 FIS experiment. No launch specification or user-data.
const instanceEvidence = JSON.parse(readFileSync(new URL('./fixtures/fis-instance.json', import.meta.url)));
const spotEvidence = JSON.parse(readFileSync(new URL('./fixtures/fis-spot-request.json', import.meta.url)));
const raw = instanceEvidence.Reservations[0].Instances[0];
const alloc = 'm6fvma20ae', runner = `ci-kit-ec2-${alloc}`;
const at = Date.parse('2026-10-24T10:55:10Z'), transition = Date.parse('2026-10-24T10:54:36Z');
function evidence({ code = 'instance-terminated-by-experiment', state = 'terminated', reason = 'Client.UserInitiatedShutdown', timestamp = true } = {}) {
  const f = fixture(), instances = structuredClone(instanceEvidence), spots = structuredClone(spotEvidence);
  f.advance(at - fakeStart);
  const i = instances.Reservations[0].Instances[0];
  i.State = { Code: state === 'running' ? 16 : 48, Name: state }; i.StateReason.Code = reason;
  if (!timestamp) i.StateTransitionReason = 'User initiated';
  spots.SpotInstanceRequests[0].Status.Code = code;
  f.handlers.DescribeInstances = () => instances;
  f.handlers.DescribeSpotInstanceRequests = () => spots;
  return { f, instances, spots, provider: f.make(), i };
}

test('the exact live FIS responses establish preemption despite Client.UserInitiatedShutdown, not at notice time', async () => {
  const f = fixture(); f.advance(at - fakeStart);
  f.handlers.DescribeInstances = () => structuredClone(instanceEvidence);
  f.handlers.DescribeSpotInstanceRequests = () => structuredClone(spotEvidence);
  assert.deepEqual(await f.provider.preemptions(), new Map([[runner, transition]]));
  assert.deepEqual(f.calls.find(([name]) => name === 'DescribeSpotInstanceRequests')[1], { SpotInstanceRequestIds: ['sir-f2a7mf7g'] });
});

for (const code of ['instance-terminated-by-experiment', 'instance-terminated-by-price', 'instance-terminated-no-capacity']) {
  test(`${code} is authoritative only after the instance is gone`, async () => {
    const s = evidence({ code });
    assert.deepEqual(await s.provider.preemptions(), new Map([[runner, transition]]));
    s.i.State = { Code: 16, Name: 'running' };
    assert.deepEqual(await s.provider.preemptions(), new Map());
  });
}
for (const code of ['instance-terminated-by-user', 'spot-instance-terminated-by-user', 'capacity-oversubscribed',
  'instance-terminated-by-service', 'instance-terminated-by-schedule', 'instance-stopped-no-capacity', 'marked-for-termination', 'fulfilled', 'future-unknown-code']) {
  test(`${code} alone is not authoritative preemption evidence`, async () => {
    const s = evidence({ code });
    assert.deepEqual(await s.provider.preemptions(), new Map());
  });
}

test('Server.SpotInstanceTermination remains authoritative without depending on the Spot-request read', async () => {
  const s = evidence({ reason: 'Server.SpotInstanceTermination', code: 'instance-terminated-by-user' });
  s.f.handlers.DescribeSpotInstanceRequests = () => { throw new Error('must not need this read'); };
  assert.deepEqual(await s.provider.preemptions(), new Map([[runner, transition]]));
});

test('missing transition timestamps use observation time, never the Spot status UpdateTime', async () => {
  const s = evidence({ timestamp: false });
  assert.deepEqual(await s.provider.preemptions(), new Map([[runner, at]]));
  assert.notEqual(at, Date.parse(s.spots.SpotInstanceRequests[0].Status.UpdateTime));
});

test('a different request or instance cannot lend its interruption evidence to this allocation', async () => {
  for (const mismatch of ['InstanceId', 'SpotInstanceRequestId']) {
    const s = evidence();
    s.spots.SpotInstanceRequests[0][mismatch] = 'other-resource';
    assert.deepEqual(await s.provider.preemptions(), new Map());
  }
});

for (const fail of ['instances', 'spot', 'later-spot-page']) {
  test(`${fail} read failure is unknown, never an empty successful preemption history`, async () => {
    const s = evidence();
    if (fail === 'instances') s.f.handlers.DescribeInstances = () => { throw new Error('unavailable'); };
    else s.f.handlers.DescribeSpotInstanceRequests = input => {
      if (fail === 'spot' || input.NextToken) throw new Error('unavailable');
      return { ...s.spots, NextToken: 'more' };
    };
    assert.equal(await s.provider.preemptions(), null);
  });
}

test('Spot-request evidence is read across all pages', async () => {
  const s = evidence();
  s.f.handlers.DescribeSpotInstanceRequests = input => input.NextToken ? s.spots : { SpotInstanceRequests: [], NextToken: 'more' };
  assert.deepEqual(await s.provider.preemptions(), new Map([[runner, transition]]));
  assert.equal(s.f.calls.filter(([name]) => name === 'DescribeSpotInstanceRequests').length, 2);
});

async function lifecycle(code = 'instance-terminated-by-experiment') {
  const repo = 'SSFSKIM/ci-kit-sandbox', start = Date.parse(raw.LaunchTime), w = world({ start }), f = fixture();
  const cfg = { ...ONE_REGION_CFG, repos: [{ repo }], max_vcpus: 16 };
  const ec2 = { enabled: true, accounts: [{ ...account, roles: { launcher: `arn:aws:iam::${account.account}:role/ci-kit-ec2-launcher` } }] };
  const ledger = () => createGceLedger(w.github, cfg.ledger, { now: w.now });
  const rows = async () => { const l = ledger(); await l.read(); return l.rows(); };
  const make = () => {
    const providers = createProviders({ gce: w.gce, cfg, ec2, config: 'evidence', now: w.now, awsFactory: () => f.aws });
    return new Launcher({ provider: providers[0], providers, ec2, cfg, config: 'evidence', gh: w.github,
      ledger: ledger(), now: w.now, after: w.after });
  };
  let gone = false;
  const live = { ...structuredClone(raw), State: { Code: 16, Name: 'running' }, StateReason: undefined, StateTransitionReason: '',
    InstanceType: 'c8a.large', Placement: { AvailabilityZone: 'us-east-2c' }, SubnetId: account.placements[0].subnet, ImageId: 'ami-123' };
  f.handlers.DescribeInstances = () => gone ? structuredClone(instanceEvidence) : { Reservations: [{ Instances: [live] }] };
  f.handlers.DescribeSpotInstanceRequests = () => {
    const result = structuredClone(spotEvidence); result.SpotInstanceRequests[0].Status.Code = code; return result;
  };
  const l = ledger(); await l.read();
  await l.upsert(launchRow({ alloc, repo, cpus: 2, reserved: 2, provider: 'ec2', account: account.account, at: start, config: 'evidence' }));
  const labels = ['self-hosted', 'ci-kit-pool', 'cpus-2', 'ci-kit-ec2'];
  await w.github.jitConfig(repo, { name: runner, labels });
  await make().tick(); // observe the live allocation before the interruption
  const end = () => {
    gone = true; w.advance(at - start); f.advance(at - start);
    f.objects.set(`reports/${alloc}/exit.json`, { alloc, value: 'failed:unit', at: '2026-10-24T10:54:36Z' });
  };
  return { w, f, cfg, make, rows, ledger, end, repo, labels };
}

test('a gone FIS instance finalizes preempted ahead of a competing guest failure without rerunning its job', async () => {
  const s = await lifecycle();
  const job = s.w.sim.queue(s.repo, s.labels); s.w.sim.take(s.repo, runner, job);
  s.end();
  await s.make().tick();
  const row = (await s.rows())[0];
  assert.equal(row.end, 'preempted');
  assert.equal(row.deleted, '2026-10-24T10:54:36.000Z');
  assert.equal(row.job.id, job.id);
  assert.equal(s.w.gh.jobs.length, 1);
  assert.equal(s.f.calls.filter(([name]) => name === 'RunInstances').length, 0);
});

test('by-user disappearance with terminal evidence still ends done, not preempted', async () => {
  const s = await lifecycle('instance-terminated-by-user'); s.end();
  await s.make().tick();
  assert.equal((await s.rows())[0].end, 'done');
});

test('notice while the instance is live neither claims nor retires its idle runner', async () => {
  const s = await lifecycle();
  s.f.objects.set(`reports/${alloc}/notice.json`, { alloc, action: 'terminate', time: '2026-10-24T10:54:33Z' });
  const launcher = s.make(), seen = await launcher.observe(createPreparation({ now: s.w.now }));
  assert.equal(seen.claimed.has(runner), false);
  const out = await s.make().tick();
  assert.equal((await s.rows())[0].state, 'running');
  assert.equal(out.deleted.length, 0);
  assert.equal(out.finalized.length, 0);
});

test('failed Spot history holds the row even when a guest terminal report exists', async () => {
  const s = await lifecycle(); s.end();
  s.f.handlers.DescribeSpotInstanceRequests = () => { throw new Error('unavailable'); };
  const out = await s.make().tick();
  assert.equal((await s.rows())[0].state, 'running');
  assert.equal(out.finalized.length, 0);
});

test('new evidence does not rewrite an already-final historical done row', async () => {
  const s = await lifecycle(); s.end();
  const l = s.ledger(); await l.read();
  await l.upsert(finalRow((await s.rows())[0], { end: 'done', deleted: at, diskGb: 50 }));
  const before = await s.rows();
  await s.make().tick();
  assert.deepEqual(await s.rows(), before);
});
