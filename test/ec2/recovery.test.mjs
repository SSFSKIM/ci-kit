import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { launchRow } from '../../gce/launcher/ledger.mjs';
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
    return new Launcher({ provider: providers[0], providers, ec2, cfg, config: 'commit', gh: w.github, ledger: l, poolRepos: [], now: w.now, after: w.after });
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
