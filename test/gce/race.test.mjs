// The race of a slow insert and the walk's counts (spec 2026-10-21 M6, steps 3 and 5), in their pure parts: which
// attempts a race walks, the walk halting once its allocation raced, what a row keeps of its walk, an unresolved
// launching row as cover and as vCPUs in flight, a race VM as cover, and the counts on the daily line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GceError } from '../../lib/gce.mjs';
import {
  placements, raceAttempts, walkPlacements, walkRecord, unsettledInsert, planLaunches, viewInstance, instanceName, repoLabel,
  RACE_AFTER_MS,
} from '../../gce/launcher/logic.mjs';
import { launchRow, runningRow, finalRow, launchCounts, dailyLine, renderDaily } from '../../gce/launcher/ledger.mjs';
import { NEW_CFG } from './config-fixtures.mjs';

const SBX = 'SSFSKIM/ci-kit-sandbox';
const T0 = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60_000;
const L = (n) => ['self-hosted', 'ci-kit-pool', `cpus-${n}`];
const key = (p) => `${p.machine}/${p.provisioning}@${p.zone}`;
const at = (list, zone, provisioning = 'spot') => list.find((p) => p.zone === zone && p.provisioning === provisioning);

test('the race walks the attempts after the pending one in other zones, another region first, spot before on demand', () => {
  const list = placements(4, NEW_CFG);
  assert.deepEqual(raceAttempts(list, at(list, 'us-west4-a')).map(key), [
    'c3d-highcpu-4/spot@us-central1-a', 'c3d-highcpu-4/spot@us-central1-b', 'c3d-highcpu-4/spot@us-central1-c', 'c3d-highcpu-4/spot@us-central1-f',
    'c4d-highcpu-4/spot@us-west4-b', 'c4d-highcpu-4/spot@us-west4-c',
    'c3d-highcpu-4/standard@us-central1-a', 'c3d-highcpu-4/standard@us-central1-b', 'c3d-highcpu-4/standard@us-central1-c', 'c3d-highcpu-4/standard@us-central1-f',
    'c4d-highcpu-4/standard@us-west4-b', 'c4d-highcpu-4/standard@us-west4-c',
  ]);
  // Pending in the last placement's spot: its region's other spot zones still come before any on-demand attempt.
  assert.deepEqual(raceAttempts(list, at(list, 'us-central1-b')).map(key), [
    'c3d-highcpu-4/spot@us-central1-c', 'c3d-highcpu-4/spot@us-central1-f',
    'c4d-highcpu-4/standard@us-west4-a', 'c4d-highcpu-4/standard@us-west4-b', 'c4d-highcpu-4/standard@us-west4-c',
    'c3d-highcpu-4/standard@us-central1-a', 'c3d-highcpu-4/standard@us-central1-c', 'c3d-highcpu-4/standard@us-central1-f',
  ]);
  assert.deepEqual(raceAttempts(list, list.at(-1)), [], 'nothing after the last attempt');
});

test('a walk whose allocation raced makes no further attempt: a refusal after the race ends it, never another zone', async () => {
  const cap = new GceError(200, 'op', ['ZONE_RESOURCE_POOL_EXHAUSTED'], { accepted: true, finished: true });
  let raced = false;
  const tried = [];
  const result = await walkPlacements(placements(4, NEW_CFG), {
    attempt: async (p) => {
      tried.push(key(p));
      raced = true; // the race started while this insert was pending
      throw cap;
    },
    reconcile: async () => 'unknown',
    raced: () => raced,
  });
  assert.deepEqual(tried, ['c4d-highcpu-4/spot@us-west4-a']);
  assert.equal(result.stop, 'raced');
  assert.deepEqual(result.tried.map((t) => t.outcome), ['capacity']);
});

test('each attempt of a walk keeps when it was sent and how long it took to settle, and a quota refusal its metric', async () => {
  let clock = T0;
  const quota = new GceError(403, "Quota 'C4D_CPUS' exceeded.  Limit: 50.0 in region us-west4.", ['QUOTA_EXCEEDED']);
  const result = await walkPlacements(placements(4, NEW_CFG), {
    attempt: async (p) => {
      clock += p.zone === 'us-west4-a' ? 3_000 : 25_000;
      if (p.zone === 'us-west4-a') throw quota;
    },
    reconcile: async () => 'unknown',
    now: () => clock,
  });
  assert.deepEqual(result.tried.map((t) => [t.zone, t.outcome, t.sent, t.ms, t.metric]), [
    ['us-west4-a', 'quota', T0, 3_000, 'C4D_CPUS'],
    ['us-central1-a', 'created', T0 + 3_000, 25_000, undefined],
  ]);
});

test('a row keeps its walk\'s refusals and its slow inserts: unsettled past the race threshold, or never settled', () => {
  const tried = [
    { zone: 'us-west4-a', outcome: 'quota', metric: 'IN_USE_ADDRESSES', sent: T0, ms: 2_000 },
    { zone: 'us-central1-a', outcome: 'capacity', sent: T0 + 2_000, ms: 1_000 },
    { zone: 'us-central1-b', outcome: 'capacity', sent: T0 + 3_000, ms: RACE_AFTER_MS + 9_000 },
    { zone: 'us-central1-c', outcome: 'unknown', sent: T0 + 32_000, ms: 41_000 },
  ];
  assert.deepEqual(walkRecord(tried), {
    refused: [
      { kind: 'quota', zone: 'us-west4-a', metric: 'IN_USE_ADDRESSES' },
      { kind: 'capacity', zone: 'us-central1-a' },
      { kind: 'capacity', zone: 'us-central1-b' },
    ],
    slow: [
      { zone: 'us-central1-b', outcome: 'capacity', sent: new Date(T0 + 3_000).toISOString(), done: new Date(T0 + 32_000).toISOString() },
      { zone: 'us-central1-c', outcome: 'unknown', sent: new Date(T0 + 32_000).toISOString() },
    ],
  });
  assert.deepEqual(walkRecord([{ zone: 'us-west4-a', outcome: 'created', sent: T0, ms: 9_000 }]), {}, 'a clean walk adds nothing');
  const row = { state: 'launching', ...walkRecord(tried) };
  assert.equal(unsettledInsert(row).zone, 'us-central1-c');
  assert.equal(unsettledInsert({ ...row, state: 'running' }).zone, 'us-central1-c', 'its VM seen, the operation\'s end is still to learn');
  assert.equal(unsettledInsert({ ...row, state: 'final' }), null);
});

// As the aggregated listing returns a job VM, and the runners listing its runner.
const vm = (alloc, { cpus = 4, machine = 'c3d-highcpu-4', age = MIN } = {}) => viewInstance({
  name: instanceName(alloc), status: 'RUNNING', zone: 'zones/us-central1-a', machineType: `zones/us-central1-a/machineTypes/${machine}`,
  creationTimestamp: new Date(T0 - age).toISOString(), labels: { 'ci-kit': 'gce', 'ci-kit-repo': repoLabel(SBX), 'ci-kit-cpus': String(cpus) },
});
const runner = (alloc, busy = false) => [instanceName(alloc), { id: 1, name: instanceName(alloc), status: 'offline', busy }];
const job = (id, cpus = 4) => ({ id, repo: SBX, status: 'queued', labels: L(cpus), created_at: new Date(T0 - MIN).toISOString() });
// A launching row whose insert outcome stayed unknown (spec M6: an unresolved original).
const unresolved = (alloc, cpus = 4) => ({
  ...launchRow({ alloc, repo: SBX, cpus, at: T0 - 30_000, config: 'c0ffee00' }),
  slow: [{ zone: 'us-west4-a', outcome: 'unknown', sent: new Date(T0 - 29_000).toISOString() }],
});

test('a race VM is cover for its size until claimed, like any unclaimed VM; claimed, it covers nothing', () => {
  const instances = [vm('raceaaaaaa')];
  const runners = new Map([[SBX, new Map([runner('raceaaaaaa')])]]);
  const plan = (claimed) => planLaunches({ queued: [job(1)], instances, runners, now: T0, cfg: NEW_CFG, claimed });
  assert.deepEqual(plan(new Set()).launches, []);
  assert.deepEqual(plan(new Set([instanceName('raceaaaaaa')])).launches.map((l) => l.job.id), [1]);
});

test('an unresolved launching row (its insert never settled, its VM not listed) is cover while its runner waits, and keeps its vCPUs', () => {
  const rows = [unresolved('origaaaaaa')];
  const runners = new Map([[SBX, new Map([runner('origaaaaaa')])]]);
  const cfg = { ...NEW_CFG, max_vcpus: 8 };
  const p = planLaunches({ queued: [job(1), job(2), job(3)], instances: [], runners, rows, now: T0, cfg });
  assert.deepEqual(p.launches.map((l) => l.job.id), [2], 'job 1 is covered; job 3 does not fit beside the row\'s reserved 4');
  assert.equal(p.inflight, 8);
  // Its runner gone or busy, the row covers nothing, but its VM may still appear: the vCPUs stay reserved.
  const gone = planLaunches({ queued: [job(1)], instances: [], runners: new Map([[SBX, new Map()]]), rows, now: T0, cfg });
  assert.deepEqual([gone.launches.map((l) => l.job.id), gone.inflight], [[1], 8]);
  // Listed, its VM counts as itself, once; settled (its operation's end learned), the row counts for nothing; nor does
  // a running row whose VM is gone.
  const vanished = planLaunches({ queued: [job(1)], instances: [], runners, rows: [{ ...rows[0], state: 'running' }], now: T0, cfg });
  assert.deepEqual([vanished.launches.map((l) => l.job.id), vanished.inflight], [[1], 4]);
  const listed = planLaunches({ queued: [job(1)], instances: [vm('origaaaaaa')], runners, rows, now: T0, cfg });
  assert.deepEqual([listed.launches, listed.inflight], [[], 4]);
  const settled = [{ ...rows[0], slow: [{ ...rows[0].slow[0], outcome: 'capacity', done: new Date(T0).toISOString() }] }];
  const free = planLaunches({ queued: [job(1)], instances: [], runners, rows: settled, now: T0, cfg });
  assert.deepEqual([free.launches.map((l) => l.job.id), free.inflight], [[1], 4]);
});

test('a race row names its original and the demand that started it, apart from the job its VM ran', () => {
  const row = launchRow({ alloc: 'raceaaaaaa', repo: SBX, cpus: 4, at: T0, config: 'c0ffee00', race: { of: 'origaaaaaa', demand: { job: 7 } } });
  assert.deepEqual(row.race, { of: 'origaaaaaa', demand: { job: 7 } });
  const final = finalRow(runningRow(row, { zone: 'us-central1-a', machine: 'c3d-highcpu-4', provisioning: 'spot', created: T0 }), {
    end: 'done', deleted: T0 + 600_000, job: { id: 8, name: 'unit 2/4' }, diskGb: 50,
  });
  assert.deepEqual([final.race, final.job.id], [{ of: 'origaaaaaa', demand: { job: 7 } }, 8]);
});

test('counts: refusals by kind, metric and zone; slow inserts with their settle times; VMs on demand', () => {
  const s = (sec) => new Date(T0 + sec * 1000).toISOString();
  const rows = [
    { refused: [{ kind: 'quota', zone: 'us-west4-a', metric: 'C4D_CPUS' }, { kind: 'capacity', zone: 'us-central1-a' }], provisioning: 'spot' },
    { refused: [{ kind: 'quota', zone: 'us-west4-a', metric: 'C4D_CPUS' }], slow: [{ zone: 'us-central1-b', outcome: 'created', sent: s(0), done: s(63) }], provisioning: 'standard' },
    { slow: [{ zone: 'us-central1-b', outcome: 'unknown', sent: s(0) }] },
    { slow: [{ zone: 'us-central1-a', outcome: 'created', sent: s(0), done: s(41.4) }] },
  ];
  assert.deepEqual(launchCounts(rows), {
    refusals: [{ kind: 'capacity', zone: 'us-central1-a', n: 1 }, { kind: 'quota', metric: 'C4D_CPUS', zone: 'us-west4-a', n: 2 }],
    slow: { inserts: 3, unsettled: 1, seconds: [41, 63] },
    onDemand: 1,
  });
});

test('the daily line counts refusals, slow inserts, on-demand VMs and races by what was observed of each pair', () => {
  const day = '2026-10-16';
  const iso = (ms) => new Date(ms).toISOString();
  const final = (alloc, extra) => ({
    alloc, state: 'final', at: iso(T0), deleted: iso(T0 + 900_000), end: 'done', seconds: 600, dollars: 0.01, machine: 'c3d-highcpu-4',
    zone: 'us-central1-a', provisioning: 'spot', ...extra,
  });
  const ran = (id, startedSec) => ({ job: { id, name: 'unit', started: iso(T0 + startedSec * 1000) } });
  const idle = { end: 'cancelled-idle', dollars: 0.005 };
  const race = (of, demand) => ({ race: { of, demand: { job: demand } } });
  const rows = [
    // The race's VM was claimed first, and the original idled out.
    final('o1', { ...idle, slow: [{ zone: 'us-west4-a', outcome: 'created', sent: iso(T0), done: iso(T0 + 63_000) }] }),
    final('r1', { ...race('o1', 1), ...ran(1, 60) }),
    // Both claimed (the original took a later job), the original first.
    final('o2', { ...ran(2, 50) }),
    final('r2', { ...race('o2', 2), ...ran(3, 70) }),
    // Neither claimed: the race's insert was refused after it started (no VM), the original idled.
    final('o3', { ...idle, provisioning: 'standard' }),
    final('r3', { ...race('o3', 4), end: 'abandoned', seconds: null, dollars: null, refused: [{ kind: 'capacity', zone: 'us-central1-a' }] }),
    // Unresolved: the original's insert never settled and its row is not final; the race VM's idle cost is counted.
    { alloc: 'o4', state: 'launching', at: iso(T0), slow: [{ zone: 'us-west4-a', outcome: 'unknown', sent: iso(T0) }] },
    final('r4', { ...race('o4', 5), ...idle, dollars: 0.004 }),
  ];
  const line = dailyLine(rows, day, 'abcdef0123');
  assert.deepEqual(line.refusals, [{ kind: 'capacity', zone: 'us-central1-a', n: 1 }]);
  assert.deepEqual(line.slow, { inserts: 1, unsettled: 0, seconds: [63] }, 'by the rows finalized that day');
  assert.equal(line.onDemand, 1);
  assert.deepEqual(line.races, {
    started: 4, firstClaim: { race: 1, original: 1 }, bothClaimed: 1, neitherClaimed: 1, unresolved: 1, unclaimedDollars: 0.014,
  });
  const text = renderDaily(line);
  assert.match(text, / Refusals: capacity us-central1-a 1\./);
  assert.match(text, / Slow inserts: 1, settled in 63 s\./);
  assert.match(text, / Races: 4 started; claimed first: the race 1, the original 1; both claimed 1, neither 1, unresolved 1; unclaimed VMs \$0\.0140\./);
  assert.match(text, / On demand: 1 VMs\./);
  // A day with none of these reads as before.
  const quiet = dailyLine([final('q1', {})], day, 'abcdef0123');
  for (const k of ['refusals', 'slow', 'onDemand', 'races']) assert.equal(k in quiet, false, k);
  assert.doesNotMatch(renderDaily(quiet), /Refusals|Slow|Races|On demand/);
});
