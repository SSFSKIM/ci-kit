#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_STARTED of the mac runner (I10): before a job, refuse it at once if a system dialog holds
# focus on the desktop and put Terminal in front (desktop-check.sh), park the real cursor on the menu bar
# (cursor-park.swift), then kill what an earlier job left under the runner's work directory, so no job starts beside
# another's Electron windows or test processes.
here=$(dirname "$0")
"$here/desktop-check.sh" || exit 1
# The real cursor goes to the menu bar, out of every app window (cursor-park.swift). The runner runs this hook with
# -e -o pipefail, so the optional step is fenced: a 5 s deadline (perl's alarm; macOS has no timeout(1)) and every
# failure, the helper's or the log's, is absorbed. It never blocks or fails the job.
if [[ -x $here/cursor-park ]]; then
  {
    out=$(mktemp)
    # Output goes to a file, not a pipe: the hook waits only for the helper, never for anything it left behind.
    perl -e 'alarm 5; exec @ARGV' "$here/cursor-park" >"$out" 2>&1 && line=$(<"$out") ||
      line="failed or timed out: $(head -c 200 "$out" 2>/dev/null)"
    rm -f "$out"
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) cursor-park run=${GITHUB_RUN_ID:--} job=${GITHUB_JOB:--} $line" |
      tee -a "$HOME/Library/Logs/ci-kit/mac-runner-hooks.log"
  } || true
fi
exec node "$here/sweep.mjs" job-started
