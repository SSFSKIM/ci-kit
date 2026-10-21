// When the launcher's ticks run (spec 2026-10-21 M4, The launcher). Cloud Scheduler asks for a tick every minute, and
// the webhook receiver asks for one when a job is queued in a served repo (through Pub/Sub). Every tick is the same full tick, so
// requests need not each get their own: one tick runs at a time in the process, and every request that arrives while
// it runs is served by one more tick after it (at most one pending). Ticks start at least 10 s apart, which bounds a
// burst's cost in GitHub calls. While the App's remaining budget is low, a tick that only requests asked for is
// dropped: the minute tick alone serves, and a job waits at most that minute.

export const TICK_SPACING_MS = 10_000;
// A tick whose deadline (launcher.mjs TICK_BUDGET_MS) cut launches off (its outcome's `cut`) is followed by one more,
// TICK_SPACING_MS after its start, rather than leaving those jobs to the next minute tick: it joins the pending tick if
// there is one, and the request that asked for the cut tick is answered only once its follow-up has ended, because a
// tick run with no request open would have no CPU (the service runs with --cpu-throttling). FOLLOW_UPS bounds a run of
// them, and none starts FOLLOW_WINDOW_MS past the run's first tick: a tick takes up to ~90 s (its 45 s budget, then the
// inserts already sent, which wait up to 40 s), and a request held past Cloud Run's 300 s timeout, Cloud Scheduler's
// 300 s attempt deadline or Pub/Sub's 300 s ack deadline would fail or be redelivered. A pool that keeps running out
// of time waits for the next request.
export const FOLLOW_UPS = 3;
export const FOLLOW_WINDOW_MS = 180_000;

// tick({trigger, requests}) → its outcome: runs one tick; trigger is 'scheduled' when a scheduled request is among
// those it serves, 'requested' when another request is, else 'follow-up'; requests is how many requests it serves.
// budgetLow() → true while requested ticks (and follow-ups) are to be dropped, read when the tick would start. Returns
// serve(trigger) → the outcome of the tick that serves this request ({dropped, requests} when it was dropped), or the
// error it failed with.
export function createTicker({ tick, budgetLow, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), spacingMs = TICK_SPACING_MS }) {
  let running = null; // the tick in progress
  let pending = null; // {scheduled, requests, chain, since, done}: the tick that serves requests arriving now
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
    slot.since ??= lastStart;
    const mine = tick({ trigger: slot.scheduled ? 'scheduled' : slot.requests ? 'requested' : 'follow-up', requests: slot.requests });
    running = mine;
    let out;
    try {
      out = await mine;
    } finally {
      if (running === mine) running = null;
    }
    if (out?.cut > 0 && slot.chain < FOLLOW_UPS && now() - slot.since < FOLLOW_WINDOW_MS) await join('follow-up', slot.chain + 1, slot.since).catch(() => {});
    return out;
  }

  // A request, or a follow-up `chain` ticks into a run of them that began at `since`, joins the pending tick, or makes it.
  function join(trigger, chain = 0, since = null) {
    const slot = pending ?? (pending = { scheduled: false, requests: 0, chain: 0, since: null, done: null });
    if (trigger === 'follow-up') {
      slot.chain = Math.max(slot.chain, chain);
      slot.since = Math.min(slot.since ?? since, since);
    } else slot.requests += 1;
    if (trigger === 'scheduled') slot.scheduled = true;
    slot.done ??= start(slot);
    return slot.done;
  }

  return (trigger) => join(trigger);
}
