#!/bin/bash
# The VM lane's runner wrapper (docs/mac-lane.md, the VM lane), started by kickoff.sh in a job clone as
# `wrapper.sh <slot> <clone>`. It owns the clone's one runner: it runs `run.sh --once`, so the listener takes one job
# and exits; it tells the launcher, through out/, what the listener is doing, read from the listener's own diag log
# (diag.sh) and from the processes (a Runner.Worker, by the kernel's path: hooks/runner-state.py); it answers the
# launcher's idle stop; and when the runner has exited it copies the clone's record to out/ and powers the guest off,
# which ends the launcher's `tart run`. The runner and its hooks get CI_KIT_VM_SLOT and CI_KIT_VM_CLONE.
#
# THE out/ PROTOCOL. out/ is the slot's out share (/Volumes/My Shared Files/out in the guest, ~/ci-kit-vm/<slot>/out on
# the host). The launcher hands each clone an empty one: kickoff.sh refuses a clone whose out/ holds any marker below.
# A marker is one file, written once, replaced whole by a rename (a reader never sees half of one), holding one line of
# space-separated key=value fields unless said otherwise; times are UTC, YYYY-MM-DDTHH:MM:SSZ.
#
#   written by the guest                          meaning
#   listening        at=<time>                    the listener created its session and polls for its one job; <time>
#                                                 is the diag line's. After a self-update relaunch it is not rewritten.
#   session-conflict at=<time>                    the listener found the slot's last session still open at GitHub (a
#                                                 clone that died mid-job) and is retrying, every 30 s for up to 4 min;
#                                                 listening follows once the server lets go of it.
#   assigned         job=<id> at=<time> by=<how>  the listener took a job: by=diag, a job line in its diag log (<id>
#                                                 the job's GUID, or the acknowledged request's id, or -, and <time>
#                                                 the line's), by=worker, a Runner.Worker with no job line yet (job=-),
#                                                 or by=unknown, the processes could not be read when a stop was asked
#                                                 (fail closed: job=unknown). Minutes before the job's hook runs.
#   job              run=<run id> attempt=<n> job=<job key> repository=<owner/repo> at=<time>
#                                                 the job reached its job-started hook (hooks/job-started.sh), written
#                                                 before any check, so a refused job writes it too.
#   refused          <the refusal line>           the guest's hook refused the job: the `ci-kit: … rerun` line the
#                                                 job's log carries, verbatim.
#   stop-refused     job=<id>                     the answer to stop-request when the listener has taken a job (<id>
#                                                 as in assigned; assigned is written too): the guest is not stopped.
#   stop-raced       job=<id>                     the answer when no job was taken at the check, the listener was
#                                                 stopped, and its diag log then showed a job: the acceptance raced the
#                                                 stop, which cancelled the job at GitHub. assigned is not written.
#   stopped          at=<time>                    the answer when the listener took no job and was stopped.
#   done             <exit code>                  run.sh has exited, with that code, and _diag and the hooks log are in
#                                                 out/; the guest powers itself off next (`sudo -n shutdown -h now`).
#                                                 A guest that does not power off after done is the launcher's to stop.
#
#   written by the launcher
#   stop-request     (empty)                      past the idle bound with nothing assigned and nothing queued for it,
#                                                 the launcher asks for the listener's stop; the wrapper answers once,
#                                                 with exactly one of stop-refused, stop-raced or stopped. A request
#                                                 that finds the runner already exited is answered from its diag log.
#
#   also in out/: wrapper.log (this script's lines and the runner's console, live), and at the end _diag/ (the
#   listener's and the worker's diag logs: the update line the launcher counts as a refresh trigger is there) and
#   mac-runner-hooks.log (the guest's hook lines). Each marker the launcher reads it may read in any order: the
#   wrapper writes them as it sees them, one loop, so the answer to a stop never interleaves with a marker of its own.
#
# The idle handshake: at the request, the listener has taken a job if its diag log has a job line or a Runner.Worker
# runs; otherwise the wrapper sends the runner's process group SIGINT, the runner's graceful stop (Ctrl-C: the
# listener ends its session and exits without a job), waits for it to exit (CI_KIT_VM_STOP_WAIT, 60 s, then SIGKILL),
# and reads the diag log again. The check found no job line in it, so any job line now came after the check.
#
# Bounds and overrides: CI_KIT_VM_WATCH, the watch's poll (1 s); CI_KIT_VM_STOP_WAIT; CI_KIT_VM_SHUTDOWN, a command run
# in place of the power-off (tests).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd) || exit 1
# shellcheck source=guest.sh
source "$here/guest.sh"
# shellcheck source=diag.sh
source "$here/diag.sh"
slot=${1:?usage: wrapper.sh <slot> <clone>} clone=${2:?usage: wrapper.sh <slot> <clone>}
watch=${CI_KIT_VM_WATCH:-1}
stop_wait=${CI_KIT_VM_STOP_WAIT:-60}
[[ $stop_wait =~ ^[0-9]+$ ]] || stop_wait=60
runner_state=$here/../../hooks/runner-state.py

say() {
  printf '%s wrapper %s %s: %s\n' "$(vm_now)" "$slot" "$clone" "$*"
}
marked=' ' unwritten=' '
mark() { # <name> <contents>: written once; one that cannot be written is tried again by the next watch, logged once
  [[ $marked != *" $1 "* ]] || return 0
  if vm_mark "$1" "$2"; then
    marked+="$1 "
    say "out/$1: $2"
  elif [[ $unwritten != *" $1 "* ]]; then
    unwritten+="$1 "
    say "could not write out/$1 ($2)"
  fi
}

# The listener's record: d_listening, d_conflict, d_job_at and d_job, empty for what it has not done.
scan() {
  local key first rest
  d_listening='' d_conflict='' d_job_at='' d_job=''
  while read -r key first rest; do
    case $key in
      listening) d_listening=$first ;;
      conflict) d_conflict=$first ;;
      job) d_job_at=$first d_job=$rest ;;
    esac
  done < <(diag_scan "$vm_runner/_diag")
}
# Whether a job worker runs: 0 one does, 1 none, 2 the processes could not be read.
worker() {
  local state
  state=$(python3 -I "$runner_state" "$vm_runner" 2>/dev/null) || return 2
  [[ $state == busy* ]] && return 0
  return 1
}

watch_once() {
  scan
  [[ -z $d_conflict ]] || mark session-conflict "at=$d_conflict"
  [[ -z $d_listening ]] || mark listening "at=$d_listening"
  [[ $marked != *' assigned '* ]] || return 0
  if [[ -n $d_job ]]; then
    mark assigned "job=$d_job at=$d_job_at by=diag"
  elif worker; then
    mark assigned "job=- at=$(vm_now) by=worker"
  fi
}

answered=''
stopping=''
# The stop the launcher asked for, while the runner runs (or, with ended, after it exited by itself).
answer_stop() { # [ended]
  local busy=1 job
  answered=1
  say 'stop requested'
  scan
  if [[ -n $d_job ]]; then
    mark assigned "job=$d_job at=$d_job_at by=diag"
    mark stop-refused "job=$d_job"
    return
  fi
  if [[ -n ${1:-} ]]; then
    mark stopped "at=$(vm_now)"
    return
  fi
  worker
  busy=$?
  if ((busy != 1)); then
    job=-
    ((busy == 0)) || job=unknown
    mark assigned "job=$job at=$(vm_now) by=$([[ $job == - ]] && echo worker || echo unknown)"
    mark stop-refused "job=$job"
    return
  fi
  stopping=1
  say "no job taken; stopping the listener (SIGINT to $pid's group)"
  kill -INT -- "-$pid" 2>/dev/null || kill -INT "$pid" 2>/dev/null
  local deadline=$((SECONDS + stop_wait))
  while kill -0 "$pid" 2>/dev/null && ((SECONDS < deadline)); do sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then
    say "the runner did not exit within $stop_wait s of SIGINT; killing it"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  fi
  scan
  if [[ -n $d_job ]]; then
    mark stop-raced "job=$d_job"
  else
    mark stopped "at=$(vm_now)"
  fi
}

say "starting $vm_runner/run.sh --once"
export CI_KIT_VM_SLOT=$slot CI_KIT_VM_CLONE=$clone
# The runner gets its own process group, which the stop signals as a terminal's Ctrl-C would, and SIGINT back: a
# command started in the background of a non-interactive shell has it ignored, and a listener that ignores it cannot
# stop gracefully.
perl -e '$SIG{INT} = $SIG{QUIT} = "DEFAULT"; setpgrp(0, 0) or exit 126; exec { $ARGV[0] } @ARGV; exit 127' \
  "$vm_runner/run.sh" --once </dev/null &
pid=$!
while kill -0 "$pid" 2>/dev/null; do
  watch_once
  [[ -n $answered || ! -e $vm_out/stop-request ]] || answer_stop
  sleep "$watch"
done
wait "$pid"
code=$?
say "the runner exited ($code)"
if [[ -z $stopping ]]; then
  watch_once
  [[ -n $answered || ! -e $vm_out/stop-request ]] || answer_stop ended
fi
rm -rf "$vm_out/_diag" 2>/dev/null
[[ ! -d $vm_runner/_diag ]] || cp -R "$vm_runner/_diag" "$vm_out/_diag" || say 'could not copy _diag to out/'
[[ ! -f $vm_hooks_log ]] || cp "$vm_hooks_log" "$vm_out/mac-runner-hooks.log" || say 'could not copy the hooks log to out/'
mark 'done' "$code"
say 'powering off'
if [[ -n ${CI_KIT_VM_SHUTDOWN:-} ]]; then
  "$CI_KIT_VM_SHUTDOWN"
else
  sudo -n /sbin/shutdown -h now
fi || say "the power-off failed ($?)"
