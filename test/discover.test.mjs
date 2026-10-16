// Run discovery against a scripted client and clock: it waits on the same budget-aware pace as the watch loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRun } from '../cli/discover.mjs';
import { createPacer } from '../cli/pace.mjs';
import { GitHubError } from '../lib/github.mjs';

const CALLER = '.github/workflows/ci.yml';
const RUN = { id: 9, event: 'push', path: CALLER, html_url: 'https://github.com/o/r/actions/runs/9' };

// Each poll answers from the script: { runs, remaining } or { error, remaining, reset }.
function harness(script) {
  let clock = 0;
  let i = 0;
  let stats = { remaining: null, reset: null };
  const lines = [];
  const sleeps = [];
  const gh = {
    stats: () => stats,
    async runsForCommit() {
      const s = script[Math.min(i, script.length - 1)];
      i += 1;
      stats = { remaining: s.remaining ?? null, reset: s.reset ?? null };
      if (s.error) throw new GitHubError(s.error, `HTTP ${s.error} GET /repos/o/r/actions/runs: API rate limit exceeded`);
      return s.runs;
    },
  };
  const opts = {
    gh,
    repo: 'o/r',
    commit: 'abc',
    caller: CALLER,
    ref: 'ci/x-abc-123456',
    pacer: createPacer(gh, (l) => lines.push(l)),
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  };
  return { opts, lines, sleeps, polls: () => i };
}

test('the run is found at the normal 5 s pace while the budget is healthy', async () => {
  const h = harness([{ runs: [], remaining: 4000 }, { runs: [RUN], remaining: 3999 }]);
  assert.deepEqual(await findRun(h.opts), { run: RUN });
  assert.deepEqual(h.sleeps, [5000, 5000]);
  assert.deepEqual(h.lines, []);
});

test('a low budget stretches discovery to 60 s, says THROTTLE once, and still finds the run', async () => {
  const h = harness([{ runs: [], remaining: 450 }, { runs: [], remaining: 440 }, { runs: [RUN], remaining: 430 }]);
  assert.deepEqual(await findRun(h.opts), { run: RUN });
  assert.deepEqual(h.sleeps, [5000, 60_000, 55_000]); // the last poll lands on the 2-minute deadline
  assert.deepEqual(h.lines, ['THROTTLE remaining=450']);
});

test('a 403 at zero remaining paces at 60 s and ends in an ERROR naming the rate limit', async () => {
  const reset = 1792112484;
  const h = harness([{ error: 403, remaining: 0, reset }]);
  const r = await findRun(h.opts);
  assert.deepEqual(h.lines, ['THROTTLE remaining=0']);
  assert.deepEqual(h.sleeps, [5000, 60_000, 55_000]); // the 2-minute deadline still holds
  assert.equal(h.polls(), 3);
  assert.equal(r.run, undefined);
  assert.equal(r.error, 'the GitHub API rate limit is exhausted (remaining 0, resets 2026-10-16T01:01:24Z); could not look for the run of ci/x-abc-123456');
});

test('with a healthy budget, no run within 2 minutes is the plain "no run appeared" error', async () => {
  const h = harness([{ runs: [], remaining: 4000 }]);
  const r = await findRun(h.opts);
  assert.equal(h.sleeps.reduce((a, b) => a + b, 0), 120_000);
  assert.match(r.error, /^no run of \.github\/workflows\/ci\.yml appeared within 2 min of the push to ci\/x-abc-123456$/);
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
