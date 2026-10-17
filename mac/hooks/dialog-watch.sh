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
# - While the episode is open and the runner has no job, the runner's LaunchAgent is stopped, so queued jobs go to
#   another Mac or wait instead of each being refused here in seconds. After the episode closes, only a runner this
#   stopped is started again.
#
# Every external call has a deadline. Nothing here clicks, types or dismisses anything.
set -uo pipefail
log_tag='dialog-watch'
here=$(dirname "$0")
# shellcheck source=dialog.sh
source "$here/dialog.sh"

runner_agent=com.ssfskim.ci-kit.mac-runner
runner_plist=$HOME/Library/LaunchAgents/$runner_agent.plist
worker=$HOME/actions-runner-maws/bin/Runner.Worker
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

runner_loaded() {
  bounded 10 launchctl print "$domain/$runner_agent" >/dev/null 2>&1
}
runner_enabled() { # positively not disabled; an unreadable listing is not that
  local listing
  listing=$(bounded 10 launchctl print-disabled "$domain" 2>/dev/null) || return 1
  ! grep -Fq -e "\"$runner_agent\" => disabled" -e "\"$runner_agent\" => true" <<<"$listing"
}
# Whether the runner has a job, as `busy <pid>…` or `idle`: a process whose executable is exactly the runner's
# Runner.Worker (runner-worker.py reads the kernel's path, not a command line, which any process can carry). Only `idle`
# lets the drain stop the runner; anything else, a failure included, leaves it running.
runner_jobs() {
  bounded 10 python3 -I "$here/runner-worker.py" "$worker" 2>/dev/null
}

# The drain. A runner whose hook refuses every job in seconds draws most of the queue and fails it, while another Mac
# is busy. The watcher stops it only while it has no job, and records that in a marker beside the episode; launchctl's
# disabled state keeps it stopped through a reboot (RunAtLoad loads nothing disabled). It is started again only after
# the episode closes, and only while the marker says this stopped it: a runner disabled by `install.sh --disabled` or by
# hand (docs/mac-lane.md removes the marker) stays off. A loaded runner that is already disabled is not this one's to
# stop. Stopping can still abort a job the listener took a moment before the check; that job fails as any killed job.
drain() {
  local workers
  load_state
  if [[ $st_phase == open ]]; then
    runner_loaded || return 0
    if [[ ! -e $drain_marker ]] && ! runner_enabled; then return 0; fi
    workers=$(runner_jobs) || workers="failed ($?)"
    case $workers in
      idle) ;;
      busy*)
        log "drain: a job is running ($workers); $runner_agent left running"
        return 0
        ;;
      *)
        log "drain: could not tell whether a job is running: ${workers:-no answer}; $runner_agent left running"
        return 0
        ;;
    esac
    if ! printf 'stopped at %s: %s since %s\n' "$now" "$st_name" "$st_since" >"$drain_marker"; then
      log "drain: could not write $drain_marker; $runner_agent left running"
      return 0
    fi
    bounded 10 launchctl disable "$domain/$runner_agent" >/dev/null 2>&1 || log "drain: launchctl disable failed or timed out"
    if bounded 10 launchctl bootout "$domain/$runner_agent" >/dev/null 2>&1; then
      log "drain: stopped $runner_agent: $st_name in front since $st_since, no job running"
    else
      log "drain: stopping $runner_agent failed or timed out; retrying at the next read"
    fi
  elif [[ -z $st_phase && -e $drain_marker ]]; then
    if runner_loaded; then
      rm -f "$drain_marker"
      log "drain: $runner_agent was started by someone else; nothing to start"
    elif [[ ! -f $runner_plist ]]; then
      rm -f "$drain_marker"
      log "drain: $runner_plist is gone; $runner_agent not started"
    elif bounded 10 launchctl enable "$domain/$runner_agent" >/dev/null 2>&1 &&
      bounded 10 launchctl bootstrap "$domain" "$runner_plist" >/dev/null 2>&1; then
      rm -f "$drain_marker"
      log "drain: started $runner_agent: the episode closed"
    else
      log "drain: starting $runner_agent failed or timed out; retrying at the next read"
    fi
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
