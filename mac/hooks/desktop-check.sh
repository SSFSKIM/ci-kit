#!/bin/bash
# Part of the mac runner's job-started hook: make this Mac's desktop the same before every job.
#
# - A system dialog in front, or on screen without focus, refuses the job at once. An e2e job under a modal alert fails
#   group after group on focus and pasteboard (2026-10-16: seven groups red, UserNotificationCenter frontmost), and its
#   real input can land on one that floats over the app in front (2026-10-21: a SecurityAgent keychain prompt sat on
#   screen for hours with Terminal in front). Dialogs are the human's to dismiss; this never tries to clear one. The
#   refusal opens the machine's dialog episode and its alert issue unless the dialog watcher already did (dialog.sh,
#   dialog-watch.sh): they share it.
# - With CI_KIT_DISPLAY configured, a different main display or persistent probe failure also refuses (dialog.sh).
#   It shares the episode and hold above; this check only reads the display, never changes it.
# - Any other app in front is replaced by Terminal: some of MAWS's paste and to-human results depend on the app in
#   front (Finder where focus falls when an e2e app quits; Chrome after a test leaked a URL into it), so every job
#   starts from the same one. `open -a Terminal` goes through LaunchServices (no Apple Events, no Automation consent);
#   the job fails fast if Terminal is not in front within about 5 s. It acts only before the job, so MAWS's own
#   MAWS_E2E_FOREGROUND=1 is never fought.
#
# When the frontmost app cannot be read, only a dialog on screen or a failed display check blocks; when the windows on
# screen cannot be read, a dialog is seen only in front. Either miss is logged.
set -uo pipefail
log_tag='desktop-check'
# shellcheck source=dialog.sh
source "$(dirname "$0")/dialog.sh"

# A refused job opens the episode at once when none is open; a pending first read by the watcher lends it its time. In
# an open episode it names the episode's time, and the episode's source when the same dialog is up: the source
# is read once per episode, when it opens. Its read restarts the watcher's count of clear reads. A closed episode whose
# alert's close is owed is settled as the watcher settles it (reopen_episode): the close is tried, and while it cannot
# go through the episode reopens with its alert. The lock wait outlasts the watcher's longest hold (attribution, then
# gh).
refuse_dialog() {
  local since=$now opened=''
  source='source unknown' source_line=''
  if lock_state 45; then
    load_state
    [[ $st_phase != closed ]] || reopen_episode || load_state
    if [[ $st_phase == open ]]; then
      since=$st_since
      [[ $st_name != "$dialog" ]] || source=$st_source
      [[ -n $st_name ]] || st_name=$dialog
      st_clear=0 st_clear_since=''
      save_state || true
    else
      if [[ $st_phase == pending && $st_name == "$dialog" ]] && consecutive; then since=$st_since; fi
      if start_episode "$since"; then opened=1; fi
    fi
  else
    log "the dialog state stayed locked; refusing without touching the episode"
    load_state
    if [[ $st_phase == open ]]; then
      since=$st_since
      [[ $st_name != "$dialog" ]] || source=$st_source
    fi
  fi
  if [[ $dialog == Display ]]; then
    log "$display_detail; desktop held since $since; failing the job"
    echo "ci-kit: $display_detail on the $machine; desktop held since $(minute "$since") — restore its display there and rerun" >&2
  else
    log "$seen: $source; a system dialog $dialog_held since $since; failing the job"
    echo "ci-kit: a system dialog ($dialog: $source) $dialog_held on the $machine since $(minute "$since") — dismiss it there and rerun" >&2
  fi
  [[ -z $opened ]] || alert_episode "a refused job (run ${GITHUB_RUN_ID:--})" || true
  unlock_state
}

# A read that sees no dialog ends the watcher's pending first read. An open episode is the watcher's to close, after
# three clear reads about a minute apart: a job's read comes at job cadence, not on that clock. An alert close owed is
# the watcher's to finish too. Only a pending read takes the lock, since the file is replaced whole: no job waits on a
# watcher's gh calls for an episode it leaves alone.
passed_dialog() {
  [[ -e $dialog_state ]] || return 0
  load_state
  case $st_phase in open | closed) return 0 ;; esac
  lock_state 45 || return 0
  load_state
  case $st_phase in open | closed) ;; *) drop_state || true ;; esac
  unlock_state
}

read_front
# Read-only entry point for the start/end posture reporter; no focus changes, dialog alerts or logging.
if [[ ${1:-} == --frontmost ]]; then
  printf '%s\n' "${name:-unknown}"
  exit 0
fi
read_windows
[[ -z $windows_miss ]] || log "could not read the windows on screen ($windows_miss); a dialog is seen only in front"

read_display
if is_blocked; then
  clock
  refuse_dialog
  exit 1
fi
if [[ -z $name ]]; then
  log "could not read the frontmost app; not blocking the job"
  exit 0
fi
passed_dialog || true

if is_app com.apple.Terminal Terminal; then
  log "frontmost is $name"
  exit 0
fi

before=$name
if ! open -a Terminal; then
  log "frontmost before=$before; open -a Terminal failed; failing the job"
  echo "ci-kit: could not open Terminal on the $machine ($before is in front) — check its desktop and rerun" >&2
  exit 1
fi
for _ in 1 2 3 4 5 6 7 8 9 10; do
  read_front
  is_app com.apple.Terminal Terminal && break
  sleep 0.5
done
log "frontmost before=$before after=${name:-unreadable}"
if [[ -z $name ]]; then
  log "could not read the frontmost app after opening Terminal; not blocking the job"
elif ! is_app com.apple.Terminal Terminal; then
  echo "ci-kit: Terminal did not come to the front on the $machine ($name is) — check its desktop and rerun" >&2
  exit 1
fi
