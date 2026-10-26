import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { launchRow, finalRow } from '../../gce/launcher/ledger.mjs';
import { createProviders } from '../../gce/launcher/providers/index.mjs';
import { world } from '../gce/fake-world.mjs';
import { ONE_REGION_CFG } from '../gce/config-fixtures.mjs';
import { fixture, account, start, instance } from './fake-ec2.mjs';
const repo = 'SSFSKIM/ci-kit-sandbox';
const labels = ['self-hosted', 'ci-kit-pool', 'cpus-8', 'ci-kit-ec2'];
function setup() {
  const w = world({ start }), f = fixture();
  const cfg = { ...ONE_REGION_CFG, repos: [{ repo, providers: [{ provider: 'ec2', account: account.account }, { provider: 'gce' }] }], max_vcpus: 16 };
  const entry = { ...account, roles: { launcher: `arn:aws:iam::${account.account}:role/ci-kit-ec2-launcher` }, credit: { enabled: false } };
  let ec2 = { enabled: true, accounts: [entry] };
  const awsRoles = [];
  const awsFactory = (opts) => { awsRoles.push(opts.roleArn); return f.aws; };
  const ledger = () => createGceLedger(w.github, cfg.ledger, { now: w.now });
  const make = (l = ledger()) => {
    const providers = createProviders({ gce: w.gce, cfg, config: 'commit', ec2, now: w.now, awsFactory });
    return new Launcher({ provider: providers[0], providers, ec2, cfg, config: 'commit', gh: w.github, ledger: l, now: w.now, after: w.after });
  };
  const saved = async (ageMinutes = 0) => {
    const row = { ...launchRow({ alloc: 'alloc1', repo, cpus: 8, reserved: 8, provider: 'ec2', account: account.account, at: start, config: 'commit' }),
      zone: 'us-east-2c', client_token: 'alloc1-1', sent_at: new Date(start).toISOString(), image: 'ami-123' };
    const l = ledger(); await l.read(); await l.upsert(row);
    await w.github.jitConfig(repo, { name: row.instance, labels });
    w.advance(ageMinutes * 60_000); f.advance(ageMinutes * 60_000);
    return row;
  };
  return { w, f, cfg, ledger, make, saved, awsRoles, setEc2: (value) => { ec2 = value; }, entry };
}

test('cold launcher retains uncertain registration after five minutes, abandons absent request at ten, frees reservation', async () => {
  const s = setup(); await s.saved(6);
  await s.make().tick(); let l = s.ledger(); await l.read();
  assert.equal((await l.rows())[0].state, 'launching'); assert.equal((await s.w.github.runners(repo)).length, 1);
  s.w.advance(4 * 60_000); s.f.advance(4 * 60_000);
  await s.make().tick(); l = s.ledger(); await l.read();
  const row = (await l.rows())[0]; assert.equal(row.state, 'final'); assert.equal(row.end, 'abandoned');
  assert.equal((await s.w.github.runners(repo)).length, 0);
  assert.equal(s.f.calls.filter(([n]) => n === 'RunInstances').length, 0, 'restarts never replay');
  s.w.sim.queue(repo, ['self-hosted', 'ci-kit-pool', 'cpus-16']);
  assert.equal((await s.make().tick()).launched.length, 1, 'entire global budget is available after abandonment');
});

test('cold launcher recovers an accepted request with lost response and does not overwrite persisted launch price', async () => {
  const s = setup(); const row = await s.saved(6);
  const l = s.ledger(); await l.read(); await l.upsert({ ...row, price: { source: 'launch-price', initializationUsd: 0.027504 }, disk_gb: 50 });
  s.f.instances.push(instance()); await s.make().tick();
  const cold = s.ledger(); await cold.read(); const recovered = (await cold.rows())[0];
  assert.equal(recovered.state, 'running'); assert.equal(recovered.instance_id, 'i-123'); assert.equal(recovered.zone_id, 'use2-az3');
  assert.equal(recovered.price.source, 'launch-price'); assert.equal((await s.w.github.runners(repo)).length, 1);
  assert.equal(s.f.calls.filter(([n]) => n === 'RunInstances').length, 0);
});

test('accepted lost response that boots and terminates before restart still accrues its per-volume initialization', async () => {
  const s = setup(); const row = await s.saved(6);
  const l = s.ledger(); await l.read(); await l.upsert({ ...row, price: { source: 'ec2-spot', computeHourlyUsd: 0.12, diskGiBMonthlyUsd: 0.08, ipv4HourlyUsd: 0.005, initializationUsd: 0.027504 }, disk_gb: 50 });
  s.f.instances.push(instance({ State: { Name: 'terminated' } }));
  await s.make().tick(); const cold = s.ledger(); await cold.read(); const ended = (await cold.rows())[0];
  assert.equal(ended.state, 'final'); assert.ok(ended.dollars >= 0.027504); assert.equal(ended.instance_id, 'i-123');
  assert.notEqual(ended.end, 'abandoned', 'AWS accepted it and created a charged disk');
});

test('unknown account inventory prevents ten-minute abandonment and preserves both debits across a fresh ledger', async () => {
  const s = setup(); await s.saved(11);
  s.f.handlers.DescribeInstances = () => { throw new Error('outage'); };
  s.w.sim.queue(repo, ['self-hosted', 'ci-kit-pool', 'cpus-16']);
  assert.equal((await s.make().tick()).launched.length, 0);
  const l = s.ledger(); await l.read(); assert.equal((await l.rows())[0].state, 'launching');
  assert.equal((await s.w.github.runners(repo)).length, 1);
  assert.equal(s.f.calls.filter(([n]) => ['RunInstances', 'TerminateInstances'].includes(n)).length, 0);
});

test('runtime constructs disabled accounts for management, removes only absent accounts, and reads ARNs from config', async () => {
  const s = setup(); await s.saved(6); s.f.instances.push(instance());
  s.setEc2({ enabled: false, accounts: [s.entry] }); await s.make().tick();
  assert.deepEqual(s.awsRoles, [s.entry.roles.launcher]);
  assert.ok(s.f.calls.some(([n]) => n === 'DescribeInstances'));
  s.f.calls.length = 0; s.setEc2(null); await s.make().tick();
  assert.equal(s.f.calls.length, 0);
  const l = s.ledger(); await l.read(); assert.equal((await l.rows())[0].state, 'running');
});

test('real provider launch persists pricing and physical disk before AWS call without secret launch data', async () => {
  const s = setup(); s.w.sim.queue(repo, labels);
  const l = s.ledger();
  let sentRow, request;
  s.f.handlers.RunInstances = async (body) => {
    request = body;
    const cold = s.ledger(); await cold.read(); sentRow = (await cold.rows())[0];
    return { Instances: [{ InstanceId: 'i-new' }] };
  };
  assert.equal((await s.make(l).tick()).launched.length, 1);
  assert.equal(sentRow.zone, 'us-east-2c'); assert.equal(sentRow.client_token, request.ClientToken);
  assert.equal(sentRow.price?.initializationUsd, 0.027504); assert.equal(sentRow.disk_gb, 50);
  assert.ok(!JSON.stringify(sentRow).includes('signature=secret'));
  assert.equal(sentRow.jit, undefined); assert.equal(sentRow.request, undefined);
  assert.equal((await l.rows())[0].provider, 'ec2');
});

// The EC2 guest exits about two seconds before shutdown; both events can happen between minute ticks.
async function completedBetweenTicks({ terminal = 'exit:0', terminated = false, reason } = {}) {
  const s = setup(), original = await s.saved();
  s.f.instances.push(instance());
  await s.make().tick(); // establish the allocation before the guest claims and finishes its job between ticks
  const job = s.w.sim.queue(repo, labels);
  s.w.sim.take(repo, original.instance, job);
  s.w.advance(47_000); s.f.advance(47_000);
  job.status = 'completed';
  s.w.gh.runs.find(r => r.id === job.run_id).status = 'completed';
  s.w.gh.runners.set(repo, []);
  if (terminal) s.f.objects.set(`reports/${original.alloc}/exit.json`, {
    v: 1, alloc: original.alloc, value: terminal, at: new Date(start + 45_000).toISOString(),
  });
  if (terminated) Object.assign(s.f.instances[0], { State: { Name: 'terminated' },
    ...(reason ? { StateReason: { Code: reason }, StateTransitionReason: 'Server.SpotInstanceTermination (2026-10-23 12:00:47 GMT)' } : {}) });
  else s.f.instances.length = 0;
  s.f.calls.length = 0;
  const read = async () => { const l = s.ledger(); await l.read(); return (await l.rows()).find(r => r.alloc === original.alloc); };
  return { ...s, original, job, read };
}

for (const terminated of [false, true]) {
  test(`normal EC2 completion between polls finalizes done with its job when the VM is ${terminated ? 'terminated' : 'absent'}`, async () => {
    const s = await completedBetweenTicks({ terminated });
    const out = await s.make().tick();
    const row = await s.read();
    assert.equal(row.state, 'final');
    assert.equal(row.end, 'done');
    assert.equal(row.job.id, s.job.id);
    assert.ok(out.finalized.includes('alloc1 done'));
    assert.equal(s.f.calls.filter(([name, input]) => name === 'GetObject' && input.Key.endsWith('/exit.json')).length, 1);
    assert.equal(s.f.calls.filter(([name]) => name === 'TerminateInstances').length, 0, 'gone VMs need no new termination');
  });
}

for (const terminal of ['exit:1', 'failed:image']) {
  test(`${terminal} is an ended runner, not evidence of an orphan or a successful GitHub job`, async () => {
    const s = await completedBetweenTicks({ terminal });
    await s.make().tick();
    assert.equal((await s.read()).end, 'done', 'existing done vocabulary means the job/runner ended, not exit success');
    assert.equal(s.w.gh.jobs.length, 1, 'no rerun was submitted');
  });
}

test('independently established interruption takes priority over a competing terminal report', async () => {
  const s = await completedBetweenTicks({ terminated: true, reason: 'Server.SpotInstanceTermination' });
  await s.make().tick();
  const row = await s.read();
  assert.equal(row.end, 'preempted');
  assert.equal(row.job.id, s.job.id);
  assert.equal(row.price.source, 'interrupted-free');
  assert.equal(s.w.gh.jobs.length, 1);
});

for (const unavailable of ['missing', 'unreadable', 'telemetry-only']) {
  test(`${unavailable} terminal evidence cannot turn an absent VM into done`, async () => {
    const s = await completedBetweenTicks({ terminal: null });
    if (unavailable === 'unreadable') s.f.handlers.GetObject = () => { throw Object.assign(new Error('S3 unavailable'), { name: 'AccessDenied' }); };
    if (unavailable === 'telemetry-only') {
      s.f.objects.set('reports/alloc1/boot.json', { alloc: 'alloc1', value: 'started' });
      s.f.objects.set('reports/alloc1/notice.json', { alloc: 'alloc1', action: 'terminate' });
    }
    await s.make().tick();
    assert.equal((await s.read()).end, 'orphan');
    assert.ok(s.f.calls.some(([name, input]) => name === 'GetObject' && input.Key === 'reports/alloc1/exit.json'), 'read even when the provider has no live VM');
  });
}

test('an already-final EC2 row is neither reread from S3 nor reclassified by a late terminal report', async () => {
  const s = await completedBetweenTicks();
  const l = s.ledger(); await l.read();
  await l.upsert(finalRow(await s.read(), { end: 'orphan', deleted: s.w.now(), diskGb: 50 }));
  const before = await s.read();
  const out = await s.make().tick();
  assert.deepEqual(await s.read(), before);
  assert.equal(out.finalized.length, 0);
  assert.equal(s.f.calls.filter(([name]) => name === 'GetObject').length, 0);
});

test('unknown EC2 inventory holds the row and reservation without consuming a terminal report', async () => {
  const s = await completedBetweenTicks();
  s.f.handlers.DescribeInstances = () => { throw new Error('inventory unavailable'); };
  s.w.sim.queue(repo, ['self-hosted', 'ci-kit-pool', 'cpus-16']);
  const out = await s.make().tick();
  assert.equal((await s.read()).state, 'running');
  assert.equal(out.launched.length, 0);
  assert.equal(out.finalized.length, 0);
  assert.equal(s.f.calls.filter(([name]) => ['GetObject', 'TerminateInstances', 'RunInstances'].includes(name)).length, 0);
});

test('terminal evidence cannot release reservations before its final row is durable; a later tick retries', async () => {
  const s = await completedBetweenTicks();
  const l = s.ledger(), upsert = l.upsert;
  l.upsert = async row => { if (row.state === 'final') throw new Error('ledger unavailable'); return upsert(row); };
  s.w.sim.queue(repo, ['self-hosted', 'ci-kit-pool', 'cpus-16']);
  const first = await s.make(l).tick();
  assert.equal((await s.read()).state, 'running');
  assert.equal(first.launched.length, 0, 'the old eight-vCPU reservation still holds');
  const second = await s.make().tick();
  assert.equal((await s.read()).end, 'done');
  assert.equal(second.launched.length, 1, 'durable finalization releases budget for the sixteen-vCPU demand');
  assert.equal(s.f.calls.filter(([name, input]) => name === 'GetObject' && input.Key.endsWith('/exit.json')).length, 2);
});

test('unavailable preemption history holds an absent allocation even when its terminal report exists', async () => {
  const s = await completedBetweenTicks();
  const describe = s.f.handlers.DescribeInstances;
  s.f.handlers.DescribeInstances = input => {
    if (input.Filters?.some(f => f.Name === 'instance-state-name')) throw new Error('preemption history unavailable');
    return describe(input);
  };
  await s.make().tick();
  assert.equal((await s.read()).state, 'running');
});

test('explicit five-minute guest deadline is max-run even under the configured 120-minute limit', async () => {
  const s = await completedBetweenTicks({ terminal: 'failed:deadline', terminated: true });
  s.w.advance(255_000); s.f.advance(255_000);
  s.f.objects.get('reports/alloc1/exit.json').at = new Date(start + 5 * 60_000).toISOString();
  assert.equal(s.cfg.max_run_minutes, 120);
  assert.equal(s.w.now() - start, 5 * 60_000 + 2000);
  await s.make().tick();
  assert.equal((await s.read()).end, 'max-run');
});

test('an absent EC2 allocation can read terminal evidence despite an unavailable GitHub runner listing', async () => {
  const s = await completedBetweenTicks();
  s.w.hooks.runnersFail = () => true;
  await s.make().tick();
  assert.equal((await s.read()).end, 'done');
});

test('an accepted lost response reconciled only after termination consumes its terminal report too', async () => {
  const s = setup(); await s.saved(6);
  s.f.instances.push(instance({ State: { Name: 'terminated' } }));
  s.f.objects.set('reports/alloc1/exit.json', { alloc: 'alloc1', value: 'exit:0' });
  await s.make().tick();
  const l = s.ledger(); await l.read();
  const row = (await l.rows())[0];
  assert.equal(row.end, 'done');
  assert.ok(row.created);
  assert.equal(row.instance_id, 'i-123');
});
