#!/bin/bash
# Admission to the desktop on a Mac with shared instances (instances.sh, docs/mac-lane.md): the exclusive instance's
# jobs run alone, the shared instances' jobs beside each other. Both sides decide under one lock, so no job's check can
# be overtaken by another's write.
#
#   shared-hold.sh exclusive-start <worker pid>  the exclusive instance's job-started hook, before its desktop check
#   shared-hold.sh exclusive-end <worker pid>    its job-completed hook, once its sweep went through
#   shared-hold.sh shared-start <worker pid>     a shared instance's job-started hook, before its desktop check
#   shared-hold.sh shared-end <worker pid>       its job-completed hook, once its sweep went through
#   shared-hold.sh reconcile                     the dialog watcher, at each read while a hold is up or its alert open
#
# Two kinds of marker in ~/Library/Logs/ci-kit, each naming a job by its run, its job and its worker (the
# Runner.Worker's pid and the start time the kernel gives it, so a reused pid or a reboot cannot pass for it):
#
# - shared-running-<n>: shared instance n runs a job. The shared start writes it once no hold is up, and its end removes
#   it after its own sweep. A marker whose worker is gone is stale, and counts for nothing.
# - shared-hold: the hold, raised by the exclusive start. No shared job is admitted while it is up, nor while the
#   dialog watcher holds every runner (runner-drained): a shared start waits, a second at a time, at most
#   CI_KIT_SHARED_WAIT minutes (60), and is then refused. The exclusive start waits, at most CI_KIT_EXCLUSIVE_WAIT
#   minutes (10), until no live running marker is left, then sweeps every shared _work, sparing the jobs still parked
#   in their own start (each live shared worker and what it started), so what a dead or finished shared job left is
#   gone before the exclusive job starts. Past its bound, or when a sweep fails, the job is refused. Every refusal is a
#   `ci-kit: … rerun` line.
# - A claim, once made (a running marker written, the hold raised), is kept until the job's job-completed hook releases
#   it after its own sweep, whatever becomes of the job's start: a refused hook fails its step, but the steps that run
#   after a failure (failure(), always(), !cancelled(), cancelled()) still run, and the runner runs that hook at the end
#   of every job (always()). A failed end sweep keeps the claim: a shared marker until its worker is gone, the hold for
#   the dialog watcher.
# - reconcile is the recovery for a crashed exclusive job (its worker died, so no job-completed hook ran): under the
#   lock, once the worker the hold names is gone, its _work is swept and the hold dropped. A sweep that fails keeps the
#   hold up and opens one alert issue, closed once no hold is up. An exclusive start that finds such a hold does the
#   same before raising its own.
# - A sweep here is of a _work that is not its own job's, so it spares every live job worker of the user and what that
#   started, read from its own process list (sweep.mjs --spare-workers): a job parked in its own hook, or one whose
#   worker started since the caller last looked.
#
# The lock is flock(2) through perl, as dialog.sh takes its own, which the kernel releases with its holder: a process
# killed mid-transition leaves no lock behind. Markers are replaced whole (a rename). Bash 3.2: macOS's own.
set -uo pipefail
log_tag='shared-hold'
here=$(dirname "$0")
# shellcheck source=dialog.sh
source "$here/dialog.sh"
# shellcheck source=instances.sh
source "$here/instances.sh"

desktop_lock=$ci_kit_logs/desktop.lock
drain_marker=$ci_kit_logs/runner-drained
stuck_alert=$ci_kit_logs/shared-hold.alert
poll=${CI_KIT_SHARED_POLL:-1}
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

# An instance's own copy of the sweep, which finds its _work from where it sits, sparing every live job worker's tree.
# It may run under the lock: the descriptor is closed for it.
sweep() { # <instance root>
  bounded 120 node "$1/ci-kit/hooks/sweep.mjs" shared-hold --spare-workers 8>&-
}

exclusive_start() { # <worker pid>
  local worker=$1 started roots=() root live said='' bound stale=''
  started=$(started_of "$worker")
  bound=$(minutes "${CI_KIT_EXCLUSIVE_WAIT:-}" 10)
  clock
  refuse() { # <why>: the hold stays up until this job's end, whatever runs of it before then
    log "refusing this job: $1; the hold stays up until it ends"
    echo "ci-kit: the shared runners on the $machine did not make way for an exclusive job ($1); waited $SECONDS s — rerun" >&2
    exit 1
  }
  SECONDS=0
  if ! lock 180; then
    log "the desktop lock stayed taken for 180 s; refusing this job"
    echo "ci-kit: the desktop lock on the $machine stayed taken — rerun" >&2
    exit 1
  fi
  # A hold this job finds is a job's that never reached its end (this instance runs one job at a time): what it left is
  # swept before this one's hold replaces it.
  if read_marker "$shared_hold"; then
    log "the hold of $(named) outlived its job; sweeping $instance/_work"
    sweep "$instance" || stale="the work directory of $(named) could not be swept"
  fi
  if ! write_marker "$shared_hold" held "$worker" "$started"; then
    unlock
    log "could not write $shared_hold; refusing this job"
    echo "ci-kit: the shared hold could not be raised on the $machine ($shared_hold) — rerun" >&2
    exit 1
  fi
  unlock
  [[ -z $stale ]] || refuse "$stale"
  log "raised the hold for this job: no shared job starts until it ends; waiting for the running ones (at most $bound min)"
  while :; do
    live=''
    if lock; then
      for marker in "$ci_kit_logs"/shared-running-*; do
        if [[ ! -e $marker ]] || ! read_marker "$marker"; then continue; fi
        if alive "$m_worker" "$m_started"; then
          live+="${live:+, }shared runner ${marker##*-}: $(named)"
        else
          rm -f "$marker" && log "the marker of shared runner ${marker##*-}, $(named), is stale: its worker is gone"
        fi
      done
      unlock
    else
      live='the desktop lock stayed taken'
    fi
    [[ -n $live ]] || break
    [[ $live == "$said" ]] || log "waiting for $live"
    said=$live
    ((SECONDS < $(seconds "$bound"))) || refuse "after $bound min: $live"
    sleep "$poll"
  done
  # What a dead or finished shared job left. A job still in its own start, or in its end after its own sweep, is spared
  # with its worker.
  while IFS= read -r root; do roots+=("$root"); done < <(shared_instances)
  for root in ${roots[@]+"${roots[@]}"}; do
    sweep "$root" || refuse "$(instance_title "$root")'s work directory could not be swept"
  done
  log "admitted after $SECONDS s: no shared job runs, and the shared work directories are swept"
}

# What keeps a shared job out: the hold, or the dialog watcher's hold on every runner. Empty when nothing does.
holder() {
  local why
  why=$(perl -e 'exit 0 if lstat $ARGV[0]; exit 1 if $!{ENOENT}; print "$!"; exit 2' "$shared_hold" 2>&1)
  case $? in
    0)
      read_marker "$shared_hold" || true
      printf 'an exclusive job, run %s job %s, holds the desktop since %s' "${m_run:--}" "${m_job:--}" "${m_since:-?}"
      return
      ;;
    1) ;;
    *) printf 'cannot tell whether an exclusive job holds the desktop (%s: %s)' "$shared_hold" "${why:-the lookup failed}"; return ;;
  esac
  why=$(perl -e 'exit 0 if lstat $ARGV[0]; exit 1 if $!{ENOENT}; print "$!"; exit 2' "$drain_marker" 2>&1)
  case $? in
    0) printf 'the dialog watcher holds every runner (%s)' "$(head -1 "$drain_marker" 2>/dev/null)" ;;
    1) ;;
    *) printf 'cannot tell whether the dialog watcher holds the runners (%s: %s)' "$drain_marker" "${why:-the lookup failed}" ;;
  esac
}

shared_start() { # <worker pid>
  local worker=$1 started n marker why said='' bound
  n=$(shared_number "$(instance_root "$here")") || n=0
  marker=$ci_kit_logs/shared-running-$n
  started=$(started_of "$worker")
  bound=$(minutes "${CI_KIT_SHARED_WAIT:-}" 60)
  SECONDS=0
  while :; do
    clock
    if lock; then
      why=$(holder)
      if [[ -z $why ]]; then
        if ! write_marker "$marker" running "$worker" "$started"; then
          unlock
          log "could not write $marker; refusing this job"
          echo "ci-kit: shared runner $n on the $machine could not record its job ($marker) — rerun" >&2
          exit 1
        fi
        unlock
        [[ -z $said ]] || log "admitted after $SECONDS s"
        return 0
      fi
      unlock
    else
      why='the desktop lock stayed taken'
    fi
    [[ $why == "$said" ]] || log "parked: $why"
    said=$why
    if ((SECONDS >= $(seconds "$bound"))); then
      log "refusing this job after $bound min: $why"
      echo "ci-kit: shared runner $n on the $machine waited $bound min to start ($why) — rerun" >&2
      exit 1
    fi
    sleep "$poll"
  done
}

# The stuck hold's alert, in the repository the dialog alerts go to. Its title is outside MAWS's dialog-alert pattern
# (^ci-kit alert: <machine>: <dialog> since …), so ci-gate.sh never reads it as a dialog on the machine.
open_alert() { # <why>
  local out body url=''
  [[ ! -e $stuck_alert ]] || return 0
  out=$(mktemp) || return 0
  read_alert_token
  printf -v body 'Time: %s\nMachine: %s\nHold: %s\nWhy: %s\nWhile the hold is up, no shared job starts (jobs that ask for ci-kit-mac-shared wait, then are refused), and the exclusive instance runs its jobs alone.\n' \
    "$now" "$machine" "$(head -1 "$shared_hold" 2>/dev/null)" "$1"
  if alert_gh issue create --repo "$alert_repo" --label ci-kit-alert \
    --title "ci-kit alert: shared hold stuck on $machine since $(minute "${m_since:-$now}"): $1" --body "$body" >"$out" 2>/dev/null; then
    IFS= read -r url <"$out" || true
  else
    log "shared hold alert issue creation failed or timed out; not retried"
  fi
  printf '%s\n' "${url:-none}" >"$stuck_alert" || true
  rm -f "$out" || true
}
close_alert() {
  local url=''
  [[ -e $stuck_alert && ! -e $shared_hold ]] || return 0
  IFS= read -r url <"$stuck_alert" || true
  if [[ -n $url && $url != none ]]; then
    read_alert_token
    if ! alert_gh issue close "$url" --repo "$alert_repo" --comment "cleared at $now: the shared hold is down" >/dev/null 2>&1; then
      log "shared hold alert close failed or timed out; tried again at the next read"
      return 0
    fi
    log "closed the shared hold alert $url"
  fi
  rm -f "$stuck_alert"
}

reconcile() {
  local why=''
  clock
  if [[ -e $shared_hold ]]; then
    lock || return 0
    # Under the lock: the hold, its owner and the sweep are read and acted on with no job's start between them.
    if read_marker "$shared_hold" && ! alive "$m_worker" "$m_started"; then
      log "the hold of $(named) outlived its job: its worker is gone; sweeping $lane_root/_work"
      if sweep "$lane_root" >/dev/null; then
        rm -f "$shared_hold" && log "dropped the hold of $(named): its job is over and its work directory swept"
      else
        why="the exclusive instance's leftovers survived the sweep"
        log "the sweep of $lane_root/_work failed; the hold stays up, and no shared job starts"
      fi
    fi
    unlock
    [[ -z $why ]] || open_alert "$why"
  fi
  close_alert
}

instance=$(instance_root "$here")
case ${1:-} in
  exclusive-start) exclusive_start "${2:?a worker pid}" ;;
  exclusive-end) remove_named "$shared_hold" "${2:?a worker pid}" "$(started_of "$2")" hold 'its job ended' || true ;;
  shared-start) shared_start "${2:?a worker pid}" ;;
  shared-end)
    n=$(shared_number "$instance") || n=0
    remove_named "$ci_kit_logs/shared-running-$n" "${2:?a worker pid}" "$(started_of "$2")" 'running marker' 'its job ended' || true
    ;;
  reconcile) reconcile ;;
  *) echo 'usage: shared-hold.sh exclusive-start|exclusive-end|shared-start|shared-end <worker pid> | reconcile' >&2; exit 2 ;;
esac
exit 0
