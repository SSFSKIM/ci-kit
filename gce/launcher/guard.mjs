// The independent EC2 guard's trigger (ci-kit#222). GitHub starts pool-guard.yml's 15-minute schedule only every 6 to
// 9 hours, so Cloud Scheduler's ci-kit-pool-guard also POSTs /guard every 15 minutes and the launcher dispatches the
// workflow with the App's token. The guard still runs on GitHub Actions under its own OIDC role: it depends on the
// launcher for this trigger only, and its schedule stays as the second one. The workflow's concurrency group keeps
// one run going and at most one pending, whichever trigger asked.
export const GUARD = { repo: 'SSFSKIM/ci-kit', workflow: 'pool-guard.yml', ref: 'main' };
// Four missed triggers: a guard with no successful run in this long is silent, and its ERROR line is alerted on
// (gce/deploy.sh alert). The run just dispatched has not completed when this is read, so the check sees the previous one.
export const GUARD_SILENT_MS = 60 * 60_000;

// github(): the launcher's App client (lib/github.mjs). say(severity, message, fields): the structured log line.
// Answers what was dispatched and the newest successful run; throws when the dispatch failed, after logging it.
export function createGuardTrigger({ github, say, now = Date.now }) {
  return async function guard() {
    let dispatched;
    try {
      const gh = await github();
      dispatched = await gh.dispatchWorkflow(GUARD.repo, GUARD.workflow, { ref: GUARD.ref });
    } catch (err) {
      say('ERROR', `pool-guard dispatch failed: ${err.message}`, { event: 'pool-guard-dispatch-failed' });
      throw err;
    }
    const out = { dispatched: dispatched?.workflow_run_id ?? null };
    let last;
    try {
      last = await (await github()).latestRun(GUARD.repo, GUARD.workflow, 'success');
    } catch (err) {
      // The dispatch went through, so a guard run is on its way; only the silence check is lost this time.
      say('WARNING', `pool-guard dispatched, but its last successful run is unreadable: ${err.message}`, out);
      return out;
    }
    // updated_at is when a completed run last changed: its completion.
    const completed = last ? last.updated_at : null;
    out.lastSuccess = last ? { id: last.id, completed } : null;
    const silentMs = completed ? now() - Date.parse(completed) : Infinity;
    if (silentMs > GUARD_SILENT_MS) {
      const since = completed ? `since ${completed}` : 'ever';
      say('ERROR', `pool-guard silent: no successful run ${since}; expired EC2 instances, volumes and snapshots are not being reaped`,
        { event: 'pool-guard-silent', ...out });
    } else {
      say('INFO', `pool-guard dispatched; last success ${completed}`, out);
    }
    return out;
  };
}
