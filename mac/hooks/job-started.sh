#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_STARTED of the mac runner (I10): before a job, refuse it at once if a system dialog holds
# focus on the desktop and put Terminal in front (desktop-check.sh), park the real cursor on the menu bar
# (cursor-park.swift), then kill what an earlier job left under the runner's work directory, so no job starts beside
# another's Electron windows or test processes.
here=$(dirname "$0")
"$here/desktop-check.sh" || exit 1
# The real cursor goes to the menu bar, out of every app window (cursor-park.swift). Logged; never blocks the job.
if [[ -x $here/cursor-park ]]; then
  "$here/cursor-park" 2>&1 | sed "s/^/$(date -u +%Y-%m-%dT%H:%M:%SZ) cursor-park run=${GITHUB_RUN_ID:--} job=${GITHUB_JOB:--} /" |
    tee -a "$HOME/Library/Logs/ci-kit/mac-runner-hooks.log"
fi
exec node "$here/sweep.mjs" job-started
