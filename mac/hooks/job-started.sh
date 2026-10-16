#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_STARTED of the mac runner (I10): before a job, kill what an earlier job left under the
# runner's work directory, so no job starts beside another's Electron windows or test processes.
exec node "$(dirname "$0")/sweep.mjs" job-started
