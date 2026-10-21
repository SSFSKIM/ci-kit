// The GCE ledger (gce/launcher/ledger.mjs, ledger-store.mjs; spec I12): one comment per allocation on the pool ledger
// issue, written `launching` before the JIT mint and finalized in place, idempotently, keyed by the allocation id;
// a daily line; and costs from the machine, provisioning and seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  launchRow, runningRow, withJob, jobRecord, finalRow, renderRow, parseRow, rowsOf, moreFinal, dollars, dailyLine, renderDaily, dailyDays,
} from '../../gce/launcher/ledger.mjs';
import { createGceLedger, ROTATE_AT, WINDOW_MS, FULL_READ_MS } from '../../gce/launcher/ledger-store.mjs';
import { createLedgerStore } from '../../pool/lib/ledger-store.mjs';
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

// M3 Timing in the ledger: the stages of a job's start are read back from its row (gce/latency-report.mjs).
test('timing: a row carries its job\'s run, workflow, queued and started times and the VM\'s RUNNING time', () => {
  const launching = launchRow({ alloc: 'tb0abc0001', repo: SBX, cpus: 4, at: T0, config: 'x' });
  const booting = runningRow(launching, INST);
  assert.equal('running' in booting, false, 'not RUNNING yet: no time, not a guess');
  const up = runningRow(booting, { ...INST, running: T0 + 16_000 });
  assert.equal(up.running, new Date(T0 + 16_000).toISOString());
  assert.equal(runningRow(up, INST).running, up.running, 'a later view without the time keeps it');
  // As GET /repos/{repo}/actions/runs/{id}/jobs lists one, with the run's workflow path the launcher adds.
  const apiJob = {
    id: 119166794835, run_id: 39583515002, name: 'static', workflow: '.github/workflows/gate.yml', status: 'in_progress',
    created_at: '2026-10-21T10:17:58Z', started_at: '2026-10-21T10:20:04Z', runner_name: 'ci-kit-gce-tb0abc0001', labels: ['cpus-4'],
  };
  const record = { id: 119166794835, name: 'static', run: 39583515002, workflow: '.github/workflows/gate.yml', queued: '2026-10-21T10:17:58Z', started: '2026-10-21T10:20:04Z' };
  assert.deepEqual(jobRecord(apiJob), record);
  assert.deepEqual(withJob(up, apiJob).job, record);
  assert.deepEqual(jobRecord({ id: 5, name: 'probes', run_id: 7, created_at: '2026-10-21T10:00:00Z', started_at: null }), { id: 5, name: 'probes', run: 7, queued: '2026-10-21T10:00:00Z' }, 'what GitHub has not set is left out');
  const done = finalRow(withJob(up, apiJob), { end: 'done', deleted: T0 + 600_000, job: record, diskGb: 50 });
  assert.deepEqual([done.job, done.running, done.cpus], [record, up.running, 4], 'the size is the row\'s cpus');
  assert.deepEqual(parseRow(renderRow(done)), done);
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

const C3D = { machine: 'c3d-highcpu-4', zone: 'us-central1-a', diskType: 'pd-balanced', diskGb: 50 };
test('dollars: vCPU and memory at the machine family\'s spot or on-demand rate in its region, plus the address and the disk, at least a minute', () => {
  // c3d-highcpu-4 spot: 4 vCPU × 0.00715 + 8 GiB × 0.00096 + IP 0.0025 = 0.03878 $/h; disk 50 GiB × 0.10 / 730 h.
  const hour = dollars({ ...C3D, provisioning: 'spot', seconds: 3600 });
  assert.ok(Math.abs(hour - (0.03878 + 50 * 0.1 / 730)) < 1e-9, String(hour));
  assert.equal(dollars({ ...C3D, provisioning: 'spot', seconds: 10 }), dollars({ ...C3D, provisioning: 'spot', seconds: 60 }));
  assert.ok(dollars({ ...C3D, provisioning: 'standard', seconds: 3600 }) > hour * 3);
  assert.ok(dollars({ ...C3D, machine: 'e2-highcpu-2', provisioning: 'spot', seconds: 3600 }) > 0);
  assert.equal(dollars({ ...C3D, machine: 'n9-mystery-4', provisioning: 'spot', seconds: 60 }), null);
  // A row from before placements names no disk type: its VM booted from pd-balanced.
  assert.equal(dollars({ ...C3D, diskType: undefined, provisioning: 'spot', seconds: 3600 }), hour);
});

test('dollars: a c4d VM in us-west4 at the catalog\'s C4D rates there, on Hyperdisk Balanced with its default performance', () => {
  // c4d-highcpu-8: 8 vCPU and 15 GiB (C4D memory is priced per GB, 10^9 bytes). Hyperdisk Balanced's defaults for 50 GiB
  // are 3,300 IOPS and 215 MiB/s, of which the first 3,000 and 140 are in the capacity price.
  const gb = 15 * 1.073741824;
  const disk = (50 * 0.09 + 300 * 0.006 + 75 * 0.045) / 730;
  const vm = { machine: 'c4d-highcpu-8', zone: 'us-west4-b', diskType: 'hyperdisk-balanced', diskGb: 50, seconds: 3600 };
  const spot = dollars({ ...vm, provisioning: 'spot' });
  assert.ok(Math.abs(spot - (8 * 0.0062 + gb * 0.000661 + 0.0025 + disk)) < 1e-9, String(spot));
  const standard = dollars({ ...vm, provisioning: 'standard' });
  assert.ok(Math.abs(standard - (8 * 0.036834 + gb * 0.00393707 + 0.005 + disk)) < 1e-9, String(standard));
  assert.ok(dollars({ ...vm, machine: 'c4d-highcpu-2', provisioning: 'spot' }) > 0);
  // No rate for the family in that region, or for the disk type there: unpriced, never guessed.
  assert.equal(dollars({ ...vm, zone: 'europe-west4-a', provisioning: 'spot' }), null);
  assert.equal(dollars({ ...C3D, zone: 'us-west4-a', provisioning: 'spot', seconds: 60 }), null);
  assert.equal(dollars({ ...vm, diskType: 'pd-balanced', provisioning: 'spot' }), null);
});

test('a running row records its VM\'s disk type; the final row is priced with it', () => {
  const launching = launchRow({ alloc: 'tb0abc0001', repo: SBX, cpus: 8, at: T0, config: 'abcdef0123' });
  const running = runningRow(launching, { zone: 'us-west4-a', machine: 'c4d-highcpu-8', provisioning: 'spot', diskType: 'hyperdisk-balanced', created: T0 });
  assert.equal(running.diskType, 'hyperdisk-balanced');
  const final = finalRow(running, { end: 'done', deleted: T0 + 3600_000, diskGb: 50 });
  assert.equal(final.dollars, Math.round(dollars({ machine: 'c4d-highcpu-8', zone: 'us-west4-a', provisioning: 'spot', diskType: 'hyperdisk-balanced', diskGb: 50, seconds: 3600 }) * 1e4) / 1e4);
  // A VM seen without its disk label (launched before placements) keeps what the row knew.
  assert.equal(runningRow(running, { ...INST, diskType: null }).diskType, 'hyperdisk-balanced');
});

test('the daily line totals the day\'s final rows (by deletion time), projects the month, and names the config commit', () => {
  const day = '2026-10-16';
  const mk = (alloc, deleted, end, seconds, dollarsSpent, machine = 'c3d-highcpu-4', zone = 'us-central1-a') =>
    ({ alloc, state: 'final', deleted: new Date(deleted).toISOString(), end, seconds, dollars: dollarsSpent, ...(seconds === null ? {} : { machine, zone }) });
  const rows = [
    mk('a', T0, 'done', 300, 0.01),
    mk('b', T0 + 3600_000, 'preempted', 100, 0.002, 'c4d-highcpu-8', 'us-west4-c'),
    mk('c', T0, 'abandoned', null, null),
    mk('d', Date.parse('2026-10-15T23:59:59Z'), 'done', 999, 1),
    mk('f', T0, 'done', 60, null, 'n9-mystery-4', 'us-central1-b'),
    { alloc: 'e', state: 'running' },
  ];
  const line = dailyLine(rows, day, 'abcdef0123');
  assert.deepEqual(line, {
    day, vms: 3, seconds: 460, dollars: 0.012, month: 0.36, ends: { done: 2, preempted: 1, abandoned: 1 }, config: 'abcdef01',
    families: { 'c3d@us-central1': { vms: 1, dollars: 0.01 }, 'c4d@us-west4': { vms: 1, dollars: 0.002 }, 'n9@us-central1': { vms: 1, dollars: 0, unpriced: 1 } },
  });
  const text = renderDaily(line);
  assert.match(text, /^<!-- ci-kit-gce-daily \{"day":"2026-10-16"/);
  assert.match(text, /3 VMs, 460 VM-seconds, \$0\.0120; projected month \$0\.36/);
  assert.match(text, /By family@region: c3d@us-central1 1 VMs \$0\.0100, c4d@us-west4 1 VMs \$0\.0020, n9@us-central1 1 VMs \$0\.0000 \(1 unpriced\)\./);
  assert.deepEqual([...dailyDays([{ body: text }, { body: 'x' }])], [day]);
});

// The store, against fake ledger issues. A comment without `issue` is on #7; an issue's `older` stands for comments
// made before the test. GitHub's cap is modelled: no new comment on an issue that already has 2,500.
const iso = (ms) => new Date(ms).toISOString();
// `listLag` (ms): how long a new issue stays out of the open-issues listing (GitHub's measured about 4 s).
function fakeIssue({ comments = [], issues = [{ number: 7, title: 'pool ledger', created_at: '2026-10-15T00:00:00Z' }], clock = { t: T0 }, listLag = 0 } = {}) {
  let id = 100;
  let nextIssue = 20;
  const calls = [];
  const state = {
    issues: issues.map((i) => ({ state: 'open', older: 0, ...i })),
    comments: comments.map((c) => ({ issue: 7, updated_at: iso(clock.t), ...c })),
  };
  const count = (n) => (state.issues.find((i) => i.number === n)?.older ?? 0) + state.comments.filter((c) => c.issue === n).length;
  const gh = {
    openIssues: async () => {
      calls.push('list');
      return state.issues.filter((i) => i.state === 'open' && Date.parse(i.created_at) + listLag <= clock.t)
        .map(({ older, ...i }) => ({ ...i, comments: count(i.number) }));
    },
    createIssue: async (_r, issue) => {
      calls.push(`open ${issue.title}`);
      const made = { number: nextIssue++, ...issue, state: 'open', created_at: iso(clock.t), older: 0 };
      state.issues.push(made);
      return { ...made, comments: 0 };
    },
    closeIssue: async (_r, n) => { calls.push(`close #${n}`); state.issues.find((i) => i.number === n).state = 'closed'; },
    issueComments: async (_repo, n, { since } = {}) => {
      calls.push(`read #${n} since ${since}`);
      return state.comments.filter((c) => c.issue === n && (!since || c.updated_at >= since)).map((c) => ({ ...c }));
    },
    createComment: async (_r, n, body) => {
      if (count(n) >= 2500) throw Object.assign(new Error('Commenting is disabled on issues with more than 2500 comments'), { status: 403 });
      calls.push(`create #${n}`);
      const c = { id: id++, issue: n, body, updated_at: iso(clock.t) };
      state.comments.push(c);
      return { ...c };
    },
    getComment: async (_r, cid) => {
      calls.push(`get ${cid}`);
      const c = state.comments.find((x) => x.id === cid);
      if (!c) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { ...c };
    },
    updateComment: async (_r, cid, body) => {
      calls.push(`update ${cid}`);
      Object.assign(state.comments.find((c) => c.id === cid), { body, updated_at: iso(clock.t) });
    },
    deleteComment: async (_r, cid) => { calls.push(`delete ${cid}`); state.comments = state.comments.filter((c) => c.id !== cid); },
  };
  return { gh, calls, state, clock, count };
}
const LEDGER = { repo: SBX, issue_title: 'pool ledger' };

test('the store reads only the recent window, creates a launch row, and finalizes that same comment in place', async () => {
  const f = fakeIssue({ comments: [{ id: 1, body: 'an old Hetzner row', updated_at: '2026-10-01T00:00:00Z' }] });
  const store = createGceLedger(f.gh, LEDGER, { now: () => T0 });
  const launching = launchRow({ alloc: 'tb0abc0001', repo: SBX, cpus: 4, at: T0, config: 'x' });
  await store.read();
  assert.deepEqual(f.calls, ['list', 'read #7 since 2026-10-15T10:00:00.000Z']);
  await store.upsert(launching);
  await store.read();
  const running = runningRow((await store.rows())[0], INST);
  await store.upsert(running);
  await store.upsert(running); // unchanged: no write
  await store.upsert(launching); // older: never written over the running row
  assert.deepEqual(f.calls.filter((c) => !c.startsWith('read') && c !== 'list'), ['create #7', 'get 100', 'update 100']);
  assert.equal(parseRow(f.state.comments.find((c) => c.id === 100).body).state, 'running');
});

// M3: a tick's first insert waits for the ledger read, which at a busy day's rate is several pages of the window.
test('a later read asks only for what changed since the last one (with an overlap), and keeps the rest of the window', async () => {
  const f = fakeIssue({ comments: [{ id: 1, body: renderRow(launchRow({ alloc: 'tb0abc0001', repo: SBX, cpus: 4, at: T0, config: 'x' })) }] });
  const store = createGceLedger(f.gh, LEDGER, { now: () => f.clock.t });
  await store.read();
  f.clock.t += 60_000;
  // Another writer moves the row on; this store writes one of its own.
  const other = runningRow(launchRow({ alloc: 'tb0abc0001', repo: SBX, cpus: 4, at: T0, config: 'x' }), INST);
  await f.gh.updateComment(SBX, 1, renderRow(other));
  f.clock.t += 60_000;
  await store.upsert(launchRow({ alloc: 'tb0abc0002', repo: SBX, cpus: 2, at: f.clock.t, config: 'x' }));
  f.calls.length = 0;
  await store.read();
  assert.deepEqual(f.calls, ['list', `read #7 since ${iso(T0 - 5 * 60_000)}`], 'from the last read (at T0), less 5 min');
  assert.deepEqual((await store.rows()).map((r) => [r.alloc, r.state]).sort(), [['tb0abc0001', 'running'], ['tb0abc0002', 'launching']]);
  // A comment last updated before the window leaves it, as it would from a whole read.
  f.clock.t = T0 + WINDOW_MS + 90_000;
  await store.read();
  assert.deepEqual((await store.rows()).map((r) => r.alloc), ['tb0abc0002']);
});

test('a comment this store deleted (a duplicate row) does not come back from the store\'s own memory', async () => {
  const dup = launchRow({ alloc: 'tb0abc0003', repo: SBX, cpus: 4, at: T0, config: 'x' });
  const f = fakeIssue({ comments: [{ id: 1, body: renderRow(dup) }, { id: 2, body: renderRow(dup) }] });
  const store = createGceLedger(f.gh, LEDGER, { now: () => f.clock.t });
  await store.read();
  await store.upsert(runningRow(dup, INST)); // updates #1 and removes #2
  assert.ok(f.calls.includes('delete 2'));
  f.clock.t += 60_000;
  await store.read();
  f.calls.length = 0;
  await store.upsert(finalRow(runningRow(dup, INST), { end: 'done', deleted: f.clock.t, diskGb: 50 }));
  assert.ok(!f.calls.includes('delete 2'), 'nothing to delete twice');
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

test('review 2: a stale writer never moves a row back: the comment is re-read before each update, and a final row is never rewritten', async () => {
  const f = fakeIssue();
  const a = createGceLedger(f.gh, LEDGER, { now: () => T0 });
  const b = createGceLedger(f.gh, LEDGER, { now: () => T0 });
  const launching = launchRow({ alloc: 'tb0abc0001', repo: SBX, cpus: 4, at: T0, config: 'x' });
  await a.upsert(launching);
  await a.read();
  await b.read();
  const running = runningRow(launching, INST);
  await a.upsert(running);
  await b.upsert(running); // b's copy is current: same rank, same body after the re-read → nothing written
  const final = finalRow(running, { end: 'done', deleted: T0 + 60_000, diskGb: 50 });
  await a.upsert(final);
  // b still holds the launching copy and writes running over what is now final.
  await b.upsert({ ...running, job: { id: 5, name: 'late' } });
  assert.equal(parseRow(f.state.comments[0].body).state, 'final');
  // Another final over a final is refused too: the first final stands.
  await b.upsert(finalRow(running, { end: 'orphan', deleted: T0 + 90_000, diskGb: 50 }));
  assert.equal(parseRow(f.state.comments[0].body).end, 'done');
});

// Rotation (ci-kit#25): GitHub refuses new comments on an issue that has 2,500, so the ledger moves to a fresh issue
// at ROTATE_AT, reads every open ledger issue over the window, and closes an old one once nothing in it is inside it.
const H = 3600_000;
const row = (alloc, state = 'launching') => {
  const l = launchRow({ alloc, repo: SBX, cpus: 4, at: T0, config: 'x' });
  if (state === 'launching') return l;
  const r = runningRow(l, INST);
  return state === 'running' ? r : finalRow(r, { end: 'done', deleted: T0 + 60_000, diskGb: 50 });
};
const rowIssue = (f, alloc) => f.state.comments.filter((c) => parseRow(c.body)?.alloc === alloc).map((c) => c.issue);

test('rotation: below ROTATE_AT rows stay on the issue; at it, a dated ledger issue continuing the old one takes new rows', async () => {
  assert.ok(ROTATE_AT <= 2000, 'the threshold leaves real headroom under the 2,500 cap');
  const f = fakeIssue({ issues: [{ number: 7, title: 'pool ledger', created_at: '2026-10-15T00:00:00Z', older: ROTATE_AT - 2 }] });
  const store = createGceLedger(f.gh, LEDGER, { now: () => f.clock.t });
  await store.read();
  await store.upsert(row('tb0abc0001'));
  assert.equal(f.state.issues.length, 1);
  await store.read();
  await store.upsert(row('tb0abc0002')); // the issue now has ROTATE_AT comments; the next read rotates
  await store.read();
  assert.equal(f.state.issues.length, 2);
  const fresh = f.state.issues[1];
  assert.equal(fresh.title, 'pool ledger from 2026-10-16');
  assert.match(fresh.body, /#7\b/, 'the new issue names the one it continues');
  await store.upsert(row('tb0abc0003'));
  await store.postDaily(dailyLine([], '2026-10-15', 'abcdef01'));
  assert.deepEqual(rowIssue(f, 'tb0abc0003'), [fresh.number]);
  assert.equal(f.state.comments.at(-1).issue, fresh.number, 'the daily line goes on the current issue too');
  assert.equal(f.count(7), ROTATE_AT, 'nothing new on the old issue');
  await store.read();
  assert.equal(f.state.issues.length, 2, 'one rotation, not one per read');
});

test('rotation: a read sees every row updated in the window on every open ledger issue, and only those', async () => {
  const f = fakeIssue({
    issues: [{ number: 7, title: 'pool ledger', created_at: '2026-10-01T00:00:00Z' }, { number: 9, title: 'pool ledger from 2026-10-16', created_at: iso(T0 - H) }, { number: 8, title: 'ci-kit alert: x' }],
    comments: [
      { id: 1, issue: 7, body: renderRow(row('tb0abc0001', 'running')), updated_at: iso(T0 - 20 * H) },
      { id: 2, issue: 7, body: renderRow(row('tb0abc0002', 'final')), updated_at: iso(T0 - 27 * H) },
      { id: 3, issue: 9, body: renderRow(row('tb0abc0003')), updated_at: iso(T0 - 60_000) },
      { id: 4, issue: 8, body: renderRow(row('tb0abc0004')), updated_at: iso(T0) },
    ],
  });
  const store = createGceLedger(f.gh, LEDGER, { now: () => T0 });
  await store.read();
  assert.deepEqual((await store.rows()).map((r) => r.alloc).sort(), ['tb0abc0001', 'tb0abc0003']);
  assert.deepEqual(f.calls.filter((c) => c.startsWith('read')).map((c) => c.split(' ')[1]), ['#7', '#9']);
});

test('rotation: a row on the old issue is updated in place there, and its allocation gets no second comment', async () => {
  const f = fakeIssue({
    issues: [{ number: 7, title: 'pool ledger', created_at: '2026-10-01T00:00:00Z', older: ROTATE_AT }],
    comments: [{ id: 1, issue: 7, body: renderRow(row('tb0abc0001', 'running')), updated_at: iso(T0 - H) }],
  });
  const store = createGceLedger(f.gh, LEDGER, { now: () => T0 });
  await store.read();
  assert.equal(f.state.issues.length, 2);
  await store.upsert(row('tb0abc0001', 'final'), { dedupe: true });
  assert.deepEqual(rowIssue(f, 'tb0abc0001'), [7]);
  assert.equal(parseRow(f.state.comments.find((c) => c.id === 1).body).state, 'final');
});

test('rotation: the daily line is not posted again when yesterday\'s already sits on the old issue', async () => {
  const line = dailyLine([], '2026-10-15', 'abcdef01');
  const f = fakeIssue({
    issues: [{ number: 7, title: 'pool ledger', created_at: '2026-10-01T00:00:00Z' }, { number: 9, title: 'pool ledger from 2026-10-16', created_at: iso(T0 - H) }],
    comments: [{ id: 1, issue: 7, body: renderDaily(line), updated_at: iso(T0 - 10 * H) }],
  });
  const store = createGceLedger(f.gh, LEDGER, { now: () => T0 });
  await store.read();
  assert.equal(await store.postDaily(line), false);
  assert.equal(f.state.comments.length, 1);
});

test('rotation: two ticks that both rotate converge on the newest issue, and no row either wrote is lost', async () => {
  const f = fakeIssue({
    issues: [{ number: 7, title: 'pool ledger', created_at: '2026-10-01T00:00:00Z', older: ROTATE_AT }],
    comments: [{ id: 1, issue: 7, body: renderRow(row('tb0abc0001', 'running')), updated_at: iso(T0 - H) }],
  });
  const a = createGceLedger(f.gh, LEDGER, { now: () => f.clock.t });
  const b = createGceLedger(f.gh, LEDGER, { now: () => f.clock.t });
  await Promise.all([a.read(), b.read()]); // both list before either creates
  assert.equal(f.state.issues.length, 3, 'both rotated');
  const [first, second] = f.state.issues.slice(1).map((i) => i.number);
  await a.upsert(row('tb0abc0002'));
  await b.upsert(row('tb0abc0003'));
  assert.notDeepEqual(rowIssue(f, 'tb0abc0002'), rowIssue(f, 'tb0abc0003'), 'each wrote to the issue it made');
  // Every reader now agrees: the newest open ledger issue is current, and every open one is read.
  f.clock.t += 60_000;
  const c = createGceLedger(f.gh, LEDGER, { now: () => f.clock.t });
  for (const s of [a, b, c]) {
    await s.read();
    assert.deepEqual((await s.rows()).map((r) => r.alloc).sort(), ['tb0abc0001', 'tb0abc0002', 'tb0abc0003']);
  }
  assert.equal(f.state.issues.length, 3, 'nobody rotates again');
  await a.upsert(row('tb0abc0004'));
  await b.upsert(row('tb0abc0005'));
  await c.postDaily(dailyLine([], '2026-10-15', 'abcdef01'));
  assert.deepEqual([...rowIssue(f, 'tb0abc0004'), ...rowIssue(f, 'tb0abc0005'), f.state.comments.at(-1).issue], [second, second, second]);
  assert.ok(first < second);
});

test('rotation: an old issue is closed once nothing on it is in the window and its successor is a window old; the current one never', async () => {
  const f = fakeIssue({
    issues: [{ number: 7, title: 'pool ledger', created_at: '2026-10-01T00:00:00Z', older: ROTATE_AT }],
    comments: [{ id: 1, issue: 7, body: renderRow(row('tb0abc0001', 'running')), updated_at: iso(T0 - H) }],
  });
  const store = createGceLedger(f.gh, LEDGER, { now: () => f.clock.t });
  await store.read(); // rotates
  const current = f.state.issues[1].number;
  await store.upsert(row('tb0abc0001', 'final')); // touches #7's row: it stays in the window 26 h more
  f.clock.t += WINDOW_MS - 60_000;
  await store.read();
  assert.equal(f.state.issues[0].state, 'open', 'its row is still inside the window');
  f.clock.t += 2 * 60_000;
  await store.read();
  assert.equal(f.state.issues[0].state, 'closed');
  assert.equal(f.state.issues[1].state, 'open');
  assert.ok(f.calls.includes('close #7'));
  assert.equal(f.state.comments.filter((c) => c.issue === 7).length, 1, 'its history is kept');
  assert.match(f.state.issues[0].title, /^pool ledger/, 'and it stays findable by title');
  // The current issue is never closed, however long it sits idle; and a closed one is no longer read.
  f.clock.t += 3 * WINDOW_MS;
  f.calls.length = 0;
  await store.read();
  assert.equal(f.state.issues.find((i) => i.number === current).state, 'open');
  assert.deepEqual(f.calls.filter((c) => c.startsWith('read')).map((c) => c.split(' ')[1]), [`#${current}`]);
});

test('rotation: an old issue whose successor is younger than the window is kept open even with nothing in the window', async () => {
  const f = fakeIssue({ issues: [{ number: 7, title: 'pool ledger', created_at: '2026-10-01T00:00:00Z' }, { number: 9, title: 'pool ledger from 2026-10-16', created_at: iso(T0 - H) }] });
  const store = createGceLedger(f.gh, LEDGER, { now: () => T0 });
  await store.read();
  assert.equal(f.state.issues[0].state, 'open');
});

test('rotation: when the new issue cannot be made, rows keep going to the current one and the next read tries again', async () => {
  const f = fakeIssue({ issues: [{ number: 7, title: 'pool ledger', created_at: '2026-10-01T00:00:00Z', older: ROTATE_AT }] });
  const logs = [];
  const create = f.gh.createIssue;
  f.gh.createIssue = async () => { throw Object.assign(new Error('HTTP 502'), { status: 502 }); };
  const store = createGceLedger(f.gh, LEDGER, { now: () => T0, log: (m) => logs.push(m) });
  await store.read();
  await store.upsert(row('tb0abc0001'));
  assert.deepEqual(rowIssue(f, 'tb0abc0001'), [7]);
  assert.match(logs.join('\n'), /#7/);
  f.gh.createIssue = create;
  await store.read();
  assert.equal(f.state.issues.length, 2);
});

test('rotation: Hetzner\'s ledger store still finds the original "pool ledger" issue, never a rotated GCE one', async () => {
  const f = fakeIssue({ issues: [{ number: 7, title: 'pool ledger', created_at: '2026-10-01T00:00:00Z', older: ROTATE_AT }] });
  await createGceLedger(f.gh, LEDGER, { now: () => T0 }).read();
  assert.equal(f.state.issues.length, 2);
  f.state.issues.reverse(); // GitHub lists the newest first
  const hetzner = createLedgerStore(f.gh, LEDGER);
  await hetzner.comments();
  assert.ok(f.calls.includes('read #7 since undefined'));
});

test('rotation: the store keeps reading the issue it opened while GitHub\'s listing has not caught up', async () => {
  const f = fakeIssue({ issues: [{ number: 7, title: 'pool ledger', created_at: '2026-10-01T00:00:00Z', older: ROTATE_AT }], listLag: 4_000 });
  const store = createGceLedger(f.gh, LEDGER, { now: () => f.clock.t });
  await store.read();
  const fresh = f.state.issues[1].number;
  await store.upsert(row('tb0abc0001'));
  const line = dailyLine([], '2026-10-15', 'abcdef01');
  await store.postDaily(line);
  f.clock.t += 1_000; // the new issue is not listed yet
  await store.read();
  assert.deepEqual((await store.rows()).map((r) => r.alloc), ['tb0abc0001']);
  assert.equal(await store.postDaily(line), false);
  assert.equal(f.state.issues.length, 2, 'no second rotation');
  await store.upsert(row('tb0abc0002'));
  assert.deepEqual(rowIssue(f, 'tb0abc0002'), [fresh]);
  f.clock.t += 60_000; // listed now
  await store.read();
  assert.deepEqual((await store.rows()).map((r) => r.alloc).sort(), ['tb0abc0001', 'tb0abc0002']);
});

// Review (M3, P2): an incremental read returns what changed, never what was deleted. Two launchers overlap on an
// allocation with two comments: B read the second while it was running and removes it as the duplicate (its deleting
// comment is further along); A read it after it went final. Until A drops what GitHub no longer has, rowsOf prefers
// that final comment, and A never finalizes the allocation.
test('a comment another writer deleted leaves this store\'s memory at its next whole read, at most FULL_READ_MS later', async () => {
  const launching = launchRow({ alloc: 'tb0abc0001', repo: SBX, cpus: 4, at: T0, config: 'x' });
  const running = runningRow(launching, INST);
  const deleting = finalRow(running, { end: 'done', deleted: T0 + 60_000, diskGb: 50, state: 'deleting' });
  const final = finalRow(running, { end: 'done', deleted: T0 + 60_000, diskGb: 50 });
  const f = fakeIssue({ comments: [{ id: 1, body: renderRow(deleting) }, { id: 2, body: renderRow(running) }] });
  const a = createGceLedger(f.gh, LEDGER, { now: () => f.clock.t });
  const b = createGceLedger(f.gh, LEDGER, { now: () => f.clock.t });
  await b.read();
  await f.gh.updateComment(SBX, 2, renderRow(final)); // a third writer's stale finalization of the duplicate
  await a.read();
  assert.equal((await a.rows())[0].state, 'final');
  f.clock.t += 60_000;
  await b.upsert(deleting); // B keeps its deleting comment and removes the duplicate it holds as running
  assert.ok(f.calls.includes('delete 2'));
  f.clock.t += 60_000;
  await a.read();
  assert.equal((await a.rows())[0].state, 'final', 'an incremental read does not show the deletion');
  f.clock.t += FULL_READ_MS;
  f.calls.length = 0;
  await a.read();
  assert.ok(f.calls.includes(`read #7 since ${iso(f.clock.t - WINDOW_MS)}`), 'a whole read of the window');
  assert.equal((await a.rows())[0].state, 'deleting', 'A no longer holds the deleted final comment');
  await a.upsert(final);
  assert.equal(parseRow(f.state.comments.find((c) => c.id === 1).body).state, 'final', 'and A finalizes the allocation');
});

test('a whole read keeps a comment this store just wrote that GitHub does not list yet', async () => {
  const f = fakeIssue();
  const store = createGceLedger(f.gh, LEDGER, { now: () => f.clock.t });
  await store.read();
  f.clock.t += FULL_READ_MS;
  await store.upsert(launchRow({ alloc: 'tb0abc0002', repo: SBX, cpus: 2, at: f.clock.t, config: 'x' }));
  const listing = f.gh.issueComments;
  f.gh.issueComments = async (...args) => (await listing(...args)).filter((c) => Date.parse(c.updated_at) < f.clock.t); // listing lag
  await store.read();
  assert.deepEqual((await store.rows()).map((r) => r.alloc), ['tb0abc0002']);
});
