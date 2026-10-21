#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_COMPLETED of the VM lane's guest (docs/mac-lane.md, the VM lane): the posture line at the
# job's end, with the slot and the clone. Nothing else of the host's end: no sweep and no drain (the clone is deleted
# after this job, and its runner exits by itself: run.sh --once), no claim to release, no gh.
here=$(dirname "$0")
# shellcheck source=common.sh
source "$here/common.sh"
vm_posture end
exit 0
