// The guard's rules (spec §3 Guard) as one pure plan over recorded shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardPlan } from '../../pool/lib/guard.mjs';
import { makeRow } from '../../pool/lib/ledger.mjs';
import { FOREIGN } from './fake-hcloud.mjs';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const CFG = { max_hours_per_day: 8 };
const box = (id, { created = 30, beat = 1, state = 'ready' } = {}) => ({
  id, name: 'ci-kit-pool', created: ago(created), status: 'running',
  labels: { 'ci-kit': 'pool', 'ci-kit-state': state, ...(beat === null ? {} : { 'ci-kit-heartbeat': String(Math.floor((NOW - beat * 60_000) / 1000)) }) },
});
const queuedJob = (min) => ({ id: 1, repo: 'SSFSKIM/ci-kit-sandbox', status: 'queued', labels: ['self-hosted', 'ci-kit-pool', 'cpus-4'], created_at: ago(min) });
const BASE = { now: NOW, servers: [...FOREIGN.servers], queued: [], rows: [], summaryAt: NOW - 3600_000, cfg: CFG };
const base = BASE;
const kinds = (actions) => actions.map((a) => [a.kind, a.server?.id ?? a.row?.server ?? a.title ?? a.reason ?? '']);

test('a healthy box with a fresh heartbeat and nothing queued: nothing to do', () => {
  assert.deepEqual(guardPlan({ ...base, servers: [...base.servers, box(1)] }), []);
});

test('dead agent: a heartbeat older than 10 min deletes the box with end stale-heartbeat and opens an alert', () => {
  const actions = guardPlan({ ...base, servers: [...base.servers, box(1, { beat: 11 })] });
  assert.deepEqual(actions.map((a) => [a.kind, a.server.id, a.end]), [['delete', 1, 'stale-heartbeat']]);
  assert.match(actions[0].alert.title, /pool server 1 .*heartbeat/);
  assert.deepEqual(guardPlan({ ...base, servers: [...base.servers, box(1, { beat: 9 })] }), []);
});

test('dead agent: a box that never wrote a heartbeat counts from its creation (a stock image with no agent)', () => {
  assert.deepEqual(guardPlan({ ...base, servers: [...base.servers, box(1, { beat: null, created: 9, state: 'booting' })] }), []);
  const actions = guardPlan({ ...base, servers: [...base.servers, box(1, { beat: null, created: 11, state: 'booting' })] });
  assert.deepEqual(actions.map((a) => [a.kind, a.end]), [['delete', 'stale-heartbeat']]);
});

test('uptime: more than 12 h alerts, more than 24 h deletes with end max-uptime', () => {
  const base = { ...BASE, cfg: { max_hours_per_day: 100 } }; // the day's hours are another rule's
  assert.deepEqual(guardPlan({ ...base, servers: [box(1, { created: 12 * 60 - 1 })] }), []);
  const long = guardPlan({ ...base, servers: [box(1, { created: 12 * 60 + 1 })] });
  assert.deepEqual(long.map((a) => a.kind), ['alert']);
  assert.match(long[0].title, /pool server 1 up more than 12 h/);
  const day = guardPlan({ ...base, servers: [box(1, { created: 24 * 60 + 1 })] });
  assert.deepEqual(day.map((a) => [a.kind, a.end]), [['delete', 'max-uptime']]);
});

test('wake: a pool job queued more than 5 min with no pool server runs ensure', () => {
  assert.deepEqual(kinds(guardPlan({ ...base, queued: [queuedJob(4)] })), []);
  assert.deepEqual(kinds(guardPlan({ ...base, queued: [queuedJob(6)] })), [['ensure', 'a pool job queued 6 min with no pool server']]);
  assert.deepEqual(kinds(guardPlan({ ...base, servers: [box(1)], queued: [queuedJob(6)] })), []);
});

test('wake after a dead-agent delete: the stranded job gets a new box in the same cycle', () => {
  const actions = guardPlan({ ...base, servers: [box(1, { beat: 30 })], queued: [queuedJob(20)] });
  assert.deepEqual(actions.map((a) => a.kind), ['delete', 'ensure']);
});

test('ledger: a deleting row whose server is gone is finalized; one whose server lives is left to the deleter', () => {
  const server = { id: 7, created: ago(60), type: 'cpx62', location: 'hel1', price: 0.2452, jobs: 2 };
  const row = makeRow(server, { deleted: NOW - 5 * 60_000, end: 'idle', state: 'deleting' });
  assert.deepEqual(guardPlan({ ...base, rows: [row] }).map((a) => [a.kind, a.row.server]), [['finalize', 7]]);
  assert.deepEqual(guardPlan({ ...base, servers: [box(7)], rows: [row] }), []);
  assert.deepEqual(guardPlan({ ...base, rows: [{ ...row, state: 'final' }] }), []);
});

test('builders more than 2 h old are deleted with an alert; younger ones are left to their bake', () => {
  const builder = (id, min) => ({ id, name: `ci-kit-builder-${id}`, created: ago(min), labels: { 'ci-kit': 'builder', 'ci-kit-run': '5' } });
  const actions = guardPlan({ ...base, servers: [...base.servers, builder(1, 121), builder(2, 119)] });
  assert.deepEqual(actions.map((a) => [a.kind, a.server.id]), [['delete-builder', 1]]);
  assert.match(actions[0].alert.title, /builder 1/);
});

test('daily hours above max_hours_per_day alert and never delete', () => {
  const server = { id: 1, created: '2026-10-15T01:00:00Z', type: 'cpx62', location: 'hel1', price: 0.2452, jobs: 1 };
  const rows = [makeRow(server, { deleted: Date.parse('2026-10-15T09:30:00Z'), end: 'idle', state: 'final' })];
  const actions = guardPlan({ ...base, rows });
  assert.deepEqual(actions.map((a) => a.kind), ['alert']);
  assert.match(actions[0].title, /pool hours on 2026-10-15 above 8/);
});

test('the weekly cost summary is due 7 days after the last one, or when there is none', () => {
  assert.deepEqual(guardPlan({ ...base, summaryAt: null }).map((a) => a.kind), ['summary']);
  assert.deepEqual(guardPlan({ ...base, summaryAt: NOW - 7 * 86400_000 }).map((a) => a.kind), ['summary']);
  assert.deepEqual(guardPlan({ ...base, summaryAt: NOW - 6 * 86400_000 }), []);
});

test('resources without a ci-kit= label are never deleted, even when they match by name, age or staleness', () => {
  const old = FOREIGN.servers.map((s) => ({ ...s, created: ago(48 * 60) }));
  const actions = guardPlan({ ...base, servers: old, queued: [queuedJob(30)] });
  // The unlabelled server named ci-kit-pool is not a pool box: the stranded job still wakes one.
  assert.deepEqual(actions.map((a) => a.kind), ['ensure']);
});
