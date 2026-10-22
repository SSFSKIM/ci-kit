#!/bin/bash
# The step of the measured-job guard (action.yml beside it, docs/mac-lane.md). A timing measurement taken under a
# desktop that is not the calibrated one is void: on 2026-10-18 MAWS lost two measured sets on the mini, one to another
# session's parallel renders (a 1-minute load of 15 and more), one to a Parsec viewer that switched the display to @1x.
#
# Every 30 s it reads the desktop posture, and releases the job once two consecutive reads each meet every condition:
# the 1-minute load under SETTLE_LOAD, the display at SETTLE_DISPLAY's scale, no remote viewer (SETTLE_REMOTE=none:
# Parsec or screensharingd), no computer-use process (SETTLE_COMPUTERUSE=none). `any` leaves a condition unchecked. A
# read that fails is unknown, and unknown meets no condition. When the next read would come after SETTLE_BOUND minutes,
# the job is refused with the job-started check's `ci-kit: … rerun` line, which MAWS's ci-gate.sh counts as refused,
# not red; the line names what kept the last reads from settling and what they read. Settled or refused, that one line
# goes to the job's log and to the hooks log.
#
# The reads are desktop-posture.sh --read from this action's own checkout: the guard and the reads it judges ship under
# one tag, so moving v1 never meets an installed hook set that lacks them. Only the display helper comes from the
# runner's installed hooks, since install.sh compiles it there; the runner's .env names their directory.
#
# On a Mac with the VM lane installed (mac/hooks/instances.sh), a measured job also keeps the lane's guest out
# (mac/hooks/vm-claim.sh, from the same checkout): before its first read it raises the measured claim, vm-claim.<its
# Runner.Worker>, so no guest boots until its job-completed hook removes the claim, and each read reads the guest's
# reservation (vm=none, reserved or unknown) as SETTLE_VM=none's condition: released only while no guest may be running.
# A claim that cannot be raised refuses the job at once, since the lane would boot beside it. The line names the claim.
# Without the lane none of this runs, and the line is as it was.
# Bash 3.2: macOS's own.
set -uo pipefail
here=$(dirname "$0")
interval=30
machine=${CI_KIT_MACHINE:-mini}
installed=$(dirname "${ACTIONS_RUNNER_HOOK_JOB_STARTED:-$HOME/actions-runner-maws/ci-kit/hooks/job-started.sh}")

want_load=${SETTLE_LOAD:-5} want_display=${SETTLE_DISPLAY:-@2x} want_remote=${SETTLE_REMOTE:-none}
want_computeruse=${SETTLE_COMPUTERUSE:-none} want_vm=${SETTLE_VM:-none} bound=${SETTLE_BOUND:-15}
bad_input() { echo "ci-kit settle: $1 takes $2, not '$3'" >&2; exit 2; }
# The load in hundredths, as sysctl prints it to two decimals, so the comparison is integer arithmetic.
if [[ $want_load =~ ^([0-9]+)([.]([0-9]{1,2}))?$ ]]; then
  frac=${BASH_REMATCH[3]}00
  want_load=$((10#${BASH_REMATCH[1]} * 100 + 10#${frac:0:2}))
elif [[ $want_load != any ]]; then
  bad_input load 'a number with at most two decimals, or any' "$want_load"
fi
[[ $want_display =~ ^@[0-9]+([.][0-9]+)?x$ || $want_display == any ]] || bad_input display 'a scale like @2x, or any' "$want_display"
[[ $want_remote == none || $want_remote == any ]] || bad_input remote 'none or any' "$want_remote"
[[ $want_computeruse == none || $want_computeruse == any ]] || bad_input computeruse 'none or any' "$want_computeruse"
[[ $want_vm == none || $want_vm == any ]] || bad_input vm 'none or any' "$want_vm"
[[ $bound =~ ^[1-9][0-9]*$ ]] || bad_input bound 'a whole number of minutes, at least 1' "$bound"
lane=''
# shellcheck source=mac/hooks/instances.sh
if source "$here/../hooks/instances.sh" 2>/dev/null && vm_lane_installed; then lane=1; fi

# One read: posture (the posture line's fields) and failed (each condition it does not meet, with what it read).
fields='^frontmost=(.*) display=([^ ]*) remote=([^ ]*) load=([^ ]*) computeruse=(.*)$'
read_posture() {
  local display remote load computeruse scale
  posture=$(CI_KIT_CURSOR_PARK=$installed/cursor-park bash "$here/../hooks/desktop-posture.sh" --read 2>/dev/null)
  if [[ $posture =~ $fields ]]; then
    display=${BASH_REMATCH[2]} remote=${BASH_REMATCH[3]} load=${BASH_REMATCH[4]%%/*} computeruse=${BASH_REMATCH[5]}
  else
    display=unknown remote=unknown load=unknown computeruse=unknown
    posture="frontmost=unknown display=unknown remote=unknown load=unknown computeruse=unknown"
  fi
  failed=''
  if [[ $want_load != any ]]; then
    [[ $load =~ ^[0-9]+[.][0-9]{2}$ ]] && ((10#${load/./} < want_load)) || failed+="${failed:+, }load $load"
  fi
  if [[ $want_display != any ]]; then
    scale=unknown
    [[ $display =~ (@[0-9.]+x)$ ]] && scale=${BASH_REMATCH[1]}
    [[ $scale == "$want_display" ]] || failed+="${failed:+, }display $scale"
  fi
  if [[ $want_remote != any ]]; then
    [[ $remote != unknown ]] || failed+="${failed:+, }remote unknown"
    [[ $remote != *parsec* ]] || failed+="${failed:+, }parsec"
    [[ $remote != *screensharing* ]] || failed+="${failed:+, }screensharingd"
  fi
  if [[ $want_computeruse != any ]]; then
    [[ $computeruse == none ]] || failed+="${failed:+, }computeruse $computeruse"
  fi
  if [[ -n $lane ]]; then
    vm=$(bash "$here/../hooks/vm-claim.sh" reservation 2>/dev/null)
    [[ $vm == none || $vm == reserved ]] || vm=unknown
    posture+=" vm=$vm"
    [[ $want_vm == any || $vm == none ]] || failed+="${failed:+, }vm $vm"
  fi
}

record() { # <line> <stream>: the job's log and the hooks log, in that file's line style
  printf '%s\n' "$1" >&"$2"
  {
    mkdir -p "$HOME/Library/Logs/ci-kit" &&
      printf '%s settle run=%s job=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${GITHUB_RUN_ID:--}" "${GITHUB_JOB:--}" "$1" \
        >>"$HOME/Library/Logs/ci-kit/mac-runner-hooks.log"
  } 2>/dev/null || true
}

start=$(date -u +%s)
claim=''
if [[ -n $lane && $want_vm != any ]]; then
  # Only the claim's name comes out on success; why it could not be raised otherwise.
  if ! claim=$(bash "$here/../hooks/vm-claim.sh" measured "$$" 2>&1) || [[ ! $claim =~ ^vm-claim[.][^[:space:]]+$ ]]; then
    claim=${claim//$'\n'/; }
    record "ci-kit: the $machine could not keep the guest out for a measured job (${claim:-the claim failed}) — rerun" 2
    exit 1
  fi
  claim="claim: $claim; "
fi
read_posture
first=$posture previous=''
while :; do
  # No read comes after the bound: when the next would, the job is refused on what the last two read.
  waited=$(($(date -u +%s) - start))
  if ((waited + interval > bound * 60)); then
    record "ci-kit: the $machine did not settle for a measured job within $bound min (${failed:-$previous}); waited $waited s; ${claim}start: $first; refusal: $posture — fix that there and rerun" 2
    exit 1
  fi
  previous=$failed
  sleep "$interval"
  read_posture
  if [[ -z $failed && -z $previous ]]; then
    record "ci-kit settle: settled in $(($(date -u +%s) - start)) s; ${claim}start: $first; release: $posture" 1
    exit 0
  fi
done
