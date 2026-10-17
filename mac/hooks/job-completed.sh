#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_COMPLETED of the mac runner (I10): after a job, kill and log what it left under the runner's
# work directory, the orphaned test processes that once loaded the MacBook.
here=$(dirname "$0")
"$here/desktop-posture.sh" end || true
exec node "$here/sweep.mjs" job-completed
