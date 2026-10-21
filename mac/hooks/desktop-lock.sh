#!/bin/bash
# Sourced by what decides under the desktop lock (shared-hold.sh, vm-claim.sh, the VM lane's launcher): the lock itself,
# the waits' bounds, and the markers that name a job by its worker (docs/mac-lane.md). The caller sources dialog.sh
# first (ci_kit_logs, log, bounded, clock).
#
# A marker names a job by its run, its job and its worker: the Runner.Worker's pid and the start time the kernel gives
# it, so a reused pid or a reboot cannot pass for it. Markers are replaced whole (a rename).
#
# The lock is flock(2) through perl, as dialog.sh takes its own, which the kernel releases with its holder: a process
# killed mid-transition leaves no lock behind. Bash 3.2: macOS's own.
desktop_lock=$ci_kit_logs/desktop.lock
poll=${CI_KIT_SHARED_POLL:-1} # the waits' poll, in seconds
minutes() { # <value> <default>: a number of minutes, the default when it is not one
  [[ $1 =~ ^[0-9]+([.][0-9]+)?$ ]] && printf '%s\n' "$1" || printf '%s\n' "$2"
}
seconds() { # <minutes>
  perl -e 'printf "%d\n", $ARGV[0] * 60 + 0.5' "$1"
}

# The lock: flock(2) on descriptor 8, taken by a helper on the inherited descriptor, and held until this shell closes
# it or exits. What runs while it is held gets the descriptor closed, so nothing can carry it away.
lock() { # [<seconds to wait>]: 30 unless told
  mkdir -p "$ci_kit_logs" 2>/dev/null || return 1
  exec 8>>"$desktop_lock" || return 1
  if perl -MFcntl=:flock -e '
    open(my $fh, ">>&=", 8) or exit 2;
    local $SIG{ALRM} = sub { exit 1 };
    alarm shift;
    exit(flock($fh, LOCK_EX) ? 0 : 1);
  ' "${1:-30}"; then
    return 0
  fi
  exec 8>&-
  return 1
}
unlock() {
  exec 8>&-
}

# The kernel's start time of a process, in the C locale; empty when it cannot be read.
started_of() { # <pid>
  LC_ALL=C bounded 5 /bin/ps -o lstart= -p "$1" 8>&- 2>/dev/null | sed -e 's/^ *//' -e 's/ *$//'
}
# Whether the worker a marker names still runs. False only when it is gone, or its pid now holds another process: a
# read that fails cannot tell, and counts as running.
alive() { # <pid> <start time>
  local now status
  [[ $1 =~ ^[1-9][0-9]*$ ]] || return 1
  now=$(LC_ALL=C bounded 5 /bin/ps -o lstart= -p "$1" 8>&- 2>/dev/null)
  status=$?
  now=$(sed -e 's/^ *//' -e 's/ *$//' <<<"$now")
  if [[ -z $now ]]; then ((status != 1)); return; fi
  [[ -z $2 || $now == "$2" ]]
}

# A marker's fields, as m_*; false when it is not there.
read_marker() { # <file>
  local key value
  m_run='' m_job='' m_worker='' m_started='' m_since='' m_text=''
  m_text=$(cat "$1" 2>/dev/null) || return 1
  while IFS='=' read -r key value; do
    case $key in
      run) m_run=$value ;;
      job) m_job=$value ;;
      worker) m_worker=$value ;;
      started) m_started=$value ;;
      since) m_since=$value ;;
    esac
  done <<<"$m_text"
  return 0
}
named() { # the job the marker read last names
  printf 'run %s job %s (worker %s)' "${m_run:--}" "${m_job:--}" "${m_worker:--}"
}
write_marker() { # <file> <what> <worker pid> <its start time>: under the lock
  printf '%s since %s: run %s job %s (worker %s)\nrun=%s\nattempt=%s\njob=%s\nworker=%s\nstarted=%s\nsince=%s\n' \
    "$2" "$now" "${GITHUB_RUN_ID:--}" "${GITHUB_JOB:--}" "$3" "${GITHUB_RUN_ID:--}" "${GITHUB_RUN_ATTEMPT:--}" \
    "${GITHUB_JOB:--}" "$3" "$4" "$now" >"$1.tmp" && mv -f "$1.tmp" "$1"
}
# Removes the marker if it names the worker given; under the lock.
remove_named() { # <file> <worker pid> <its start time> <what> <why>
  if ! lock; then
    log "could not take the lock to remove the $4; it goes stale with its worker"
    return 1
  fi
  if read_marker "$1"; then
    if [[ $m_worker == "$2" && $m_started == "$3" ]]; then
      if rm -f "$1"; then log "removed the $4 of $(named) ($5)"; else log "could not remove $1"; fi
    else
      log "the $4 names another job, $(named); left alone"
    fi
  fi
  unlock
}
