// Finding the run a ci-gate push started: poll the runs of the nonce commit until the caller workflow's push run shows.
// The listing is conditional, so polls that find nothing new are free 304s; the pace still yields to a low budget.
import { BudgetExhausted } from './pace.mjs';

// GitHub has created a push's run minutes late (2026-10-21, 2026-11-04), and giving up deletes the ref, which turns the
// late run into a failure with an empty branch. A run that does appear is found at once, so only a push that never
// triggers pays the long deadline.
const DEADLINE_MS = 5 * 60 * 1000;
const NOTE_AFTER_MS = 60 * 1000;
const EVERY_MS = 5000;

// Returns { run }, or { error } with the I5 ERROR message: no run showed within 5 minutes of the push, or the rate
// limit stayed exhausted past the pacer's bound (then also runMayExist: the push most likely started a run ci-gate
// could not see). An exhausted budget is waited out (pace.mjs), and the time waited extends the deadline: the deadline
// is for GitHub to create the run, not for the budget to come back. The last poll lands on the deadline even when the
// pace is stretched. After a minute without the run, `note` says once that the call is still waiting.
export async function findRun({ gh, repo, commit, caller, ref, pacer, now, sleep, note = () => {}, deadlineMs = DEADLINE_MS, everyMs = EVERY_MS }) {
  const start = now();
  let deadline = start + deadlineMs;
  let noted = false;
  while (now() < deadline) {
    await sleep(Math.min(pacer.wait(everyMs), deadline - now()));
    const held = pacer.heldMs();
    try {
      const runs = await pacer.read(() => gh.runsForCommit(repo, commit));
      const run = runs.find((r) => r.event === 'push' && r.path === caller);
      if (run) return { run };
    } catch (e) {
      if (e instanceof BudgetExhausted) return { error: `${e.message}; could not look for the run of ${ref}`, runMayExist: true };
      // any other failure: the next poll retries
    }
    deadline += pacer.heldMs() - held;
    if (!noted && now() - start >= NOTE_AFTER_MS && now() < deadline) {
      noted = true;
      note(`no run of ${caller} yet a minute after the push to ${ref}; waiting up to ${deadlineMs / 60_000} min`);
    }
  }
  return { error: `no run of ${caller} appeared within ${deadlineMs / 60_000} min of the push to ${ref}` };
}
