// When the launcher's ticks run (spec 2026-10-21 M4, The launcher). Cloud Scheduler asks for a tick every minute, and
// the webhook receiver asks for one when a pool job is queued (through Pub/Sub). Every tick is the same full tick, so
// requests need not each get their own: one tick runs at a time in the process, and every request that arrives while
// it runs is served by one more tick after it (at most one pending). Ticks start at least 10 s apart, which bounds a
// burst's cost in GitHub calls. While the App's remaining budget is low, a tick that only requests asked for is
// dropped: the minute tick alone serves, and a job waits at most that minute.

export const TICK_SPACING_MS = 10_000;

// tick({trigger, requests}) → its outcome: runs one tick; trigger is 'scheduled' when a scheduled request is among
// those it serves, else 'requested'; requests is how many requests it serves. budgetLow() → true while requested ticks
// are to be dropped, read when the tick would start. Returns serve(trigger) → the outcome of the tick that serves
// this request ({dropped, requests} when it was dropped), or the error it failed with.
export function createTicker({ tick, budgetLow, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), spacingMs = TICK_SPACING_MS }) {
  let running = null; // the tick in progress
  let pending = null; // {scheduled, requests, done}: the tick that serves requests arriving now
  let lastStart = -Infinity;

  async function start(slot) {
    if (running) await running.catch(() => {});
    const wait = lastStart + spacingMs - now();
    if (wait > 0) await sleep(wait);
    // Leaving the queue: requests from here on wait for the next tick. No await until the tick starts, so no request
    // can find both this slot gone and no tick running.
    pending = null;
    if (!slot.scheduled && budgetLow()) return { dropped: 'rate budget', requests: slot.requests };
    lastStart = now();
    const mine = tick({ trigger: slot.scheduled ? 'scheduled' : 'requested', requests: slot.requests });
    running = mine;
    try {
      return await mine;
    } finally {
      if (running === mine) running = null;
    }
  }

  return function serve(trigger) {
    const slot = pending ?? (pending = { scheduled: false, requests: 0, done: null });
    slot.requests += 1;
    if (trigger === 'scheduled') slot.scheduled = true;
    slot.done ??= start(slot);
    return slot.done;
  };
}
