#!/bin/bash
# The dialog watcher (docs/mac-lane.md): the LaunchAgent com.ssfskim.ci-kit.dialog-watch runs it every 60 s in the
# logged-in GUI session, from the hooks mac/install.sh copies into the runner. The job hook sees a system dialog only
# when a job starts; this sees one when no job does (2026-10-17: a SecurityAgent keychain dialog held the mini for 12
# minutes while MAWS held its runs, and nobody was told).
#
# - Each run reads the frontmost app, read-only (dialog.sh's lsappinfo read; no AppleScript, no GUI action).
# - A dialog on two consecutive reads opens the machine's episode: the source is attributed once, and the alert issue
#   is opened, unless the job hook opened it first. Three consecutive reads with no dialog close it (2026-10-17: a
#   dismissed prompt came back within a minute, twice).
# - While the episode is open the runner is held (a marker its LaunchAgent's wrapper waits on) and, once it has no
#   job, stopped, so queued jobs go to another Mac or wait instead of each being refused here in seconds. The episode's
#   close releases it.
#
# Every external call has a deadline. Nothing here clicks, types or dismisses anything.
set -uo pipefail
log_tag='dialog-watch'
here=$(dirname "$0")
# shellcheck source=dialog.sh
source "$here/dialog.sh"

runner_agent=com.ssfskim.ci-kit.mac-runner
runner_dir=$HOME/actions-runner-maws
drain_marker=$ci_kit_logs/runner-drained
domain=gui/$(id -u)

# One read's effect on the episode, under the lock.
watch_read() {
  load_state
  if is_dialog; then
    case $st_phase in
      open)
        st_at=$now_epoch
        if ((st_clear > 0)); then log "frontmost is $name: the dialog is back; the count of clear reads restarts"; fi
        st_clear=0 st_clear_since=''
        [[ -n $st_name ]] || st_name=$dialog
        save_state || true
        ;;
      pending)
        if [[ $st_name == "$dialog" ]] && consecutive; then
          if start_episode "$st_since"; then
            log "frontmost is $name since $st_since: $source; the episode opens"
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
          log "frontmost is $name: no dialog on $clear_reads reads in a row; the episode of $st_name since $st_since closes"
          close_episode
        else
          log "frontmost is $name: no dialog ($st_clear of $clear_reads reads)"
          save_state || true
        fi
        ;;
      pending)
        log "frontmost is $name: the $st_name seen at $st_since is gone; no episode"
        drop_state || true
        ;;
      *) drop_state || true ;;
    esac
  fi
}
first_read() {
  st_phase=pending st_name=$dialog st_since=$now st_at=$now_epoch st_source='' st_issue='' st_clear=0 st_clear_since=''
  save_state || true
  log "frontmost is $name: a system dialog; the episode opens if the next read sees it too"
}

# What the runner is doing: `busy <pid>…`, `idle` or `stopped` (runner-state.py, which reads the kernel's executable
# paths, never a command line). Only `idle` lets the drain stop it; anything else, a failure included, leaves it be.
runner_state() {
  bounded 10 python3 -I "$here/runner-state.py" "$runner_dir" 2>/dev/null
}

# The drain. A runner whose hook refuses every job in seconds draws most of the queue and fails it, while another Mac
# is busy. While the episode is open the marker holds the runner: the agent's program, runner-hold.sh, waits instead of
# starting it, after a stop, a crash or a reboot alike. An idle runner is stopped with SIGTERM to the agent (runsvc.sh
# turns it into the listener's graceful stop) and KeepAlive brings back only the waiting wrapper. Once the episode
# closes, removing the marker lets the wrapper start the runner. The watcher never loads, unloads, enables or disables
# anything, so a runner disabled by hand or by `install.sh --disabled` stays off. Stopping can still abort a job the
# listener took a moment before the check; that job fails as any job that loses its runner.
drain() {
  local runner
  load_state
  if [[ $st_phase == open ]]; then
    if [[ ! -e $drain_marker ]]; then
      if ! printf 'held at %s: %s since %s\n' "$now" "${st_name:-a system dialog}" "$st_since" >"$drain_marker"; then
        log "drain: could not write $drain_marker; the runner is not held"
        return 0
      fi
      log "drain: holding the runner while ${st_name:-a system dialog} holds the front (since $st_since)"
    fi
    runner=$(runner_state) || runner="failed ($?)"
    case $runner in
      stopped) ;;
      idle)
        if bounded 10 launchctl kill SIGTERM "$domain/$runner_agent" >/dev/null 2>&1; then
          log "drain: stopped the runner (no job running); it waits for the episode to close"
        else
          log "drain: SIGTERM to $runner_agent failed or timed out; retrying at the next read"
        fi
        ;;
      busy*) log "drain: a job is running ($runner); the runner stops once it is idle" ;;
      *) log "drain: could not tell whether a job is running: ${runner:-no answer}; the runner is left running" ;;
    esac
  elif [[ -z $st_phase && -e $drain_marker ]]; then
    if rm -f "$drain_marker"; then log "drain: released the runner: the episode closed"; fi
  fi
}

read_front
clock
if [[ -z $name ]]; then
  log "could not read the frontmost app; nothing changes"
elif [[ -e $dialog_state ]] || is_dialog; then
  if lock_state 0; then
    watch_read
    unlock_state
  else
    log "the job hook holds the dialog state; this read is skipped"
  fi
fi
drain
exit 0
