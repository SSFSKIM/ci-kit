import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { createProviders } from '../../gce/launcher/providers/index.mjs';
import { world } from '../gce/fake-world.mjs';
import { ONE_REGION_CFG } from '../gce/config-fixtures.mjs';
import { fixture, account, start, instance, prepared } from './fake-ec2.mjs';

const repo = 'SSFSKIM/ci-kit-sandbox';
const labels = (cpus, provider) => ['self-hosted', 'ci-kit-pool', `cpus-${cpus}`, `ci-kit-${provider}`];
function setup() {
  const w = world({ start }), f = fixture();
  const cfg = { ...ONE_REGION_CFG, max_vcpus: 16, repos: [{ repo, providers: [
    { provider: 'ec2', account: account.account, max_vcpus: 8 }, { provider: 'gce' },
  ] }] };
  const ec2 = { enabled: true, accounts: [{ ...account, roles: { launcher: `arn:aws:iam::${account.account}:role/ci-kit-ec2-launcher` } }] };
  const ledger = () => createGceLedger(w.github, cfg.ledger, { now: w.now });
  const rows = async () => { const l = ledger(); await l.read(); return l.rows(); };
  let random = 0;
  const providerState = new Map();
  const make = (l = ledger()) => {
    const providers = createProviders({ gce: w.gce, cfg, config: 'presend', ec2, now: w.now, awsFactory: () => f.aws });
    return new Launcher({ provider: providers[0], providers, ec2, cfg, config: 'presend', gh: w.github, ledger: l,
      poolRepos: [], now: w.now, after: w.after, providerState, random: () => ++random });
  };
  const queue = (cpus, provider) => w.sim.queue(repo, labels(cpus, provider));
  // Drive the actual launch path and fail at its durable-write boundary, rather than manufacturing a row.
  async function interrupt(stage) {
    const l = ledger(), write = l.upsert;
    l.upsert = async (row, opts) => {
      if (stage === 'initial' && row.state === 'launching' && !row.client_token) {
        await write(row, opts);
        throw new Error('process lost after initial row persisted');
      }
      if (stage === 'coordinates' && row.client_token) throw new Error('coordinate write failed before send');
      return write(row, opts);
    };
    const job = queue(8, 'ec2');
    await make(l).tick();
    const saved = (await rows()).find(r => r.provider === 'ec2');
    assert.equal(saved.state, 'launching');
    assert.equal(saved.zone, undefined);
    assert.equal(saved.client_token, undefined);
    assert.equal(saved.sent_at, undefined);
    assert.equal(f.calls.filter(([name]) => name === 'RunInstances').length, 0);
    // The original caller cancels its queued demand; subsequent tests control fresh admissions independently.
    job.status = 'completed';
    w.gh.runs.find(r => r.id === job.run_id).status = 'completed';
    f.calls.length = 0;
    return saved;
  }
  return { w, f, cfg, ledger, rows, make, queue, interrupt, providerState };
}
const foundFor = row => {
  const found = instance({ InstanceId: 'i-defensive-adoption' });
  found.Tags = found.Tags.map(t => t.Key === 'ci-kit-alloc' ? { ...t, Value: row.alloc } : t);
  return found;
};
const tagLookup = (input, alloc) => input.Filters?.some(f => f.Name === 'tag:ci-kit-alloc' && f.Values.includes(alloc));

for (const stage of ['initial', 'coordinates']) {
  test(`cold restart abandons an unsent allocation at ten minutes after ${stage} write interruption and frees global budget`, async () => {
    const s = setup(), saved = await s.interrupt(stage);
    const runners = await s.w.github.runners(repo);
    assert.equal(runners.length, stage === 'coordinates' ? 1 : 0);
    s.queue(16, 'gce');
    s.w.advance(9 * 60_000); s.f.advance(9 * 60_000);
    assert.equal((await s.make().tick()).launched.length, 0, 'fresh initial rows remain protected');
    assert.equal((await s.rows()).find(r => r.alloc === saved.alloc).state, 'launching');
    s.w.advance(60_000); s.f.advance(60_000); s.f.calls.length = 0;
    const out = await s.make().tick();
    const final = (await s.rows()).find(r => r.alloc === saved.alloc);
    assert.deepEqual([final.state, final.end], ['final', 'abandoned']);
    assert.equal(s.w.now(), start + 10 * 60_000, 'the grace is measured from the persisted initial row time');
    assert.equal(out.launched.length, 1, 'the released eight-vCPU debit no longer blocks sixteen GCE vCPUs');
    assert.ok(!(await s.w.github.runners(repo)).some(r => r.name === saved.instance));
    const queries = s.f.calls.filter(([name, input]) => name === 'DescribeInstances' && tagLookup(input, saved.alloc));
    assert.equal(queries.length, 1);
    assert.ok(!queries[0][1].Filters.some(f => ['availability-zone', 'client-token'].includes(f.Name)), 'no coordinates are invented');
    assert.equal(s.f.calls.filter(([name]) => name === 'RunInstances').length, 0, 'the original EC2 request is never replayed');
  });
}

test('an old initial allocation cannot hold reservations forever after a cold ledger restart', async () => {
  const s = setup(), saved = await s.interrupt('initial');
  s.w.advance(48 * 3600_000); s.f.advance(48 * 3600_000);
  s.queue(16, 'gce');
  const out = await s.make().tick();
  assert.equal((await s.rows()).find(r => r.alloc === saved.alloc).end, 'abandoned');
  assert.equal(out.launched.length, 1);
});

test('tag lookup adopts a defensively found VM without attempt coordinates, rather than abandoning it', async () => {
  const s = setup(), saved = await s.interrupt('coordinates'), found = foundFor(saved);
  s.f.handlers.DescribeInstances = input => ({ Reservations: [{ Instances:
    tagLookup(input, saved.alloc) || input.InstanceIds?.includes(found.InstanceId) ? [found] : [],
  }] });
  const out = await s.make().tick();
  const row = (await s.rows()).find(r => r.alloc === saved.alloc);
  assert.equal(row.state, 'running');
  assert.equal(row.instance_id, found.InstanceId);
  assert.equal(row.zone, 'us-east-2c');
  assert.equal(row.created, new Date(start).toISOString());
  assert.equal(out.finalized.length, 0);
  assert.ok((await s.w.github.runners(repo)).some(r => r.name === saved.instance));
  assert.equal(s.f.calls.filter(([name]) => name === 'RunInstances').length, 0);
});

for (const failure of ['inventory', 'tag-query', 'tag-later-page']) {
  test(`${failure} failure holds the unsent row, reservations and JIT instead of proving absence`, async () => {
    const s = setup(), saved = await s.interrupt('coordinates');
    s.w.advance(10 * 60_000); s.f.advance(10 * 60_000);
    s.f.handlers.DescribeInstances = input => {
      if (failure === 'inventory') throw new Error('inventory unavailable');
      if (tagLookup(input, saved.alloc)) {
        if (failure === 'tag-query' || input.NextToken) throw new Error('tag observation unavailable');
        return { Reservations: [], NextToken: 'page2' };
      }
      return { Reservations: [] };
    };
    s.queue(16, 'gce');
    const out = await s.make().tick();
    assert.equal((await s.rows()).find(r => r.alloc === saved.alloc).state, 'launching');
    assert.equal(out.launched.length, 0);
    assert.equal(out.finalized.length, 0);
    assert.ok((await s.w.github.runners(repo)).some(r => r.name === saved.instance));
    assert.equal(s.f.calls.filter(([name]) => ['RunInstances', 'TerminateInstances'].includes(name)).length, 0);
    if (failure === 'inventory') assert.equal(s.f.calls.filter(([name, input]) => name === 'DescribeInstances' && tagLookup(input, saved.alloc)).length, 0);
  });
}

for (const provider of ['gce', 'ec2']) {
  test(`failed presend finalization retains both budgets and registration; durable retry releases the ${provider} admission`, async () => {
    const s = setup(), saved = await s.interrupt('coordinates');
    s.w.advance(10 * 60_000); s.f.advance(10 * 60_000);
    const l = s.ledger(), write = l.upsert;
    l.upsert = async (row, opts) => {
      if (row.alloc === saved.alloc && row.state === 'final') throw new Error('final ledger write failed');
      return write(row, opts);
    };
    const remove = s.w.github.deleteRunner;
    s.w.github.deleteRunner = async (targetRepo, id) => {
      const runner = (await s.w.github.runners(targetRepo)).find(r => r.id === id);
      if (runner?.name === saved.instance) assert.equal((await s.rows()).find(r => r.alloc === saved.alloc).state, 'final', 'unregister follows durable finalization');
      return remove(targetRepo, id);
    };
    s.queue(provider === 'gce' ? 16 : 8, provider);
    const first = await s.make(l).tick();
    assert.equal((await s.rows()).find(r => r.alloc === saved.alloc).state, 'launching');
    assert.equal(first.launched.length, 0, provider === 'gce' ? 'global reservation is held' : 'repo/account cap reservation is held');
    assert.ok((await s.w.github.runners(repo)).some(r => r.name === saved.instance));
    const second = await s.make().tick();
    assert.equal((await s.rows()).find(r => r.alloc === saved.alloc).end, 'abandoned');
    assert.equal(second.launched.length, 1);
    assert.ok(!(await s.w.github.runners(repo)).some(r => r.name === saved.instance));
  });
}

test('a fresh overlapping launcher cannot abandon the initial row while its writer is still minting JIT', async () => {
  const s = setup(), l = s.ledger(), write = l.upsert;
  let reached, release, saved;
  const atInitial = new Promise(resolve => { reached = resolve; });
  const continueWriter = new Promise(resolve => { release = resolve; });
  l.upsert = async (row, opts) => {
    await write(row, opts);
    if (!saved && row.state === 'launching' && !row.client_token) {
      saved = row; reached(); await continueWriter;
    }
  };
  const sentRows = [];
  s.f.handlers.RunInstances = async () => {
    sentRows.push((await s.rows()).find(r => r.alloc === saved.alloc));
    return { Instances: [{ InstanceId: 'i-active-writer' }] };
  };
  const job = s.queue(8, 'ec2');
  const writer = s.make(l).tick();
  await atInitial;
  job.status = 'in_progress'; // keep the second tick on recovery, not a competing admission
  s.w.gh.runs.find(r => r.id === job.run_id).status = 'in_progress';
  let during;
  try {
    await s.make().tick();
    during = (await s.rows()).find(r => r.alloc === saved.alloc);
  } finally { release(); await writer; }
  assert.equal(during.state, 'launching', 'fresh absence is not proof the first writer died');
  assert.equal(sentRows.length, 1);
  assert.equal(sentRows[0].state, 'launching', 'RunInstances must not follow a silently rejected coordinate write over a final row');
  assert.ok(sentRows[0].client_token);
  assert.equal((await s.rows()).find(r => r.alloc === saved.alloc).state, 'running');
});

test('a writer stalled in asynchronous report signing beyond eight minutes abandons without sending or cooling down its account', async () => {
  const s = setup();
  let reached, release;
  const signing = new Promise(resolve => { reached = resolve; });
  const continueSigning = new Promise(resolve => { release = resolve; });
  const sign = s.f.aws.presignPut;
  s.f.aws.presignPut = async input => { reached(); await continueSigning; return sign(input); };
  let original;
  const remove = s.w.github.deleteRunner;
  s.w.github.deleteRunner = async (targetRepo, id) => {
    const runner = (await s.w.github.runners(targetRepo)).find(r => r.id === id);
    if (runner?.name === original?.instance) assert.equal((await s.rows()).find(r => r.alloc === original.alloc).state, 'final');
    return remove(targetRepo, id);
  };
  const l = s.ledger(), write = l.upsert;
  l.upsert = async (row, opts) => {
    await write(row, opts);
    if (row.state === 'launching' && !row.client_token) { s.w.advance(30_000); s.f.advance(30_000); }
  };
  s.queue(8, 'ec2');
  const active = s.make(l).tick();
  await signing;
  original = (await s.rows())[0];
  assert.ok(original.client_token, 'this writer already persisted its attempt coordinates');
  assert.equal(Date.parse(original.at), start);
  assert.equal(Date.parse(original.sent_at), start + 30_000, 'attempt time differs from the allocation origin');
  s.w.advance(7 * 60_000 + 30_001); s.f.advance(7 * 60_000 + 30_001);
  release();
  assert.equal((await active).launched.length, 0);
  assert.equal(s.f.calls.filter(([name]) => name === 'RunInstances').length, 0);
  assert.equal((await s.rows()).find(r => r.alloc === original.alloc).end, 'abandoned');
  assert.ok(!(await s.w.github.runners(repo)).some(r => r.name === original.instance));
  assert.ok(![...s.providerState.values()].some(state => state.deniedUntil));
  assert.equal((await s.make().tick()).launched.length, 1, 'the waiting demand gets a fresh allocation on the same account');
  assert.equal(s.f.calls.filter(([name]) => name === 'RunInstances').length, 1);
});

test('a stalled coordinate writer cannot send after another launcher has abandoned and unregistered its initial allocation', async () => {
  const s = setup(), l = s.ledger(), write = l.upsert;
  let reached, release, saved;
  const atCoordinates = new Promise(resolve => { reached = resolve; });
  const continueWriter = new Promise(resolve => { release = resolve; });
  l.upsert = async (row, opts) => {
    if (!saved && row.client_token) { saved = row; reached(); await continueWriter; }
    return write(row, opts);
  };
  const job = s.queue(8, 'ec2'), writer = s.make(l).tick();
  await atCoordinates;
  job.status = 'in_progress'; s.w.gh.runs.find(r => r.id === job.run_id).status = 'in_progress';
  s.w.advance(10 * 60_000); s.f.advance(10 * 60_000);
  try {
    await s.make().tick();
    assert.equal((await s.rows()).find(r => r.alloc === saved.alloc).end, 'abandoned');
    assert.ok(!(await s.w.github.runners(repo)).some(r => r.name === saved.instance));
  } finally { release(); await writer; }
  assert.equal(s.f.calls.filter(([name]) => name === 'RunInstances').length, 0);
  assert.equal((await s.rows()).find(r => r.alloc === saved.alloc).end, 'abandoned');
  assert.ok(![...s.providerState.values()].some(state => state.deniedUntil));
});

test('a launch without its allocation origin cannot substitute sent_at for the send-age limit', async () => {
  const f = fixture(), candidate = await prepared(f);
  const { at, ...withoutOrigin } = f.row;
  assert.equal((await f.provider.launch(withoutOrigin, candidate, 'test-jit')).outcome, 'abandoned');
  assert.equal(f.calls.filter(([name]) => name === 'RunInstances').length, 0);
});
