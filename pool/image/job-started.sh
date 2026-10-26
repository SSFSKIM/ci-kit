#!/bin/bash
# The runner's job-started hook (ACTIONS_RUNNER_HOOK_JOB_STARTED): its output is the first thing in the job's log.
# It records the cores this job runs on.
echo "ci-kit pool: runner ${RUNNER_NAME:-?} on cores ${CI_KIT_CORES:-?} (nproc $(nproc))"
