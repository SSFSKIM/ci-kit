// The pacer's wait-out of an exhausted budget, against a scripted client and clock: a rate-limited read sleeps until
// the published reset, checks /rate_limit, and reads again, up to LIMIT_WAIT_MS of continuous exhaustion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetExhausted, createPacer, LIMIT_WAIT_MS, RESET_SLACK_MS } from '../cli/pace.mjs';
import { GitHubError } from '../lib/github.mjs';

const T0 = Date.parse('2026-11-10T11:02:00Z');
const RESET = Date.parse('2026-11-10T11:22:00Z') / 1000;
const limited = (rateLimit, message = 'API rate limit exceeded for user ID 1.') =>
  new GitHubError(403, `HTTP 403 GET /repos/o/r/actions/runs/7: ${message}`, { remaining: null, reset: null, retryAfter: null, ...rateLimit });

// cores: what each /rate_limit read answers (an Error to throw, or a core object).
function harness({ cores = [] } = {}) {
  let clock = T0;
  const lines = [];
  const sleeps = [];
  const checks = [];
  const gh = {
    stats: () => ({ remaining: 4000 }),
    async rateLimit() {
      checks.push(clock);
      const c = cores.shift() ?? { remaining: 4999, reset: RESET + 3600 };
      if (c instanceof Error) throw c;
      return c;
    },
  };
  const pacer = createPacer(gh, (l) => lines.push(l), { now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  return { pacer, lines, sleeps, checks, clock: () => clock };
}

// A read that throws each of `errors` in turn, then answers `value`.
function reads(errors, value = 'ok') {
  let n = 0;
  const fn = async () => {
    n += 1;
    if (errors.length > 0) throw errors.shift();
    return value;
  };
  return { fn, calls: () => n };
}

test('a healthy read passes straight through: no sleep, no /rate_limit check, no line', async () => {
  const h = harness();
  const r = reads([]);
  assert.equal(await h.pacer.read(r.fn), 'ok');
  assert.deepEqual([h.sleeps, h.checks, h.lines], [[], [], []]);
});

test('an exhausted budget sleeps until the published reset and a few seconds, checks /rate_limit, then reads again', async () => {
  const h = harness();
  const r = reads([limited({ remaining: 0, reset: RESET })]);
  assert.equal(await h.pacer.read(r.fn), 'ok');
  assert.deepEqual(h.lines, ['THROTTLE remaining=0 until=2026-11-10T11:22:00Z']);
  assert.deepEqual(h.sleeps, [20 * 60_000 + RESET_SLACK_MS]);
  assert.deepEqual(h.checks, [RESET * 1000 + RESET_SLACK_MS]);
  assert.equal(r.calls(), 2);
  assert.equal(h.pacer.heldMs(), 20 * 60_000 + RESET_SLACK_MS);
});

test('a retry-after later than the reset wins; a secondary limit with budget left waits its retry-after only', async () => {
  const late = harness();
  await late.pacer.read(reads([limited({ remaining: 0, reset: RESET, retryAfter: 30 * 60 })]).fn);
  assert.deepEqual(late.lines, ['THROTTLE remaining=0 until=2026-11-10T11:32:00Z']);

  const secondary = harness();
  await secondary.pacer.read(reads([limited({ remaining: 4100, reset: RESET, retryAfter: 60 }, 'You have exceeded a secondary rate limit.')]).fn);
  assert.deepEqual(secondary.lines, ['THROTTLE remaining=4100 until=2026-11-10T11:03:00Z']);
  assert.deepEqual(secondary.sleeps, [60_000 + RESET_SLACK_MS]);
});

test('a limit that says neither reset nor retry-after waits a minute', async () => {
  const h = harness();
  await h.pacer.read(reads([limited({})]).fn);
  assert.deepEqual(h.sleeps, [60_000 + RESET_SLACK_MS]);
});

test('a reset that moved (the window refilled and drained again) is slept out again before the read', async () => {
  const moved = RESET + 40 * 60;
  const h = harness({ cores: [{ remaining: 0, reset: moved }] });
  const r = reads([limited({ remaining: 0, reset: RESET })]);
  assert.equal(await h.pacer.read(r.fn), 'ok');
  assert.deepEqual(h.lines, ['THROTTLE remaining=0 until=2026-11-10T11:22:00Z', 'THROTTLE remaining=0 until=2026-11-10T12:02:00Z']);
  assert.equal(h.clock(), moved * 1000 + RESET_SLACK_MS);
  assert.equal(r.calls(), 2); // no read was spent while /rate_limit still said 0
});

test('a /rate_limit check that fails falls back to reading again', async () => {
  const h = harness({ cores: [new Error('fetch failed')] });
  const r = reads([limited({ remaining: 0, reset: RESET })]);
  assert.equal(await h.pacer.read(r.fn), 'ok');
  assert.equal(r.calls(), 2);
});

test(`continuous exhaustion past ${LIMIT_WAIT_MS / 60_000} min gives up with BudgetExhausted, without sleeping past the bound`, async () => {
  // The budget refills only to be drained again: every read after a reset is rate-limited once more.
  const errors = Array.from({ length: 10 }, (_, k) => limited({ remaining: 0, reset: RESET + k * 50 * 60 }));
  const h = harness();
  const r = reads(errors);
  await assert.rejects(h.pacer.read(r.fn), (e) => e instanceof BudgetExhausted
    && e.message === 'the GitHub API rate limit stayed exhausted for 90 min (resets 2026-11-10T13:52:00Z)');
  assert.equal(h.clock() - T0, LIMIT_WAIT_MS); // the third wait (reset 13:02) is cut to the bound, 12:32
  // 11:02 limited; 11:22 limited (reset 12:12); 12:12 limited (reset 13:02); 12:32 limited, the bound spent
  assert.equal(r.calls(), 4);
});

test('a /rate_limit that keeps saying 0 with a reset already past still gives up once 90 min have elapsed', async () => {
  const stale = { remaining: 0, reset: RESET };
  const h = harness({ cores: Array.from({ length: 500 }, () => stale) });
  const r = reads([limited({ remaining: 0, reset: RESET })]);
  await assert.rejects(h.pacer.read(r.fn), BudgetExhausted);
  assert.equal(h.clock() - T0, LIMIT_WAIT_MS);
  assert.equal(r.calls(), 1);
});

test('a reset published far past the bound (a skewed or moved window) is slept only until the bound', async () => {
  const h = harness({ cores: [{ remaining: 0, reset: RESET + 5 * 3600 }] });
  const r = reads([limited({ remaining: 0, reset: RESET + 5 * 3600 })]);
  await assert.rejects(h.pacer.read(r.fn), BudgetExhausted);
  assert.deepEqual(h.sleeps, [LIMIT_WAIT_MS]);
});

test('onLimited is called before the first wait begins, once per wait-out', async () => {
  const h = harness();
  const seen = [];
  await h.pacer.read(reads([limited({ remaining: 0, reset: RESET })]).fn, { onLimited: () => seen.push(h.sleeps.length) });
  assert.deepEqual(seen, [0]);
});

test('a read that succeeds in between starts the bound afresh', async () => {
  const h = harness();
  await h.pacer.read(reads([limited({ remaining: 0, reset: RESET + 3000 })]).fn); // 50 min + slack
  await h.pacer.read(reads([limited({ remaining: 0, reset: RESET + 3000 + 3000 })]).fn); // another 50 min
  assert.ok(h.clock() - T0 > LIMIT_WAIT_MS);
});

test('an error that is not the rate limit is the caller\'s: thrown at once, nothing waited', async () => {
  const h = harness();
  await assert.rejects(h.pacer.read(reads([new GitHubError(404, 'HTTP 404 GET /x: Not Found')]).fn), /404/);
  await assert.rejects(h.pacer.read(reads([limited({}, 'Resource not accessible by integration')]).fn), /not accessible/);
  assert.deepEqual([h.sleeps, h.lines], [[], []]);
});
