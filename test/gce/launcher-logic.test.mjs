// The GCE launcher's decisions (gce/launcher/logic.mjs, spec §3a The launcher, M10 Decisions): demand per (repo,
// label set) where a busy instance covers nothing, admission under max_vcpus, the order of zone, spot and on-demand
// attempts, each cleanup predicate, and the one-file-per-repo rule. Instances and runners are recorded API shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GceError } from '../../lib/gce.mjs';
import {
  allocationId, allocationTime, instanceName, allocOf, repoLabel, runnerLabels, jobCpus, viewInstance, planLaunches,
  placements, insertOutcome, walkPlacements, reviewInstances, reviewRows, orphanRunners, orphanDisks, newestReadyImage,
  jobInstance, reportable,
} from '../../gce/launcher/logic.mjs';
import { parseGceConfig, servedRepos } from '../../gce/launcher/config.mjs';
import { ONE_REGION_CFG } from './config-fixtures.mjs';

const CFG = ONE_REGION_CFG;
const MACHINES = CFG.placements[0].machines;
const SBX = 'SSFSKIM/ci-kit-sandbox';
const MAWS = 'SSFSKIM/MAWS';
const T0 = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60_000;
const L = (n) => ['self-hosted', 'ci-kit-pool', `cpus-${n}`];

// As the aggregated instances list returns one (recorded 2026-10-16; fields the launcher reads).
const ZONE = 'https://www.googleapis.com/compute/v1/projects/ssfskim-ci-kit/zones/us-central1-a';
function instance({ alloc, repo = SBX, cpus = 4, status = 'RUNNING', age = 2 * MIN, machine = 'c3d-highcpu-4', labels = {} }) {
  return {
    kind: 'compute#instance', name: instanceName(alloc), status, zone: ZONE,
    machineType: `${ZONE}/machineTypes/${machine}`,
    creationTimestamp: new Date(T0 - age).toISOString(),
    labels: { 'ci-kit': 'gce', 'ci-kit-alloc': alloc, 'ci-kit-repo': repoLabel(repo), 'ci-kit-cpus': String(cpus), 'ci-kit-provisioning': 'spot', ...labels },
  };
}
// As GET /repos/{repo}/actions/runners lists one.
const runner = (name, { busy = false, status = 'online' } = {}) => ({ id: name.length * 7, name, os: 'Linux', status, busy, labels: [] });
const job = (id, labels, at = T0 - MIN) => ({ id, repo: SBX, status: 'queued', labels, created_at: new Date(at).toISOString(), runner_name: null });
const A = (n) => `000000${n}abc`.slice(-10); // a fixed allocation id

test('allocation ids are 10 lowercase base36 characters: the launch minute and 5 random, read back no earlier than the launch', () => {
  const id = allocationId(T0 + 30_000, () => 12345);
  assert.match(id, /^[0-9a-z]{10}$/);
  // The id's time is the end of its minute: an age read from it is never more than the real age.
  assert.equal(allocationTime(id), T0 + MIN);
  assert.notEqual(allocationId(T0, () => 1), allocationId(T0, () => 2));
  assert.equal(instanceName(id), `ci-kit-gce-${id}`);
  assert.equal(allocOf(`ci-kit-gce-${id}`), id);
  assert.equal(allocOf('ci-kit-gce-builder-20261016-100502'), null, 'a builder is never an allocation');
  assert.equal(allocOf('ci-kit-pool-170733794-3'), null);
});

test('the repo label is owner--name, lowercased, within GCE\'s label alphabet', () => {
  assert.equal(repoLabel(SBX), 'ssfskim--ci-kit-sandbox');
  assert.equal(repoLabel('SSFSKIM/a.b'), 'ssfskim--a_b');
});

test('a job is served only with exactly one known cpus-N and labels its runner will carry', () => {
  assert.deepEqual(runnerLabels(8), ['self-hosted', 'ci-kit-pool', 'cpus-8', 'ci-kit-gce']);
  assert.equal(jobCpus(L(8), MACHINES), 8);
  assert.equal(jobCpus([...L(2), 'ci-kit-gce'], MACHINES), 2);
  assert.equal(jobCpus(['Self-Hosted', 'ci-kit-pool', 'cpus-4'], MACHINES), 4, 'GitHub matches labels case-insensitively');
  assert.equal(jobCpus(['self-hosted', 'ci-kit-pool'], MACHINES), null);
  assert.equal(jobCpus([...L(4), 'cpus-8'], MACHINES), null);
  assert.equal(jobCpus(L(3), MACHINES), null);
  assert.equal(jobCpus([...L(4), 'gpu'], MACHINES), null, 'a label the runner lacks would never match it');
  assert.equal(jobCpus(['self-hosted', 'cpus-4'], MACHINES), null);
});

test('viewInstance reads the fields the launcher decides on', () => {
  const v = viewInstance(instance({ alloc: A(1), machine: 'e2-highcpu-2', cpus: 2 }));
  assert.deepEqual({ ...v, raw: undefined }, {
    name: `ci-kit-gce-${A(1)}`, alloc: A(1), zone: 'us-central1-a', machine: 'e2-highcpu-2', vcpus: 2, status: 'RUNNING',
    created: T0 - 2 * MIN, repoLabel: 'ssfskim--ci-kit-sandbox', cpus: 2, provisioning: 'spot', config: null, diskType: null, raw: undefined,
  });
});

// Demand and admission.
const plan = ({ queued, instances = [], runners = new Map([[SBX, new Map()]]), cfg = CFG }) =>
  planLaunches({ queued, instances: instances.map(viewInstance), runners, now: T0, cfg });

test('demand is one launch per queued job, oldest first', () => {
  const p = plan({ queued: [job(2, L(8), T0 - MIN), job(1, L(4), T0 - 2 * MIN)] });
  assert.deepEqual(p.launches.map((l) => [l.job.id, l.repo, l.cpus]), [[1, SBX, 4], [2, SBX, 8]]);
});

test('an unclaimed instance (runner registered, not busy, younger than the idle limit) covers one job of its key', () => {
  const instances = [instance({ alloc: A(1), cpus: 4 })];
  const runners = new Map([[SBX, new Map([[instanceName(A(1)), runner(instanceName(A(1)))]])]]);
  const p = plan({ queued: [job(1, L(4)), job(2, L(4)), job(3, L(8))], instances, runners });
  assert.deepEqual(p.launches.map((l) => l.job.id), [2, 3], 'one cpus-4 job is covered; cpus-8 is another key');
});

test('a busy instance covers nothing, nor does one past the idle limit, one whose runner is gone, or a stopped one', () => {
  const names = [1, 2, 3, 4].map((n) => instanceName(A(n)));
  const instances = [
    instance({ alloc: A(1) }),
    instance({ alloc: A(2), age: 10 * MIN }),
    instance({ alloc: A(3) }),
    instance({ alloc: A(4), status: 'TERMINATED' }),
  ];
  const runners = new Map([[SBX, new Map([[names[0], runner(names[0], { busy: true })], [names[1], runner(names[1])], [names[3], runner(names[3])]])]]);
  const p = plan({ queued: [job(1, L(4)), job(2, L(4))], instances, runners });
  assert.deepEqual(p.launches.map((l) => l.job.id), [1, 2]);
});

test('a repo whose runner listing failed gets no launches: unknown coverage is never read as demand', () => {
  const p = plan({ queued: [job(1, L(4))], runners: new Map() });
  assert.deepEqual(p.launches, []);
});

test('admission keeps the vCPUs in flight at or under max_vcpus, first in first out: a job that does not fit holds the line', () => {
  const cfg = { ...CFG, max_vcpus: 16 };
  const instances = [instance({ alloc: A(1), cpus: 4, machine: 'c3d-highcpu-4' }), instance({ alloc: A(2), cpus: 2, machine: 'e2-highcpu-2', status: 'TERMINATED' })];
  const runners = new Map([[SBX, new Map([[instanceName(A(1)), runner(instanceName(A(1)), { busy: true })]])]]);
  // 4 in flight (the stopped VM counts nothing); then 8 fits (12), 8 does not (20), and the later 2 waits behind it.
  const p = plan({ queued: [job(1, L(8), T0 - 3 * MIN), job(2, L(8), T0 - 2 * MIN), job(3, L(2), T0 - MIN)], instances, runners, cfg });
  assert.deepEqual(p.launches.map((l) => l.job.id), [1]);
  assert.deepEqual(p.waiting.map((j) => j.id), [2, 3]);
});

test('a job with no servable labels is passed over and reported, not launched', () => {
  const p = plan({ queued: [job(1, ['self-hosted', 'ci-kit-pool']), job(2, L(4))] });
  assert.deepEqual(p.launches.map((l) => l.job.id), [2]);
  assert.deepEqual(p.unservable.map((j) => j.id), [1]);
});

// Placement order.
test('placements: the machine in every zone as spot, then its fallback as spot, then both on demand', () => {
  const two = placements(2, CFG).map((p) => `${p.machine}/${p.provisioning}@${p.zone.slice(-1)}`);
  assert.deepEqual(two, [
    'e2-highcpu-2/spot@a', 'e2-highcpu-2/spot@b', 'e2-highcpu-2/spot@c', 'e2-highcpu-2/spot@f',
    'c3d-highcpu-4/spot@a', 'c3d-highcpu-4/spot@b', 'c3d-highcpu-4/spot@c', 'c3d-highcpu-4/spot@f',
    'e2-highcpu-2/standard@a', 'e2-highcpu-2/standard@b', 'e2-highcpu-2/standard@c', 'e2-highcpu-2/standard@f',
    'c3d-highcpu-4/standard@a', 'c3d-highcpu-4/standard@b', 'c3d-highcpu-4/standard@c', 'c3d-highcpu-4/standard@f',
  ]);
  assert.equal(placements(8, CFG).length, 8);
});

const opError = (codes) => new GceError(200, 'op failed', codes, { accepted: true, finished: true });
test('insert outcomes: capacity and quota are definite refusals; a finished error or an outright 4xx is a failure; anything else is unknown', () => {
  assert.equal(insertOutcome(opError(['ZONE_RESOURCE_POOL_EXHAUSTED'])), 'capacity');
  assert.equal(insertOutcome(opError(['ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS'])), 'capacity');
  assert.equal(insertOutcome(new GceError(403, 'quota', ['quotaExceeded'])), 'quota');
  assert.equal(insertOutcome(opError(['QUOTA_EXCEEDED'])), 'quota');
  assert.equal(insertOutcome(opError(['RESOURCE_NOT_FOUND'])), 'failed');
  assert.equal(insertOutcome(new GceError(400, 'invalid', ['invalid'])), 'failed');
  assert.equal(insertOutcome(new GceError(0, 'pending', [], { accepted: true })), 'unknown');
  assert.equal(insertOutcome(new GceError(503, 'wait call failed', [], { accepted: true })), 'unknown');
  assert.equal(insertOutcome(new GceError(503, 'backend error')), 'unknown');
  assert.equal(insertOutcome(new Error('The operation was aborted due to timeout')), 'unknown');
});

async function walk(cpus, script, reconcile = async () => 'unknown') {
  const tried = [];
  const result = await walkPlacements(placements(cpus, CFG), {
    attempt: async (p) => {
      const key = `${p.machine}/${p.provisioning}@${p.zone.slice(-1)}`;
      tried.push(key);
      const err = script[key];
      if (err) throw err;
    },
    reconcile: async (p, err) => reconcile(`${p.machine}/${p.provisioning}@${p.zone.slice(-1)}`, err),
  });
  return { tried, result };
}
const cap = () => opError(['ZONE_RESOURCE_POOL_EXHAUSTED']);

test('capacity moves to the next zone, and after every zone refused spot the same machine goes on demand', async () => {
  const script = Object.fromEntries(['a', 'b', 'c', 'f'].map((z) => [`c3d-highcpu-8/spot@${z}`, cap()]));
  const { tried, result } = await walk(8, script);
  assert.deepEqual(tried, ['c3d-highcpu-8/spot@a', 'c3d-highcpu-8/spot@b', 'c3d-highcpu-8/spot@c', 'c3d-highcpu-8/spot@f', 'c3d-highcpu-8/standard@a']);
  assert.deepEqual(result.placement, { machine: 'c3d-highcpu-8', provisioning: 'standard', zone: 'us-central1-a', placement: CFG.placements[0] });
});

test('a quota refusal skips the machine\'s family in its region and moves to the fallback\'s; with none left the walk is exhausted', async () => {
  const quota = () => new GceError(403, 'quota', ['quotaExceeded']);
  const { tried, result } = await walk(2, { 'e2-highcpu-2/spot@a': quota(), 'c3d-highcpu-4/spot@a': quota() });
  assert.deepEqual(tried, ['e2-highcpu-2/spot@a', 'c3d-highcpu-4/spot@a']);
  assert.equal(result.placement, null);
  assert.equal(result.stop, 'exhausted');
  assert.equal(result.quota, true);
});

test('an insert with an unknown outcome is reconciled through its operation before any other zone is tried', async () => {
  const seen = [];
  const lost = new GceError(0, 'pending', [], { accepted: true });
  // Reconciled as created: the walk ends there.
  let r = await walk(4, { 'c3d-highcpu-4/spot@a': lost }, async (key, err) => { seen.push([key, err]); return 'created'; });
  assert.deepEqual(r.tried, ['c3d-highcpu-4/spot@a']);
  assert.equal(r.result.placement.zone, 'us-central1-a');
  assert.deepEqual(seen, [['c3d-highcpu-4/spot@a', lost]]);
  // Reconciled as a capacity refusal: only then is the next zone tried.
  r = await walk(4, { 'c3d-highcpu-4/spot@a': lost }, async () => 'capacity');
  assert.deepEqual(r.tried, ['c3d-highcpu-4/spot@a', 'c3d-highcpu-4/spot@b']);
  // Still unknown: the walk stops; no second zone, so never two instances for one allocation.
  r = await walk(4, { 'c3d-highcpu-4/spot@a': lost }, async () => 'unknown');
  assert.deepEqual(r.tried, ['c3d-highcpu-4/spot@a']);
  assert.equal(r.result.stop, 'unknown');
});

test('any other failure stops the walk as a failure', async () => {
  const { tried, result } = await walk(4, { 'c3d-highcpu-4/spot@a': new GceError(400, 'bad', ['invalid']) });
  assert.deepEqual(tried, ['c3d-highcpu-4/spot@a']);
  assert.equal(result.stop, 'failed');
});

// The job VM's request body.
test('a job VM: spot with a DELETE run limit, no service account, the JIT config in metadata, I12 labels, the kit subnetwork', () => {
  const body = jobInstance({
    alloc: A(1), zone: 'us-central1-b', machine: 'c3d-highcpu-8', provisioning: 'spot', repo: SBX, cpus: 8,
    image: 'projects/ssfskim-ci-kit/global/images/ci-kit-runner-x', jit: 'JITCONFIG', placement: CFG.placements[0], cfg: CFG, config: 'abcdef0123456789',
  });
  assert.equal(body.name, `ci-kit-gce-${A(1)}`);
  assert.equal(body.machineType, 'zones/us-central1-b/machineTypes/c3d-highcpu-8');
  assert.deepEqual(body.labels, {
    'ci-kit': 'gce', 'ci-kit-alloc': A(1), 'ci-kit-repo': 'ssfskim--ci-kit-sandbox', 'ci-kit-cpus': '8',
    'ci-kit-provisioning': 'spot', 'ci-kit-config': 'abcdef01', 'ci-kit-disk': 'pd-balanced',
  });
  assert.deepEqual(body.serviceAccounts, []);
  assert.deepEqual(body.scheduling, {
    provisioningModel: 'SPOT', instanceTerminationAction: 'DELETE', maxRunDuration: { seconds: '7200' }, automaticRestart: false, onHostMaintenance: 'TERMINATE',
  });
  const disk = body.disks[0];
  assert.equal(disk.autoDelete, true);
  assert.deepEqual(disk.initializeParams.labels, { 'ci-kit': 'gce', 'ci-kit-alloc': A(1) });
  assert.equal(disk.initializeParams.diskSizeGb, '50');
  assert.equal(disk.initializeParams.sourceImage, 'projects/ssfskim-ci-kit/global/images/ci-kit-runner-x');
  assert.deepEqual(body.metadata.items, [{ key: 'enable-guest-attributes', value: 'TRUE' }, { key: 'ci-kit-jit', value: 'JITCONFIG' }]);
  assert.equal(body.networkInterfaces[0].subnetwork, 'regions/us-central1/subnetworks/ci-kit-us-central1');
  const std = jobInstance({ alloc: A(1), zone: 'us-central1-b', machine: 'c3d-highcpu-8', provisioning: 'standard', placement: CFG.placements[0], repo: SBX, cpus: 8, image: 'i', jit: 'j', cfg: CFG, config: 'bundled' });
  assert.equal(std.scheduling.provisioningModel, 'STANDARD');
  assert.equal(std.scheduling.instanceTerminationAction, 'DELETE');
  assert.equal(std.labels['ci-kit-provisioning'], 'standard');
  assert.equal(std.labels['ci-kit-config'], 'bundled');
});

test('the newest image labelled ready is chosen from a list; unready, foreign and other-family images never are', () => {
  const img = (name, at, labels, family = 'ci-kit-runner') => ({ name, family, status: 'READY', creationTimestamp: at, labels, selfLink: `https://x/global/images/${name}` });
  const images = [
    img('old', '2026-10-15T00:00:00Z', { 'ci-kit': 'gce-image', 'ci-kit-ready': 'true' }),
    img('newest-unready', '2026-10-16T12:00:00Z', { 'ci-kit': 'gce-image', 'ci-kit-ready': 'false' }),
    img('ready', '2026-10-16T11:00:00Z', { 'ci-kit': 'gce-image', 'ci-kit-ready': 'true' }),
    img('foreign', '2026-10-16T13:00:00Z', { 'ci-kit-ready': 'true' }),
    img('other', '2026-10-16T13:00:00Z', { 'ci-kit': 'gce-image', 'ci-kit-ready': 'true' }, 'other'),
  ];
  assert.equal(newestReadyImage(images, 'ci-kit-runner').name, 'ready');
  assert.equal(newestReadyImage([], 'ci-kit-runner'), null);
});

// Cleanup predicates.
const review = ({ instances, runners, served = new Set(['ssfskim--ci-kit-sandbox']), cfg = CFG }) =>
  reviewInstances({ instances: instances.map(viewInstance), runnersOf: (v) => runners.get(v.repoLabel), served, now: T0, cfg })
    .map((a) => [a.instance.alloc, a.action, a.end ?? null]);

test('a stopped VM is deleted; its runner, if still registered, is unregistered on the way', () => {
  const name = instanceName(A(1));
  assert.deepEqual(review({ instances: [instance({ alloc: A(1), status: 'TERMINATED' })], runners: new Map([['ssfskim--ci-kit-sandbox', new Map([[name, runner(name, { status: 'offline' })]])]]) }),
    [[A(1), 'delete', 'done']]);
});

test('an idle runner (registered, not busy, past the idle limit) is unregistered before its VM is deleted; younger or busy is left', () => {
  const n = (k) => instanceName(A(k));
  const runners = new Map([['ssfskim--ci-kit-sandbox', new Map([[n(1), runner(n(1))], [n(2), runner(n(2))], [n(3), runner(n(3), { busy: true })]])]]);
  const out = review({ instances: [instance({ alloc: A(1), age: 10 * MIN }), instance({ alloc: A(2), age: 9 * MIN }), instance({ alloc: A(3), age: 60 * MIN })], runners });
  assert.deepEqual(out, [[A(1), 'unregister-delete', 'cancelled-idle']]);
});

test('a failed runner listing is never read as idleness', () => {
  assert.deepEqual(review({ instances: [instance({ alloc: A(1), age: 30 * MIN })], runners: new Map() }), []);
});

test('a VM whose runner is gone (its job ended) but which is still up after the idle limit is deleted', () => {
  const runners = new Map([['ssfskim--ci-kit-sandbox', new Map()]]);
  assert.deepEqual(review({ instances: [instance({ alloc: A(1), age: 10 * MIN }), instance({ alloc: A(2), age: 3 * MIN })], runners }), [[A(1), 'delete', 'done']]);
});

test('an unserved repo\'s idle runner goes at once (draining); its busy runner finishes its job', () => {
  const n = (k) => instanceName(A(k));
  const runners = new Map([['ssfskim--ci-kit-sandbox', new Map([[n(1), runner(n(1))], [n(2), runner(n(2), { busy: true })]])]]);
  const out = review({ instances: [instance({ alloc: A(1), age: MIN }), instance({ alloc: A(2), age: 30 * MIN })], runners, served: new Set() });
  assert.deepEqual(out, [[A(1), 'unregister-delete', 'cancelled-idle']]);
});

test('overage: a VM older than max_run_minutes + 5 is deleted and alerted, whatever its runner says', () => {
  const name = instanceName(A(1));
  const runners = new Map([['ssfskim--ci-kit-sandbox', new Map([[name, runner(name, { busy: true })]])]]);
  const out = reviewInstances({ instances: [viewInstance(instance({ alloc: A(1), age: 126 * MIN }))], runnersOf: () => runners.get('ssfskim--ci-kit-sandbox'), served: new Set(['ssfskim--ci-kit-sandbox']), now: T0, cfg: CFG });
  assert.deepEqual(out.map((a) => [a.action, a.end, a.alert]), [['delete', 'max-run', true]]);
  assert.deepEqual(review({ instances: [instance({ alloc: A(1), age: 124 * MIN })], runners }), []);
});

test('only ci-kit=gce instances are reviewed, whatever their name', () => {
  const foreign = { ...instance({ alloc: A(1), status: 'TERMINATED' }), labels: { 'ci-kit': 'gce-builder' } };
  const unlabelled = { ...instance({ alloc: A(2), status: 'TERMINATED' }), labels: {} };
  assert.deepEqual(review({ instances: [foreign, unlabelled], runners: new Map() }), []);
});

const row = (alloc, state, extra = {}) => ({ alloc, instance: instanceName(alloc), repo: SBX, cpus: 4, state, at: new Date(allocationTime(alloc) || T0).toISOString(), ...extra });
const allocAt = (ms, k = 0) => allocationId(ms, () => k);

test('rows: a launching row whose instance exists becomes running; a deleting row whose instance is gone is finalized with its end', () => {
  const a1 = allocAt(T0 - 2 * MIN, 1);
  const a2 = allocAt(T0 - 20 * MIN, 2);
  const out = reviewRows({
    rows: [row(a1, 'launching'), row(a2, 'deleting', { end: 'cancelled-idle' })],
    instances: [viewInstance(instance({ alloc: a1 }))], runnerKnown: () => true, runnerOf: () => null, preempted: new Set(), now: T0, cfg: CFG,
  });
  assert.deepEqual(out.map((a) => [a.row.alloc, a.action, a.end ?? null]), [[a1, 'running', null], [a2, 'final', 'cancelled-idle']]);
});

test('rows: a running row whose VM vanished is preempted when GCE recorded a preemption, max-run past the run limit, else orphan', () => {
  const a1 = allocAt(T0 - 5 * MIN, 1);
  const a2 = allocAt(T0 - 121 * MIN, 2);
  const a3 = allocAt(T0 - 30 * MIN, 3);
  const out = reviewRows({
    rows: [row(a1, 'running'), row(a2, 'running'), row(a3, 'running')],
    instances: [], runnerKnown: () => true, runnerOf: () => null, preempted: new Set([instanceName(a1)]), now: T0, cfg: CFG,
  });
  assert.deepEqual(out.map((a) => [a.row.alloc, a.action, a.end]), [[a1, 'final', 'preempted'], [a2, 'final', 'max-run'], [a3, 'final', 'orphan']]);
});

test('rows: a launching row with no instance and no runner after 10 min is abandoned; with a runner, or younger, or unreadable, it waits', () => {
  const old = allocAt(T0 - 11 * MIN, 1);
  const young = allocAt(T0 - 9 * MIN, 2);
  const withRunner = allocAt(T0 - 11 * MIN, 3);
  const unread = allocAt(T0 - 11 * MIN, 4);
  const out = reviewRows({
    rows: [row(old, 'launching'), row(young, 'launching'), row(withRunner, 'launching'), row(unread, 'launching', { repo: MAWS })],
    instances: [], runnerKnown: (r) => r.repo === SBX, runnerOf: (r) => (r.alloc === withRunner ? runner(r.instance) : null),
    preempted: new Set(), now: T0, cfg: CFG,
  });
  assert.deepEqual(out.map((a) => [a.row.alloc, a.action, a.end]), [[old, 'final', 'abandoned']]);
});

test('rows: a final row is never revisited', () => {
  const a = allocAt(T0 - 30 * MIN, 1);
  assert.deepEqual(reviewRows({ rows: [row(a, 'final', { end: 'done' })], instances: [], runnerKnown: () => true, runnerOf: () => null, preempted: new Set(), now: T0, cfg: CFG }), []);
});

test('a ci-kit-gce runner with no instance, older than 5 min and not busy, is unregistered; younger, busy or foreign is left', () => {
  const old = instanceName(allocAt(T0 - 6 * MIN, 1));
  const young = instanceName(allocAt(T0 - 4 * MIN, 2));
  const busy = instanceName(allocAt(T0 - 6 * MIN, 3));
  const hasVm = instanceName(allocAt(T0 - 6 * MIN, 4));
  const runners = [runner(old, { status: 'offline' }), runner(young), runner(busy, { busy: true }), runner(hasVm), runner('ci-kit-pool-170733794-3'), runner('ci-kit-mac-mini')];
  assert.deepEqual(orphanRunners({ runners, instanceNames: new Set([hasVm]), now: T0 }).map((r) => r.name), [old]);
});

test('a ci-kit=gce disk with no user, older than 10 min, is an orphan; in use, younger or foreign is not', () => {
  const disk = (name, { users, age = 11 * MIN, labels = { 'ci-kit': 'gce' } } = {}) => ({ name, zone: ZONE, users, labels, creationTimestamp: new Date(T0 - age).toISOString() });
  const disks = [disk('a'), disk('b', { users: ['x'] }), disk('c', { age: 9 * MIN }), disk('d', { labels: {} }), disk('e', { labels: { 'ci-kit': 'gce-builder' } })];
  assert.deepEqual(orphanDisks(disks, T0).map((d) => d.name), ['a']);
});

// One file per repo.
test('a repo listed in both gce.json and pool.json is served by neither (by the launcher) and reported', () => {
  const r = servedRepos([{ repo: SBX }, { repo: MAWS }], ['ssfskim/maws']);
  assert.deepEqual(r.served, [SBX]);
  assert.deepEqual(r.both, [MAWS]);
});

test('the kit\'s own pool.json and gce.json list no repo twice', () => {
  const pool = JSON.parse(readFileSync(new URL('../../pool/config/pool.json', import.meta.url), 'utf8')).repos.map((r) => r.repo);
  const shipped = parseGceConfig(readFileSync(new URL('../../pool/config/gce.json', import.meta.url), 'utf8'));
  const gce = shipped.repos.map((r) => r.repo);
  assert.deepEqual(servedRepos(shipped.repos, pool).both, [], `in both files: ${gce.filter((g) => pool.some((p) => p.toLowerCase() === g.toLowerCase()))}`);
});

test('the GCE config is validated: unknown keys and missing fields are refused, naming them', () => {
  assert.throws(() => parseGceConfig(JSON.stringify({ ...CFG, extra: 1 })), /unknown key "extra"/);
  assert.throws(() => parseGceConfig(JSON.stringify({ ...CFG, zones: [] })), /zones/);
  assert.throws(() => parseGceConfig(JSON.stringify({ ...CFG, repos: [{ repo: 'nope' }] })), /repos\[0\]/);
  assert.throws(() => parseGceConfig(JSON.stringify({ ...CFG, machines: { 3: 'x' } })), /machines/);
  assert.throws(() => parseGceConfig('{'), /not JSON/);
});

// Fix wave 1 (high-rung review): regressions.
test('review 8: the random part is 5 base36 characters taken from the source, all of its range used', () => {
  assert.equal(allocationId(T0, () => 0).slice(5), '00000');
  assert.equal(allocationId(T0, () => 36 ** 5 - 1).slice(5), 'zzzzz');
  assert.equal(allocationId(T0, () => 36 ** 5).slice(5), '00000', 'the source is taken modulo 36^5');
  assert.equal(allocationId(T0, () => 46_656).slice(5), '01000');
  assert.equal(allocationId(T0, () => 1).slice(0, 5), allocationId(T0 + 59_999, () => 1).slice(0, 5), 'one minute, one prefix');
});

test('fix wave 2: a VM deleted at its run limit is max-run by its recorded creation time, though its id rounds up', () => {
  // Created 12:00:05 in the minute 12:00 (its id reads 12:01), deleted at 14:00:05, seen gone at 14:00:10.
  const created = Date.parse('2026-10-16T12:00:05Z');
  const alloc = allocationId(created, () => 9);
  const seen = created + 120 * MIN + 5_000;
  const out = reviewRows({
    rows: [row(alloc, 'running', { created: new Date(created).toISOString() })],
    instances: [], runnerKnown: () => true, runnerOf: () => null, preempted: new Set(), now: seen, cfg: CFG,
  });
  assert.deepEqual(out.map((a) => a.end), ['max-run']);
});

test('review 1: admission reserves the largest machine the walk could land on (an e2-2 may become a c3d-4)', () => {
  const cfg = { ...CFG, max_vcpus: 64 };
  // 62 vCPUs in flight: a cpus-2 job fits on e2-highcpu-2 (64) but not on its fallback c3d-highcpu-4 (66).
  const instances = Array.from({ length: 31 }, (_, k) => instance({ alloc: A(k + 10), cpus: 2, machine: 'e2-highcpu-2' }))
    .map((i) => ({ ...i, name: `ci-kit-gce-${i.labels['ci-kit-alloc']}` }));
  const p = plan({ queued: [job(1, L(2))], instances, cfg });
  assert.deepEqual(p.launches, []);
  assert.deepEqual(p.waiting.map((j) => j.id), [1]);
  assert.equal(plan({ queued: [job(1, L(2))], instances: instances.slice(1), cfg }).launches.length, 1, '60 in flight + 4 fits');
});

test('review 5: the walk makes no new attempt once the tick\'s budget is spent', async () => {
  let clock = 0;
  const tried = [];
  const result = await walkPlacements(placements(8, CFG), {
    attempt: async (p) => {
      tried.push(p.zone);
      clock += 20_000;
      throw opError(['ZONE_RESOURCE_POOL_EXHAUSTED']);
    },
    reconcile: async () => 'unknown',
    now: () => clock,
    deadline: 45_000,
  });
  assert.deepEqual(tried, ['us-central1-a', 'us-central1-b', 'us-central1-c']);
  assert.equal(result.placement, null);
  assert.equal(result.stop, 'deadline');
});

test('review 7: with the preemption history unavailable, a vanished row is left for a later tick, not called orphan', () => {
  const a1 = allocAt(T0 - 5 * MIN, 1);
  const a2 = allocAt(T0 - 20 * MIN, 2);
  const out = reviewRows({
    rows: [row(a1, 'running'), row(a2, 'deleting', { end: 'done' })],
    instances: [], runnerKnown: () => true, runnerOf: () => null, preempted: null, now: T0, cfg: CFG,
  });
  assert.deepEqual(out.map((a) => [a.row.alloc, a.end]), [[a2, 'done']], 'a deleting row needs no history');
});

test('review 3: an incomplete instance listing launches nothing and finalizes nothing by absence', () => {
  const p = planLaunches({ queued: [job(1, L(4))], instances: [], runners: new Map([[SBX, new Map()]]), now: T0, cfg: CFG, complete: false });
  assert.deepEqual(p.launches, []);
  const a = allocAt(T0 - 30 * MIN, 1);
  assert.deepEqual(reviewRows({ rows: [row(a, 'running')], instances: [], complete: false, runnerKnown: () => true, runnerOf: () => null, preempted: new Set(), now: T0, cfg: CFG }), []);
  const old = instanceName(allocAt(T0 - 6 * MIN, 1));
  assert.deepEqual(orphanRunners({ runners: [runner(old)], instanceNames: new Set(), now: T0, complete: false }), []);
});

// Step 4 (A13 teardown): a VM whose job unit reported is deleted at once, not after the guest's power-off.
test('a VM that reported its job\'s end (ci-kit/job) is deleted on that tick, before it powers off; unreported, it waits', () => {
  const n = (k) => instanceName(A(k));
  const runners = new Map([['ssfskim--ci-kit-sandbox', new Map([[n(3), runner(n(3), { status: 'offline' })], [n(4), runner(n(4), { busy: true })]])]]);
  const reports = new Map([[n(1), 'exit:0'], [n(2), 'failed:unit'], [n(3), 'exit:1'], [n(4), 'exit:0']]);
  const out = reviewInstances({
    instances: [instance({ alloc: A(1), age: MIN }), instance({ alloc: A(2), age: MIN, status: 'STOPPING' }), instance({ alloc: A(3), age: MIN }), instance({ alloc: A(4), age: MIN }), instance({ alloc: A(5), age: MIN })].map(viewInstance),
    runnersOf: () => runners.get('ssfskim--ci-kit-sandbox'), reports, served: new Set(['ssfskim--ci-kit-sandbox']), now: T0, cfg: CFG,
  }).map((a) => [a.instance.alloc, a.action, a.end, a.reason, Boolean(a.unregister)]);
  assert.deepEqual(out, [
    [A(1), 'delete', 'done', 'job-exited', false],
    [A(2), 'delete', 'done', 'job-exited', false],
    // A runner still registered is unregistered first, and a refusal (it took a job) keeps the VM.
    [A(3), 'unregister-delete', 'done', 'job-exited', false],
  ], 'a busy runner\'s VM is left alone whatever it reports; no report, no early delete');
});

test('reportable: only a VM whose runner listing is known and whose runner is not busy is worth reading', () => {
  const n = (k) => instanceName(A(k));
  const runners = new Map([[n(2), runner(n(2), { busy: true })], [n(3), runner(n(3))]]);
  const views = [instance({ alloc: A(1) }), instance({ alloc: A(2) }), instance({ alloc: A(3) }), instance({ alloc: A(4), status: 'TERMINATED' })].map(viewInstance);
  assert.deepEqual(reportable(views, () => runners).map((v) => v.alloc), [A(1), A(3)]);
  assert.deepEqual(reportable(views, () => undefined), []);
});
