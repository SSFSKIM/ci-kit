// The pace of ci-gate's polls against the GitHub token every session on the account shares (spec Decision Log,
// "ci-gate is a good citizen of the shared token"). One pacer serves a whole call, discovery and watch alike, so the
// low-budget THROTTLE line is said once.
import { setTimeout as delay } from 'node:timers/promises';
import { isRateLimited } from '../lib/github.mjs';

export const THROTTLE_BELOW = 500;
export const THROTTLED_MS = 60_000;
// An exhausted budget is waited out, not counted as a failed read: the run keeps going, and giving up loses its
// verdict. The wait is bounded at 90 minutes of continuous exhaustion: one hour's window, plus a reset that moved once
// because the window refilled and drained again (observed 2026-11-09). Past that something drains the budget without
// pause, and a human should look.
export const LIMIT_WAIT_MS = 90 * 60_000;
// Slept past the published reset, for the clocks' skew.
export const RESET_SLACK_MS = 5000;
// GitHub's advice when a limited answer gives neither a reset nor a retry-after.
const UNSAID_WAIT_MS = 60_000;

export const isLow = (remaining) => remaining !== null && remaining < THROTTLE_BELOW;

export const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export class BudgetExhausted extends Error {}

// When a rate-limited answer may be retried (GitHub's rule): after retry-after when it is given, after the reset when
// nothing remains, whichever is later; a minute from now when the answer says neither.
function resumeAt({ remaining = null, reset = null, retryAfter = null } = {}, nowMs) {
  const times = [];
  if (retryAfter !== null) times.push(nowMs + retryAfter * 1000);
  if (remaining === 0 && reset !== null) times.push(reset * 1000);
  return times.length > 0 ? Math.max(...times) : nowMs + UNSAID_WAIT_MS;
}

//   gh.stats() → { remaining }: the client's view of the budget (null until a response reports it);
//   gh.rateLimit() → { remaining, reset }: the core budget from /rate_limit, which GitHub does not count.
//   emit(line): one stdout line. now, sleep: the clock, injected by tests.
export function createPacer(gh, emit, { now = Date.now, sleep = delay } = {}) {
  let said = false;
  let exhaustedSince = null; // when the current run of rate-limited answers began; null again once a read succeeds
  let held = 0;
  let announced = null; // the resume time last said in a THROTTLE line: each is said once

  // Sleeps until the limit in `error` lifts, as /rate_limit confirms; throws BudgetExhausted past LIMIT_WAIT_MS.
  async function waitOut(error) {
    exhaustedSince ??= now();
    let remaining = error.rateLimit?.remaining ?? 0;
    let until = resumeAt(error.rateLimit, now());
    for (;;) {
      if (until - exhaustedSince > LIMIT_WAIT_MS) {
        throw new BudgetExhausted(`the GitHub API rate limit stayed exhausted for ${LIMIT_WAIT_MS / 60_000} min (resets ${iso(until)})`);
      }
      if (until !== announced) {
        announced = until;
        emit(`THROTTLE remaining=${remaining} until=${iso(until)}`);
      }
      const ms = until > now() ? until - now() + RESET_SLACK_MS : UNSAID_WAIT_MS;
      await sleep(ms);
      held += ms;
      let core;
      try {
        core = await gh.rateLimit();
      } catch {
        return; // the read itself will tell
      }
      if (core.remaining > 0) return;
      remaining = 0;
      until = core.reset * 1000;
    }
  }

  return {
    // The wait before the next poll: `baseMs` while the budget is healthy, THROTTLED_MS while it is low.
    wait(baseMs) {
      const { remaining } = gh.stats();
      if (!isLow(remaining)) return baseMs;
      if (!said) {
        said = true;
        emit(`THROTTLE remaining=${remaining}`);
      }
      return THROTTLED_MS;
    },
    // fn's answer. A rate-limited answer is waited out and fn read again; any other error is thrown to the caller.
    async read(fn) {
      for (;;) {
        try {
          const value = await fn();
          exhaustedSince = null;
          return value;
        } catch (e) {
          if (!isRateLimited(e)) throw e;
          await waitOut(e);
        }
      }
    },
    // How long this call has slept waiting out the limit (discovery does not count it against its deadline).
    heldMs: () => held,
  };
}
