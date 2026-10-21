// The pool's start latency (gce/latency-report.mjs, spec M3 Timing in the ledger): the stages of a job's wait for its
// VM, read from ledger rows and the launcher's tick log lines, as the medians of the table in the spec's Purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stages, ticksOf, renderReport, renderByMachine, renderPrelaunch, readRows } from '../../gce/latency-report.mjs';
import { renderRow } from '../../gce/launcher/ledger.mjs';

const t = (hms) => Date.parse(`2026-10-21T${hms}Z`);
const iso = (hms) => new Date(t(hms)).toISOString();

// Two ticks; the second launched two VMs. A row as the launcher writes it from M3 on.
const ticks = [
  { start: t('10:17:30'), end: t('10:17:45'), firstInsert: null },
  { start: t('10:18:08'), end: t('10:18:30'), firstInsert: t('10:18:11') },
];
const row = (alloc, { at, created, running, queued, started, cpus = 4, machine = 'c3d-highcpu-4' }) => ({
  alloc, instance: `ci-kit-gce-${alloc}`, repo: 'SSFSKIM/MAWS', cpus, machine, at: iso(at), created: iso(created), state: 'final',
  ...(running ? { running: iso(running) } : {}),
  job: { id: 1, name: 'static', run: 2, workflow: '.github/workflows/gate.yml', ...(queued ? { queued: iso(queued) } : {}), ...(started ? { started: iso(started) } : {}) },
});

test('each stage is measured from the fields that time it; a row or tick without them counts in none of its stages', () => {
  const rows = [
    row('hscp6qvnqf', { at: '10:18:12', created: '10:18:13', running: '10:18:24', queued: '10:17:58', started: '10:18:50' }),
    row('hscp6yqi0i', { at: '10:18:12', created: '10:18:14', running: '10:18:26', queued: '10:17:58', started: '10:18:58' }),
    // An older row: no RUNNING time, no job times.
    { alloc: 'hscox688lt', instance: 'ci-kit-gce-hscox688lt', repo: 'SSFSKIM/MAWS', cpus: 4, at: iso('10:17:40'), created: iso('10:17:42'), state: 'final', job: { id: 3, name: 'static' } },
  ];
  const s = stages({ rows, ticks });
  assert.deepEqual(s.queuedToTick, [10_000, 10_000], 'queued 10:17:58, the next tick began 10:18:08');
  assert.deepEqual(s.tickToInsert.sort((a, b) => a - b), [5_000, 12_000], 'per tick: its start to its first VM\'s creation');
  assert.deepEqual(s.tickToFirstInsert, [3_000], 'where the tick logged it');
  assert.deepEqual(s.insertToRunning, [11_000, 12_000]);
  assert.deepEqual(s.runningToStarted, [26_000, 32_000]);
  assert.deepEqual(s.queuedToStarted, [52_000, 60_000]);
  assert.deepEqual(s.insertToStarted, [37_000, 44_000], 'M3\'s target: each VM\'s own insert accepted → its job started');
});

test('the report prints each stage\'s median, spread and count, and says which have no samples', () => {
  const text = renderReport({
    queuedToTick: [10_000, 20_000, 30_000], tickToInsert: [5_000], tickToFirstInsert: [], insertToRunning: [], runningToStarted: [], queuedToStarted: [40_000, 50_000],
  }, { from: t('00:00:00'), to: t('23:59:59'), rows: 2, ticks: 3 });
  assert.match(text, /queued → next launcher tick +20\.0 s +10\.0–30\.0 +3/);
  assert.match(text, /tick start → insert accepted +5\.0 s/);
  assert.match(text, /insert accepted → RUNNING +- +- +0/);
  assert.match(text, /queued → started +45\.0 s/);
});

test('tick log lines: the start logged, else the end less the tick\'s duration; the first insert where logged', () => {
  const entries = [
    { timestamp: '2026-10-21T10:18:30.000Z', jsonPayload: { ms: 22_000, started: '2026-10-21T10:18:08.000Z', firstInsert: '2026-10-21T10:18:11.000Z' } },
    { timestamp: '2026-10-21T10:17:45.500Z', jsonPayload: { ms: 15_500 } },
  ];
  assert.deepEqual(ticksOf(entries), [
    { start: t('10:17:30'), end: t('10:17:45') + 500, firstInsert: null },
    { start: t('10:18:08'), end: t('10:18:30'), firstInsert: t('10:18:11') },
  ]);
});

// Review (M3, P2): insert accepted → job started is measured per VM, never as a sum of the stages' medians, and each
// machine type's numbers read on their own (the c3d-highcpu-4 median beside the C4D one).
test('the report gives each machine type\'s VM stages on their own, insert accepted → job started among them', () => {
  const rows = [
    row('a1', { at: '10:18:12', created: '10:18:13', running: '10:18:20', queued: '10:17:58', started: '10:18:40', machine: 'c3d-highcpu-4' }),
    row('a2', { at: '10:18:12', created: '10:18:14', running: '10:18:24', queued: '10:17:58', started: '10:18:50', machine: 'c3d-highcpu-4' }),
    row('b1', { at: '10:18:12', created: '10:18:15', running: '10:18:22', queued: '10:17:58', started: '10:18:35', machine: 'c4d-highcpu-4' }),
  ];
  const text = renderByMachine(rows);
  assert.match(text, /^c3d-highcpu-4 \(2 VMs\)$/m);
  assert.match(text, /^c4d-highcpu-4 \(1 VM\)$/m);
  const [c3d, c4d] = text.split(/\n(?=c4d)/);
  assert.match(c3d, /insert accepted → job started +31\.5 s +27\.0–36\.0 +2/);
  assert.match(c4d, /insert accepted → job started +20\.0 s/);
  assert.match(renderReport(stages({ rows, ticks }), { from: t('00:00:00'), to: t('23:59:59'), rows: 3, ticks: 2 }), /insert accepted → job started +27\.0 s/);
});

// M5's proof: a run's gate VMs inserted before its gates were queued, and Acceptance 5, its gates' queued → started.
test('the pre-launch lines: its VMs and how many a job claimed, each insert\'s lead on its job, and the gates\' wait by run', () => {
  const pre = (alloc, run, times, job = { run }) => {
    const r = row(alloc, times);
    return { ...r, prelaunch: { run, attempt: 1, workflow: '.github/workflows/gate.yml' }, job: job && { ...r.job, ...job } };
  };
  const rows = [
    // Run 7, pre-launched: inserts at :05 and :06, the gates queued at :19, started at :35 and :41.
    pre('p1', 7, { at: '10:00:03', created: '10:00:05', queued: '10:00:19', started: '10:00:35' }),
    pre('p2', 7, { at: '10:00:03', created: '10:00:06', queued: '10:00:19', started: '10:00:41' }),
    pre('p3', 7, { at: '10:00:03', created: '10:00:06' }, null), // unclaimed
    // Run 7's VM went to run 8's gate: claimed, but no lead on a gate of its own run.
    pre('p4', 7, { at: '10:00:03', created: '10:00:07', queued: '10:00:30', started: '10:00:50' }, { run: 8 }),
    // Run 9, not pre-launched: its gate waited 50 s.
    ((r) => ({ ...r, job: { ...r.job, run: 9 } }))(row('n1', { at: '10:10:00', created: '10:10:02', queued: '10:09:50', started: '10:10:40' })),
  ];
  const text = renderPrelaunch(rows);
  assert.match(text, /^Pre-launch: 4 VMs, 3 claimed, 1 unclaimed$/m);
  assert.match(text, /insert accepted → own job queued +13\.5 s +13\.0–14\.0 +2/);
  assert.match(text, /queued → started \(pre-launched\) +19\.0 s +16\.0–22\.0 +2/);
  assert.match(text, /queued → started \(other runs\) +35\.0 s +20\.0–50\.0 +2/);
  assert.equal(renderPrelaunch([row('n2', { at: '10:00:00', created: '10:00:01' })]), 'Pre-launch: none');
});

test('a window\'s rows include those on closed (rotated) ledger issues updated in it', async () => {
  const calls = [];
  const on = (n) => [{ id: n, body: renderRow(row(`hs000000${n}a`, { at: '10:18:12', created: '10:18:13' })) }];
  const gh = {
    openIssues: async () => { calls.push('open'); return [{ number: 9, title: 'pool ledger from 2026-10-20' }, { number: 3, title: 'other' }]; },
    closedIssuesSince: async (_repo, since) => { calls.push(`closed since ${since}`); return [{ number: 7, title: 'pool ledger' }]; },
    issueComments: async (_repo, n) => on(n),
  };
  const rows = await readRows(gh, { repo: 'SSFSKIM/ci-kit-sandbox', issue_title: 'pool ledger' }, t('00:00:00'));
  assert.deepEqual(calls, ['open', `closed since ${iso('00:00:00')}`]);
  assert.deepEqual(rows.map((r) => r.alloc).sort(), ['hs0000007a', 'hs0000009a']);
});
