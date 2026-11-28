#!/bin/bash
# The runner's job-started hook (ACTIONS_RUNNER_HOOK_JOB_STARTED): its output is the first thing in the job's log.
# It records the cores this job runs on and the VM it got (machine type, spot or standard, zone; the guest passes them
# from its cloud's metadata), in the log and, where the runner gives the hook one, the job's summary: a slow job's page
# then says whether it ran on the pool's fallback machine.
line="ci-kit pool: runner ${RUNNER_NAME:-?} on ${CI_KIT_MACHINE:-?} (${CI_KIT_PROVISIONING:-?}, ${CI_KIT_ZONE:-?}), cores ${CI_KIT_CORES:-?} (nproc $(nproc))"
echo "$line"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$line" >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true; fi
exit 0
