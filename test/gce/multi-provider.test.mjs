import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocationId } from '../../gce/launcher/logic.mjs';
import { createConfigSource } from '../../gce/launcher/source.mjs';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createProvider } from '../../gce/launcher/providers/gce.mjs';
import { providerRunnerLabels } from '../../gce/launcher/providers/contracts.mjs';
import { launchRow } from '../../gce/launcher/ledger.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { world } from './fake-world.mjs';
import { ONE_REGION_CFG } from './config-fixtures.mjs';

const repo = 'SSFSKIM/ci-kit-sandbox';
const start = Date.parse('2026-10-23T12:00:00Z');
const labels = (n = 8, p = 'any') => ['self-hosted', 'ci-kit-pool', `cpus-${n}`, ...(p === 'any' ? [] : [`ci-kit-${p}`])];
const ref = (provider, account, max_vcpus) => ({ provider, account, ...(max_vcpus ? { max_vcpus } : {}) });

function fakeEc2(w, account = 'a') {
  const instances = [], calls = [], reports = new Map();
  let outcome = 'accepted', complete = true;
  return {
    name: 'ec2', account, instances, calls, reports,
    set outcome(value) { outcome = value; }, set complete(value) { complete = value; },
    candidates(_cfg, size) { return ['us-east-2a', 'us-east-2b'].map((zone) => ({ provider: 'ec2', account, region: 'us-east-2', zone, size, labels: providerRunnerLabels('ec2', size), machine: `fake-${size}`, vcpus: size, memoryGiB: size * 2, arch: 'x86_64', provisioning: 'spot', subnet: 'subnet', disk: { type: 'gp3', sizeGB: 50 }, price: { source: 'fake', at: new Date(w.now()).toISOString() } })); },
    async observe() { calls.push(['observe']); if (complete === 'throw') throw new Error('unreachable'); return { instances: [...instances], complete }; },
    async readyImage() { return { id: 'ami-fake', manifest: {} }; },
    async launch(row, candidate, jit) {
      calls.push(['launch', row, candidate, jit]);
      const result = typeof outcome === 'function' ? await outcome(row, candidate) : { outcome, detail: 'fake' };
      if (result.outcome === 'accepted') instances.push({ provider: 'ec2', id: `i-${row.alloc}`, alloc: row.alloc, runner: row.instance, size: row.cpus, labels: candidate.labels, state: 'running', candidate, createdAt: new Date(w.now()).toISOString() });
      return result;
    },
    async reconcileLaunch(row) { calls.push(['reconcile', row]); return { outcome: 'uncertain', detail: '' }; },
    async terminate(instance) { calls.push(['terminate', instance]); instances.splice(instances.findIndex((x) => x.alloc === instance.alloc), 1); },
    async readReports(rows) { calls.push(['reports', rows]); return reports; },
    async cleanupOrphans() { calls.push(['cleanup']); return []; },
  };
}
function setup({ refs, max = 64 } = {}) {
  const w = world({ start });
  const cfg = { ...ONE_REGION_CFG, repos: [{ repo }], max_vcpus: max };
  const ec2 = { enabled: true, accounts: [{ account: 'a' }, { account: 'b' }] };
  const a = fakeEc2(w), b = fakeEc2(w, 'b');
  const ledger = createGceLedger(w.github, cfg.ledger, { now: w.now });
  const gce = createProvider({ gce: w.gce, cfg, config: 'test', now: w.now });
  let seq = 0;
  const state = new Map(), logs = [];
  const make = (extra = {}) => new Launcher({ providers: [gce, a, b], provider: gce, ec2, repoProviders: { [repo]: refs ?? [ref('ec2', 'a'), ref('gce', cfg.project)] }, gh: w.github, ledger, cfg, config: 'test', poolRepos: [], now: w.now, random: () => ++seq, providerState: state, log: (s) => logs.push(s), ...extra });
  const rows = async () => ledger.rows();
  const queue = (size = 8, p = 'any') => w.sim.queue(repo, labels(size, p));
  return { w, cfg, a, b, gce, ec2, ledger, rows, queue, make, logs };
}

test('repo list controls order, fresh fallback registrations, and instance-scoped refusal memory', async () => {
  const s = setup({ refs: [ref('ec2', 'a'), ref('ec2', 'b'), ref('gce', ONE_REGION_CFG.project)] });
  s.a.outcome = 'quota'; s.queue();
  const out = await s.make().tick();
  const rows = await s.rows();
  assert.deepEqual(rows.map((r) => [r.provider, r.account, r.state, r.end]), [['ec2', 'a', 'final', 'refused'], ['ec2', 'b', 'running', undefined]]);
  assert.equal(s.a.calls.filter(([k]) => k === 'launch').length, 1, 'account quota skips all other candidates');
  assert.equal(out.launched.length, 1);
  const runners = await s.w.github.runners(repo);
  assert.deepEqual(runners.map((r) => r.name), [rows[1].instance]);
  assert.ok(runners[0].labels.some((l) => l.name === 'ci-kit-ec2'));
});

test('two queued admissions reserve cap synchronously before a delayed first ledger write', async () => {
  const s = setup({ refs: [ref('ec2', 'a', 8), ref('ec2', 'b')] });
  let release;
  const first = new Promise((r) => { release = r; });
  const original = s.ledger.upsert;
  s.ledger.upsert = async (row, opts) => {
    if (row.state === 'launching' && row.account === 'a') await first;
    if (row.state === 'launching' && row.account === 'b') release();
    return original(row, opts);
  };
  s.queue(); s.queue();
  const out = await s.make().tick();
  assert.equal(out.launched.length, 2);
  assert.deepEqual((await s.rows()).map((r) => r.account).sort(), ['a', 'b']);
});

test('fallback admission releases old reservation and checks larger physical GCE candidate', async () => {
  for (const free of [2, 4]) {
    const s = setup({ max: free }); s.a.outcome = 'capacity'; s.queue(2);
    await s.make().tick();
    const rows = await s.rows();
    assert.equal(rows[0].end, 'refused');
    assert.equal(rows.length, free === 4 ? 2 : 1);
    if (free === 4) assert.equal(rows[1].reserved, 4);
  }
});

test('GCE-only repo never opens EC2; disallowed pinned job logs once and stays queued', async () => {
  const s = setup({ refs: [ref('gce', ONE_REGION_CFG.project)] });
  s.queue(); s.queue(8, 'ec2');
  const l = s.make(); await l.tick(); await l.tick();
  assert.equal(s.a.calls.filter(([k]) => k === 'launch').length, 0);
  assert.equal((await s.rows()).length, 1);
  assert.equal(s.logs.filter((x) => x.includes(`unservable: ${repo} lists no ec2`)).length, 1);
});

test('unknown EC2 inventory keeps old reservations and suppresses all its effects while GCE serves', async () => {
  const s = setup({ max: 16 });
  await s.ledger.read();
  await s.ledger.upsert(launchRow({ alloc: 'held', repo, cpus: 8, reserved: 8, provider: 'ec2', account: 'a', at: start - 48 * 3600_000, config: 'test' }));
  s.a.complete = 'throw'; s.queue(); s.queue();
  await s.make().tick();
  assert.equal((await s.rows()).find((r) => r.alloc === 'held').state, 'launching');
  assert.equal((await s.rows()).filter((r) => r.provider === 'gce').length, 1);
  assert.deepEqual(s.a.calls.map(([k]) => k), ['observe']);
  s.w.advance(31 * 60_000);
  await s.make().tick(); await s.make().tick();
  assert.equal(s.logs.filter((x) => x.includes('inventory unknown for 30 min')).length, 1);
});

async function until(cond) {
  for (let n = 0; n < 2000; n += 1) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail('scheduler did not reach the expected asynchronous boundary');
}

test('race at the original account cap walks the next account, with separate reservations and shared speculative group', async () => {
  const s = setup({ refs: [ref('ec2', 'a', 8), ref('ec2', 'b')], max: 16 });
  let release;
  s.a.outcome = () => new Promise((r) => { release = r; });
  await s.ledger.read();
  await s.ledger.upsert({ ...launchRow({ alloc: 'history', repo, cpus: 8, at: start - 3600_000, config: 'test' }), state: 'final', end: 'done', job: { run: 1, workflow: 'ci.yml', labels: labels(), required_provider: 'any' } });
  s.w.sim.queue(repo, ['ubuntu-slim'], { workflow: 'ci.yml' });
  s.w.gh.runs.at(-1).path = 'ci.yml';
  const tick = s.make({ after: s.w.after }).tick();
  await until(() => release);
  s.w.advance(20_000);
  await until(() => s.b.instances.length === 1);
  release({ outcome: 'accepted', detail: '' });
  const out = await tick;
  const rows = (await s.rows()).filter((r) => r.alloc !== 'history');
  assert.equal(out.raced.length, 1);
  assert.deepEqual(rows.map((r) => r.account).sort(), ['a', 'b']);
  assert.equal(new Set(rows.map((r) => r.prelaunch.group)).size, 1);
  assert.equal(rows.reduce((n, r) => n + r.reserved, 0), 16);
});

test('uncertainty holds both budgets, and successful row writes never double-count an allocation', async () => {
  const s = setup({ refs: [ref('ec2', 'a', 8), ref('ec2', 'b')], max: 16 });
  s.a.outcome = 'uncertain';
  s.queue(); s.queue();
  const tick = s.make({ after: s.w.after }).tick();
  await until(() => s.a.calls.some(([k]) => k === 'reconcile'));
  s.w.advance(45_000);
  await tick;
  const rows = await s.rows();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.account === 'a').state, 'launching');
  assert.equal(rows.find((r) => r.account === 'b').state, 'running');
  assert.equal((await s.w.github.runners(repo)).length, 2);
  s.queue();
  await s.make({ after: s.w.after }).tick();
  assert.equal((await s.rows()).length, 2, 'next tick keeps uncertain debit and live debit');
});

test('GCE spot refusal falls back to EC2 before GCE standard with cloud-correct JIT labels', async () => {
  const s = setup({ refs: [ref('gce', ONE_REGION_CFG.project), ref('ec2', 'a')] });
  const launch = s.gce.launch;
  s.gce.launch = async (row, p, jit) => p.provisioning === 'spot' ? { outcome: 'capacity', detail: 'out of stock' } : launch(row, p, jit);
  s.queue(); await s.make().tick();
  const rows = await s.rows();
  assert.deepEqual(rows.map((r) => [r.provider, r.end]), [['gce', 'refused'], ['ec2', undefined]]);
  assert.ok((await s.w.github.runners(repo))[0].labels.some((l) => l.name === 'ci-kit-ec2'));
  assert.equal(s.w.g.instances.length, 0);
});

test('a credit policy only demotes; an uncredited account follows repo order', async () => {
  for (const [refs, credit, preference, expected] of [
    [[ref('ec2', 'a'), ref('gce', ONE_REGION_CFG.project)], {}, false, 'gce'],
    [[ref('gce', ONE_REGION_CFG.project), ref('ec2', 'a')], {}, true, 'gce'],
    [[ref('ec2', 'a'), ref('gce', ONE_REGION_CFG.project)], undefined, false, 'ec2'],
  ]) {
    const s = setup({ refs }); s.ec2.accounts[0].credit = credit;
    s.queue(); await s.make({ creditPreference: () => preference }).tick();
    assert.equal((await s.rows())[0].provider, expected);
  }
});

async function speculative(s, count = 2) {
  await s.ledger.read();
  for (let i = 0; i < count; i += 1) await s.ledger.upsert({ ...launchRow({ alloc: `history-${i}`, repo, cpus: 8, at: start - 3600_000, config: 'test' }), state: 'final', end: 'done', job: { run: 1, workflow: 'ci.yml', labels: labels(), required_provider: 'any' } });
  s.w.sim.queue(repo, ['ubuntu-slim']);
  s.w.gh.runs.at(-1).path = 'ci.yml';
}

test('concurrent speculative admission obeys the cap before delayed ledger writes', async () => {
  const s = setup({ refs: [ref('ec2', 'a', 8), ref('ec2', 'b')], max: 16 });
  await speculative(s);
  let release;
  const held = new Promise((r) => { release = r; });
  const write = s.ledger.upsert;
  s.ledger.upsert = async (r, opts) => {
    if (r.account === 'a' && r.state === 'launching' && !r.client_token) await held;
    if (r.account === 'b') release();
    return write(r, opts);
  };
  await s.make().tick();
  assert.deepEqual((await s.rows()).filter((r) => r.prelaunch).map((r) => r.account).sort(), ['a', 'b']);
});

test('all-refused speculative demand retries, and partial successful fallbacks count one slot across restart', async () => {
  for (const partial of [false, true]) for (const restart of [false, true]) {
    const s = setup({ refs: [ref('ec2', 'a'), ref('ec2', 'b')] });
    await speculative(s);
    s.a.outcome = 'quota';
    let accepted = 0;
    s.b.outcome = () => ({ outcome: partial && accepted++ === 0 ? 'accepted' : 'quota', detail: '' });
    const launcher = s.make();
    const first = await launcher.tick();
    assert.equal(first.prelaunched.length, partial ? 1 : 0);
    s.b.outcome = 'accepted';
    const next = restart ? s.make({ ledger: createGceLedger(s.w.github, s.cfg.ledger, { now: s.w.now }) }) : launcher;
    const second = await next.tick();
    assert.equal(second.prelaunched.length, partial ? 1 : 2);
    const live = (await next.ledger.rows()).filter((r) => r.prelaunch && r.state !== 'final');
    assert.equal(live.length, 2);
    assert.equal(new Set(live.map((r) => r.prelaunch.group)).size, 2);
    assert.equal((await next.tick()).prelaunched.length, 0);
  }
});

test('real source enabled -> disabled -> absent preserves management only while accounts remain configured', async () => {
  const s = setup({ max: 32 });
  const id = '290475840169';
  const a = fakeEc2(s.w, id);
  const account = { account: id, region: 'us-east-2', placements: [{ zone: 'us-east-2a', subnet: 'subnet-fade', machines: { 2: 'c8a.large', 4: 'c8a.xlarge', 8: 'c8a.2xlarge', 16: 'c8a.4xlarge' } }], disk_gb: 50, security_group: 'sg-fade', report_bucket: 'reports', roles: Object.fromEntries(['launcher', 'bake', 'guard'].map((r) => [r, `arn:aws:iam::${id}:role/ci-kit-${r}`])) };
  const config = { ...s.cfg, repos: [{ repo, providers: [ref('ec2', id), { provider: 'gce' }] }] };
  let ec2 = { enabled: true, accounts: [account] }, revision = 1;
  const source = createConfigSource({ gh: { lastCommit: async (_repo, path) => ({ sha: path.endsWith('ec2.json') ? String(revision) : 'base' }) },
    fetchText: async (url) => url.endsWith('ec2.json') ? ec2 && JSON.stringify(ec2) : url.endsWith('gce.json') ? JSON.stringify(config) : '{"repos":[]}', readBundled: async () => null, bundledCommit: 'base', log: (m) => s.logs.push(m) });
  const tick = async () => s.make({ ...await source(), providers: [s.gce, a] }).tick();
  s.queue(); await tick();
  const original = (await s.rows())[0];
  (await s.w.github.runners(repo))[0].status = 'online';
  ec2 = { ...ec2, enabled: false }; revision++;
  await s.ledger.upsert(launchRow({ alloc: 'pending', provider: 'ec2', account: id, repo, cpus: 8, reserved: 8, at: start, config: 'test' }));
  s.queue();
  const disabled = await tick();
  assert.equal(disabled.launched.length, 1);
  assert.equal((await s.rows()).filter((r) => r.provider === 'ec2').length, 2);
  assert.ok(a.calls.some(([k]) => k === 'reconcile'));
  assert.ok(a.calls.some(([k]) => k === 'reports'));
  const before = a.calls.length;
  ec2 = null; revision++;
  await tick(); await tick();
  assert.equal(a.calls.length, before, 'absent file removes all EC2 management');
  assert.equal((await s.rows()).filter((r) => r.provider === 'ec2' && r.state !== 'final').length, 2);
  assert.equal(s.logs.filter((m) => m.includes('skipping') && m.includes('ec2')).length, 1);
  // Restore disabled: the old allocation is still managed, including terminal reporting and termination.
  ec2 = { enabled: false, accounts: [account] }; revision++;
  a.reports.set(original.alloc, { telemetry: [], terminal: { kind: 'terminal', value: 'exit:0' } });
  await tick();
  assert.ok(a.calls.some(([k]) => k === 'terminate'));
});

test('account disable affects only its launches; removing a provider list entry does not revoke live coverage', async () => {
  const s = setup({ refs: [ref('ec2', 'a'), ref('ec2', 'b')] });
  s.ec2.accounts[0].enabled = false;
  s.queue(); await s.make().tick();
  assert.equal((await s.rows())[0].account, 'b');
  s.queue();
  const out = await s.make({ repoProviders: { [repo]: [ref('gce', s.cfg.project)] } }).tick();
  assert.equal(out.launched.length, 1, 'existing EC2 covers the first job after removal; only new demand launches');
  assert.equal((await s.rows()).length, 2);
});

test('denied memory lasts ten minutes only on its account; throttling lasts one tick', async () => {
  for (const outcome of ['denied', 'throttled']) {
    const s = setup({ refs: [ref('ec2', 'a'), ref('ec2', 'b')] });
    s.a.outcome = outcome;
    s.queue(); await s.make().tick();
    assert.deepEqual((await s.rows()).map((r) => [r.account, r.end]), [['a', 'refused'], ['b', undefined]]);
    s.a.outcome = 'accepted';
    s.queue(); await s.make().tick();
    assert.equal(s.a.calls.filter(([k]) => k === 'launch').length, outcome === 'denied' ? 1 : 2);
    if (outcome === 'denied') {
      s.w.advance(10 * 60_000);
      s.queue(); await s.make().tick();
      assert.ok(s.a.calls.filter(([k]) => k === 'launch').length > 1);
    }
  }
});

test('provider-only demand never falls back across clouds and both cloud labels are unservable', async () => {
  const s = setup(); s.a.outcome = 'quota';
  s.queue(8, 'ec2'); s.w.sim.queue(repo, [...labels(8, 'ec2'), 'ci-kit-gce']);
  await s.make().tick();
  assert.equal((await s.rows()).length, 1);
  assert.equal((await s.rows())[0].end, 'refused');
  assert.equal(s.w.g.instances.length, 0);
});

test('unknown inventory retains failed running writes and all row states without cleanup; online-only coverage', async () => {
  const s = setup({ max: 32 });
  const write = s.ledger.upsert;
  s.ledger.upsert = async (r, opts) => { if (r.provider === 'ec2' && r.state === 'running') throw new Error('lost running write'); return write(r, opts); };
  s.queue(); await s.make().tick();
  const original = (await s.rows())[0];
  assert.equal(original.state, 'launching');
  assert.equal(original.reserved, 8);
  s.ledger.upsert = write;
  for (const state of ['running', 'deleting']) await write({ ...launchRow({ alloc: state, provider: 'ec2', account: 'a', repo, cpus: 8, reserved: 8, at: start - 48 * 3600_000, config: 'test' }), state });
  const runner = (await s.w.github.runners(repo))[0]; runner.status = 'online';
  s.a.complete = false;
  const before = s.a.calls.length;
  s.queue(); await s.make().tick();
  assert.equal((await s.rows()).filter((r) => r.provider === 'gce').length, 1, 'online independent runner covers one, GCE fills remaining global room');
  assert.deepEqual(s.a.calls.slice(before).map(([k]) => k), ['observe']);
  assert.ok((await s.rows()).filter((r) => r.provider === 'ec2').every((r) => r.state !== 'final'));
  runner.busy = true; s.queue();
  await s.make().tick();
  assert.equal((await s.rows()).length, 4, 'busy supplies no coverage and cannot release the held vCPUs');
});

test('boot and notice telemetry cannot retire a VM; a refused orphan registration is reaped after five minutes', async () => {
  const s = setup(); s.queue(); await s.make().tick();
  const r = (await s.rows())[0];
  s.a.reports.set(r.alloc, { telemetry: [{ kind: 'telemetry', boot: true }, { kind: 'telemetry', notice: true }] });
  await s.make().tick();
  assert.equal(s.a.instances.length, 1);
  assert.equal((await s.rows()).length, 1);
  // Another allocation was refused immediately before a process died, leaving its nonbusy registration.
  const alloc = allocationId(start - 10 * 60_000, () => 1234);
  const orphan = launchRow({ alloc, provider: 'ec2', account: 'a', repo, cpus: 8, at: start - 10 * 60_000, config: 'test' });
  await s.ledger.upsert({ ...orphan, state: 'final', end: 'refused' });
  await s.w.github.jitConfig(repo, { name: orphan.instance, labels: labels(8, 'ec2'), work_folder: '_work' });
  s.w.advance(6 * 60_000);
  await s.make().tick();
  assert.ok(!(await s.w.github.runners(repo)).some((x) => x.name === orphan.instance));
});

test('accepted cloud identity and credit policy are persisted on the provider-bound row', async () => {
  const s = setup(); s.ec2.accounts[0].credit = { enabled: true };
  s.a.outcome = () => ({ outcome: 'accepted', id: 'i-observed', detail: '' });
  s.queue(); await s.make({ creditPreference: () => true }).tick();
  const [r] = await s.rows();
  assert.equal(r.instance_id, 'i-observed');
  assert.equal(r.credit_policy, 'on');
});

test('a terminal orphan VM is retired with its actual provider/account, not a synthetic GCE row', async () => {
  const s = setup();
  const alloc = allocationId(start - 20 * 60_000, () => 4321);
  const candidate = s.a.candidates(s.ec2.accounts[0], 8)[0];
  s.a.instances.push({ provider: 'ec2', id: `i-${alloc}`, alloc, runner: `ci-kit-ec2-${alloc}`, size: 8, labels: candidate.labels, repo, state: 'stopped', candidate, createdAt: new Date(start - 20 * 60_000).toISOString() });
  await s.make().tick();
  const [r] = await s.rows();
  assert.equal(r.provider, 'ec2');
  assert.equal(r.account, 'a');
  assert.equal(r.repo, repo);
  assert.equal(r.end, 'orphan');
});
