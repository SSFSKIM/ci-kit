// Finding the run a ci-gate push started: poll the runs of the nonce commit until the caller workflow's push run shows.
// The listing is conditional, so polls that find nothing new are free 304s; the pace still yields to a low budget.

const DEADLINE_MS = 2 * 60 * 1000;
const EVERY_MS = 5000;

const iso = (epochSeconds) => new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Returns { run } or { error }: the I5 ERROR message when no run showed within 2 minutes of the push. The last poll
// lands on the deadline even when the pace is stretched, so a throttled call still looks as late as a healthy one.
export async function findRun({ gh, repo, commit, caller, ref, pacer, now, sleep, deadlineMs = DEADLINE_MS, everyMs = EVERY_MS }) {
  const deadline = now() + deadlineMs;
  let lastError = null;
  while (now() < deadline) {
    await sleep(Math.min(pacer.wait(everyMs), deadline - now()));
    try {
      const runs = await gh.runsForCommit(repo, commit);
      lastError = null;
      const run = runs.find((r) => r.event === 'push' && r.path === caller);
      if (run) return { run };
    } catch (e) {
      lastError = e; // the next poll retries
    }
  }
  const { remaining, reset } = gh.stats();
  const limited = remaining === 0 || ([403, 429].includes(lastError?.status) && /rate limit/i.test(lastError.message));
  if (limited) {
    const when = reset ? `, resets ${iso(reset)}` : '';
    return { error: `the GitHub API rate limit is exhausted (remaining ${remaining ?? 0}${when}); could not look for the run of ${ref}` };
  }
  return { error: `no run of ${caller} appeared within 2 min of the push to ${ref}` };
}
