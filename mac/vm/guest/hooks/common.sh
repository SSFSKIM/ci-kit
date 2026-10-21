#!/bin/bash
# Sourced by the guest's hooks (job-started.sh, job-completed.sh, desktop-check.sh), the host's hooks cut down for a
# clone that lives for one job (docs/mac-lane.md, the VM lane): what they share. The caller sets here, its own directory.
#
# The lane's own scripts are reused where they take their machine from CI_KIT_MACHINE and call no gh: dialog.sh (the
# dialog and frontmost reads), desktop-posture.sh (the posture fields). They sit in the kit's hooks/, beside vm/, as in
# the checkout. The compiled helpers are the image's, baked outside the read-only kit share: CI_KIT_CURSOR_PARK and
# CI_KIT_WINDOW_LIST name them (the runner's .env), ~/ci-kit-helpers/ when unset.
# shellcheck disable=SC2154 # here: set by the hook that sources this
lane_hooks=$here/../../../hooks
# shellcheck source=../guest.sh
source "$here/../guest.sh"
export CI_KIT_CURSOR_PARK=${CI_KIT_CURSOR_PARK:-$HOME/ci-kit-helpers/cursor-park}
export CI_KIT_WINDOW_LIST=${CI_KIT_WINDOW_LIST:-$HOME/ci-kit-helpers/window-list}
# Which slot and clone this is, from wrapper.sh through the runner's environment.
vm_fields="vm=${CI_KIT_VM_SLOT:-unknown} clone=${CI_KIT_VM_CLONE:-unknown}"

# The posture line, the host's with the slot and the clone first: in the job's log and the hooks log. Never fails.
vm_posture() { # <start|end>
  local fields line
  fields=$(/bin/bash "$lane_hooks/desktop-posture.sh" --read 2>/dev/null) || fields=''
  line="ci-kit desktop ($1): $vm_fields ${fields:-unknown}"
  printf '%s\n' "$line"
  {
    mkdir -p "${vm_hooks_log%/*}" &&
      printf '%s run=%s job=%s %s\n' "$(vm_now)" "${GITHUB_RUN_ID:--}" "${GITHUB_JOB:--}" "$line" >>"$vm_hooks_log"
  } 2>/dev/null || true
}
