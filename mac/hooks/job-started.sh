#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_STARTED of the mac runner (I10): before a job, refuse it at once if a system dialog holds
# focus on the desktop and put Terminal in front of Finder (desktop-check.sh), then kill what an earlier job left under
# the runner's work directory, so no job starts beside another's Electron windows or test processes.
here=$(dirname "$0")
"$here/desktop-check.sh" || exit 1
exec node "$here/sweep.mjs" job-started
