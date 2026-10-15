// ci-gate's watch loop against recorded API shapes (the Actions REST run and jobs objects), with a scripted clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateOf, jobEvents, watchRun } from '../cli/watch.mjs';

const T0 = Date.parse('2026-10-15T12:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString().replace('.000Z', 'Z');
const URL = 'https://github.com/SSFSKIM/ci-kit/actions/runs/7';

function job(id, name, { status = 'completed', conclusion = 'success', created = 0, started = 5, completed = 46 } = {}) {
  return {
    id,
    name,
    status,
    conclusion: status === 'completed' ? conclusion : null,
    created_at: at(created),
    started_at: status === 'queued' ? null : at(started),
    completed_at: status === 'completed' ? at(completed) : null,
    html_url: `${URL}/job/${id}`,
  };
}
const run = (status, conclusion = null) => ({ id: 7, status, conclusion, html_url: URL });
const plan = (opts) => job(1, 'ci / plan', { completed: 10, ...opts });

// A fake GitHub client that replays one snapshot per poll; the clock advances 10 s per sleep.
function harness(snapshots, { onFail, planError } = {}) {
  let i = 0;
  let clock = T0;
  const lines = [];
  const calls = { fail: [] };
  const gh = {
    async getRun() {
      const s = snapshots[Math.min(i, snapshots.length - 1)];
      if (s.error) throw new Error(s.error);
      return s.run;
    },
    async listJobs() {
      const s = snapshots[Math.min(i, snapshots.length - 1)];
      i += 1;
      return s.jobs;
    },
  };
  const opts = {
    gh,
    repo: 'SSFSKIM/ci-kit',
    runId: 7,
    runUrl: URL,
    emit: (l) => lines.push(l),
    onFail: onFail ?? (async (j, gate) => { calls.fail.push(gate); return `/tmp/ci-gate/SSFSKIM-ci-kit/7/${gate}.log`; }),
    planError: planError ?? (async () => 'ci-kit: lane "pool" is for private repos only (gate "big")'),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    interval: 10_000,
    maxUnreadable: 3,
  };
  return { opts, lines, calls };
}

test('gateOf reads the gate from a caller-prefixed job name, and skips the workflow\'s own jobs', () => {
  assert.equal(gateOf('ci / unit'), 'unit');
  assert.equal(gateOf('unit'), 'unit');
  assert.equal(gateOf('ci / plan'), null);
  assert.equal(gateOf('ci / verdict'), null);
  assert.equal(gateOf('ci / matrix.gate.name'), null); // the skipped, unexpanded matrix job, as the API names it
  assert.equal(gateOf('ci / ${{ matrix.gate.name }}'), null);
});

test('green: a PASS line per gate as each finishes, then GREEN, exit 0', async () => {
  const h = harness([
    { run: run('in_progress'), jobs: [plan()] },
    { run: run('in_progress'), jobs: [plan(), job(2, 'ci / unit', { completed: 46 }), job(3, 'ci / lint', { status: 'in_progress' })] },
    { run: run('completed', 'success'), jobs: [plan(), job(2, 'ci / unit'), job(3, 'ci / lint', { completed: 70 }), job(4, 'ci / verdict')] },
  ]);
  const r = await watchRun(h.opts);
  assert.deepEqual(h.lines, ['PASS unit 0m41s', 'PASS lint 1m05s']);
  assert.deepEqual(r, { line: `GREEN ${URL}`, code: 0 });
});

test('WAIT is printed once, when a gate has been queued for 2 minutes', async () => {
  const queued = job(2, 'ci / unit', { status: 'queued', created: 0 });
  const h = harness([
    ...Array.from({ length: 15 }, () => ({ run: run('in_progress'), jobs: [plan(), queued] })),
    { run: run('completed', 'success'), jobs: [plan(), job(2, 'ci / unit', { started: 150, completed: 160 })] },
  ]);
  const r = await watchRun(h.opts);
  assert.deepEqual(h.lines, ['WAIT unit 2m00s', 'PASS unit 0m10s']);
  assert.equal(r.code, 0);
});

test('red: FAIL carries the downloaded log path, RED counts failed of total, exit 1', async () => {
  const h = harness([
    { run: run('in_progress'), jobs: [plan(), job(2, 'ci / unit', { conclusion: 'failure', completed: 65 }), job(3, 'ci / lint', { status: 'in_progress' })] },
    { run: run('completed', 'failure'), jobs: [plan(), job(2, 'ci / unit', { conclusion: 'failure', completed: 65 }), job(3, 'ci / lint'), job(4, 'ci / verdict', { conclusion: 'failure' })] },
  ]);
  const r = await watchRun(h.opts);
  assert.deepEqual(h.lines, ['FAIL unit 1m00s log=/tmp/ci-gate/SSFSKIM-ci-kit/7/unit.log', 'PASS lint 0m41s']);
  assert.deepEqual(h.calls.fail, ['unit']);
  assert.deepEqual(r, { line: `RED 1/2 ${URL}`, code: 1 });
});

test('a timed-out gate is a FAIL, a cancelled one a CANCEL, a skipped one a SKIP; both of the first count as failed', async () => {
  const h = harness([
    {
      run: run('completed', 'failure'),
      jobs: [
        plan(),
        job(2, 'ci / a', { conclusion: 'timed_out' }),
        job(3, 'ci / b', { conclusion: 'cancelled' }),
        job(4, 'ci / c', { conclusion: 'skipped' }),
        job(5, 'ci / d'),
      ],
    },
  ]);
  const r = await watchRun(h.opts);
  assert.deepEqual(h.lines, [
    'FAIL a 0m41s log=/tmp/ci-gate/SSFSKIM-ci-kit/7/a.log',
    'CANCEL b',
    'SKIP c',
    'PASS d 0m41s',
  ]);
  assert.deepEqual(r, { line: `RED 2/4 ${URL}`, code: 1 });
});

test('a failed plan is an ERROR with the planner\'s message, without waiting for the run to end', async () => {
  const h = harness([
    { run: run('in_progress'), jobs: [plan({ conclusion: 'failure' }), job(4, 'ci / verdict', { status: 'queued' })] },
  ]);
  const r = await watchRun(h.opts);
  assert.deepEqual(h.lines, []);
  assert.deepEqual(r, { line: 'ERROR ci-kit: lane "pool" is for private repos only (gate "big")', code: 2 });
});

test('an empty selection is GREEN (the matrix job is skipped unexpanded)', async () => {
  // Recorded from run 38814096312: the skipped matrix job is listed as "ci / matrix.gate.name".
  const h = harness([
    { run: run('completed', 'success'), jobs: [plan(), job(3, 'ci / matrix.gate.name', { conclusion: 'skipped' }), job(4, 'ci / verdict')] },
  ]);
  const r = await watchRun(h.opts);
  assert.deepEqual(h.lines, []);
  assert.deepEqual(r, { line: `GREEN ${URL}`, code: 0 });
});

test('a run that failed to start is an ERROR', async () => {
  const h = harness([{ run: run('completed', 'startup_failure'), jobs: [] }]);
  const r = await watchRun(h.opts);
  assert.equal(r.code, 2);
  assert.match(r.line, /^ERROR the workflow run failed to start/);
});

test('a run cancelled from outside is an ERROR, not a verdict', async () => {
  const h = harness([{ run: run('completed', 'cancelled'), jobs: [plan(), job(2, 'ci / unit', { conclusion: 'cancelled' })] }]);
  const r = await watchRun(h.opts);
  assert.deepEqual(h.lines, ['CANCEL unit']);
  assert.equal(r.code, 2);
  assert.match(r.line, /^ERROR the run was cancelled/);
});

test('a transient read failure is retried; a run that stays unreadable is an ERROR', async () => {
  const ok = harness([
    { error: 'HTTP 502' },
    { run: run('completed', 'success'), jobs: [plan(), job(2, 'ci / unit')] },
  ]);
  ok.opts.gh.getRun = (() => {
    let n = 0;
    return async () => {
      n += 1;
      if (n === 1) throw new Error('HTTP 502');
      return run('completed', 'success');
    };
  })();
  ok.opts.gh.listJobs = async () => [plan(), job(2, 'ci / unit')];
  assert.equal((await watchRun(ok.opts)).code, 0);

  const bad = harness([{ error: 'HTTP 404' }]);
  const r = await watchRun(bad.opts);
  assert.equal(r.code, 2);
  assert.match(r.line, /^ERROR run 7 cannot be read: HTTP 404/);
});

test('jobEvents reports each job once', () => {
  const seen = new Map();
  const jobs = [plan(), job(2, 'ci / unit')];
  assert.equal(jobEvents(jobs, seen, T0).length, 1);
  assert.equal(jobEvents(jobs, seen, T0).length, 0);
});
