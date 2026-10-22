#!/bin/bash
# The VM lane's launcher (docs/mac-lane.md, the VM lane): the program of the LaunchAgent com.ssfskim.ci-kit.vm-lane
# (com.ssfskim.ci-kit.vm-lane.plist beside it), run from the installed kit (~/ci-kit-vm/kit/vm/lane.sh) in the user's
# GUI session, where Virtualization.framework finds an unlocked login keychain and the host's main screen gives the
# guest its density. It is the only automated way a guest starts: it reads the queue, boots a job clone of the golden
# image for one queued job, follows it through that job and deletes it after. Maintenance (bake.sh) runs only with this
# booted out. Two launchers cannot run: each holds vm-lane.lock (flock, released by the kernel) for its life.
#
# ONE CLONE, ONE JOB, THEN GONE. Every bound is read from the environment, its default in parentheses.
#   idle        the queue read every CI_KIT_VM_POLL s (15); a boot when the boot rule holds (below)
#   booting     one step under the desktop lock, from the first write to the spawn: vm-reserved written, `tart clone
#               <golden> maws-vm-job-<slot>-<time>`, `tart run --no-graphics --no-clipboard` with the four shares spawned detached. A
#               clone that fails releases under the same lock; a run that exits within CI_KIT_VM_SPAWN_CHECK s (1)
#               has its stopped clone deleted, then releases. Then until `tart exec <clone> true` answers, at most
#               CI_KIT_VM_BOOT s (120)
#   kicking     `tart exec <clone> …/kickoff.sh <slot> <clone>`, run beside the loop, then until out/listening or
#               out/session-conflict, at most CI_KIT_VM_KICKOFF s (60) from the kickoff. An exec that fails is read
#               against out/ first: the wrapper's markers go on as they would, a wrapper that may run with nothing
#               assigned is given up through the handshake, and only a clone where none can run fails at once
#   session     the listener found the slot's last session open: until out/listening (or out/assigned, a job taken
#               all the same), at most CI_KIT_VM_SESSION s (300); past it a `session` failure, counted apart from
#               `image`. A bound passed before a job (the kickoff's, the session's) gives the guest up through the
#               idle handshake where a wrapper may run, and stops it outright only where none can
#   listening   until out/assigned; past CI_KIT_VM_IDLE s (180) without it, the idle handshake (below)
#   stopping    the handshake's out/stop-request is written: until the wrapper's answer, at most CI_KIT_VM_STOP_ANSWER s
#               (180) on this launcher's clock; past it the wrapper could not answer, which may hide a cancelled job:
#               tart stop, a `raced` failure and its alert
#   preparing   from out/assigned (the wrapper saw the listener take a job) until out/job (the guest's hook ran)
#   running     until tart run exits, the guest having powered itself off; at most CI_KIT_VM_JOB_BOUND min (50) from
#               out/assigned, then an `image` failure: GitHub ends a job at its timeout, so a clone past it did not end
#   ending      a guest with nothing left to run: until it powers off, at most CI_KIT_VM_END_WAIT s (60)
#   teardown    the end verified against Tart (tart.sh; where it still runs, tart stop with CI_KIT_VM_STOP_TIMEOUT s
#               of graceful stop (30), then the check again), out/ folded into the logs, tart delete, then vm-reserved
#               removed under the lock. A stop that fails or a state that cannot be read keeps the reservation, is
#               retried each poll, and opens one alert after CI_KIT_VM_STOP_ALERT s (600)
# A failure (a bound passed, a command failed) is logged with its reason, counted by kind (image, session, memory,
# disk, raced) and ends in teardown. Three `image` failures in a row pause the lane until an operator removes vm-pause,
# with one alert; a clone that ends by itself after its job ends the run of them. Two refusals in a row by the guest's
# hook (out/refused) pause it the same way, with an alert naming the refusal: a fresh clone that refuses twice shows an
# image fault.
#
# RECOVERY runs at one point only, this launcher's start, under the desktop lock, before the first queue read, and
# touches job clones alone (maws-vm-job-<slot>-*, and vm-reserved); a golden, a candidate, a trial clone or the base is
# the maintenance procedure's. A reservation's VM running with out/assigned and no out/done is adopted (running, the
# bound from out/assigned); one asked to stop has its answer read first, before an out/done after it; one running with
# no assignment goes through the idle handshake where a wrapper may run (a marker or out/wrapper.log in out/, or a
# kickoff still in the process table) and is stopped where none can; one stopped or gone is deleted and released;
# a job clone with no reservation is reserved first, so settle sees it, then torn down the same way. A reservation that
# names anything but a job clone of the slot stays, and is neither stopped nor deleted: recovery waits. Nothing else is
# released, ever: a reservation goes only by a verified teardown, whatever became of the launcher that wrote it. A
# recovery that cannot read what it needs waits, boots nothing, and alerts after CI_KIT_VM_STOP_ALERT s; while it waits
# with a reservation naming a job clone, the guard samples for that VM, and its stop (critical, the disk floor) takes
# it by name. A teardown whose end cannot be told stops its clone by name once, and releases only a verified end.
#
# THE IDLE HANDSHAKE. The launcher never signals the listener and never stops a clone that may hold a job. Past the
# idle bound with no out/assigned, it reads the queue again; with nothing the guest can take, it writes
# out/stop-request, and the wrapper answers (wrapper.sh's header has the out/ protocol): stop-refused (a job was taken:
# preparing), stopped (none was: the guest ends), stop-raced (a job was accepted as the listener stopped, which
# cancelled it: logged, alerted with the run and the job, counted as `raced`, once per clone across restarts).
#
# THE BOOT RULE, read at each poll in idle (the reads are lane-reads.sh's); what fails it is logged once per change,
# and a boot logs what it read. Conditions 3 and 4 are read again inside the locked step, where they are written.
#   1. a job wants a guest: a queued job of a queued or in-progress run of CI_KIT_VM_REPO (SSFSKIM/MAWS) whose labels
#      are a subset of {ci-kit-mac-solo, ci-kit-mac-vm}, read with the machine user's own gh login (the job's or the
#      alert's token never reaches it), each call bounded as dialog.sh bounds its own;
#   2. the host will not take it first: a ci-kit-mac-vm job always counts; a ci-kit-mac-solo job counts only when the
#      exclusive instance is busy, held (the dialog watcher's drain) or offline (runner-state.py), or more of them are
#      queued than it can take (one);
#   3. nothing holds the lane: no vm-hold.<owner>, no vm-pause in force, and no claim (vm-claim.sh claims, read under
#      the desktop lock: clear only when it exits 0 and prints nothing);
#   4. no guest exists: vm-reserved absent, and Tart lists no maws-vm-* running (a maintenance VM keeps the lane shut,
#      logged once per change and alerted after CI_KIT_VM_MAINTENANCE_ALERT s, 600);
#   5. the memory guard and the disk reserve admit: pressure 1, available at least CI_KIT_VM_MEMORY_FLOOR % (37: a 4 GB
#      guest's share of 16 GB plus 12 points), swap not grown since the last read at least CI_KIT_VM_SWAP_GAP s (60)
#      older, and the volume of ~/.tart (CI_KIT_VM_TART_HOME) with at least CI_KIT_VM_DISK_RESERVE GB (40) free; a read
#      that fails admits nothing;
#   6. the host's main display is at @2x (cursor-park --describe through CI_KIT_CURSOR_PARK, the exclusive instance's
#      installed helper by default), since the guest takes its density from it at boot;
#   7. CI_KIT_VM_LANE_MODE is always (the default), or hold-only with every host instance held or stopped;
#   8. every host job now running is VM-safe: a job that is not holds a claim, so this is 3.
# Outside the rule: the lane's parts must be there (Tart, the golden image ~/ci-kit-vm/golden names (CI_KIT_VM_GOLDEN),
# read at every boot, the slot's identity, the kit (CI_KIT_VM_KIT, ~/ci-kit-vm/kit)), and a window of CI_KIT_VM_PAUSE_WINDOWS (UTC HH:MM-HH:MM,
# comma-separated, none by default) keeps the lane down. Missing parts alert after CI_KIT_VM_GOLDEN_ALERT s (3600) of a
# job waiting. A hold is logged once per change and alerted, per owner, after CI_KIT_VM_HOLD_ALERT s (21600) on.
#
# THE MEMORY GUARD samples from tart run to the verified end, every CI_KIT_VM_SAMPLE s (15), into vm-lane.log:
#   - pressure 2 on two samples in a row: a guest holding no job (booting, kicking, session, listening, as the step
#     just before the sample read out/) is given up at once (a `memory` failure), through the idle handshake where a
#     wrapper may run, since its answer keeps a job taken meanwhile, and by a plain teardown only where none can (no
#     kickoff started, or one that refused); a job (preparing, running, or an answer still owed) is left to finish,
#     and vm-pause is written CI_KIT_VM_WARN_PAUSE s (120) past its teardown;
#   - pressure 4 on one sample: tart stop in any state, `stopped for memory`, one alert, a `memory` failure, and a pause
#     of CI_KIT_VM_CRITICAL_PAUSE s (600);
#   - free disk under CI_KIT_VM_DISK_FLOOR GB (5): the same stop, for `disk`; under half the reserve, vm-pause (disk)
#     until the space is back, in every state, idle included.
#   Nothing the loop waits on outlasts about one sample: the kickoff runs beside it, the queue read has an overall
#   deadline of CI_KIT_VM_QUEUE_WAIT s (15), past which the queue reads as unknown (no boot, no stop), and a sample due
#   by the end of a step is taken before the next one, so two samples are at most one interval and one read apart.
#
# STATE, in ~/Library/Logs/ci-kit beside the host's, each file replaced whole by a rename and written under the
# desktop lock; a write that fails leaves the stricter state (a reservation not written is no boot, a release not done
# stays reserved, a pause not written holds in this launcher). vm-reserved (this launcher's alone), vm-hold.<owner>
# (read, never written), vm-claim.* (read through vm-claim.sh), vm-pause; vm-failures (the failure counts) and
# vm-lane.alert.<kind> (an open alert's issue) are this launcher's own. The log is vm-lane.log; at each teardown out/ is
# folded in (its markers and the wrapper's log), the guest's hook lines go to the hooks log, and out/ itself is kept
# as vm-out/<clone> (the last CI_KIT_VM_KEEP_OUT, 20). Alerts go through dialog.sh's alert_gh, one open issue per kind,
# closed when its condition clears; each title is outside MAWS's dialog-alert pattern.
#
# Tests move the paths and the reads: CI_KIT_VM_HOME, CI_KIT_VM_SLOT (vm), CI_KIT_VM_SYSCTL, CI_KIT_VM_DF, CI_KIT_TART,
# CI_KIT_GH_BIN, CI_KIT_VM_TICK (the loop's sleep, 1 s). Bash 3.2: macOS's own.
set -uo pipefail
log_tag='vm-lane'
here=$(cd "$(dirname "$0")" && pwd) || exit 1
hooks=$here/../hooks
# shellcheck source=../hooks/dialog.sh
source "$hooks/dialog.sh"
# shellcheck source=../hooks/desktop-lock.sh
source "$hooks/desktop-lock.sh"
# shellcheck source=../hooks/instances.sh
source "$hooks/instances.sh"
# shellcheck source=tart.sh
source "$here/tart.sh"
# shellcheck source=guest/diag.sh
source "$here/guest/diag.sh"
# shellcheck source=lane-reads.sh
source "$here/lane-reads.sh"

lane_log=$ci_kit_logs/vm-lane.log
say() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) vm-lane $*"
  { mkdir -p "$ci_kit_logs" && printf '%s\n' "$line" >>"$lane_log"; } 2>/dev/null || printf '%s\n' "$line" >&2
}
log() { # dialog.sh's helpers log here
  say "$@"
}
whole() { # <value> <default>: a whole number, the default when it is not one
  if [[ $1 =~ ^[0-9]+$ ]]; then printf '%s\n' "$((10#$1))"; else printf '%s\n' "$2"; fi
}

slot=${CI_KIT_VM_SLOT:-vm}
vm_home=${CI_KIT_VM_HOME:-$HOME/ci-kit-vm}
slot_dir=$vm_home/$slot
out=$slot_dir/out
kit=${CI_KIT_VM_KIT:-$vm_home/kit}
golden_pointer=${CI_KIT_VM_GOLDEN:-$vm_home/golden}
repo=${CI_KIT_VM_REPO:-SSFSKIM/MAWS}
display_read=${CI_KIT_CURSOR_PARK:-$lane_root/ci-kit/hooks/cursor-park}
lane_mode=${CI_KIT_VM_LANE_MODE:-always}
pause_windows=${CI_KIT_VM_PAUSE_WINDOWS:-}
sysctl_bin=${CI_KIT_VM_SYSCTL:-/usr/sbin/sysctl}
df_bin=${CI_KIT_VM_DF:-/bin/df}
tart_home=${CI_KIT_VM_TART_HOME:-${TART_HOME:-$HOME/.tart}}
tick=${CI_KIT_VM_TICK:-1}
queue_poll=$(whole "${CI_KIT_VM_POLL:-}" 15)
queue_wait=$(whole "${CI_KIT_VM_QUEUE_WAIT:-}" 15)
boot_bound=$(whole "${CI_KIT_VM_BOOT:-}" 120)
kickoff_bound=$(whole "${CI_KIT_VM_KICKOFF:-}" 60)
session_bound=$(whole "${CI_KIT_VM_SESSION:-}" 300)
idle_bound=$(whole "${CI_KIT_VM_IDLE:-}" 180)
job_bound_min=$(minutes "${CI_KIT_VM_JOB_BOUND:-}" 50)
job_bound=$(seconds "$job_bound_min")
answer_bound=$(whole "${CI_KIT_VM_STOP_ANSWER:-}" 180)
end_wait=$(whole "${CI_KIT_VM_END_WAIT:-}" 60)
stop_timeout=$(whole "${CI_KIT_VM_STOP_TIMEOUT:-}" 30)
spawn_check=$(whole "${CI_KIT_VM_SPAWN_CHECK:-}" 1)
sample_every=$(whole "${CI_KIT_VM_SAMPLE:-}" 15)
swap_gap=$(whole "${CI_KIT_VM_SWAP_GAP:-}" 60)
memory_floor=$(whole "${CI_KIT_VM_MEMORY_FLOOR:-}" 37)
warn_pause=$(whole "${CI_KIT_VM_WARN_PAUSE:-}" 120)
critical_pause=$(whole "${CI_KIT_VM_CRITICAL_PAUSE:-}" 600)
disk_reserve=$(whole "${CI_KIT_VM_DISK_RESERVE:-}" 40)
disk_floor=$(whole "${CI_KIT_VM_DISK_FLOOR:-}" 5)
stop_alert=$(whole "${CI_KIT_VM_STOP_ALERT:-}" 600)
maintenance_alert=$(whole "${CI_KIT_VM_MAINTENANCE_ALERT:-}" 600)
hold_alert=$(whole "${CI_KIT_VM_HOLD_ALERT:-}" 21600)
golden_alert=$(whole "${CI_KIT_VM_GOLDEN_ALERT:-}" 3600)
keep_out=$(whole "${CI_KIT_VM_KEEP_OUT:-}" 20)
image_streak_pause=3 refused_streak_pause=2

reserved_file=$ci_kit_logs/vm-reserved
pause_file=$ci_kit_logs/vm-pause
failures_file=$ci_kit_logs/vm-failures
lane_lock=$ci_kit_logs/vm-lane.lock
run_log=$ci_kit_logs/vm-run.log
drain_marker=$ci_kit_logs/runner-drained
markers='listening session-conflict assigned job refused stop-request stop-refused stop-raced stopped done'
identity_files='.runner .credentials .credentials_rsaparams'
job_clone_pattern="^maws-vm-job-$slot-[0-9]{8}T[0-9]{6}Z\$"

# Logged when what is said under its key changes, not at every poll; a read whose figures move at every poll gives
# what stays the same as its signature.
note() { # <key> <text> [<signature>]
  local var=noted_$1
  [[ ${!var-} != "${3:-$2}" ]] || return 0
  printf -v "$var" '%s' "${3:-$2}"
  say "$2"
}
forget() { # <key>: the next note under it is logged
  unset "noted_$1"
}
# 0 there, 1 not there (ENOENT), 2 the lookup failed (why in exists_why).
exists() { # <path>
  exists_why=$(perl -e 'exit 0 if lstat $ARGV[0]; exit 1 if $!{ENOENT}; print "$!"; exit 2' "$1" 2>&1)
}
mtime() { # <path>: its modification time, in seconds since the epoch
  stat -f %m "$1" 2>/dev/null
}
has() { # <marker>
  [[ -f $out/$1 ]]
}
first_line() { # <marker>
  head -1 "$out/$1" 2>/dev/null
}
field() { # <marker> <key>: the key's value in the marker's key=value line
  local word
  for word in $(first_line "$1"); do
    [[ $word != "$2="* ]] || { printf '%s\n' "${word#*=}"; return 0; }
  done
}

# THE ALERTS, in the repository the dialog alerts go to, through dialog.sh's alert_gh and token. One open issue per
# kind: vm-lane.alert.<kind> holds its URL (none when its creation failed, which is not retried) until the condition
# clears and the close goes through.
alert_open() { # <kind> <title> <body>
  local file=$ci_kit_logs/vm-lane.alert.$1 url='' scratch
  [[ ! -e $file ]] || return 0
  scratch=$(mktemp) || return 0
  read_alert_token
  if alert_gh issue create --repo "$alert_repo" --label ci-kit-alert --title "$2" --body "Time: $now
Machine: $machine
$3" >"$scratch" 2>/dev/null 7>&- 8>&-; then
    IFS= read -r url <"$scratch" || true
    say "alert opened: $2 (${url:-no url})"
  else
    say "alert issue creation failed or timed out: $2; not retried"
  fi
  printf '%s\n' "${url:-none}" >"$file" 2>/dev/null || say "could not record the alert in $file"
  rm -f "$scratch"
}
alert_close() { # <kind> <why it cleared>
  local file=$ci_kit_logs/vm-lane.alert.$1 url=''
  [[ -e $file ]] || return 0
  IFS= read -r url <"$file" 2>/dev/null || true
  if [[ -n $url && $url != none ]]; then
    read_alert_token
    if ! alert_gh issue close "$url" --repo "$alert_repo" --comment "cleared at $now: $2" >/dev/null 2>&1 7>&- 8>&-; then
      say "the alert $url could not be closed; tried again at the next poll"
      return 0
    fi
    say "alert closed: $url ($2)"
  fi
  rm -f "$file"
}
alert_kinds() { # <prefix>: the kinds of the open alerts whose kind starts so
  local file
  for file in "$ci_kit_logs/vm-lane.alert.$1"*; do
    [[ -e $file ]] && printf '%s\n' "${file##*/vm-lane.alert.}"
  done
}
# An alert of its own for one event (an acceptance that raced the stop): nothing clears it but the human's rerun.
alert_event() { # <title> <body>
  read_alert_token
  if alert_gh issue create --repo "$alert_repo" --label ci-kit-alert --title "$1" --body "Time: $now
Machine: $machine
$2" >/dev/null 2>&1 7>&- 8>&-; then
    say "alert opened: $1"
  else
    say "alert issue creation failed or timed out: $1"
  fi
}

# THE RESERVATION: r_state none, reserved or unknown; r_vm the VM it names, empty when unreadable.
read_reservation() {
  local key value
  r_vm='' r_why=''
  exists "$reserved_file"
  case $? in
    1) r_state=none; return 0 ;;
    0) r_state=reserved ;;
    *) r_state=unknown r_why="$reserved_file: ${exists_why:-the lookup failed}"; return 0 ;;
  esac
  r_since='' r_golden=''
  while IFS='=' read -r key value; do
    case $key in vm) r_vm=$value ;; since) r_since=$value ;; golden) r_golden=$value ;; esac
  done <"$reserved_file" 2>/dev/null || true
  [[ $r_vm =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || r_vm=''
}
res_since='' res_golden='' res_job=''
write_reservation() { # <vm>: under the lock
  local started
  started=$(started_of $$)
  printf 'reserved since %s: vm=%s slot=%s golden=%s%s (launcher %s)\nvm=%s\nslot=%s\ngolden=%s\nsince=%s\nlauncher=%s\nstarted=%s\njob=%s\n' \
    "$res_since" "$1" "$slot" "${res_golden:--}" "${res_job:+ job=$res_job}" $$ "$1" "$slot" "${res_golden:--}" \
    "$res_since" $$ "$started" "$res_job" >"$reserved_file.tmp" 2>/dev/null &&
    mv -f "$reserved_file.tmp" "$reserved_file" 2>/dev/null && return 0
  rm -f "$reserved_file.tmp" 2>/dev/null
  return 1
}
release() { # under the lock: true once vm-reserved is gone
  rm -f "$reserved_file" 2>/dev/null
  exists "$reserved_file"
  (($? == 1))
}

# THE PAUSE: vm-pause, the strictest one in force (failures, then disk, then memory, the later end first). A pause
# that cannot be written holds in this launcher as m_pause_* until it ends.
m_pause_reason='' m_pause_until='' m_pause_why=''
rank() { # <reason>
  case $1 in failures | unreadable) echo 3 ;; disk) echo 2 ;; memory) echo 1 ;; *) echo 0 ;; esac
}
pause_read() { # p_reason (empty: none in force), p_until (seconds, or none), p_why; p_ended: vm-pause has ended
  local key value reason='' until='' why=''
  p_ended=''
  exists "$pause_file"
  case $? in
    0)
      while IFS='=' read -r key value; do
        case $key in reason) reason=$value ;; until) until=$value ;; why) why=$value ;; esac
      done <"$pause_file" 2>/dev/null
      [[ -n $reason && ($until == none || $until =~ ^[0-9]+$) ]] ||
        reason=unreadable until=none why="$pause_file cannot be read"
      ;;
    1) ;;
    *) reason=unreadable until=none why="$pause_file: ${exists_why:-the lookup failed}" ;;
  esac
  if [[ -n $reason && $until != none ]] && ((until <= now_epoch)); then
    reason='' p_ended=1
  fi
  if [[ -n $m_pause_reason && $m_pause_until != none ]] && ((m_pause_until <= now_epoch)); then
    m_pause_reason=''
  fi
  if [[ -n $m_pause_reason ]] && (($(rank "$m_pause_reason") > $(rank "$reason"))); then
    reason=$m_pause_reason until=$m_pause_until why="$m_pause_why (held in this launcher: vm-pause could not be written)"
  fi
  p_reason=$reason p_until=$until p_why=$why
}
pause_expire() { # removes a vm-pause that has ended, under the lock
  pause_read
  [[ -n $p_ended ]] || return 0
  lock 30 || return 0
  pause_read
  if [[ -n $p_ended ]] && rm -f "$pause_file" 2>/dev/null; then say 'the pause ended'; fi
  unlock
  pause_read
}
pause_line() {
  local until=$p_until
  [[ $until == none ]] && until='an operator removes vm-pause' || until=$(date -u -r "$until" +%Y-%m-%dT%H:%M:%SZ)
  printf 'paused (%s) until %s: %s' "$p_reason" "$until" "$p_why"
}
pause_set() { # <reason> <until: seconds, or none> <why>
  pause_read
  if [[ -n $p_reason ]]; then
    (($(rank "$p_reason") <= $(rank "$1"))) || return 0
    if [[ $p_reason == "$1" ]]; then
      [[ $1 == memory && $p_until != none && $2 != none ]] && (($2 <= p_until)) && return 0
      [[ $p_until == "$2" ]] && return 0
    fi
  fi
  if lock 30 && printf 'paused since %s: %s: %s\nreason=%s\nuntil=%s\nsince=%s\nwhy=%s\n' "$now" "$1" "$3" "$1" "$2" "$now" "$3" \
    >"$pause_file.tmp" 2>/dev/null && mv -f "$pause_file.tmp" "$pause_file" 2>/dev/null; then
    unlock
    m_pause_reason=''
  else
    unlock
    rm -f "$pause_file.tmp" 2>/dev/null
    m_pause_reason=$1 m_pause_until=$2 m_pause_why=$3
    say "could not write $pause_file; the pause holds in this launcher"
  fi
  p_reason=$1 p_until=$2 p_why=$3
  say "$(pause_line)"
}
pause_clear() { # <reason> <why>
  pause_read
  [[ $m_pause_reason != "$1" ]] || m_pause_reason=''
  [[ $p_reason == "$1" ]] || return 0
  if lock 30; then
    rm -f "$pause_file" 2>/dev/null && say "the $1 pause is lifted: $2"
    unlock
  fi
}

# THE FAILURES, counted by kind into vm-failures (this launcher's own, so a restart keeps the runs of them).
# raced_clone names the clone whose raced stop is counted and alerted already, so a restart neither loses it (the
# answer stays in out/ until the teardown) nor counts it twice.
image_run=0 refused_run=0 total_image=0 total_session=0 total_memory=0 total_disk=0 total_raced=0 raced_clone=''
load_failures() {
  local key value
  [[ -f $failures_file ]] || return 0
  while IFS='=' read -r key value; do
    [[ $key != raced_clone ]] || raced_clone=$value
    [[ $value =~ ^[0-9]+$ ]] || continue
    case $key in
      image_run | refused_run | total_image | total_session | total_memory | total_disk | total_raced) printf -v "$key" '%s' "$value" ;;
    esac
  done <"$failures_file" 2>/dev/null
}
save_failures() {
  if ! printf 'image_run=%s\nrefused_run=%s\ntotal_image=%s\ntotal_session=%s\ntotal_memory=%s\ntotal_disk=%s\ntotal_raced=%s\nraced_clone=%s\n' \
    "$image_run" "$refused_run" "$total_image" "$total_session" "$total_memory" "$total_disk" "$total_raced" "$raced_clone" \
    >"$failures_file.tmp" 2>/dev/null || ! mv -f "$failures_file.tmp" "$failures_file" 2>/dev/null; then
    rm -f "$failures_file.tmp" 2>/dev/null
    say "could not write $failures_file; the counts hold in this launcher"
  fi
}
count_failure() { # <kind> <why>
  local total=total_$1
  printf -v "$total" '%s' "$((${!total} + 1))"
  if [[ $1 == image ]]; then
    image_run=$((image_run + 1))
    say "failure (image): $2; $image_run in a row (the lane pauses at $image_streak_pause)"
    if ((image_run >= image_streak_pause)); then
      image_run=0
      pause_set failures none "$image_streak_pause image failures in a row, the last: $2"
      alert_open image "ci-kit alert: vm lane on $machine paused after $image_streak_pause image failures since $(minute "$now")" \
        "Last failure: $2
The lane boots nothing until an operator removes ~/Library/Logs/ci-kit/vm-pause; the golden image is the likely cause."
    fi
  else
    say "failure ($1): $2"
  fi
  save_failures
}

# THE GUEST'S STATE in this launcher: the clone, since when the state holds, its own tart run's pid (empty for a guest
# adopted at start), and what its teardown owes.
state=recover since=0 clone='' run_pid='' kicked='' assigned_at='' stop_at='' failed='' next_ask=0 done_code=''
pause_after='' recovering=1 td_next=0 td_since='' td_stopped='' td_done='' td_forced=''
enter() { # <state>
  state=$1 since=$now_epoch
}
clear_guest() {
  kickoff_forget
  clone='' run_pid='' kicked='' assigned_at='' stop_at='' failed='' next_ask=0 pause_after='' td_next=0 td_since=''
  td_stopped='' td_done='' td_forced='' res_job='' warned=0
}
run_gone() { # whether the clone's tart run has exited; a process table that cannot be read says it has not
  local pids
  if [[ -n $run_pid ]]; then
    ! kill -0 "$run_pid" 2>/dev/null
    return
  fi
  pids=$(tart_run_pids "$clone") || return 1
  [[ -z $pids ]]
}
# Into teardown, a failure counted unless none is given.
fail() { # <kind> <why>
  failed=$1
  say "$clone: $2; teardown"
  count_failure "$1" "$2"
  enter teardown
}
to_teardown() { # <why>
  say "$clone: $1; teardown"
  enter teardown
}
# A bound passed before the guest took a job: the failure is counted (once), and the guest is given up through the
# handshake where a wrapper may run, since its answer keeps a job taken meanwhile; only one with none is stopped.
give_up() { # <kind> <why>
  if [[ -z $failed ]]; then
    failed=$1
    count_failure "$1" "$2"
  fi
  if wrapper_may_run; then ask_stop "$2"; else to_teardown "$2"; fi
}

# IDLE: one poll. Housekeeping first (the disk pause, the alerts that follow holds, maintenance VMs and missing parts),
# then the boot rule.
idle_poll() {
  local vms list_ok=1 running owners line owner kind since_file waiting
  disk_read || true
  follow_disk
  memory_read || true
  vms=$(tart_vms) || list_ok=''
  # Maintenance VMs, and job clones nothing reserved: either keeps the lane shut.
  running=''
  if [[ -n $list_ok ]]; then
    running=$(awk -F'\t' '$1 ~ /^maws-vm-/ && $2 != "stopped" { print $1 }' <<<"$vms" | tr '\n' ' ')
    running=${running% }
  fi
  if [[ -n $running ]]; then
    note maintenance "a maws-vm-* VM runs that this launcher did not boot ($running); nothing boots while it does"
    [[ -n ${maintenance_since:-} ]] || maintenance_since=$now_epoch
    if ((now_epoch - maintenance_since >= maintenance_alert)); then
      alert_open maintenance "ci-kit alert: vm lane on $machine found $running running since $(minute "$(date -u -r "$maintenance_since" +%Y-%m-%dT%H:%M:%SZ)")" \
        "VMs: $running
The launcher boots nothing while a maintenance VM (a golden, a candidate, a trial clone) runs: a maintenance procedure was released out of order. Finish or stop it with the verified stop."
    fi
  elif [[ -n $list_ok ]]; then
    [[ -z ${maintenance_since:-} ]] || say 'no maws-vm-* VM runs any more'
    maintenance_since=''
    forget maintenance
    alert_close maintenance 'no maws-vm-* VM runs'
  fi
  # Holds: logged once per change; per owner, an alert after hold_alert s.
  holds_read
  owners=$h_owners
  if [[ -n $owners ]]; then
    note holds "held: ${owners//$'\n'/; }"
  elif [[ -n ${noted_holds:-} ]]; then
    say 'no hold any more'
    forget holds
  fi
  while IFS= read -r line; do
    [[ -n $line && $line != 'the holds in '* ]] || continue
    owner=${line%%: *}
    since_file=$(mtime "$ci_kit_logs/vm-hold.$owner") || continue
    if ((now_epoch - since_file >= hold_alert)); then
      alert_open "hold.$owner" "ci-kit alert: vm lane on $machine held by $owner since $(minute "$(date -u -r "$since_file" +%Y-%m-%dT%H:%M:%SZ)")" \
        "Hold: ${line#*: }
The lane boots nothing while any vm-hold.<owner> exists; only its owner removes it."
    fi
  done <<<"$owners"
  for kind in $(alert_kinds hold.); do
    [[ -e $ci_kit_logs/vm-$kind ]] || alert_close "$kind" "the hold of ${kind#hold.} is gone"
  done
  # Failure pauses an operator removed: their alerts close.
  pause_expire
  if [[ $p_reason != failures ]]; then
    alert_close image 'the pause is lifted'
    alert_close refused 'the pause is lifted'
  fi
  if [[ $p_reason != memory && $m_pressure == 1 ]] && ((${m_available:-0} >= memory_floor)); then
    alert_close memory "pressure 1, available $m_available%"
  fi

  if [[ -z $list_ok ]] || ! parts_ready "$vms"; then
    [[ -n $list_ok ]] || parts_why="Tart cannot list its VMs ($tart_bin list failed)"
    note boot "no boot: $parts_why"
    waiting=''
    queue_read && wants_guest && waiting=1
    if [[ -n $waiting ]]; then
      [[ -n ${parts_since:-} ]] || parts_since=$now_epoch
      if ((now_epoch - parts_since >= golden_alert)); then
        alert_open parts "ci-kit alert: vm lane on $machine cannot boot since $(minute "$(date -u -r "$parts_since" +%Y-%m-%dT%H:%M:%SZ)"): $parts_why" \
          "A job has waited for the guest since then: $want_why."
      fi
    else
      parts_since=''
    fi
    return
  fi
  parts_since=''
  alert_close parts 'the lane has its parts'
  alert_close recover 'recovery went through'
  admit "$vms" || return
  boot
}

# The boot rule's conditions read outside the lock: none of them is written by what the lock serializes. boot_reads
# says what was read; false with the reason logged.
admit() { # <tart_vms output>
  local guest
  if in_pause_window; then note boot "no boot: inside the pause window $window_seen (UTC)"; return 1; fi
  if ! holds_read; then note boot "no boot: ${h_owners//$'\n'/; }"; return 1; fi
  if [[ -n $p_reason ]]; then note boot "no boot: $(pause_line)"; return 1; fi
  read_reservation
  case $r_state in
    reserved) note boot "no boot: the reservation stands ($(head -1 "$reserved_file" 2>/dev/null))"; return 1 ;;
    unknown) note boot "no boot: cannot tell whether a guest is reserved ($r_why)"; return 1 ;;
  esac
  guest=$(awk -F'\t' '$1 ~ /^maws-vm-/ && $2 != "stopped" { print $1 }' <<<"$1" | tr '\n' ' ')
  if [[ -n $guest ]]; then note boot "no boot: ${guest% } runs"; return 1; fi
  if [[ -z $m_pressure ]]; then note boot 'no boot: memory unknown (the read failed)'; return 1; fi
  if ((m_pressure != 1)); then
    note boot "no boot: memory pressure $m_pressure, not 1 ($(memory_line))" "pressure $m_pressure"
    return 1
  fi
  if ((m_available < memory_floor)); then
    note boot "no boot: memory available $m_available%, under the floor of $memory_floor%" 'available'
    return 1
  fi
  if ! swap_steady; then note boot "no boot: $swap_why" "swap ${swap_why%% from *}"; return 1; fi
  if [[ -z $d_free_kb ]]; then note boot "no boot: the free space of $tart_home cannot be read"; return 1; fi
  if ((d_free_kb < disk_reserve * 1048576)); then
    note boot "no boot: $d_free GB free on the volume of $tart_home, under the reserve of $disk_reserve GB" 'reserve'
    return 1
  fi
  if ! display_admits; then note boot "no boot: the host's display is $display_seen, not @2x"; return 1; fi
  if ! mode_admits; then note boot "no boot: $mode_why"; return 1; fi
  if ! queue_read; then note boot "no boot: the queue cannot be read ($q_why)"; return 1; fi
  if ! wants_guest; then note boot "no boot: $want_why"; return 1; fi
  boot_reads="$want_why; holds none; $(memory_line), $swap_why; $(disk_line); display $display_seen; $mode_why"
}

# The job boot: one locked step from the reservation's write to the spawn. Conditions 3 and 4 are read again under the
# lock, where a host job's claim and the reservation are written, so none can come between their read and the spawn.
boot() {
  local name claims status why='' entry i
  name=maws-vm-job-$slot-$(date -u +%Y%m%dT%H%M%SZ)
  # Every clone starts from an empty out/: what is there is kept beside the logs, not read as this clone's.
  if [[ -e $out && -n $(ls -A "$out" 2>/dev/null) ]]; then
    if ! mkdir -p "$ci_kit_logs/vm-out" || ! mv "$out" "$ci_kit_logs/vm-out/unclaimed-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null; then
      rm -rf "$out" 2>/dev/null
    fi
  fi
  mkdir -p "$out" "$slot_dir/cache" 2>/dev/null
  if [[ ! -d $out || -n $(ls -A "$out" 2>/dev/null) ]]; then note boot "no boot: $out cannot be emptied"; return; fi
  if ! lock 30; then note boot 'no boot: the desktop lock stayed taken for 30 s'; return; fi
  claims=$(bounded 30 /bin/bash "$hooks/vm-claim.sh" claims 7>&- 8>&- 2>&1)
  status=$?
  if ((status != 0)) || [[ -n $claims ]]; then
    unlock
    note boot "no boot: a claim holds the lane (${claims//$'\n'/; }${claims:+; }vm-claims exit $status)"
    return
  fi
  holds_read || why="${h_owners//$'\n'/; }"
  pause_read
  [[ -z $p_reason ]] || why=$(pause_line)
  read_reservation
  [[ $r_state == none ]] || why="the reservation stands (${r_why:-$r_vm})"
  if [[ -z $why ]]; then
    if ! entry=$(tart_vms); then
      why='Tart cannot list its VMs'
    elif awk -F'\t' '$1 ~ /^maws-vm-/ && $2 != "stopped" { found = 1 } END { exit !found }' <<<"$entry"; then
      why='a maws-vm-* VM runs'
    fi
  fi
  if [[ -n $why ]]; then
    unlock
    note boot "no boot: $why"
    return
  fi
  res_since=$now res_golden=$g_name res_job=''
  if ! write_reservation "$name"; then
    unlock
    note boot "no boot: $reserved_file could not be written"
    return
  fi
  forget boot
  clear_guest
  clone=$name
  say "booting $clone from the golden image $g_name: $boot_reads"
  if ! why=$(tart_clone "$g_name" "$clone" 2>&1); then
    why="tart clone $g_name $clone failed: $(tail -1 <<<"$why")"
    boot_undo "$why"
    return
  fi
  printf '%s %s: tart run\n' "$now" "$clone" >>"$run_log" 2>/dev/null
  # shellcheck disable=SC2046 # one option a line, no space in any
  tart_spawn "$clone" "$run_log" $(tart_shares "$kit" "$slot_dir")
  run_pid=$tart_run_pid
  for ((i = 0; i < spawn_check * 10; i++)); do
    kill -0 "$run_pid" 2>/dev/null || break
    sleep 0.1
  done
  if ! kill -0 "$run_pid" 2>/dev/null; then
    wait "$run_pid" 2>/dev/null
    boot_undo "tart run $clone exited at once ($?)"
    return
  fi
  unlock
  enter booting
  say "$clone runs (tart run, pid $run_pid); waiting for its guest agent (at most $boot_bound s)"
}
# A boot that failed inside the locked step: the clone, if Tart made one and it is stopped, is deleted, then the
# reservation released, all under the same lock. Whatever cannot be done that way goes to teardown, reserved.
boot_undo() { # <why>, with the lock held
  local status
  tart_ended "$clone"
  status=$?
  if ((status == 0)) && { [[ -z $(tart_state_in "$(tart_vms)" "$clone") ]] || tart_delete "$clone" >/dev/null 2>&1; } &&
    release; then
    unlock
    say "no boot: $1; nothing of $clone is left, and the reservation is released"
    count_failure image "$1"
    clear_guest
    enter idle
    return
  fi
  unlock
  failed=image
  say "$clone: $1; its end cannot be verified here (${tart_why:-the delete or the release failed}); teardown"
  count_failure image "$1"
  enter teardown
}

# The reservation names the job once the guest reports it.
note_job() {
  local run job
  run=$(field job run) job=$(field job job)
  res_job="run $run job $job"
  if lock 30; then
    write_reservation "$clone" || say "could not write the job into $reserved_file"
    unlock
  fi
  say "$clone took run $run job $job (attempt $(field job attempt), $(field job repository))"
}
# The idle handshake: the stop is asked, never forced.
ask_stop() { # <why>
  if printf '' >"$out/.stop-request.tmp" 2>/dev/null && mv -f "$out/.stop-request.tmp" "$out/stop-request" 2>/dev/null; then
    stop_at=$now_epoch
    say "$clone: $1; asked the wrapper to stop (out/stop-request), answer within $answer_bound s"
    enter stopping
  else
    note stop "$clone: $1, but out/stop-request could not be written; trying again"
  fi
}
# A stop that may have cancelled a job: counted as raced and alerted once per clone, whichever launcher meets it.
raced_once() { # <why> <alert title> <alert body>
  failed=raced
  if [[ $raced_clone == "$clone" ]]; then
    say "$clone: $1 (counted and alerted already)"
    return 0
  fi
  raced_clone=$clone
  count_failure raced "$1"
  alert_event "$2" "$3"
}
raced() { # <job>
  say "$clone: a job ($1) was accepted as the listener stopped, and the stop cancelled it at GitHub; rerun it"
  raced_once "an acceptance raced the idle stop (job $1)" \
    "ci-kit alert: vm lane on $machine cancelled job $1 at $(minute "$now") (an acceptance raced the idle stop)" \
    "Clone: $clone
Job: $1 (the runner's id; GitHub shows the job cancelled on the runner ci-kit-mac-$machine-vm)
The guest's listener accepted this job as the launcher's idle stop reached it. Rerun the job."
}

# THE STATES, one step each tick.
step_booting() {
  if run_gone; then fail image "tart run exited during the boot"; return; fi
  if tart_answers "$clone"; then
    say "$clone: its guest agent answers after $((now_epoch - since)) s"
    enter kicking
    return
  fi
  ((now_epoch - since < boot_bound)) || fail image "its guest agent did not answer within $boot_bound s"
}
# The kickoff runs beside the loop, so the guard samples through it: kick_pid while it runs, then kick_status (0, or
# why it failed) once it has returned.
kick_pid='' kick_status='' kick_file=''
kickoff_start() {
  kicked=1 kick_status=''
  kick_file=$(mktemp) || { kick_status='no scratch file for its output'; return; }
  (tart_kickoff "$clone" "$slot" "$kickoff_bound" >"$kick_file" 2>&1; echo $? >"$kick_file.status") 7>&- 8>&- &
  kick_pid=$!
}
kickoff_poll() {
  local code
  [[ -n $kick_pid ]] && ! kill -0 "$kick_pid" 2>/dev/null || return 0
  wait "$kick_pid" 2>/dev/null
  kick_pid=''
  code=$(cat "$kick_file.status" 2>/dev/null)
  if [[ $code == 0 ]]; then
    kick_status=0
    say "$clone: $(tail -1 "$kick_file" 2>/dev/null)"
  else
    kick_status="kickoff.sh failed: $(tail -1 "$kick_file" 2>/dev/null)"
    [[ $state == kicking ]] || say "$clone: $kick_status"
  fi
  rm -f "$kick_file" "$kick_file.status"
}
# A kickoff still under way when its clone is forgotten: its exec ends with the clone, which is stopped by then.
kickoff_forget() {
  if [[ -n $kick_pid ]]; then
    kill "$kick_pid" 2>/dev/null
    wait "$kick_pid" 2>/dev/null
  fi
  [[ -z $kick_file ]] || rm -f "$kick_file" "$kick_file.status"
  kick_pid='' kick_status='' kick_file=''
}
# Whether the clone's wrapper may be running, so a guest holding no job may still take one: 1 only when none can be.
# kickoff.sh opens out/wrapper.log as it starts the wrapper, returns 0 once it has, and refuses before that when out/
# holds a marker; a kickoff still under way (this launcher's, or an earlier one's, found in the process table) may yet
# start it.
wrapper_may_run() {
  local marker pids
  [[ ! -e $out/wrapper.log ]] || return 0
  for marker in $markers; do
    [[ $marker == stop-request ]] || ! has "$marker" || return 0
  done
  [[ -z $kick_pid && $kick_status != 0 ]] || return 0
  if [[ -z $kicked ]]; then
    pids=$(tart_pids exec "$clone") || return 0
    [[ -z $pids ]] || return 0
  fi
  return 1
}
step_kicking() {
  local failed_kick=''
  [[ -n $kicked ]] || kickoff_start
  kickoff_poll
  [[ -z $kick_status || $kick_status == 0 ]] || failed_kick=$kick_status
  # out/ before the kickoff's status: kickoff.sh starts the wrapper before it returns, so an exec that fails or times
  # out on the way back does not show that none runs, and what the wrapper wrote is the guest's own record.
  if [[ -n $failed_kick ]] && { has listening || has session-conflict || has assigned || has job; }; then
    say "$clone: $failed_kick, but its wrapper runs (out/ holds its markers); going on"
  fi
  if has assigned || has job; then take_assigned; return; fi
  if has listening; then say "$clone: listening ($(first_line listening))"; enter listening; return; fi
  if has session-conflict; then
    say "$clone: the slot's last session is still open at GitHub; session recovery (at most $session_bound s)"
    enter session
    return
  fi
  # Nothing assigned: a wrapper that may run may yet take a job, so give_up asks it through the handshake.
  if [[ -n $failed_kick ]]; then give_up image "$failed_kick"; return; fi
  if run_gone; then fail image 'tart run exited during the kickoff'; return; fi
  ((now_epoch - since < kickoff_bound)) || give_up image "neither out/listening nor out/session-conflict within $kickoff_bound s"
}
step_session() {
  # A job taken while out/listening was not (yet) written is a job: the session's bound no longer applies.
  if has assigned || has job; then take_assigned; return; fi
  if has listening; then say "$clone: listening after $((now_epoch - since)) s of session recovery"; enter listening; return; fi
  if run_gone; then fail session 'tart run exited during session recovery'; return; fi
  ((now_epoch - since < session_bound)) || give_up session "the slot's session was not let go within $session_bound s"
}
# A job seen taken: preparing, the running bound counted from out/assigned.
take_assigned() {
  assigned_at=$(mtime "$out/assigned") || assigned_at=$now_epoch
  say "$clone: the listener took a job ($(first_line assigned)); preparing (at most $job_bound_min min from out/assigned)"
  enter preparing
}
step_listening() {
  if has assigned; then take_assigned; return; fi
  if run_gone; then
    # A job the wrapper saw before its watch wrote assigned ended with the guest; anything else is a runner that never
    # took one.
    if has job; then
      to_teardown 'the guest ended'
    else
      fail image "the runner exited without a job (out/done: $(first_line 'done' || true))"
    fi
    return
  fi
  ((now_epoch - since >= idle_bound)) || return 0
  ((now_epoch >= ${next_ask:-0})) || return 0
  next_ask=$((now_epoch + queue_poll))
  if ! queue_read; then note stop "$clone: idle past $idle_bound s, but the queue cannot be read ($q_why); listening on"; return; fi
  if ((q_solo + q_vm > 0)); then
    note stop "$clone: idle past $idle_bound s, but $((q_solo + q_vm)) job(s) queued it can take; listening on"
    return
  fi
  forget stop
  ask_stop "no job taken in $((now_epoch - since)) s and none queued for it"
}
step_stopping() {
  if has stop-refused; then
    [[ -n $assigned_at ]] || assigned_at=$(mtime "$out/assigned") || assigned_at=$now_epoch
    say "$clone: the wrapper refused the stop ($(first_line stop-refused)): the listener took a job; preparing"
    enter preparing
    return
  fi
  if has stop-raced; then
    raced "$(field stop-raced job)"
    enter ending
    return
  fi
  if has stopped; then say "$clone: the listener stopped with no job ($(first_line stopped))"; enter ending; return; fi
  # The runner exited before the request was read: its record (job, done) says what ran, and an answer that still
  # comes is read at the teardown.
  if has 'done'; then say "$clone: the runner exited before the stop was answered; ending"; enter ending; return; fi
  # No wrapper was started (kickoff refused, or never got that far): nothing can hold a job, and no answer will come.
  if ! wrapper_may_run; then
    to_teardown 'no wrapper was started in it, so no answer comes and no job can be in it; stopping it'
    return
  fi
  if run_gone; then
    raced_once 'the guest ended with the stop unanswered' \
      "ci-kit alert: vm lane on $machine lost an unanswered stop of $clone at $(minute "$now")" \
      "The guest ended before its wrapper answered the idle stop; a job it may have taken is unknown."
    to_teardown 'the guest ended with the stop unanswered'
    return
  fi
  if ((now_epoch - stop_at >= answer_bound)); then
    raced_once "the stop was not answered within $answer_bound s" \
      "ci-kit alert: vm lane on $machine stopped $clone with its idle stop unanswered at $(minute "$now")" \
      "The wrapper did not answer the idle stop within $answer_bound s, so a job it may have accepted is unknown; the clone was stopped. Check the run on ci-kit-mac-$machine-vm and rerun what was cancelled."
    to_teardown "the stop was not answered within $answer_bound s; stopping it"
  fi
}
step_job() { # preparing and running
  if [[ $state == preparing ]] && has job; then
    note_job
    enter running
  fi
  if run_gone; then to_teardown 'the guest powered itself off'; return; fi
  ((now_epoch - assigned_at < job_bound)) ||
    fail image "the job outlived the running bound ($job_bound_min min from out/assigned); stopping it"
}
step_ending() {
  if run_gone; then to_teardown 'the guest powered itself off'; return; fi
  ((now_epoch - since < end_wait)) || to_teardown "the guest did not power off within $end_wait s; stopping it"
}

# What the clone's out/ says of its job, read once at its teardown: the refusals in a row, and the end of a run of image
# failures by a clone that ran its course.
conclude() {
  local line
  # An answer the steps did not see (it came after the clone was given up) is still the clone's record.
  if [[ $failed != raced ]] && has stop-raced; then raced "$(field stop-raced job)"; fi
  if has job; then
    line="run $(field job run) job $(field job job)"
    if has refused; then
      refused_run=$((refused_run + 1))
      say "$clone: the guest refused $line: $(first_line refused) ($refused_run in a row; the lane pauses at $refused_streak_pause)"
      if ((refused_run >= refused_streak_pause)); then
        refused_run=0
        pause_set failures none "$refused_streak_pause refusals in a row by the guest's hook, the last: $(first_line refused)"
        alert_open refused "ci-kit alert: vm lane on $machine paused after $refused_streak_pause refusals since $(minute "$now")" \
          "Refusal: $(first_line refused)
A fresh clone that refuses its job twice shows a fault of the image (a dialog, the display). The lane boots nothing until an operator removes ~/Library/Logs/ci-kit/vm-pause."
      fi
    else
      refused_run=0
      say "$clone: $line ran; the runner exited ${done_code:-without out/done}"
    fi
  elif has assigned; then
    say "$clone: its job ($(first_line assigned)) ended before the guest's hook ran"
  fi
  if [[ -z $failed ]] && has 'done'; then image_run=0; fi
  save_failures
}
# out/ into the lane's logs: its markers and the wrapper's log here, the guest's hook lines into the hooks log, and the
# directory kept as vm-out/<clone>; a fresh, empty out/ for the next clone.
fold() {
  local marker kind at rest keep
  [[ -d $out ]] || return 0
  for marker in $markers; do
    has "$marker" && say "$clone out/$marker: $(first_line "$marker")"
  done
  if [[ -f $out/wrapper.log ]]; then
    sed "s/^/$(date -u +%Y-%m-%dT%H:%M:%SZ) vm-lane $clone wrapper.log: /" "$out/wrapper.log" >>"$lane_log" 2>/dev/null ||
      say "could not fold $out/wrapper.log into the log"
  fi
  if [[ -f $out/mac-runner-hooks.log ]]; then
    cat "$out/mac-runner-hooks.log" >>"$ci_kit_logs/mac-runner-hooks.log" 2>/dev/null ||
      say "could not fold the guest's hooks log into mac-runner-hooks.log"
  fi
  while read -r kind at rest; do
    [[ $kind == update ]] && say "$clone: refresh trigger: the runner updated itself at $at (the image's runner is behind)"
    [[ $kind == unreadable ]] && say "$clone: its _diag could not all be read"
  done < <(diag_scan "$out/_diag")
  if mkdir -p "$ci_kit_logs/vm-out" 2>/dev/null && mv "$out" "$ci_kit_logs/vm-out/$clone" 2>/dev/null; then
    # shellcheck disable=SC2012 # the names are the lane's own clone names
    keep=$(ls -1t "$ci_kit_logs/vm-out" 2>/dev/null | sed -n "$((keep_out + 1)),\$p")
    for marker in $keep; do rm -rf "${ci_kit_logs:?}/vm-out/$marker"; done
  else
    say "could not keep $out as vm-out/$clone; it is emptied"
    rm -rf "$out" 2>/dev/null
  fi
  mkdir -p "$out" 2>/dev/null || true
}
# TEARDOWN: tried at once, then each poll until it is through.
step_teardown() {
  local vms status why
  ((now_epoch >= td_next)) || return 0
  td_next=$((now_epoch + queue_poll))
  [[ -n $td_since ]] || td_since=$now_epoch
  if [[ ! $clone =~ $job_clone_pattern ]]; then
    teardown_stuck "$clone is not a job clone of slot $slot; it is neither stopped nor deleted here"
    return
  fi
  if [[ -z $td_stopped ]]; then
    tart_stop_verified "$clone" "$stop_timeout"
    status=$?
    # Its end cannot be told (Tart cannot list, the process table cannot be read): it is stopped by name all the same,
    # at each poll until a stop goes through, and released only once the end is verified.
    if ((status == 2)) && [[ -z $td_forced ]]; then
      why=$tart_why
      if tart_call $((stop_timeout + 30)) stop "$clone" --timeout "$stop_timeout" >/dev/null 2>&1; then
        td_forced=1
        say "$clone: its end cannot be told ($why); stopped by name (tart stop)"
      else
        note forced "$clone: its end cannot be told ($why), and tart stop by name failed; tried again each poll"
      fi
      tart_stop_verified "$clone" "$stop_timeout"
      status=$?
    fi
    if ((status != 0)); then
      teardown_stuck "$tart_why"
      return
    fi
    td_stopped=1
    say "$clone: its end is verified (Tart lists it stopped, and no tart run of it runs)"
  fi
  if [[ -z $td_done ]]; then
    td_done=1
    done_code=$(first_line 'done')
    conclude
    fold
  fi
  if ! vms=$(tart_vms); then teardown_stuck 'Tart cannot list its VMs'; return; fi
  if [[ -n $(tart_state_in "$vms" "$clone") ]] && ! status=$(tart_delete "$clone" 2>&1); then
    teardown_stuck "tart delete failed: $(tail -1 <<<"$status")"
    return
  fi
  if ! lock 30; then teardown_stuck 'the desktop lock stayed taken'; return; fi
  if ! release; then
    unlock
    teardown_stuck "$reserved_file could not be removed"
    return
  fi
  unlock
  say "$clone: deleted, and the reservation released, $((now_epoch - td_since)) s into the teardown"
  forget teardown; forget forced
  alert_close cannot-stop "$clone is stopped and deleted"
  if [[ -n $pause_after ]]; then
    pause_set memory $((now_epoch + warn_pause)) "memory pressure warned during $clone's job"
  fi
  clear_guest
  if [[ -n $recovering ]]; then enter recover; else enter idle; next_poll=$now_epoch; fi
}
teardown_stuck() { # <why>
  note teardown "$clone cannot be torn down yet ($1); the reservation stays, and the teardown is tried each poll"
  if ((now_epoch - td_since >= stop_alert)); then
    alert_open cannot-stop "ci-kit alert: vm lane on $machine cannot stop $clone since $(minute "$(date -u -r "$td_since" +%Y-%m-%dT%H:%M:%SZ)")" \
      "Why: $1
The reservation stays, so nothing boots and settle keeps measured jobs waiting, until the clone is stopped and deleted with the verified stop."
  fi
}

# Under half the reserve, the disk pause; back over it, the pause lifted. Every poll and every sample.
follow_disk() {
  [[ -n $d_free_kb ]] || return 0
  if ((d_free_kb < disk_reserve * 1048576 / 2)); then
    pause_set disk none "$d_free GB free on the volume of $tart_home, under half the reserve of $disk_reserve GB"
  else
    pause_clear disk "$d_free GB free, at least half the reserve of $disk_reserve GB" && alert_close disk "$d_free GB free"
  fi
}
# THE GUARD: a sample from tart run to the verified end, every sample_every s.
warned=0
# While recovery waits with a reservation standing, its VM may run: the guard samples for it, and a stop takes it by
# its name, which is a job clone of the slot (recover_poll reads the reservation; guard_reserved checks the name).
guard_reserved() {
  [[ -z $clone && $state == recover && ${r_state:-} == reserved && ${r_vm:-} =~ $job_clone_pattern ]]
}
guard_sample() {
  memory_read || true
  disk_read || true
  say "sample $state ${clone:-$r_vm}: $(memory_line); $(disk_line)"
  # A stop in recovery is the reserved VM's teardown; once it is released, recovery runs again.
  if [[ -z $clone ]]; then
    if [[ -n $d_free_kb ]] && ((d_free_kb < disk_floor * 1048576)) ||
      { [[ -n $m_pressure ]] && ((m_pressure >= 4)); }; then
      clear_guest
      clone=$r_vm res_since=${r_since:-$now} res_golden=$r_golden
    else
      return 0
    fi
  fi
  follow_disk
  # A teardown is already the stop: the samples go on, and nothing more is done.
  [[ $state != teardown ]] || return 0
  if [[ -n $d_free_kb ]] && ((d_free_kb < disk_floor * 1048576)); then
    stop_for disk "$d_free GB free on the volume of $tart_home, under the floor of $disk_floor GB" none
    return
  fi
  [[ -n $m_pressure ]] || return 0
  if ((m_pressure >= 4)); then
    stop_for memory "memory pressure critical ($(memory_line))" $((now_epoch + critical_pause))
    return
  fi
  if ((m_pressure >= 2)); then warned=$((warned + 1)); else warned=0; fi
  ((warned >= 2)) || return 0
  # The step just before this sample read what the guest wrote, and a guest whose wrapper may run is asked through the
  # handshake, whose answer keeps a job taken since: only one with no wrapper is stopped outright.
  case $state in
    booting | kicking | session | listening)
      if wrapper_may_run; then
        if [[ -z $failed ]]; then
          failed=memory
          count_failure memory "memory pressure warned on two samples ($(memory_line))"
        fi
        ask_stop 'given up for memory'
      else
        failed=memory
        count_failure memory "memory pressure warned on two samples ($(memory_line))"
        to_teardown 'given up for memory: no wrapper runs in it, so it holds no job'
      fi
      ;;
    preparing | running | stopping | ending)
      if [[ -z $pause_after ]]; then
        pause_after=1
        say "$clone: memory pressure warned on two samples; its job is left to finish, and nothing boots for $warn_pause s after it"
      fi
      ;;
  esac
}
stop_for() { # <memory|disk> <why> <pause until, or none>
  say "$clone: stopped for $1: $2"
  failed=$1
  count_failure "$1" "$2"
  pause_set "$1" "$3" "$clone stopped for $1: $2"
  alert_open "$1" "ci-kit alert: vm lane on $machine stopped a job for $1 at $(minute "$now")" \
    "Clone: $clone ($state)
Why: $2
A job in it is lost: GitHub reports the runner lost, with no ci-kit rerun line. Rerun it."
  enter teardown
  td_next=0
}

# RECOVERY: at the start, under the lock, over job clones alone; repeated until no job clone and no reservation is left.
# Until it can read what it needs, nothing boots: logged once per change, and alerted after stop_alert s.
recover_since=''
recovery_waits() { # <why>
  note recover "recovery waits: $1; nothing boots"
  [[ -n $recover_since ]] || recover_since=$now_epoch
  ((now_epoch - recover_since >= stop_alert)) || return 0
  alert_open recover "ci-kit alert: vm lane on $machine cannot recover since $(minute "$(date -u -r "$recover_since" +%Y-%m-%dT%H:%M:%SZ)")" \
    "Why: $1
The launcher boots nothing until its start-up recovery has read the reservation, Tart's VMs and the process table."
}
recovered() {
  forget recover
  [[ -z $recover_since ]] || alert_close recover 'recovery went through'
  recover_since=''
}
recover_poll() {
  local vms clones target vstate pids
  ((now_epoch >= ${next_poll:-0})) || return 0
  next_poll=$((now_epoch + queue_poll))
  if ! lock 30; then recovery_waits 'the desktop lock stayed taken for 30 s'; return; fi
  read_reservation
  if [[ $r_state == unknown ]]; then
    unlock
    recovery_waits "cannot tell whether a guest is reserved ($r_why)"
    return
  fi
  if ! vms=$(tart_vms); then
    unlock
    recovery_waits "Tart cannot list its VMs ($tart_bin list failed)"
    return
  fi
  clones=$(awk -F'\t' -v p="$job_clone_pattern" '$1 ~ p { print $1 }' <<<"$vms")
  target=$r_vm
  if [[ -z $target ]]; then
    target=${clones%%$'\n'*}
    if [[ -z $target ]]; then
      if [[ $r_state == reserved ]] && ! release; then
        unlock
        recovery_waits 'the reservation names no VM, and no job clone exists, but it cannot be removed'
        return
      fi
      unlock
      [[ $r_state == none ]] || say 'recovery: the reservation named no VM, and no job clone exists; released'
      say 'recovery: no job clone and no reservation; idle'
      recovering=''
      recovered
      enter idle
      next_poll=0
      return
    fi
    res_since=$now res_golden='' res_job=''
    if ! write_reservation "$target"; then
      unlock
      recovery_waits "$target has no reservation, and $reserved_file cannot be written"
      return
    fi
    say "recovery: $target is a job clone with no reservation; reserved it before its teardown"
  fi
  if [[ ! $target =~ $job_clone_pattern ]]; then
    unlock
    recovery_waits "the reservation names $target, which is not a job clone of slot $slot; it stays, and nothing is stopped or deleted"
    return
  fi
  if ! pids=$(tart_run_pids "$target"); then
    unlock
    recovery_waits 'the process table cannot be read'
    return
  fi
  unlock
  recovered
  clear_guest
  clone=$target
  [[ $target != "$r_vm" ]] || res_since=${r_since:-$now} res_golden=$r_golden
  vstate=$(tart_state_in "$vms" "$target")
  if [[ (-z $vstate || $vstate == stopped) && -z $pids ]]; then
    say "recovery: $clone is ${vstate:-gone}; teardown"
    enter teardown
    return
  fi
  if [[ ! -d $out || ! -r $out || ! -x $out ]]; then
    say "recovery: $clone runs, and $out cannot be read; stopping it"
    enter teardown
    return
  fi
  # The handshake first: its answer is the clone's record whatever came after it (done follows every answer).
  if has stop-request || has stop-refused || has stop-raced || has stopped; then
    stop_at=$(mtime "$out/stop-request") || stop_at=$now_epoch
    say "recovery: $clone was asked to stop; its answer is read before anything after it"
    enter stopping
    return
  fi
  if has assigned && ! has 'done'; then
    assigned_at=$(mtime "$out/assigned") || assigned_at=$now_epoch
    if has job; then enter running; else enter preparing; fi
    say "recovery: $clone runs its job ($(first_line assigned)); adopted ($state), the bound counted from out/assigned"
    return
  fi
  if has 'done'; then
    say "recovery: $clone's runner is done ($(first_line 'done')); waiting for its power-off"
    enter ending
    return
  fi
  if wrapper_may_run; then
    say "recovery: $clone runs with no job assigned; the idle handshake"
    enter listening
    since=$((now_epoch - idle_bound))
    next_ask=0
    return
  fi
  say "recovery: $clone runs, and its wrapper has not started; stopping it"
  enter teardown
}

# THE LAUNCHER.
step() { # the state's step; a kickoff under way is followed in every state
  kickoff_poll
  case $state in
    recover) recover_poll ;;
    idle)
      if ((now_epoch >= next_poll)); then
        next_poll=$((now_epoch + queue_poll))
        idle_poll
      fi
      ;;
    booting) step_booting ;;
    kicking) step_kicking ;;
    session) step_session ;;
    listening) step_listening ;;
    stopping) step_stopping ;;
    preparing | running) step_job ;;
    ending) step_ending ;;
    teardown) step_teardown ;;
  esac
}
take_lane_lock() {
  mkdir -p "$ci_kit_logs" 2>/dev/null
  if ! exec 7>>"$lane_lock"; then
    echo "vm-lane: $lane_lock cannot be opened" >&2
    exit 1
  fi
  perl -MFcntl=:flock -e 'open(my $fh, ">>&=", 7) or exit 2; exit(flock($fh, LOCK_EX | LOCK_NB) ? 0 : 1)' && return 0
  say "another launcher holds $lane_lock; waiting for it"
  perl -MFcntl=:flock -e 'open(my $fh, ">>&=", 7) or exit 2; exit(flock($fh, LOCK_EX) ? 0 : 1)' || exit 1
}
take_lane_lock
trap 'clock; say "stopping on SIGTERM ($state${clone:+, $clone}); a guest and its reservation stay for the next start"; exit 0' TERM
load_failures
clock
say "starting (pid $$, slot $slot, mode $lane_mode); recovery first"
next_sample=0 next_poll=0
while :; do
  clock
  step
  # A step may have blocked (a queue read, up to its deadline): the sample is judged on the time after it, so it is
  # taken before the next step can block again.
  clock
  if { [[ -n $clone ]] || guard_reserved; } && ((now_epoch >= next_sample)); then
    next_sample=$((now_epoch + sample_every))
    guard_sample
  fi
  sleep "$tick"
done
