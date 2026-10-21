// The pool's start latency (gce/latency-report.mjs, spec M3 Timing in the ledger): the stages of a job's wait for its
// VM, read from ledger rows and the launcher's tick log lines, as the medians of the table in the spec's Purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stages, ticksOf, renderReport } from '../../gce/latency-report.mjs';

const t = (hms) => Date.parse(`2026-10-21T${hms}Z`);
const iso = (hms) => new Date(t(hms)).toISOString();

// Two ticks; the second launched two VMs. A row as the launcher writes it from M3 on.
const ticks = [
  { start: t('10:17:30'), end: t('10:17:45'), firstInsert: null },
  { start: t('10:18:08'), end: t('10:18:30'), firstInsert: t('10:18:11') },
];
const row = (alloc, { at, created, running, queued, started, cpus = 4 }) => ({
  alloc, instance: `ci-kit-gce-${alloc}`, repo: 'SSFSKIM/MAWS', cpus, at: iso(at), created: iso(created), state: 'final',
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
