// The GCE ledger (gce/launcher/ledger.mjs, ledger-store.mjs; spec I12): one comment per allocation on the pool ledger
// issue, written `launching` before the JIT mint and finalized in place, idempotently, keyed by the allocation id;
// a daily line; and costs from the machine, provisioning and seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  launchRow, runningRow, finalRow, renderRow, parseRow, rowsOf, moreFinal, dollars, dailyLine, renderDaily, dailyDays,
} from '../../gce/launcher/ledger.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { parseRow as parseHetznerRow } from '../../pool/lib/ledger.mjs';

const SBX = 'SSFSKIM/ci-kit-sandbox';
const T0 = Date.parse('2026-10-16T12:00:00Z');
const INST = { name: 'ci-kit-gce-tb0abc0001', zone: 'us-central1-a', machine: 'c3d-highcpu-4', provisioning: 'spot', created: T0 + 5_000 };

test('a row goes launching → running → deleting → final, and renders the I12 columns', () => {
  const launching = launchRow({ alloc: 'tb0abc0001', repo: SBX, cpus: 4, at: T0, config: 'abcdef0123' });
  assert.equal(launching.state, 'launching');
  assert.equal(launching.instance, 'ci-kit-gce-tb0abc0001');
  const running = runningRow(launching, INST);
  assert.deepEqual([running.state, running.machine, running.zone, running.provisioning, running.created], ['running', 'c3d-highcpu-4', 'us-central1-a', 'spot', new Date(T0 + 5_000).toISOString()]);
  const done = finalRow(running, { end: 'done', deleted: T0 + 185_000, job: { id: 99, name: 'ci / nproc' }, diskGb: 50 });
  assert.equal(done.state, 'final');
  assert.equal(done.seconds, 180);
  const text = renderRow(done);
  assert.match(text, /^<!-- ci-kit-gce-ledger \{/);
  assert.match(text, /\| alloc \| instance \| repo \| job \(actual\) \| created \(UTC\) \| deleted \(UTC\) \| machine@zone \| spot\/standard \| seconds \| \$ \| end \|/);
  assert.match(text, /\| tb0abc0001 \| ci-kit-gce-tb0abc0001 \| SSFSKIM\/ci-kit-sandbox \| ci \/ nproc \(99\) \| 2026-10-16 12:00:05 \| 2026-10-16 12:03:05 \| c3d-highcpu-4@us-central1-a \| spot \| 180 \| 0\.\d{4} \| done \|$/);
  assert.deepEqual(parseRow(text), done);
  assert.equal(parseHetznerRow(text), null, 'the Hetzner ledger readers skip GCE rows');
});

test('a row is never moved back toward launching', () => {
  const launching = launchRow({ alloc: 'tb0abc0001', repo: SBX, cpus: 4, at: T0, config: 'x' });
  const final = finalRow(launching, { end: 'abandoned', deleted: T0 + 600_000, diskGb: 50 });
  assert.equal(moreFinal(final, launching), true);
  assert.equal(moreFinal(launching, final), false);
  assert.equal(moreFinal(final, final), false);
});

test('an abandoned allocation (no VM) costs nothing and has no seconds', () => {
  const final = finalRow(launchRow({ alloc: 'tb0abc0001', repo: SBX, cpus: 4, at: T0, config: 'x' }), { end: 'abandoned', deleted: T0 + 600_000, diskGb: 50 });
  assert.equal(final.seconds, null);
  assert.equal(final.dollars, null);
  assert.match(renderRow(final), /\| - \| - \| abandoned \|$/);
});

test('dollars: vCPU and memory at the machine family\'s spot or on-demand rate, plus the address and the disk, at least a minute', () => {
  // c3d-highcpu-4 spot: 4 vCPU × 0.00715 + 8 GiB × 0.00096 + IP 0.0025 = 0.03878 $/h; disk 50 GiB × 0.10 / 730 h.
  const hour = dollars({ machine: 'c3d-highcpu-4', provisioning: 'spot', seconds: 3600, diskGb: 50 });
  assert.ok(Math.abs(hour - (0.03878 + 50 * 0.1 / 730)) < 1e-9, String(hour));
  assert.equal(dollars({ machine: 'c3d-highcpu-4', provisioning: 'spot', seconds: 10, diskGb: 50 }), dollars({ machine: 'c3d-highcpu-4', provisioning: 'spot', seconds: 60, diskGb: 50 }));
  assert.ok(dollars({ machine: 'c3d-highcpu-4', provisioning: 'standard', seconds: 3600, diskGb: 50 }) > hour * 3);
  assert.ok(dollars({ machine: 'e2-highcpu-2', provisioning: 'spot', seconds: 3600, diskGb: 50 }) > 0);
  assert.equal(dollars({ machine: 'n9-mystery-4', provisioning: 'spot', seconds: 60, diskGb: 50 }), null);
});

test('the daily line totals the day\'s final rows (by deletion time), projects the month, and names the config commit', () => {
  const day = '2026-10-16';
  const mk = (alloc, deleted, end, seconds, dollarsSpent) => ({ alloc, state: 'final', deleted: new Date(deleted).toISOString(), end, seconds, dollars: dollarsSpent });
  const rows = [
    mk('a', T0, 'done', 300, 0.01),
    mk('b', T0 + 3600_000, 'preempted', 100, 0.002),
    mk('c', T0, 'abandoned', null, null),
    mk('d', Date.parse('2026-10-15T23:59:59Z'), 'done', 999, 1),
    { alloc: 'e', state: 'running' },
  ];
  const line = dailyLine(rows, day, 'abcdef0123');
  assert.deepEqual(line, { day, vms: 2, seconds: 400, dollars: 0.012, month: 0.36, ends: { done: 1, preempted: 1, abandoned: 1 }, config: 'abcdef01' });
  const text = renderDaily(line);
  assert.match(text, /^<!-- ci-kit-gce-daily \{"day":"2026-10-16"/);
  assert.match(text, /2 VMs, 400 VM-seconds, \$0\.0120; projected month \$0\.36/);
  assert.deepEqual([...dailyDays([{ body: text }, { body: 'x' }])], [day]);
});

// The store, against a fake issue.
function fakeIssue({ comments = [] } = {}) {
  let id = 100;
  const calls = [];
  const state = { comments: comments.map((c) => ({ updated_at: new Date(T0).toISOString(), ...c })) };
  const gh = {
    openIssues: async () => [{ number: 7, title: 'pool ledger' }],
    createIssue: async () => ({ number: 8 }),
    issueComments: async (_repo, _n, { since } = {}) => {
      calls.push(`read since ${since}`);
      return state.comments.filter((c) => !since || c.updated_at >= since).map((c) => ({ ...c }));
    },
    createComment: async (_r, _n, body) => { calls.push('create'); state.comments.push({ id: id++, body, updated_at: new Date(T0).toISOString() }); },
    updateComment: async (_r, cid, body) => { calls.push(`update ${cid}`); state.comments.find((c) => c.id === cid).body = body; },
    deleteComment: async (_r, cid) => { calls.push(`delete ${cid}`); state.comments = state.comments.filter((c) => c.id !== cid); },
  };
  return { gh, calls, state };
}
const LEDGER = { repo: SBX, issue_title: 'pool ledger' };

test('the store reads only the recent window, creates a launch row, and finalizes that same comment in place', async () => {
  const f = fakeIssue({ comments: [{ id: 1, body: 'an old Hetzner row', updated_at: '2026-10-01T00:00:00Z' }] });
  const store = createGceLedger(f.gh, LEDGER, { now: () => T0 });
  const launching = launchRow({ alloc: 'tb0abc0001', repo: SBX, cpus: 4, at: T0, config: 'x' });
  await store.read();
  assert.deepEqual(f.calls, ['read since 2026-10-15T10:00:00.000Z']);
  await store.upsert(launching);
  await store.read();
  const running = runningRow((await store.rows())[0], INST);
  await store.upsert(running);
  await store.upsert(running); // unchanged: no write
  await store.upsert(launching); // older: never written over the running row
  assert.deepEqual(f.calls.filter((c) => !c.startsWith('read')), ['create', 'update 100']);
  assert.equal(parseRow(f.state.comments.find((c) => c.id === 100).body).state, 'running');
});

test('two writers that each created a row for one allocation converge on one: the most final, then the oldest', async () => {
  const final = finalRow(runningRow(launchRow({ alloc: 'tb0abc0001', repo: SBX, cpus: 4, at: T0, config: 'x' }), INST), { end: 'orphan', deleted: T0 + 60_000, diskGb: 50 });
  const f = fakeIssue({ comments: [{ id: 1, body: renderRow({ ...final, state: 'running', end: null }) }, { id: 2, body: renderRow(final) }] });
  const store = createGceLedger(f.gh, LEDGER, { now: () => T0 });
  await store.read();
  assert.equal((await store.rows()).length, 1);
  assert.equal((await store.rows())[0].state, 'final');
  await store.upsert(final);
  assert.deepEqual(f.state.comments.map((c) => c.id), [2]);
});

test('the daily line is posted once per day', async () => {
  const f = fakeIssue();
  const store = createGceLedger(f.gh, LEDGER, { now: () => T0 });
  await store.read();
  const line = dailyLine([], '2026-10-15', 'abcdef01');
  assert.equal(await store.postDaily(line), true);
  await store.read();
  assert.equal(await store.postDaily(line), false);
  assert.equal(f.state.comments.length, 1);
});
