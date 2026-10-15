#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_COMPLETED of the mac runner (I10): after a job, kill and log what it left under the runner's
# work directory, the orphaned test processes that once loaded the MacBook.
exec node "$(dirname "$0")/sweep.mjs" job-completed
