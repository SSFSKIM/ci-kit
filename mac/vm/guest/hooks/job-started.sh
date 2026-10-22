#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_STARTED of the VM lane's guest (docs/mac-lane.md, the VM lane): the host's start, cut down
# for a clone booted for this one job and deleted after it.
#
# - out/job tells the launcher the job reached its hook (wrapper.sh's header has the protocol), before any check, so a
#   refused job is known as one.
# - The desktop check (desktop-check.sh): the display, a system dialog, Terminal in front; a refusal is the lane's.
# - The cursor parked on the menu bar and the posture line, with the slot and the clone, as on the host.
#
# What the host's start does and this does not: no admission (the clone is the job's alone), no sweep (nothing ran
# before it, and nothing it leaves outlives the clone), no alert and no gh (the guest holds no credential beyond the
# runner's).
here=$(dirname "$0")
# shellcheck source=common.sh
source "$here/common.sh"
vm_mark job "run=${GITHUB_RUN_ID:--} attempt=${GITHUB_RUN_ATTEMPT:--} job=${GITHUB_JOB:--} repository=${GITHUB_REPOSITORY:--} at=$(vm_now)" ||
  echo "ci-kit guest: could not write $vm_out/job"
"$here/desktop-check.sh" || exit 1
# Fenced as on the host (job-started.sh): a 5 s deadline, every failure absorbed; it never blocks or fails the job.
if [[ -x $CI_KIT_CURSOR_PARK ]]; then
  {
    out=$(mktemp)
    perl -e 'alarm 5; exec @ARGV' "$CI_KIT_CURSOR_PARK" >"$out" 2>&1 && line=$(<"$out") ||
      line="failed or timed out: $(head -c 200 "$out" 2>/dev/null)"
    rm -f "$out"
    mkdir -p "${vm_hooks_log%/*}"
    echo "$(vm_now) cursor-park run=${GITHUB_RUN_ID:--} job=${GITHUB_JOB:--} $line" | tee -a "$vm_hooks_log"
  } || true
fi
vm_posture start
