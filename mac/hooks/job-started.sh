#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_STARTED of every instance of the mac lane (I10): before a job, refuse it at once if a system
# dialog holds focus on the desktop and put Terminal in front (desktop-check.sh), park the real cursor on the menu bar
# (cursor-park.swift), then kill what an earlier job left under the runner's work directory, so no job starts beside
# another's Electron windows or test processes.
#
# Before all that, on a Mac with shared instances (instances.sh), the job is admitted to the desktop
# (shared-hold.sh): the exclusive instance's job raises the shared hold and waits until no shared job runs, so it runs
# alone; a shared instance's job waits while the hold is up. The worker, this hook's parent, names the job. Without
# shared instances this is the hook it always was.
here=$(dirname "$0")
# shellcheck source=instances.sh
source "$here/instances.sh"
# On a Mac with the VM lane, the exclusive instance's job is classified first (vm-claim.sh): one whose workflow does not
# promise that its measured jobs run settle raises a claim, so no guest boots beside it, and waits, after its shared
# admission, until no guest runs; one bound covers both waits. A shared instance's job needs no classification: only a
# workflow that makes the promise can ask for its label.
SECONDS=0
vm=
if vm_lane_installed && ! shared_number "$(instance_root "$here")" >/dev/null; then
  if "$here/vm-claim.sh" exclusive-start "$PPID"; then vm=safe; else
    (($? == 3)) || exit 1
    vm=claimed
  fi
fi
lane=
if [[ -n $(shared_instances) ]]; then
  if shared_number "$(instance_root "$here")" >/dev/null; then lane=shared; else lane=exclusive; fi
  "$here/shared-hold.sh" "$lane-start" "$PPID" || exit 1
fi
if [[ $vm == claimed ]]; then "$here/vm-claim.sh" exclusive-wait "$SECONDS" || exit 1; fi
# A job refused from here on keeps its admission until its job-completed hook releases it: the steps that run after a
# failure still run (shared-hold.sh).
"$here/desktop-check.sh" || exit 1
# The real cursor goes to the menu bar, out of every app window (cursor-park.swift). The runner runs this hook with
# -e -o pipefail, so the optional step is fenced: a 5 s deadline (perl's alarm; macOS has no timeout(1)) and every
# failure, the helper's or the log's, is absorbed. It never blocks or fails the job.
if [[ -x $here/cursor-park ]]; then
  {
    out=$(mktemp)
    # Output goes to a file, not a pipe: the hook waits only for the helper, never for anything it left behind.
    perl -e 'alarm 5; exec @ARGV' "$here/cursor-park" >"$out" 2>&1 && line=$(<"$out") ||
      line="failed or timed out: $(head -c 200 "$out" 2>/dev/null)"
    rm -f "$out"
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) cursor-park run=${GITHUB_RUN_ID:--} job=${GITHUB_JOB:--} $line" |
      tee -a "$HOME/Library/Logs/ci-kit/mac-runner-hooks.log"
  } || true
fi
"$here/desktop-posture.sh" start "$PPID" || true
exec node "$here/sweep.mjs" job-started
