#!/bin/bash
# The dialog watcher (docs/mac-lane.md): the LaunchAgent com.ssfskim.ci-kit.dialog-watch runs it every 60 s in the
# logged-in GUI session, from the hooks mac/install.sh copies into the runner. The job hook sees a system dialog only
# when a job starts; this sees one when no job does (2026-10-17: a SecurityAgent keychain dialog held the mini for 12
# minutes while MAWS held its runs, and nobody was told).
#
# - Each run reads the frontmost app and the windows on screen, read-only (dialog.sh's lsappinfo read and window-list;
#   no AppleScript, no GUI action), so a dialog on screen without focus counts as one in front does.
# - When CI_KIT_DISPLAY is configured, read_display checks it too (dialog.sh, including its bounded retries). A
#   mismatch or persistent unreadable display shares the episode below; no GUI action restores it here.
# - Two consecutive blocked reads open the machine's episode (dialog.sh's continues_pending): the source is attributed
#   once, and the alert issue opens unless the job hook opened it first. Three consecutive reads with no dialog and a
#   matching configured display close it (2026-10-17: a dismissed prompt came back within a minute, twice), and its alert
#   with it: a close that fails is tried again at
#   each read until it goes through (2026-10-20: it failed while the network came up after a reboot, and the open alert
#   held every Mac job until it was closed by hand).
# - While the episode is open every instance's runner is held (a marker each LaunchAgent's wrapper waits on) and stopped
#   between jobs: when its job ends, or once it is confirmed idle. Queued jobs then go to another Mac or wait instead of
#   each being refused here in seconds. The episode's close releases them.
# - While the shared hold is up (shared-hold.sh), each read reconciles it: a crashed exclusive job's hold is dropped
#   once its work directory is swept.
#
# `dialog-watch.sh --job-end <pid> [<ready file>]` is the drain at one job's end, started by job-completed.sh (job_end
# below).
#
# Every external call has a deadline. Nothing here clicks, types or dismisses anything.
set -uo pipefail
log_tag='dialog-watch'
here=$(dirname "$0")
# shellcheck source=dialog.sh
source "$here/dialog.sh"
# shellcheck source=instances.sh
source "$here/instances.sh"

drain_marker=$ci_kit_logs/runner-drained
domain=gui/$(id -u)

# One read's effect on the episode, under the lock.
watch_read() {
  load_state
  if is_blocked; then
    case $st_phase in
      open)
        st_at=$now_epoch
        if ((st_clear > 0)); then log "$seen: the dialog is back; the count of clear reads restarts"; fi
        st_clear=0 st_clear_since=''
        [[ -n $st_name ]] || st_name=$dialog
        save_state || true
        ;;
      closed)
        if reopen_episode; then
          st_at=$now_epoch
          save_state || true
        else
          first_read
        fi
        ;;
      pending)
        if continues_pending; then
          if start_episode "$st_since"; then
            log "$seen since $st_since: $source; the episode opens"
            alert_episode 'the dialog watcher (two reads in a row)'
          fi
        else
          first_read
        fi
        ;;
      *) first_read ;;
    esac
  else
    case $st_phase in
      open)
        if ((st_clear > 0)) && consecutive; then
          st_clear=$((st_clear + 1))
        else
          st_clear=1 st_clear_since=$now
        fi
        st_at=$now_epoch
        if ((st_clear >= clear_reads)); then
          log "$seen: $clear_condition on $clear_reads reads in a row; the episode of $st_name since $st_since closes"
          close_episode
        else
          log "$seen: $clear_condition ($st_clear of $clear_reads reads)"
          save_state || true
        fi
        ;;
      closed) retry_close || true ;;
      pending)
        log "$seen: the $st_name seen at $st_since is gone; no episode"
        drop_state || true
        ;;
      *) drop_state || true ;;
    esac
  fi
}
first_read() {
  st_phase=pending st_name=$dialog st_since=$now st_at=$now_epoch st_source='' st_issue='' st_clear=0 st_clear_since=''
  st_cleared='' st_commented=''
  save_state || true
  local condition='a system dialog' next='sees it too'
  [[ $dialog != Display ]] || condition='a display fault'
  [[ -z $expected_display ]] || next='still finds the desktop blocked'
  log "$seen: $condition; the episode opens if the next read $next"
}

# What an instance's runner is doing: `busy <pid>…`, `idle <listener log> <size>` or `stopped` (runner-state.py, which
# reads the kernel's executable paths, never a command line). Only idle lets the drain stop it, and only on two
# matching reads; anything else, a failure included, leaves it be.
runner_state() { # <instance root>
  bounded 10 python3 -I "$here/runner-state.py" "$1" 2>/dev/null
}

# The drain. A runner whose hook refuses every job in seconds draws most of the queue and fails it, while another Mac
# is busy. While the episode is open the marker holds the runner: the agent's program, runner-hold.sh, waits instead of
# starting it, after a stop, a crash or a reboot alike. The runner is stopped with SIGTERM to the agent (runsvc.sh
# turns it into the listener's graceful stop) and KeepAlive brings back only the waiting wrapper. Once the episode
# closes, removing the marker lets the wrapper start the runner. The watcher never loads, unloads, enables or disables
# anything, so a runner disabled by hand or by `install.sh --disabled` stays off.
#
# A stop must land between jobs. The listener asks for the next job the moment a job's worker exits: on 2026-10-18 the
# mini was offered one within the second and acquired it two seconds later, twice, while the drain waited for its
# 60 s tick (job_end below). A stop while a worker runs cancels its job. A stop after the listener has been offered a
# job, before its worker starts, leaves that job acquired and never run: in progress on an offline runner (09:59:18,
# when the drain read idle in the second a job was offered; stop_idle below).
hold() { # under the episode lock: the hold follows the episode as it stands now; an alert close owed holds nothing
  load_state
  if [[ $st_phase == open ]]; then
    if [[ ! -e $drain_marker ]]; then
      if ! printf 'held at %s: %s since %s\n' "$now" "${st_name:-a system dialog}" "$st_since" >"$drain_marker"; then
        log "drain: could not write $drain_marker; the runner is not held"
        return 0
      fi
      log "drain: holding the runner while ${st_name:-a system dialog} is up (since $st_since)"
    fi
    held=1
  elif [[ (-z $st_phase || $st_phase == closed) && -e $drain_marker ]]; then
    if rm -f "$drain_marker"; then
      log "drain: released the runner: the episode closed"
    else
      log "drain: could not remove $drain_marker; the runner stays held"
    fi
  fi
}
stop_runner() { # <instance root> <why>
  local agent
  agent=$(instance_agent "$1")
  if bounded 10 launchctl kill SIGTERM "$domain/$agent" >/dev/null 2>&1; then
    log "drain: stopped $(instance_title "$1") ($2); it waits for the episode to close"
  else
    log "drain: SIGTERM to $agent failed or timed out; retrying at the next read"
  fi
}
# An idle read alone does not show that no job is coming: a job the listener has just been offered has no worker for
# its first seconds. A second read idle_gap seconds later must print the same line, which also says the listener
# logged nothing in between (runner-state.py): the offer, and the acquiring that follows it for about two seconds, are
# logged as they happen. A stop right after the second read reaches the listener before it can acquire a job offered
# since. Any difference waits for a later read.
idle_gap=${CI_KIT_IDLE_GAP:-5}
# Every instance at once: one read of each, then, when any reads idle, one gap and a second read of those.
stop_idle() { # outside the lock: only the watcher closes an episode, so the hold outlasts this
  local roots=() first=() root i again idle=''
  roots=("$lane_root")
  while IFS= read -r root; do roots+=("$root"); done < <(shared_instances)
  for i in "${!roots[@]}"; do
    root=${roots[i]}
    first[i]=$(runner_state "$root") || first[i]="failed ($?)"
    case ${first[i]} in
      stopped) ;;
      idle*) idle=1 ;;
      busy*) log "drain: a job is running$(on_instance "$root") (${first[i]}); $(instance_title "$root") stops when it ends" ;;
      *) log "drain: could not tell whether a job is running$(on_instance "$root"): ${first[i]:-no answer}; $(instance_title "$root") is left running" ;;
    esac
  done
  [[ -n $idle ]] || return 0
  sleep "$idle_gap"
  for i in "${!roots[@]}"; do
    root=${roots[i]}
    [[ ${first[i]} == idle* ]] || continue
    again=$(runner_state "$root") || again="failed ($?)"
    if [[ $again == "${first[i]}" ]]; then
      stop_runner "$root" "no job running or offered on two reads $idle_gap s apart"
    else
      log "drain: two reads $idle_gap s apart differ (${first[i]}, then ${again:-no answer}): a job may be on its way; $(instance_title "$root") stops at a later read"
    fi
  done
}
# The drain at a job's end. job-completed.sh, which runs inside the job's worker before the worker reports the job's
# result, starts this detached, with its parent: the worker, and a ready file it waits on until the watch is armed, so
# the worker cannot exit unseen. The worker reports the result and then exits, and this sees the exit as it happens
# (runner-state.py --wait). If the runner is held then, it is stopped at once: the listener
# shuts down well before it can acquire the job it asks for next, and the job that ended has already reported. Held or
# not is decided at the exit, so an episode that opens while the job finishes counts too. The instance is the one whose
# hooks started this (job-completed.sh runs its own copy).
job_end() { # <pid of the job's worker> [<ready file>]
  local ended deadline=${CI_KIT_JOB_END_WAIT:-600} root
  root=$(instance_root "$here") || root=$lane_root
  ended=$(bounded "$deadline" python3 -I "$here/runner-state.py" "$root" --wait "$1" ${2:+"$2"} 2>/dev/null) ||
    ended="failed ($?)"
  [[ -e $drain_marker ]] || return 0
  case $ended in
    exited) stop_runner "$root" "its job ended while it was held" ;;
    *) log "drain: the end of this job could not be watched (${ended:-no answer}); the next idle read stops $(instance_title "$root")" ;;
  esac
}
if [[ ${1:-} == --job-end ]]; then
  job_end "${2:-0}" ${3:+"$3"}
  exit 0
fi

# A window list that cannot be read is logged when that starts and when it ends, not at every read: until then each
# read sees a dialog only in front, as before the helper.
windows_noted=$ci_kit_logs/window-list.miss
note_windows() {
  local noted=''
  [[ ! -e $windows_noted ]] || IFS= read -r noted <"$windows_noted" 2>/dev/null || true
  if [[ -n $windows_miss && $windows_miss != "$noted" ]]; then
    log "could not read the windows on screen ($windows_miss); a dialog is seen only in front until it can"
    printf '%s\n' "$windows_miss" >"$windows_noted" || true
  elif [[ -z $windows_miss && -e $windows_noted ]]; then
    log "the windows on screen read again"
    rm -f "$windows_noted" || true
  fi
}

# One locked step per run: the read's effect on the episode, then the hold that follows from it. The job hook
# publishes an episode under the same lock, so a release never acts on a phase the hook has since replaced. A run
# that finds the lock taken changes nothing and tries again a minute later. A read that cannot tell the app in front
# changes nothing either, unless a dialog is on screen: that one is up whatever is in front.
held=
read_front
read_windows
read_display
clock
note_windows
[[ -n $name || -n $screen_dialog || -n $display_fault ]] || log "could not read the frontmost app; nothing changes"
if [[ -e $dialog_state || -e $drain_marker ]] || is_blocked; then
  if lock_state 0; then
    [[ -z $name && -z $screen_dialog && -z $display_fault ]] || watch_read
    hold
    unlock_state
  else
    log "the job hook holds the dialog state; this read is skipped"
  fi
fi
[[ -z $held ]] || stop_idle
# The shared hold: a crashed exclusive job's is reconciled, and the alert of one that stayed stuck closed once it is down.
if [[ -e $shared_hold || -e $ci_kit_logs/shared-hold.alert ]]; then
  bounded 300 "$here/shared-hold.sh" reconcile >/dev/null || log "shared hold: the reconcile failed or timed out ($?)"
fi
exit 0
