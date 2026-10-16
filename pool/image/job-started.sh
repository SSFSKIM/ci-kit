#!/bin/bash
# The runner's job-started hook (ACTIONS_RUNNER_HOOK_JOB_STARTED): its output is the first thing in the job's log.
# It records the cores this job runs on, and, on a box smaller than the job asked for, that it was clamped.
echo "ci-kit pool: runner ${RUNNER_NAME:-?} on cores ${CI_KIT_CORES:-?} (nproc $(nproc))"
if [ -n "${CI_KIT_CLAMPED:-}" ]; then
  echo "ci-kit pool: this job asked for cpus-${CI_KIT_CLAMPED}; this box has $(nproc) cores, so it runs on all of them (clamped)"
fi
