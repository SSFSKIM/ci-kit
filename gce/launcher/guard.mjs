// The independent EC2 guard's trigger (ci-kit#222). GitHub starts pool-guard.yml's 15-minute schedule only every 6 to
// 9 hours, so Cloud Scheduler's ci-kit-pool-guard also POSTs /guard every 15 minutes and the launcher dispatches the
// workflow with the App's token. The guard still runs on GitHub Actions under its own OIDC role: it depends on the
// launcher for this trigger only, and its schedule stays as the second one. The workflow's concurrency group keeps
// one run going and at most one pending, whichever trigger asked.
export const GUARD = { repo: 'SSFSKIM/ci-kit', workflow: 'pool-guard.yml', ref: 'main' };
// Four missed triggers: a guard with no successful run on main in this long is silent, and its ERROR line is alerted
// on (gce/deploy.sh alert). The run just dispatched has not completed when this is read, so the check sees an earlier one.
export const GUARD_SILENT_MS = 60 * 60_000;

// github(): the launcher's App client (lib/github.mjs). say(severity, message, fields): the structured log line.
// The dispatch and the silence check are independent: a refused dispatch still reads the runs, since a guard that
// cannot be triggered is exactly the one that goes silent. Answers what both found; throws, after logging each
// failure at ERROR, when either failed, so the caller answers 500 and Cloud Scheduler records a failed execution.
export function createGuardTrigger({ github, say, now = Date.now }) {
  return async function guard() {
    let gh;
    try {
      gh = await github();
    } catch (err) {
      say('ERROR', `pool-guard trigger failed: no GitHub client: ${err.message}`, { event: 'pool-guard-dispatch-failed' });
      throw err;
    }
    const out = {};
    const failures = [];
    try {
      out.dispatched = (await gh.dispatchWorkflow(GUARD.repo, GUARD.workflow, { ref: GUARD.ref }))?.workflow_run_id ?? null;
    } catch (err) {
      say('ERROR', `pool-guard dispatch failed: ${err.message}`, { event: 'pool-guard-dispatch-failed' });
      failures.push(`dispatch: ${err.message}`);
    }
    try {
      const last = await gh.latestRun(GUARD.repo, GUARD.workflow, { status: 'success', branch: GUARD.ref });
      // updated_at is when a completed run last changed: its completion.
      const completed = last ? last.updated_at : null;
      out.lastSuccess = last ? { id: last.id, completed } : null;
      if (!completed || now() - Date.parse(completed) > GUARD_SILENT_MS) {
        say('ERROR', `pool-guard silent: no successful run on ${GUARD.ref} ${completed ? `since ${completed}` : 'ever'}; ` +
          'expired EC2 instances, volumes and snapshots are not being reaped', { event: 'pool-guard-silent', ...out });
      } else if (!failures.length) {
        say('INFO', `pool-guard dispatched; last success ${completed}`, out);
      }
    } catch (err) {
      say('ERROR', `pool-guard runs unreadable: ${err.message}`, { event: 'pool-guard-check-failed', ...out });
      failures.push(`runs: ${err.message}`);
    }
    if (failures.length) throw new Error(failures.join('; '));
    return out;
  };
}
