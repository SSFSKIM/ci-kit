// Run discovery against a scripted client and clock: it waits on the same budget-aware pace as the watch loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRun } from '../cli/discover.mjs';
import { createPacer, RESET_SLACK_MS } from '../cli/pace.mjs';
import { GitHubError } from '../lib/github.mjs';

const CALLER = '.github/workflows/ci.yml';
const RUN = { id: 9, event: 'push', path: CALLER, html_url: 'https://github.com/o/r/actions/runs/9' };

// Each poll answers from the script: { runs, remaining } or { error, remaining, reset }; /rate_limit answers from
// `cores`, then a healthy budget.
function harness(script, { cores = [] } = {}) {
  let clock = 0;
  let i = 0;
  let stats = { remaining: null, reset: null };
  const lines = [];
  const notes = [];
  const sleeps = [];
  const gh = {
    stats: () => stats,
    async runsForCommit() {
      const s = script[Math.min(i, script.length - 1)];
      i += 1;
      stats = { remaining: s.remaining ?? null, reset: s.reset ?? null };
      if (s.error) {
        throw new GitHubError(s.error, `HTTP ${s.error} GET /repos/o/r/actions/runs: API rate limit exceeded`, {
          remaining: s.remaining ?? null, reset: s.reset ?? null, retryAfter: null,
        });
      }
      return s.runs;
    },
    rateLimit: async () => cores.shift() ?? { remaining: 4999, reset: 0 },
  };
  const now = () => clock;
  const sleep = async (ms) => { sleeps.push(ms); clock += ms; };
  const opts = {
    gh,
    repo: 'o/r',
    commit: 'abc',
    caller: CALLER,
    ref: 'ci/x-abc-123456',
    pacer: createPacer(gh, (l) => lines.push(l), { now, sleep }),
    now,
    sleep,
    note: (l) => notes.push(l),
  };
  return { opts, lines, notes, sleeps, polls: () => i, clock: () => clock };
}

test('the run is found at the normal 5 s pace while the budget is healthy', async () => {
  const h = harness([{ runs: [], remaining: 4000 }, { runs: [RUN], remaining: 3999 }]);
  assert.deepEqual(await findRun(h.opts), { run: RUN });
  assert.deepEqual(h.sleeps, [5000, 5000]);
  assert.deepEqual(h.lines, []);
  assert.deepEqual(h.notes, []);
});

test('a run GitHub creates minutes late is still found, with one note after the first minute', async () => {
  const empty = Array.from({ length: 36 }, () => ({ runs: [], remaining: 4000 })); // 3 min of 5 s polls
  const h = harness([...empty, { runs: [RUN], remaining: 4000 }]);
  assert.deepEqual(await findRun(h.opts), { run: RUN });
  assert.equal(h.polls(), 37);
  assert.deepEqual(h.notes, ['no run of .github/workflows/ci.yml yet a minute after the push to ci/x-abc-123456; waiting up to 5 min']);
});

test('a low budget stretches discovery to 60 s, says THROTTLE once, and still finds the run', async () => {
  const h = harness([{ runs: [], remaining: 450 }, { runs: [], remaining: 440 }, { runs: [RUN], remaining: 430 }]);
  assert.deepEqual(await findRun(h.opts), { run: RUN });
  assert.deepEqual(h.sleeps, [5000, 60_000, 60_000]);
  assert.deepEqual(h.lines, ['THROTTLE remaining=450']);
});

test('a 403 at zero remaining waits until the reset, then reads again and finds the run', async () => {
  const reset = 20 * 60; // the harness clock starts at 0
  const h = harness([{ error: 403, remaining: 0, reset }, { runs: [RUN], remaining: 4999, reset: reset + 3600 }]);
  assert.deepEqual(await findRun(h.opts), { run: RUN });
  assert.deepEqual(h.lines, ['THROTTLE remaining=0 until=1970-01-01T00:20:00Z']);
  assert.deepEqual(h.sleeps, [5000, reset * 1000 - 5000 + RESET_SLACK_MS]);
  assert.equal(h.polls(), 2);
});

test('time spent waiting out the limit does not count against the 5-minute deadline for the run to appear', async () => {
  const reset = 40 * 60;
  const empty = Array.from({ length: 30 }, () => ({ runs: [], remaining: 4999, reset: reset + 3600 })); // 2.5 min more
  const h = harness([{ runs: [], remaining: 4000 }, { error: 403, remaining: 0, reset }, ...empty, { runs: [RUN], remaining: 4999 }]);
  assert.deepEqual(await findRun(h.opts), { run: RUN });
  assert.ok(h.clock() > reset * 1000 + 2 * 60_000);
});

test('a budget still exhausted after 90 min is an ERROR naming the rate limit, and the run may exist', async () => {
  // The window keeps refilling and draining: /rate_limit says 0 with a later reset each time.
  const h = harness([{ error: 403, remaining: 0, reset: 60 * 60 }], { cores: [{ remaining: 0, reset: 110 * 60 }, { remaining: 0, reset: 110 * 60 }] });
  const r = await findRun(h.opts);
  assert.equal(r.run, undefined);
  assert.equal(r.runMayExist, true);
  assert.equal(r.error, 'the GitHub API rate limit stayed exhausted for 90 min (resets 1970-01-01T01:50:00Z); could not look for the run of ci/x-abc-123456');
  assert.equal(h.polls(), 1);
});

test('with a healthy budget, no run within 5 minutes is the plain "no run appeared" error', async () => {
  const h = harness([{ runs: [], remaining: 4000 }]);
  const r = await findRun(h.opts);
  assert.equal(h.sleeps.reduce((a, b) => a + b, 0), 300_000);
  assert.equal(h.notes.length, 1);
  assert.match(r.error, /^no run of \.github\/workflows\/ci\.yml appeared within 5 min of the push to ci\/x-abc-123456$/);
});

test('one pacer says THROTTLE once across discovery and the watch', () => {
  const lines = [];
  let remaining = 300;
  const pacer = createPacer({ stats: () => ({ remaining }) }, (l) => lines.push(l));
  assert.equal(pacer.wait(5000), 60_000);
  remaining = 200;
  assert.equal(pacer.wait(15_000), 60_000);
  remaining = 4000;
  assert.equal(pacer.wait(15_000), 15_000);
  assert.deepEqual(lines, ['THROTTLE remaining=300']);
});

test('the pacer\'s threshold: 499 is low, 500 is not, an unknown budget is not', () => {
  for (const [remaining, ms] of [[499, 60_000], [500, 15_000], [null, 15_000], [0, 60_000]]) {
    const pacer = createPacer({ stats: () => ({ remaining }) }, () => {});
    assert.equal(pacer.wait(15_000), ms, String(remaining));
  }
});

test('onHidden is called as soon as the budget hides the run, before the wait (a Ctrl-C then still keeps the ref)', async () => {
  const reset = 60 * 60;
  const h = harness([{ error: 403, remaining: 0, reset }, { runs: [RUN], remaining: 4999, reset: reset + 3600 }]);
  const at = [];
  assert.deepEqual(await findRun({ ...h.opts, onHidden: () => at.push(h.clock()) }), { run: RUN });
  assert.deepEqual(at, [5000]); // at the first poll's 403, not after the hour's wait
});
