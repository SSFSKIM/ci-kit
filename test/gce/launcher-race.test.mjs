// The race of a slow insert in the launcher's tick (spec 2026-10-21 M6, step 3), against the shared fake of Compute
// Engine and GitHub on the world's clock: an insert held past RACE_AFTER_MS starts a second allocation in another
// placement; the first keeps waiting and is never walked on; each allocation races once and a race never races; no race
// before every queued job's first launch attempt, past the tick's deadline, or beyond max_vcpus; an unsettled
// allocation keeps its vCPUs and its job's cover across ticks and launcher restarts, and later learns when its insert
// ended; and the counts on the tick summary and the daily line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, gceErr } from './fake-world.mjs';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { parseRow, renderRow, dailyLine, launchRow, runningRow } from '../../gce/launcher/ledger.mjs';
import { allocOf, instanceName, RACE_AFTER_MS } from '../../gce/launcher/logic.mjs';
import { NEW_CFG } from './config-fixtures.mjs';
import { GceError } from '../../lib/gce.mjs';

const SBX = 'SSFSKIM/ci-kit-sandbox';
const CFG = { ...NEW_CFG, repos: [{ repo: SBX }] };
const T0 = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60_000;
const L = (n) => ['self-hosted', 'ci-kit-pool', `cpus-${n}`];
const COMMIT = 'c0ffee00aabbccddeeff00112233445566778899';

function setup({ cfg = CFG } = {}) {
  const w = world({ start: T0 });
  let seq = 0;
  // A new Launcher is a restart: it keeps nothing but what GCE, GitHub and the ledger hold.
  const make = () => new Launcher({
    gce: w.gce, gh: w.github, ledger: createGceLedger(w.github, cfg.ledger, { now: w.now }), cfg, config: COMMIT,
    now: w.now, random: () => (seq += 1), alert: async () => {}, log: (m) => w.log.push(`log ${m}`), after: w.after,
  });
  return { w, launcher: make(), make };
}

// Inserts `pick` chooses wait until released: held.get(name)() lets one go on to its outcome.
function hold(w, pick) {
  const held = new Map();
  w.hooks.holdInsert = (zone, body) => {
    if (!pick(zone, body)) return null;
    return new Promise((resolve) => held.set(body.name, resolve));
  };
  return held;
}
// Lets the tick run until `cond` holds (its awaits are all on the fakes, which settle within a few turns).
async function until(cond, what) {
  for (let k = 0; k < 2000; k += 1) {
    if (cond()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`never happened: ${what}`);
}
const turns = async (n = 50) => {
  for (let k = 0; k < n; k += 1) await new Promise((resolve) => setImmediate(resolve));
};
const rows = (w) => {
  const byAlloc = new Map();
  for (const c of w.gh.comments) {
    const r = parseRow(c.body);
    if (r) byAlloc.set(r.alloc, r); // the fakes keep one comment per allocation, updated in place
  }
  return byAlloc;
};
const rowOf = (w, name) => rows(w).get(allocOf(name));
const races = (w) => [...rows(w).values()].filter((r) => r.race);
const vms = (w) => w.g.instances.map((i) => i.name);
const placed = (w, name) => {
  const i = w.sim.vm(name);
  return `${i.machineType.split('/').pop()}/${i.labels['ci-kit-provisioning']}@${i.zone.split('/').pop()}`;
};
const insertsOf = (w, name) => w.log.filter((l) => l.startsWith(`insert-wait ${name} `)).length;
// An insert whose wait ended before its operation did: accepted, still running (sim.completeInsert finishes it).
const unsettled = (name = null) => ({
  match: (zone, body) => body.name === name, running: true,
  error: (op) => new GceError(0, 'gce operation did not finish in 40 s', [], { accepted: true, operation: op.selfLink }),
});

test('a pending insert races the next zone of another placement; one job, two VMs: the one no job claims idles out', async () => {
  const { w, launcher } = setup();
  const job = w.sim.queue(SBX, L(4));
  const held = hold(w, (zone) => zone === 'us-west4-a');
  const ticking = launcher.tick();
  await until(() => held.size === 1, 'the first insert is sent');
  const [first] = held.keys();
  w.advance(RACE_AFTER_MS - 1);
  await turns();
  assert.equal(races(w).length, 0, 'not before 20 s');
  w.advance(1);
  await until(() => vms(w).length === 1, 'the race\'s VM is created while the first insert is pending');
  const [second] = vms(w);
  assert.equal(placed(w, second), 'c3d-highcpu-4/spot@us-central1-a', 'another placement\'s first spot zone');
  held.get(first)(); // the first insert settles: created, 20 s after it was sent
  const out = await ticking;

  assert.deepEqual(new Set(out.launched), new Set([first, second]));
  assert.deepEqual(out.raced, [`${second} for ${first}`]);
  assert.equal(insertsOf(w, first), 1);
  assert.deepEqual(rowOf(w, second).race, { of: allocOf(first), demand: { job: job.id } });
  assert.equal(rowOf(w, first).race, undefined);
  assert.deepEqual(rowOf(w, first).slow, [{ zone: 'us-west4-a', outcome: 'created', sent: new Date(T0).toISOString(), done: new Date(T0 + RACE_AFTER_MS).toISOString() }]);
  assert.deepEqual(out.slow, { inserts: 1, unsettled: 0, seconds: [20] });
  assert.deepEqual(out.inserts.map((i) => [i.zone, i.outcome, i.seconds]).sort(), [['us-central1-a', 'created', 0], ['us-west4-a', 'created', 20]]);
  assert.deepEqual([out.refusals, out.onDemand], [[], 0]);

  // The race's VM boots first and its runner takes the job; the first VM is an ordinary unclaimed one.
  w.sim.boot(SBX, second);
  w.sim.take(SBX, second, job);
  w.sim.boot(SBX, first);
  w.advance(MIN);
  assert.deepEqual((await launcher.tick()).launched, []);
  w.advance(9 * MIN);
  await launcher.tick();
  assert.deepEqual(vms(w), [second], 'the first VM went by the idle rule');
  w.sim.finish(SBX, second, job);
  for (let k = 0; k < 2; k += 1) {
    w.advance(MIN);
    await launcher.tick();
  }
  const [a, b] = [rowOf(w, first), rowOf(w, second)];
  assert.deepEqual([a.state, a.end, a.job, b.state, b.end, b.job?.id], ['final', 'cancelled-idle', undefined, 'final', 'done', job.id]);
  const line = dailyLine([...rows(w).values()], '2026-10-16', COMMIT);
  assert.deepEqual(line.races, {
    started: 1, firstClaim: { race: 1, original: 0, tied: 0, unknown: 0 }, bothClaimed: 0, neitherClaimed: 0, unresolved: 0, unclaimedDollars: a.dollars,
  });
});

test('the first allocation is never walked: refused after its race began, it is abandoned and the race carries the job', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  const held = hold(w, (zone) => zone === 'us-west4-a');
  const ticking = launcher.tick();
  await until(() => held.size === 1, 'the first insert is sent');
  const [first] = held.keys();
  w.advance(RACE_AFTER_MS);
  await until(() => vms(w).length === 1, 'the race\'s VM');
  const [second] = vms(w);
  w.g.insertErrors.push({ match: (zone, body) => body.name === first, error: gceErr(['ZONE_RESOURCE_POOL_EXHAUSTED']) });
  w.advance(5_000);
  held.get(first)();
  const out = await ticking;

  assert.deepEqual(out.launched, [second]);
  assert.equal(insertsOf(w, first), 1, 'no second zone for the first allocation');
  const row = rowOf(w, first);
  assert.deepEqual([row.state, row.end], ['final', 'abandoned']);
  assert.deepEqual(row.refused, [{ kind: 'capacity', zone: 'us-west4-a' }]);
  assert.deepEqual(row.slow.map((s) => [s.outcome, (Date.parse(s.done) - Date.parse(s.sent)) / 1000]), [['capacity', 25]]);
  assert.equal(w.sim.runner(SBX, first), undefined, 'its runner is unregistered');
  assert.ok(w.log.includes(`log ${first}: not created (c4d-highcpu-4/spot@us-west4-a: capacity); its race serves job ${w.gh.jobs[0].id}`));
  assert.deepEqual(out.refusals, [{ kind: 'capacity', zone: 'us-west4-a', n: 1 }]);
});

test('one race per allocation and none of a race; an unsettled pair keeps its job covered and its vCPUs across a restart, and learns its end', async () => {
  const { w, launcher, make } = setup({ cfg: { ...CFG, max_vcpus: 12 } });
  const job = w.sim.queue(SBX, L(4));
  const held = hold(w, () => true);
  const ticking = launcher.tick();
  await until(() => held.size === 1, 'the first insert');
  const [first] = held.keys();
  w.advance(RACE_AFTER_MS);
  await until(() => held.size === 2, 'the race\'s insert, held too');
  const second = [...held.keys()][1];
  w.advance(RACE_AFTER_MS); // the race's insert is now 20 s old, the first's 40 s
  await turns();
  assert.equal(held.size, 2, 'no race of the race, no second race of the first');
  w.g.insertErrors.push(unsettled(first), unsettled(second));
  for (const release of held.values()) release();
  const out = await ticking;

  assert.deepEqual([out.launched, out.raced], [[], []], 'neither VM exists yet');
  assert.equal(w.log.filter((l) => l.startsWith('jit ')).length, 2);
  assert.deepEqual(races(w).map((r) => r.race.of), [allocOf(first)]);
  for (const name of [first, second]) {
    assert.equal(rowOf(w, name).state, 'launching');
    assert.equal(rowOf(w, name).slow.at(-1).outcome, 'unknown');
  }
  assert.deepEqual(out.slow, { inserts: 2, unsettled: 2, seconds: [] });

  // A restart: the next launcher sees neither VM listed. Their rows cover the job and keep 8 of the 12 vCPUs, so a
  // second cpus-4 job is covered by the spare and a cpus-8 one does not fit: nothing is launched, nothing raced.
  w.hooks.holdInsert = null;
  w.sim.queue(SBX, L(4));
  w.sim.queue(SBX, L(8));
  w.advance(MIN);
  const next = await make().tick();
  assert.deepEqual([next.launched, next.raced, next.waiting], [[], [], 1]);
  assert.equal(job.status, 'queued');

  // The operations finish (the first created, the race's refused); the next tick learns when, from the operations.
  w.advance(10_000);
  w.sim.completeInsert(first);
  w.sim.completeInsert(second, { codes: ['QUOTA_EXCEEDED'], message: "Quota 'C3D_CPUS' exceeded.  Limit: 24.0 in region us-central1." });
  const done = new Date(w.now()).toISOString();
  w.advance(MIN);
  await make().tick();
  assert.deepEqual([rowOf(w, first).state, rowOf(w, first).slow.at(-1)], ['running', { zone: 'us-west4-a', outcome: 'created', sent: rowOf(w, first).slow[0].sent, done, operation: rowOf(w, first).slow[0].operation }]);
  assert.deepEqual([rowOf(w, second).state, rowOf(w, second).end, rowOf(w, second).slow.at(-1).outcome, rowOf(w, second).slow.at(-1).done], ['final', 'abandoned', 'quota', done]);
  assert.deepEqual(rowOf(w, second).refused, [{ kind: 'quota', zone: 'us-central1-a', metric: 'C3D_CPUS' }], 'the refusal learned late is counted, with its metric');
});

test('two slow inserts in one tick race once each, and the next tick launches nothing more for their jobs', async () => {
  const { w, launcher, make } = setup();
  const jobs = [w.sim.queue(SBX, L(4)), w.sim.queue(SBX, L(4))];
  const held = hold(w, (zone) => zone === 'us-west4-a');
  const ticking = launcher.tick();
  await until(() => held.size === 2, 'both first inserts');
  const firsts = [...held.keys()];
  w.advance(RACE_AFTER_MS);
  await until(() => vms(w).length === 2, 'both races\' VMs');
  w.g.insertErrors.push(...firsts.map(unsettled));
  for (const release of held.values()) release();
  const out = await ticking;
  assert.equal(out.raced.length, 2);
  assert.deepEqual(races(w).map((r) => r.race.of).sort(), firsts.map(allocOf).sort());
  assert.deepEqual(races(w).map((r) => r.race.demand.job).sort(), jobs.map((j) => j.id).sort());

  // Four allocations for two jobs, two of them unlisted: every queued cpus-4 job is covered, a third one too.
  w.hooks.holdInsert = null;
  w.sim.queue(SBX, L(4));
  w.advance(MIN);
  const next = await make().tick();
  assert.deepEqual([next.launched, next.raced], [[], []]);
});

test('no race starts before every queued job has made its first launch attempt', async () => {
  const { w, launcher } = setup();
  for (let k = 0; k < 17; k += 1) w.sim.queue(SBX, L(2)); // one more than launch in parallel
  const held = hold(w, (zone) => zone === 'us-west4-a');
  const ticking = launcher.tick();
  await until(() => held.size === 16, 'sixteen first inserts');
  w.advance(RACE_AFTER_MS);
  await turns();
  assert.equal(races(w).length, 0, 'the seventeenth job has not been tried');
  const [early] = held.keys();
  held.get(early)(); // one settles; its worker takes the seventeenth job
  await until(() => held.size === 17, 'the seventeenth job\'s first insert');
  const lastSent = w.log.findIndex((l) => l.startsWith(`insert-wait ${[...held.keys()][16]} `));
  await until(() => races(w).length === 15, 'the fifteen still pending race');
  const firstRaceJit = w.log.findIndex((l) => races(w).some((r) => l === `jit ${r.instance}`));
  assert.ok(lastSent < firstRaceJit, `the last job's insert (${lastSent}) before any race's mint (${firstRaceJit})`);
  for (const [name, release] of held) if (name !== early) release();
  const out = await ticking;
  assert.equal(out.raced.length, 15);
  assert.equal(out.launched.length, 32);
});

test('no race past the tick\'s deadline, or beyond max_vcpus', async () => {
  for (const [why, cfg, before] of [
    ['deadline', CFG, (w) => { w.hooks.beforeJit = () => w.advance(30_000); }], // the insert goes 30 s into a 45 s tick
    ['max_vcpus', { ...CFG, max_vcpus: 4 }, () => {}],
  ]) {
    const { w, launcher } = setup({ cfg });
    w.sim.queue(SBX, L(4));
    before(w);
    const held = hold(w, (zone) => zone === 'us-west4-a');
    const ticking = launcher.tick();
    await until(() => held.size === 1, 'the first insert');
    w.advance(RACE_AFTER_MS);
    await until(() => w.log.some((l) => / no race \(/.test(l)), `the race declined (${why})`);
    for (const release of held.values()) release();
    const out = await ticking;
    assert.deepEqual([out.raced, races(w).length, out.launched.length], [[], 0, 1], why);
    assert.equal(out.slow.inserts, 1, why);
  }
});

test('pre-launch plans against what the race reserved: a race\'s vCPUs are not given to a run\'s pre-launch', async () => {
  const { w, launcher } = setup({ cfg: { ...CFG, max_vcpus: 8 } });
  // The gate workflow's earlier runs each ran one cpus-4 job: a begun run's shape is one cpus-4 VM.
  for (const run of [11, 12, 13]) {
    const alloc = `zz000000${run}`;
    const row = { alloc, instance: instanceName(alloc), repo: SBX, cpus: 4, at: new Date(T0 - 3600_000).toISOString(), config: 'c0ffee00', state: 'final', end: 'done', job: { id: run, name: 'unit', run, workflow: '.github/workflows/gate.yml' } };
    w.gh.comments.push({ id: run, issue: 1, body: renderRow(row), updated_at: new Date(T0 - 3600_000).toISOString() });
  }
  w.sim.queue(SBX, L(4)); // a queued gate of one run (4 vCPUs)
  w.sim.queue(SBX, ['ubuntu-slim'], { name: 'plan' }); // another run has begun: without the race, its pre-launch fits
  const held = hold(w, (zone) => zone === 'us-west4-a');
  const ticking = launcher.tick();
  await until(() => held.size === 1, 'the queued job\'s insert');
  w.advance(RACE_AFTER_MS);
  await until(() => races(w).length === 1, 'the race');
  held.get([...held.keys()][0])();
  const out = await ticking;
  assert.deepEqual([out.launched.length, out.raced.length, out.prelaunched], [2, 1, []], 'the race took the 4 vCPUs pre-launch would have');
});

test('a launcher restarted while a race\'s insert is in flight counts both allocations: nothing more is admitted', async () => {
  const { w, launcher, make } = setup({ cfg: { ...CFG, max_vcpus: 8 } });
  w.sim.queue(SBX, L(4));
  const held = hold(w, () => true);
  const ticking = launcher.tick();
  await until(() => held.size === 1, 'the first insert');
  w.advance(RACE_AFTER_MS);
  await until(() => held.size === 2, 'the race\'s insert, in flight');
  const [first, second] = held.keys();
  assert.deepEqual([rowOf(w, first).slow?.[0].done, rowOf(w, second).reserved], [undefined, 4], 'both written before the race\'s insert');
  w.hooks.holdInsert = null; // a new launch would not be held: if one were admitted, it would show
  w.sim.queue(SBX, L(4));
  const next = await make().tick();
  assert.deepEqual([next.launched, next.raced], [[], []], 'both covered by the pair\'s runners, and 8 of 8 vCPUs reserved');
  assert.equal(w.log.filter((l) => l.startsWith('jit ')).length, 2);
  for (const release of held.values()) release();
  await ticking;
});

test('an insert whose wait ends before its operation (still running when reconciled) is not settled: its race still starts in the tick', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  w.g.insertErrors.push({ ...unsettled(), match: (zone) => zone === 'us-west4-a' });
  const ticking = launcher.tick();
  await until(() => w.log.some((l) => / us-west4-a unsettled$/.test(l)), 'the wait call gave up early');
  await turns();
  w.advance(RACE_AFTER_MS);
  const out = await ticking;
  assert.equal(out.raced.length, 1);
  const [first] = [...rows(w).values()].filter((r) => !r.race);
  assert.deepEqual([first.state, first.slow.at(-1).outcome, races(w)[0].race.of], ['launching', 'unknown', first.alloc]);
});

test('learning how unsettled inserts ended reads each zone once, never holds a stopped VM\'s deletion, and leaves what its budget missed', async () => {
  const { w, launcher } = setup();
  const job = w.sim.queue(SBX, L(4));
  await launcher.tick();
  const [vm] = vms(w);
  w.sim.boot(SBX, vm);
  w.sim.take(SBX, vm, job);
  w.sim.finish(SBX, vm, job); // powered off: the next tick deletes it
  w.advance(MIN);
  // Three rows whose inserts never settled in their ticks, two in us-west4-a and one in us-central1-a; all done since.
  const ended = new Date(w.now() - 5_000).toISOString();
  for (const [alloc, zone] of [['west00000a', 'us-west4-a'], ['west00000b', 'us-west4-a'], ['cent00000a', 'us-central1-a']]) {
    const row = { ...launchRow({ alloc, repo: SBX, cpus: 4, at: w.now() - 50_000, config: COMMIT, reserved: 4 }), slow: [{ zone, outcome: 'unknown', sent: new Date(w.now() - 49_000).toISOString() }] };
    w.gh.comments.push({ id: 9000 + w.gh.comments.length, issue: 1, body: renderRow(row), updated_at: new Date(w.now()).toISOString() });
    const target = `https://www.googleapis.com/compute/v1/projects/ssfskim-ci-kit/zones/${zone}/instances/${instanceName(alloc)}`;
    w.g.ops.push({ name: `op-${alloc}`, zone, operationType: 'insert', status: 'DONE', insertTime: new Date(w.now() - 49_000).toISOString(), endTime: ended, targetLink: target, selfLink: `${target}-op` });
  }
  w.hooks.zoneOperations = (zone) => (zone === 'us-west4-a' ? new Promise(() => {}) : null); // that zone's read hangs
  const ticking = launcher.tick();
  await until(() => w.log.includes(`delete ${vm}`), 'the stopped VM is deleted while a read hangs');
  assert.deepEqual(w.log.filter((l) => l.startsWith('read operations ')).sort(), ['read operations us-central1-a', 'read operations us-west4-a']);
  w.advance(15_000); // the reads' budget
  await ticking;
  assert.equal(rowOf(w, instanceName('cent00000a')).slow[0].done, ended, 'the zone that answered is learned');
  assert.equal(rowOf(w, instanceName('west00000a')).slow[0].done, undefined, 'left for the next tick');
  w.hooks.zoneOperations = null;
  w.advance(MIN);
  await launcher.tick();
  for (const alloc of ['west00000a', 'west00000b']) assert.deepEqual(rowOf(w, instanceName(alloc)).slow[0], { zone: 'us-west4-a', outcome: 'created', sent: rowOf(w, instanceName(alloc)).slow[0].sent, done: ended });
});

test('the daily line reads the day\'s NAT from Cloud Monitoring once, when it is posted; a refused read says unread', async () => {
  for (const refused of [false, true]) {
    const start = Date.parse('2026-10-17T00:30:00Z');
    const w = world({ start });
    const asked = [];
    w.hooks.timeSeries = (filter, opts) => {
      asked.push({ filter, ...opts });
      if (refused) throw new GceError(403, 'Permission monitoring.timeSeries.list denied', ['forbidden']);
      const value = filter.includes('allocated_ports') ? 120 : 2 ** 30;
      return [{ resource: { type: 'nat_gateway', labels: { region: 'us-west4' } }, points: [{ value: { int64Value: String(value) } }] }];
    };
    const launcher = new Launcher({
      gce: w.gce, gh: w.github, ledger: createGceLedger(w.github, CFG.ledger, { now: w.now }), cfg: CFG, config: COMMIT,
      now: w.now, random: () => 1, alert: async () => {}, log: (m) => w.log.push(`log ${m}`), after: w.after,
    });
    await launcher.tick();
    w.advance(MIN);
    await launcher.tick(); // the line is already posted: no second read
    const daily = w.gh.comments.filter((c) => c.body.includes('ci-kit-gce-daily'));
    assert.equal(daily.length, 1);
    assert.equal(asked.length, 3, 'sent bytes, received bytes, allocated ports: once');
    assert.ok(asked.every((a) => a.start === '2026-10-16T00:00:00.000Z' && a.end === '2026-10-17T00:00:00.000Z'
      && /resource\.labels\.gateway_name="ci-kit-nat"/.test(a.filter) && a.aggregation.groupByFields === 'resource.labels.region'));
    if (refused) assert.match(daily[0].body, / NAT: unread\./);
    // 2 GiB processed (1 each way) and 2 address-hours in us-west4: $0.09 + $0.01.
    else assert.match(daily[0].body, / NAT: us-west4 2 GiB, 2 address-hours, \$0\.1000; \$0\.1000 in all\./);
  }
});

// Re-review (M6 race): a definite refusal learned late ends the allocation; a failed marker write starts no race;
// settlement writes are joined before rows are finalized; the NAT day is read after its samples land.

test('a race whose insert is learned later to have been refused is no longer pending: abandoned, runner gone, its job launched again', async () => {
  const { w, launcher, make } = setup();
  const job = w.sim.queue(SBX, L(4));
  const held = hold(w, () => true);
  const ticking = launcher.tick();
  await until(() => held.size === 1, 'the first insert');
  w.advance(RACE_AFTER_MS);
  await until(() => held.size === 2, 'the race\'s insert');
  const [first, second] = held.keys();
  w.g.insertErrors.push(unsettled(second));
  held.get(second)(); // the race's wait ends, its operation still running
  w.advance(5_000);
  w.g.insertErrors.push({ match: (zone, body) => body.name === first, error: gceErr(['ZONE_RESOURCE_POOL_EXHAUSTED']) });
  held.get(first)(); // the original is refused: abandoned, the race carries the job
  await ticking;
  assert.deepEqual([rowOf(w, first).end, rowOf(w, second).state], ['abandoned', 'launching']);
  w.hooks.holdInsert = null;
  w.sim.completeInsert(second, { codes: ['ZONE_RESOURCE_POOL_EXHAUSTED'] });
  w.advance(MIN);
  const next = await make().tick();
  assert.deepEqual([rowOf(w, second).state, rowOf(w, second).end], ['final', 'abandoned']);
  assert.equal(w.sim.runner(SBX, second), undefined, 'its runner is unregistered');
  w.advance(MIN);
  const after = await make().tick();
  assert.equal(next.launched.length + after.launched.length, 1, `the job is launched again, not left waiting on a refused allocation (${job.id})`);
});

test('a race whose original\'s pending insert cannot be written to the ledger is not started', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  const held = hold(w, (zone) => zone === 'us-west4-a');
  const ticking = launcher.tick();
  await until(() => held.size === 1, 'the first insert');
  const [first] = held.keys();
  w.hooks.commentWrite = (body) => {
    if (body.includes(`"alloc":"${allocOf(first)}"`)) throw Object.assign(new Error('Server Error'), { status: 502 });
  };
  w.advance(RACE_AFTER_MS);
  await until(() => w.log.some((l) => / no race \(/.test(l)), 'the race declined');
  w.hooks.commentWrite = null;
  held.get(first)();
  const out = await ticking;
  assert.deepEqual([out.raced, races(w).length, w.log.filter((l) => l.startsWith('jit ')).length], [[], 0, 1]);
});

test('a settlement whose ledger write outlasts the read budget is written before its row is finalized', async () => {
  const { w, launcher } = setup();
  // A row being deleted whose insert never settled in its tick; its VM is gone, so this tick finalizes it.
  const alloc = 'dele00000a';
  const at = w.now() - 5 * MIN;
  const row = {
    ...runningRow({ ...launchRow({ alloc, repo: SBX, cpus: 4, at, config: COMMIT, reserved: 4 }), slow: [{ zone: 'us-west4-a', outcome: 'unknown', sent: new Date(at + 1_000).toISOString() }] },
      { zone: 'us-west4-a', machine: 'c4d-highcpu-4', provisioning: 'spot', created: at + 60_000 }),
    state: 'deleting', end: 'done', deleted: new Date(w.now() - 30_000).toISOString(),
  };
  w.gh.comments.push({ id: 9100, issue: 1, body: renderRow(row), updated_at: new Date(w.now()).toISOString() });
  const target = `https://www.googleapis.com/compute/v1/projects/ssfskim-ci-kit/zones/us-west4-a/instances/${instanceName(alloc)}`;
  const ended = new Date(at + 61_000).toISOString();
  w.g.ops.push({ name: 'op-d', zone: 'us-west4-a', operationType: 'insert', status: 'DONE', insertTime: new Date(at + 1_000).toISOString(), endTime: ended, targetLink: target, selfLink: `${target}-op` });
  let release;
  const slowWrite = new Promise((resolve) => { release = resolve; });
  w.hooks.commentWrite = (body) => (body.includes(ended) ? slowWrite : null);
  const ticking = launcher.tick();
  await until(() => release && w.log.includes('read operations us-west4-a'), 'the operation read');
  await turns();
  w.advance(15_000); // the read budget passes while the write is in flight
  await turns();
  assert.equal(rowOf(w, instanceName(alloc)).state, 'deleting', 'not finalized ahead of the settlement');
  release();
  await ticking;
  const final = rowOf(w, instanceName(alloc));
  assert.deepEqual([final.state, final.slow[0].done], ['final', ended]);
});

test('the daily line waits until 5 min past midnight UTC, when the NAT samples of the day\'s end have landed', async () => {
  const start = Date.parse('2026-10-17T00:02:00Z');
  const w = world({ start });
  const launcher = new Launcher({
    gce: w.gce, gh: w.github, ledger: createGceLedger(w.github, CFG.ledger, { now: w.now }), cfg: CFG, config: COMMIT,
    now: w.now, random: () => 1, alert: async () => {}, log: () => {}, after: w.after,
  });
  const posted = () => w.gh.comments.filter((c) => c.body.includes('ci-kit-gce-daily')).length;
  await launcher.tick();
  assert.deepEqual([posted(), w.log.filter((l) => l.startsWith('time series')).length], [0, 0]);
  w.advance(3 * MIN);
  await launcher.tick();
  assert.equal(posted(), 1);
});

// Review of 2a300bd: marker writes of one allocation land in order, before its walk's result; an unsettled insert is
// matched to its own operation, not to an earlier attempt's in the same zone.

test('two slow attempts of one walk: a marker write held past the second lands before the walk\'s result, never after it', async () => {
  const { w, launcher } = setup();
  w.sim.queue(SBX, L(4));
  const held = new Map(); // zone → release
  w.hooks.holdInsert = (zone) => (zone.startsWith('us-west4') ? new Promise((resolve) => held.set(zone, resolve)) : null);
  const ticking = launcher.tick();
  await until(() => held.has('us-west4-a'), 'attempt A');
  const name = w.log.find((l) => l.startsWith('insert-wait ')).split(' ')[1];
  let releaseMarker;
  const markerHeld = new Promise((resolve) => { releaseMarker = resolve; });
  w.hooks.commentWrite = (body) => (body.includes(`"alloc":"${allocOf(name)}"`) && body.includes('"slow":[{"zone":"us-west4-a","outcome":"unknown"') ? markerHeld : null);
  w.advance(RACE_AFTER_MS); // A's race decision: its marker write is held
  await turns();
  w.g.insertErrors.push({ match: (zone) => zone === 'us-west4-a', error: gceErr(['ZONE_RESOURCE_POOL_EXHAUSTED']) });
  held.get('us-west4-a')(); // A is refused; the walk sends B, in us-west4-b
  await until(() => held.has('us-west4-b'), 'attempt B');
  w.advance(RACE_AFTER_MS); // B reaches the threshold too
  await turns();
  w.g.insertErrors.push({ ...unsettled(), match: (zone) => zone === 'us-west4-b' });
  held.get('us-west4-b')(); // B's wait ends unsettled: the walk's result keeps B's insert
  await turns();
  releaseMarker(); // A's obsolete marker lands only now
  await ticking;
  await turns();
  const row = rowOf(w, name);
  assert.equal(row.state, 'launching');
  assert.deepEqual(row.slow.map((s) => [s.zone, s.outcome]), [['us-west4-a', 'capacity'], ['us-west4-b', 'unknown']], 'the walk\'s record, not A\'s marker');
});

test('an unsettled insert is matched to its own operation: an earlier refused attempt in the same zone neither settles nor abandons it', async () => {
  for (const byLink of [true, false]) {
    const { w, launcher } = setup();
    const alloc = 'same00000a';
    const name = instanceName(alloc);
    const sent = w.now() - 30_000;
    const target = `https://www.googleapis.com/compute/v1/projects/ssfskim-ci-kit/zones/us-central1-a/instances/${name}`;
    const op = (id, status, insertTime, extra) => ({ name: id, zone: 'us-central1-a', operationType: 'insert', status, insertTime: new Date(insertTime).toISOString(), targetLink: target, selfLink: `${target.replace(/instances\/.*/, 'operations/')}${id}`, ...extra });
    // The spot attempt, refused, then the standard attempt in the same zone under the same name, still running.
    w.g.ops.push(op('op-spot', 'DONE', sent - 20_000, { endTime: new Date(sent - 15_000).toISOString(), error: { errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED' }] } }));
    w.g.ops.push(op('op-std', 'RUNNING', sent));
    const insert = { zone: 'us-central1-a', outcome: 'unknown', sent: new Date(sent).toISOString(), ...(byLink ? { operation: w.g.ops.at(-1).selfLink } : {}) };
    const row = { ...launchRow({ alloc, repo: SBX, cpus: 4, at: sent - 25_000, config: COMMIT, reserved: 4 }), refused: [{ kind: 'capacity', zone: 'us-central1-a' }], slow: [insert] };
    w.gh.comments.push({ id: 9200, issue: 1, body: renderRow(row), updated_at: new Date(w.now()).toISOString() });
    await w.github.jitConfig(SBX, { name, labels: L(4), work_folder: 'x' });
    await launcher.tick();
    assert.deepEqual([rowOf(w, name).state, rowOf(w, name).slow[0].done], ['launching', undefined], `still pending (${byLink ? 'by link' : 'by send time'})`);
    assert.ok(w.sim.runner(SBX, name), 'its runner stays');
    Object.assign(w.g.ops.at(-1), { status: 'DONE', endTime: new Date(w.now()).toISOString() });
    w.advance(MIN);
    await launcher.tick();
    assert.deepEqual([rowOf(w, name).state, rowOf(w, name).slow[0].outcome], ['launching', 'created'], 'its own operation settles it');
  }
});
