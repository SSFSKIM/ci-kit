#!/bin/bash
# The VM lane's maintenance procedure (docs/mac-lane.md, "The VM lane's maintenance"): the coordinator's script for the
# steps that make, try, promote and retire the lane's images. The launcher (lane.sh) never runs any of them,
# and they never run beside it.
#
#   bake.sh --bake [--memory <MB>] [--maws <checkout>] [--name maws-vm-candidate-<id>]
#   bake.sh --first-run <candidate>            shell part of the first-run step; the candidate must be running
#   bake.sh --trial <candidate>
#   bake.sh --promote <candidate>
#   bake.sh --retire <VM>
#
# THE HOLD. --bake, --first-run, --trial and --promote check it before anything else and refuse without it: a
# vm-hold.<owner> in ~/Library/Logs/ci-kit whose first line starts "maintenance" (CI-opt writes it through
# `vm/hold.sh hold <owner> maintenance`, under desktop.lock: `maintenance since <time>`), no vm-reserved (a job clone may run while it stands), and the launcher's agent com.ssfskim.ci-kit.vm-lane
# not loaded (launchctl print), with no launcher holding vm-lane.lock. Each then holds vm-lane.lock itself for its run,
# so a launcher started out of order waits for the step instead of recovering beside it. Those that boot a VM (--bake,
# --trial) also refuse while any maws-vm-* VM runs, and with less than CI_KIT_VM_DISK_RESERVE GB (40) free
# on the volume of ~/.tart. --retire needs no hold: nothing boots from a VM the golden pointer does not name, and a
# running one is never deleted.
#
# THE STEPS. Every one is safe to run again: nothing is deleted without a verified stop first (tart.sh: Tart lists it
# stopped and no `tart run` of it runs), and a step that dies leaves nothing automated to meet it.
# - --bake: `tart clone` of the base (CI_KIT_VM_BASE, ghcr.io/cirruslabs/macos-golden-gate-base:latest) to
#   maws-vm-candidate-<YYYYMMDD> (UTC; --name for another id), refused when that candidate or its golden name exists
#   (an earlier trial record of the name is moved aside, so only this candidate's own trial can authorize it);
#   `tart set --cpu 4 --memory <MB> --display 2560x1440pt --disk-size 60` before its first boot (--memory, 4096: V1's
#   size; under 4096 is refused at once, the base image's minimum being 4 GiB); a run with the installed kit
#   (CI_KIT_VM_KIT, ~/ci-kit-vm/kit) and the MAWS checkout (--maws, CI_KIT_VM_MAWS, ~/Developer/GitHub/MAWS) shared
#   read-only; the guest's Claude Code version, the host user's own (~/.local/bin/claude; CI_KIT_VM_ENGINE for
#   another), refused when there is none; provision.sh's steps through `tart exec` (the APFS container grown into
#   the larger disk, indexing and the measured background services turned off, then the display mode set, each
#   verified in the guest before the installs), the free space read after each
#   (the lowest is printed, which the first refresh records; under CI_KIT_VM_DISK_FLOOR GB, 5, the bake stops); the
#   verified stop. It then prints the first-run window step: clicks by the human, or CI-opt through cua in the guest;
#   the shell part from the MacBook through --first-run. No script answers a prompt.
# - --first-run: the candidate already running in a window, its agent answering and its MAWS share mounted;
#   every app in ~/.ci-kit/quarantined-apps absent from quarantine or user-approved (the window step first). Through
#   tart exec, a scratch clone of the share at ~/maws-firstrun, pnpm install, then e2e:deliverables with a 3 GB heap,
#   on the runner's PATH, streamed.
#   A guest-side deadline ends the shell work after CI_KIT_VM_FIRST_RUN_WAIT s (1200); the scratch clone is removed
#   on success, failure or expiry. Every run first stops scratch processes (argv or cwd, detached Electron included)
#   and removes leftovers from a cancelled exec (which can kill the EXIT cleanup shell). Failure leaves the guest
#   running; success asks it to shut down
#   (sudo -n /sbin/shutdown), then verifies its stop. This step never boots a VM.
# - --register is retired: lane and trial clones mint their own JIT registration with the host user's gh login.
# - --trial: a clone of the candidate, maws-vm-trial-<time>, booted and kicked off as the launcher boots a job clone,
#   but with the trial slot's shares (its clone's JIT config, out/ and cache) and kickoff.sh's slot vm-trial, so its runner
#   carries ci-kit-mac-vm-trial alone and can take only a trial commit's job (`Lane: vm-trial`). It follows out/ until
#   the guest powers itself off: a clone with no job assigned within CI_KIT_VM_TRIAL_IDLE s (1800) is asked to stop
#   through the wrapper's idle handshake (CI_KIT_VM_STOP_ANSWER s, 180, for its answer); one assigned is given
#   CI_KIT_VM_JOB_BOUND min (50); past a bound the clone is stopped. Then the verified stop, the delete, out/ kept as
#   ~/ci-kit-vm/trials/<clone>.out, and the record ~/ci-kit-vm/trials/<candidate> (replaced whole by a rename), which
#   binds the candidate, the trial clone, out/job's run and attempt, the job's numeric id and its conclusion. Neither
#   exists in the guest: both are read through gh with the machine user's own login (the jobs of that run attempt that
#   ran on the trial runner, started after the trial began, exactly one; CI_KIT_VM_TRIAL_RESULT s, 120, for it to
#   complete). A trial with no job in out/, or whose job cannot be told, is recorded with no job id and why.
# - --promote: refuses unless the record names the candidate, a job id and `success`; then `tart rename` of the
#   candidate to maws-vm-golden-<id> (its own id), then the pointer ~/ci-kit-vm/golden (CI_KIT_VM_GOLDEN) replaced by a
#   rename. Interrupted between the two, the pointer still names the old golden, which is valid; run again, it finds
#   the VM under either name and finishes. It prints the old golden for --retire.
# - --promote and --retire hold the pointer's own lock, ~/ci-kit-vm/golden.lock (flock, at most CI_KIT_VM_POINTER_WAIT
#   s, 120), a promote from its rename through its pointer write and a retire from its pointer check through its
#   delete, so a retire never deletes the VM a promote resuming from either name is about to point at.
# - --retire: deletes a stopped maws-vm-golden-*, maws-vm-candidate-* or maws-vm-trial-* VM that the pointer does not
#   name (a failed candidate, an old golden, a trial clone left by a step that died); never a job clone or the base. A
#   VM already gone is done.
#
# The log is ~/Library/Logs/ci-kit/vm-bake.log, the procedure's transcript. Tests move the paths and reads:
# CI_KIT_VM_HOME, CI_KIT_TART, CI_KIT_GH_BIN, CI_KIT_VM_DF, CI_KIT_VM_TART_HOME, CI_KIT_VM_TICK (the waits' poll, 2 s),
# CI_KIT_VM_REPO, and the bounds above with CI_KIT_VM_BOOT (120 s), CI_KIT_VM_KICKOFF (60 s), CI_KIT_VM_END_WAIT
# (60 s), CI_KIT_VM_STOP_TIMEOUT (60 s), CI_KIT_VM_PROVISION_WAIT (3600 s a step). Bash 3.2: macOS's own.
set -uo pipefail
log_tag='vm-bake' # dialog.sh's log names its lines so
here=$(cd "$(dirname "$0")" && pwd) || exit 1
hooks=$here/../hooks
# shellcheck source=../hooks/dialog.sh
source "$hooks/dialog.sh"
# shellcheck source=../hooks/desktop-lock.sh
source "$hooks/desktop-lock.sh"
# shellcheck source=tart.sh
source "$here/tart.sh"
# shellcheck source=lane-reads.sh
source "$here/lane-reads.sh"

bake_log=$ci_kit_logs/vm-bake.log
say() {
  printf 'ci-kit bake: %s\n' "$*"
  { mkdir -p "$ci_kit_logs" && printf '%s bake %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$bake_log"; } 2>/dev/null || true
}
die() {
  say "$*" >&2
  exit 1
}
refuse() {
  die "refused: $* (docs/mac-lane.md, the VM lane's maintenance)"
}
usage() {
  awk 'NR > 1 && !/^#/ { exit } NR > 1' "$0" | sed -n '/^#   bake.sh/s/^# \{0,1\}//p' >&2
  exit 2
}
whole() { # <value> <default>
  if [[ $1 =~ ^[0-9]+$ ]]; then printf '%s\n' "$((10#$1))"; else printf '%s\n' "$2"; fi
}

vm_home=${CI_KIT_VM_HOME:-$HOME/ci-kit-vm}
kit=${CI_KIT_VM_KIT:-$vm_home/kit}
golden_pointer=${CI_KIT_VM_GOLDEN:-$vm_home/golden}
pointer_lock_file=$vm_home/golden.lock
trials=$vm_home/trials
repo=${CI_KIT_VM_REPO:-SSFSKIM/MAWS}
base=${CI_KIT_VM_BASE:-ghcr.io/cirruslabs/macos-golden-gate-base:latest}
maws=${CI_KIT_VM_MAWS:-$HOME/Developer/GitHub/MAWS}
gh_bin=${CI_KIT_GH_BIN:-gh}
df_bin=${CI_KIT_VM_DF:-/bin/df}
tart_home=${CI_KIT_VM_TART_HOME:-${TART_HOME:-$HOME/.tart}}
tick=${CI_KIT_VM_TICK:-2}
disk_reserve=$(whole "${CI_KIT_VM_DISK_RESERVE:-}" 40)
disk_floor=$(whole "${CI_KIT_VM_DISK_FLOOR:-}" 5)
boot_bound=$(whole "${CI_KIT_VM_BOOT:-}" 120)
kickoff_bound=$(whole "${CI_KIT_VM_KICKOFF:-}" 60)
idle_bound=$(whole "${CI_KIT_VM_TRIAL_IDLE:-}" 1800)
answer_bound=$(whole "${CI_KIT_VM_STOP_ANSWER:-}" 180)
end_wait=$(whole "${CI_KIT_VM_END_WAIT:-}" 60)
stop_timeout=$(whole "${CI_KIT_VM_STOP_TIMEOUT:-}" 60)
provision_wait=$(whole "${CI_KIT_VM_PROVISION_WAIT:-}" 3600)
first_run_wait=$(whole "${CI_KIT_VM_FIRST_RUN_WAIT:-}" 1200)
result_wait=$(whole "${CI_KIT_VM_TRIAL_RESULT:-}" 120)
pointer_wait=$(whole "${CI_KIT_VM_POINTER_WAIT:-}" 120)
job_bound_min=$(minutes "${CI_KIT_VM_JOB_BOUND:-}" 50)
job_bound=$(seconds "$job_bound_min")
lane_agent=com.ssfskim.ci-kit.vm-lane
lane_lock=$ci_kit_logs/vm-lane.lock
reserved_file=$ci_kit_logs/vm-reserved
guest_shares='/Volumes/My Shared Files'
provision="$guest_shares/kit/vm/provision.sh"
markers='listening session-conflict assigned job refused stop-request stop-refused stop-raced stopped done unfit'
vm_name_re='^[A-Za-z0-9][A-Za-z0-9._-]*$'
# The guest's disk in GB, set while the candidate is stopped (tart set --disk-size) and taken into its APFS container by
# provision.sh disk. A provisioned image has about 2.5 GiB free in a 41 GiB container, and V1's clone ran three builds
# into ENOSPC (215 MiB free). With out/ no longer built in the guest a job writes less (a checkout, node_modules from
# the warm store, a ~130 MB restored out/, test results), but V1's worst clone used ~2.3 GiB and the guest's swap file
# reached ~0.9 GB. The base's disk is most likely 50 GB already (Cirrus's golden-gate template sets disk_size_gb 50,
# and a 41 GiB container beside its ~5 GB recovery container and 0.5 GB iBoot container fills 50 GB), so 50 would add
# nothing: 60 adds 10 GB, and the recovery container the resize removes about 5 more, for about 17 GiB free after
# provisioning, some 7x V1's worst. The host pays only for the blocks a clone writes (APFS copy-on-write).
guest_disk=60
# The base image refuses less memory (tart set: LessThanMinimalResourcesError, 4294967296 bytes at minimum).
memory_minimum=4096

# 0 there, 1 not there, 2 the lookup failed.
exists() { # <path>
  perl -e 'exit 0 if lstat $ARGV[0]; exit 1 if $!{ENOENT}; exit 2' "$1"
}
stamp() {
  date -u +%Y%m%dT%H%M%SZ
}
# The machine's short name: the host's exclusive runner's registration (as install.sh reads it), else CI_KIT_MACHINE.
machine_name() {
  local name
  name=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8-sig"))["agentName"])' \
    "$HOME/actions-runner-maws/.runner" 2>/dev/null) && name=${name#ci-kit-mac-} || name=${CI_KIT_MACHINE:-}
  [[ $name =~ ^[a-z0-9-]+$ ]] || die "the machine's short name cannot be read (~/actions-runner-maws/.runner, or CI_KIT_MACHINE)"
  printf '%s\n' "$name"
}

# The maintenance hold, and the lane lock for the step's run.
hold_check() {
  local file line owners='' status
  for file in "$ci_kit_logs"/vm-hold.*; do
    [[ -f $file && $file != *.tmp ]] || continue
    IFS= read -r line <"$file" 2>/dev/null || line=''
    [[ $line == maintenance* ]] && owners+="${owners:+, }${file##*/vm-hold.} ($line)"
  done
  [[ -n $owners ]] || refuse "no maintenance hold: run $here/hold.sh hold <session> maintenance first"
  exists "$reserved_file"
  case $? in
    0) refuse "a reservation stands ($(head -1 "$reserved_file" 2>/dev/null || echo unreadable)): wait for the lane's guest to go" ;;
    1) ;;
    *) refuse "whether a reservation stands cannot be read ($reserved_file)" ;;
  esac
  launchctl print "gui/$(id -u)/$lane_agent" >/dev/null 2>&1
  status=$?
  case $status in
    0) refuse "the launcher's agent is loaded: launchctl bootout gui/\$(id -u)/$lane_agent first" ;;
    113) ;;
    *) refuse "whether the launcher's agent is loaded cannot be told (launchctl print exited $status)" ;;
  esac
  mkdir -p "$ci_kit_logs" 2>/dev/null
  exec 7>>"$lane_lock" || refuse "$lane_lock cannot be opened"
  perl -MFcntl=:flock -e 'open(my $fh, ">>&=", 7) or exit 2; exit(flock($fh, LOCK_EX | LOCK_NB) ? 0 : 1)' ||
    refuse "a launcher or an install holds $lane_lock: the launcher runs though its agent is not loaded, or mac/install.sh is publishing the lane; let it finish or stop it first"
  say "held for maintenance by $owners; no reservation, the launcher booted out"
}
# The golden pointer's lock, flock(2) on descriptor 6, held from a promote's rename through its pointer write and from
# a retire's pointer check through its delete, so a retire can never delete the VM a promote is about to point at. It
# is not vm-lane.lock: a retire needs no hold and runs beside the launcher. Released with the process.
pointer_lock() {
  mkdir -p "$vm_home" 2>/dev/null
  exec 6>>"$pointer_lock_file" || refuse "$pointer_lock_file cannot be opened"
  perl -MFcntl=:flock -e 'open(my $fh, ">>&=", 6) or exit 2; local $SIG{ALRM} = sub { exit 1 }; alarm shift;
    exit(flock($fh, LOCK_EX) ? 0 : 1)' "$pointer_wait" ||
    refuse "$pointer_lock_file stayed taken for $pointer_wait s: another promote or retire runs"
}
# The free space of Tart's volume, against the reserve.
reserve_check() {
  disk_read || refuse "the free space of $tart_home cannot be read"
  ((d_free >= disk_reserve)) || refuse "$d_free GB free on the volume of $tart_home, under the reserve of $disk_reserve GB (CI_KIT_VM_DISK_RESERVE)"
  lowest=$d_free
  say "$d_free GB free on the volume of $tart_home (reserve $disk_reserve GB)"
}
# Nothing of the lane's runs: one guest at a time, and its memory is the owner's.
none_running() {
  local vms running
  vms=$(tart_vms) || refuse 'Tart cannot list its VMs'
  running=$(awk -F'\t' '$1 ~ /^maws-vm-/ && $2 != "stopped" { printf "%s%s (%s)", sep, $1, $2; sep = ", " }' <<<"$vms")
  [[ -z $running ]] || refuse "a VM of the lane runs: $running; stop it with the verified stop first"
  tart_list=$vms
}
# A VM that must be there and stopped (verified as a delete's is).
stopped_vm() { # <name>
  local status
  [[ -n $(tart_state_in "$tart_list" "$1") ]] || refuse "no VM named $1 (tart list)"
  tart_ended "$1"
  status=$?
  ((status == 0)) || refuse "$1 is not verified stopped: $tart_why"
}

# A VM booted for a step: spawned detached (tart.sh), until its guest agent answers. Sets run_vm.
run_vm=''
boot_vm() { # <name> <tart run options...>
  local name=$1 status
  shift
  tart_spawn "$name" "$ci_kit_logs/vm-bake-run.log" "$@"
  run_vm=$name
  say "$name runs (tart run, pid $tart_run_pid); waiting for its guest agent (at most $boot_bound s)"
  tart_wait_answer "$name" "$boot_bound" "$tart_run_pid"
  status=$?
  case $status in
    0) say "$name: its guest agent answers" ;;
    3) end_vm; die "$name: tart run exited during the boot (see $ci_kit_logs/vm-bake-run.log)" ;;
    *) end_vm; die "$name: its guest agent did not answer within $boot_bound s" ;;
  esac
}
# The verified stop of the step's VM; a VM whose end cannot be verified is left as it is, and said so.
end_vm() {
  [[ -n $run_vm ]] || return 0
  if tart_stop_verified "$run_vm" "$stop_timeout"; then
    say "$run_vm: its end is verified (Tart lists it stopped, and no tart run of it runs)"
    run_vm=''
    return 0
  fi
  say "$run_vm: its end cannot be verified ($tart_why); stop it by hand with the verified stop (docs/mac-lane.md)" >&2
  return 1
}
in_guest() { # <seconds> <what> <command...>: a tart exec in the step's VM
  local seconds=$1 what=$2 output status
  shift 2
  say "$run_vm: $what"
  output=$(tart_call "$seconds" exec "$run_vm" "$@" 2>&1)
  status=$?
  [[ -z $output ]] || printf '%s\n' "$output" | sed "s/^/  /"
  printf '%s\n' "$output" >>"$bake_log" 2>/dev/null
  if ((status != 0)); then
    output="$run_vm: $what failed ($status${output:+: $(tail -1 <<<"$output")})"
    end_vm
    die "$output"
  fi
}
# The free space between the bake's steps: the lowest kept, and under the floor the bake stops.
disk_follow() {
  disk_read || return 0
  ((d_free >= lowest)) || lowest=$d_free
  if ((d_free < disk_floor)); then
    end_vm
    die "$d_free GB free on the volume of $tart_home, under the floor of $disk_floor GB; the bake stopped"
  fi
}

do_bake() {
  local memory=4096 name='' golden version sha pnpm engine machine output quarantined
  while (($# > 0)); do
    case $1 in
      --memory) (($# > 1)) || usage; memory=$2; shift ;;
      --maws) (($# > 1)) || usage; maws=$2; shift ;;
      --name) (($# > 1)) || usage; name=$2; shift ;;
      *) usage ;;
    esac
    shift
  done
  [[ $memory =~ ^[1-9][0-9]{3,4}$ ]] || die "--memory takes the guest's memory in MB (got '$memory')"
  ((memory >= memory_minimum)) ||
    die "--memory $memory is under the base image's minimum of $memory_minimum MB (Tart refuses it: LessThanMinimalResourcesError)"
  name=${name:-maws-vm-candidate-$(date -u +%Y%m%d)}
  [[ $name =~ ^maws-vm-candidate-[A-Za-z0-9._-]+$ ]] || die "--name takes maws-vm-candidate-<id> (got '$name')"
  golden=maws-vm-golden-${name#maws-vm-candidate-}
  machine=$(machine_name) || exit 1
  hold_check
  reserve_check
  none_running
  [[ -z $(tart_state_in "$tart_list" "$name") ]] || refuse "$name exists: retire it (bake.sh --retire $name) or bake under another --name"
  [[ -z $(tart_state_in "$tart_list" "$golden") ]] || refuse "$golden exists, which $name would be promoted to: bake under another --name"
  [[ -f $kit/vm/provision.sh && -f $kit/hooks/cursor-park.swift ]] || refuse "no installed kit at $kit (mac/install.sh --vm)"
  [[ -f $maws/package.json && -f $maws/pnpm-lock.yaml ]] || refuse "no MAWS checkout at $maws (--maws)"
  version=$(sed -n 's/^RUNNER_VERSION=\([0-9.]*\).*/\1/p' "$kit/install.sh" 2>/dev/null)
  sha=$(sed -n 's/^RUNNER_SHA256=\([0-9a-f]*\).*/\1/p' "$kit/install.sh" 2>/dev/null)
  [[ -n $version && -n $sha ]] || refuse "the runner's pin cannot be read from $kit/install.sh"
  # A record left by an earlier candidate of this name (retired, then baked again) must not authorize this one.
  if [[ -e $trials/$name ]]; then
    mv -f "$trials/$name" "$trials/$name.before-$(stamp)" || refuse "an earlier trial record of $name cannot be moved aside ($trials/$name)"
    say "an earlier trial record of $name is kept as $trials/$name.before-<time>; this candidate has none until its own trial"
  fi
  pnpm=$(perl -MJSON::PP -e 'my $p = JSON::PP->new->decode(do { local $/; <STDIN> }); my ($v) = ($p->{packageManager} // "") =~ /^pnpm\@(\d+\.\d+\.\d+)/; print $v // ""' <"$maws/package.json" 2>/dev/null)
  [[ -n $pnpm ]] || refuse "the MAWS checkout's packageManager names no pnpm version ($maws/package.json)"
  # The guest's engine is the host's: the version of this user's own Claude Code (the native installer's link, which
  # the host lane's jobs launch), or CI_KIT_VM_ENGINE's.
  engine=${CI_KIT_VM_ENGINE:-$("$HOME/.local/bin/claude" --version 2>/dev/null | sed -n 's/^\([0-9][0-9.]*\) (Claude Code)$/\1/p')}
  [[ $engine =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    refuse "no Claude Code version for the guest: $HOME/.local/bin/claude answers none, and CI_KIT_VM_ENGINE names none (got '$engine')"
  say "baking $name from $base: --cpu 4 --memory $memory --display 2560x1440pt --disk-size $guest_disk; runner $version, pnpm $pnpm, Claude Code $engine, guest machine $machine-vm"
  tart_call 1800 clone "$base" "$name" >/dev/null 2>&1 || die "tart clone $base $name failed"
  output=$(tart_call 300 set "$name" --cpu 4 --memory "$memory" --display 2560x1440pt --disk-size "$guest_disk" 2>&1) ||
    die "tart set $name failed${output:+ ($(tail -1 <<<"$output"))}; $name stays, stopped"
  boot_vm "$name" "--dir=kit:$kit:ro" "--dir=maws:$maws:ro"
  in_guest 600 'the base (check)' /bin/bash "$provision" check
  disk_follow
  in_guest 1800 "the disk grown to $guest_disk GB (disk)" /bin/bash "$provision" disk "$guest_disk"
  disk_follow
  in_guest 600 'indexing and measured background services off (quiet)' /bin/bash "$provision" quiet
  disk_follow
  in_guest 900 'the display at 2560x1440, scaling on (display)' /bin/bash "$provision" display
  disk_follow
  in_guest "$provision_wait" "Node 22 and pnpm $pnpm (node)" /bin/bash "$provision" node "$pnpm"
  disk_follow
  in_guest "$provision_wait" "the warm store (store)" /bin/bash "$provision" store
  disk_follow
  in_guest "$provision_wait" 'LibreOffice (libreoffice)' /bin/bash "$provision" libreoffice
  disk_follow
  in_guest "$provision_wait" 'Poppler (poppler)' /bin/bash "$provision" poppler
  disk_follow
  in_guest "$provision_wait" "Claude Code $engine (engine)" /bin/bash "$provision" engine "$engine"
  disk_follow
  in_guest "$provision_wait" 'MAWS environment from its declaration (setup)' /bin/bash "$provision" setup
  disk_follow
  in_guest 900 "the runner $version (runner)" /bin/bash "$provision" runner "$version" "$sha" "$machine-vm"
  disk_follow
  in_guest "$provision_wait" 'the seeded MAWS work repository (workrepo)' /bin/bash "$provision" workrepo
  disk_follow
  in_guest 900 'the compiled helpers (helpers)' /bin/bash "$provision" helpers
  disk_follow
  quarantined=$(tart_call 30 exec "$run_vm" /bin/bash -c '
    if [[ -e $HOME/.ci-kit/quarantined-apps ]]; then cat "$HOME/.ci-kit/quarantined-apps"
    else echo /Applications/LibreOffice.app; fi') || {
    end_vm
    die "$name: cannot read the setup step's quarantined-apps record"
  }
  end_vm || die "$name is baked, but its stop is not verified"
  say "baked: $name, stopped; the lowest free space during the bake was $lowest GB"
  cat <<EOF

The human's first-run window step, once, on $name (Design, The image). The human, or CI-opt through cua, does the
window step in the guest only; the mini's own prompts stay the human's. In the mini's own GUI session, reached over
Screen Sharing from the MacBook (never VNC into the guest), with the maintenance hold still in place:
  1. Open Terminal on the mini and run:
       tart run --no-clipboard --dir=maws:$maws:ro $name
     A window opens and the guest logs in as admin by itself. Every boot of the lane drops the shared clipboard.
  2. In the guest's window, by clicks: open Terminal (Applications > Utilities > Terminal) and answer anything it
     asks on its first launch. Open each app below, answer its first-run dialogs, and quit it from its menu.
     Nothing is typed or pasted into the guest. Apps (recorded quarantine, or legacy LibreOffice without a declaration):
${quarantined:-     (none)}
  3. From the MacBook run:
       ssh mini '~/ci-kit-vm/kit/vm/bake.sh --first-run $name'
     This runs pnpm e2e:deliverables through tart exec. When macOS asks whether Electron may send notifications,
     answer it in the guest's window as the mini's own setting has it (System Settings > Notifications > Electron
     on the mini). Answer any other prompt the group raises the same way. No script answers a prompt.
     On success the scratch clone is removed and the guest shuts down, its stop verified; on failure it stays up
     for inspection. Rerun --first-run until it passes; it cleans any interrupted run first and shuts the guest
     down itself only after a pass. Keep the maintenance hold until the procedure is done.
Only after --first-run passes and the stop is verified: bake.sh --trial $name, bake.sh --promote $name.
EOF
}

do_first_run() {
  local vm=${1:-} vms script status started
  [[ $# -eq 1 ]] || usage
  [[ $vm =~ ^maws-vm-candidate-[A-Za-z0-9._-]+$ ]] || refuse "--first-run needs a maws-vm-candidate-<id> (got '$vm')"
  hold_check
  ((first_run_wait > 0)) || refuse "CI_KIT_VM_FIRST_RUN_WAIT must be positive (seconds)"
  vms=$(tart_vms) || refuse 'Tart cannot list its VMs'
  [[ $(tart_state_in "$vms" "$vm") == running ]] ||
    refuse "$vm is not running: start it with tart run in the mini's Terminal, as --bake prints"
  tart_answers "$vm" || refuse "$vm: its guest agent does not answer; wait for the guest to log in and retry --first-run"
  run_vm=$vm
  # Unlike in_guest, a failure here must leave the window open. Bound the work in the guest too: killing a host
  # tart exec can kill the cleanup shell without ending its detached workload. Every retry cleans the scratch
  # processes and directory first; normal exits and the guest deadline clean them too.
  script=$(cat <<'GUEST'
set -euo pipefail
refuse() { printf 'refused: %s\n' "$*" >&2; exit 1; }
share='/Volumes/My Shared Files/maws'
[[ -d $share && -f $share/package.json && -f $share/pnpm-lock.yaml ]] ||
  refuse "the MAWS share is not mounted at $share; start the candidate with the --dir=maws share as --bake prints"
record=$HOME/.ci-kit/quarantined-apps
if [[ -e $record ]]; then
  apps=$(cat "$record") || refuse "the setup step's quarantined-apps record cannot be read at $record"
else
  # A checkout without a declaration retains the legacy provision steps and LibreOffice approval check.
  apps=/Applications/LibreOffice.app
fi
while IFS= read -r app || [[ -n $app ]]; do
  [[ -n $app ]] || continue
  attrs=$(xattr "$app") || refuse "$app's quarantine cannot be read"
  if grep -qx com.apple.quarantine <<<"$attrs"; then
    quarantine=$(xattr -p com.apple.quarantine "$app") || refuse "$app's quarantine cannot be read"
    flags=${quarantine%%;*}
    [[ $flags =~ ^[[:xdigit:]]{1,8}$ ]] || refuse "$app's quarantine flags cannot be read: $flags"
    (( (16#$flags & 0x40) != 0 )) ||
      refuse "$app is not user-approved: open it in the guest's window, answer its first-run dialogs and quit it from its menu before --first-run"
  fi
done <<<"$apps"
PATH=$(cat "$HOME/actions-runner-maws/.path") || refuse "the runner's PATH cannot be read from ~/actions-runner-maws/.path"
[[ -n $PATH ]] || refuse "the runner's PATH is empty"
export PATH
work=$HOME/maws-firstrun
# This path belongs only to first-run in a candidate. A cancelled exec can skip EXIT, leaving it and Electron.
# Electron normally names its binary under node_modules here; pnpm and shells can name only tools elsewhere,
# so match cwd too. Do not traverse node_modules with lsof +D: the cwd table is enough.
stop_scratch() {
  /usr/bin/perl -MTime::HiRes=time,sleep -e '
    my $work = shift;
    sub matching {
      my (%parent, %cmd, %live, %skip, %found);
      open my $ps, "-|", "/bin/ps", "-axww", "-o", "pid=,ppid=,stat=,command=" or die "ps: $!";
      while (<$ps>) {
        next unless /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;
        $parent{$1} = $2; $cmd{$1} = $4; $live{$1} = $3 !~ /^Z/;
      }
      close $ps or die "first-run: cannot read processes\n";
      # This scanner carries the scratch path in argv; never select it or the exec that owns it.
      for (my $pid = $$; $pid && !$skip{$pid}++; $pid = $parent{$pid} // 0) {}
      for my $pid (keys %cmd) { $found{$pid} = 1 if index($cmd{$pid}, $work) >= 0; }
      open my $ls, "-|", "/usr/sbin/lsof", "-a", "-u", $<, "-d", "cwd", "-Fpn" or die "lsof: $!";
      my $pid;
      while (<$ls>) {
        chomp;
        if (/^p(\d+)$/) { $pid = $1; }
        elsif (/^n(.*)$/ && defined $pid && ($1 eq $work || index($1, "$work/") == 0)) { $found{$pid} = 1; }
      }
      close $ls or die "first-run: cannot read process working directories\n";
      return grep { $live{$_} && !$skip{$_} } keys %found;
    }
    sub wait_gone {
      my $until = time + 5;
      while (time < $until && grep { kill 0, $_ } @_) { sleep 0.1; }
    }
    my @pids = matching();
    exit 0 unless @pids;
    print "first-run: stopping scratch processes @pids\n";
    kill "TERM", @pids;
    wait_gone(@pids);
    @pids = matching();
    my $until = time + 5;
    while (@pids && time < $until) {
      print "first-run: killing scratch stragglers @pids\n";
      kill "KILL", @pids;
      sleep 0.1;
      @pids = matching();
    }
    die "first-run: scratch processes still run: @pids\n" if @pids;
  ' "$work"
}
printf 'first-run: cleaning owned scratch %s and any previous run\n' "$work"
stop_scratch
rm -rf "$work"
cleanup() {
  local status=$?
  trap - EXIT
  cd "$HOME"
  stop_scratch && rm -rf "$work" || exit 1
  exit "$status"
}
trap cleanup EXIT
# The workload carries the absolute scratch in argv even before clone/cd. Expiry ends its main group;
# EXIT also finds detached Electron and anything else tied to the scratch.
/usr/bin/perl -MPOSIX=setsid -e '
  my $seconds = shift;
  my $pid = fork;
  defined $pid or exit 125;
  if (!$pid) { setsid() or exit 126; exec { $ARGV[0] } @ARGV; exit 127; }
  $SIG{ALRM} = sub {
    kill "KILL", -$pid; kill "KILL", $pid; waitpid $pid, 0;
    print STDERR "first-run: timed out after $seconds s\n"; exit 124;
  };
  alarm $seconds;
  waitpid $pid, 0;
  my $status = $?;
  alarm 0;
  exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);
' "$1" /bin/bash -euo pipefail -c '
  git -c safe.directory="*" clone "/Volumes/My Shared Files/maws" "$1"
  cd "$1"
  pnpm install --frozen-lockfile
  NODE_OPTIONS=--max-old-space-size=3072 pnpm e2e:deliverables
' first-run "$work"
GUEST
)
  say "$vm: first-run shell (at most $first_run_wait s); answer any prompt in the guest's window"
  tart_call "$((first_run_wait + 60))" exec "$vm" /bin/bash -c "$script" first-run "$first_run_wait" 2>&1 | tee -a "$bake_log"
  status=$?
  ((status == 0)) || die "$vm: first-run failed ($status); stays running: inspect the output and the guest's window, fix the cause, then rerun --first-run $vm"
  say "$vm: first-run passed; the scratch clone is removed; asking the guest to shut down"
  tart_call 30 exec "$vm" sudo -n /sbin/shutdown -h now ||
    say "$vm: shutdown did not acknowledge; checking its end before the verified stop"
  started=$SECONDS
  while ((SECONDS - started < end_wait)); do
    tart_ended "$vm" && break
    sleep "$tick"
  done
  end_vm || die "$vm: first-run passed, but its stop is not verified"
}

do_register() {
  refuse '--register is retired: each job/trial clone mints JIT with the existing host gh login; no registration token or persistent identity is needed'
}

# A trial failure after mint still revokes its registration when the VM is verified
# ended. A killed maintenance process leaves its private record for --retire or the
# next trial; neither can remove a running clone's registration.
trial_jit_cleanup() {
  [[ -n ${trial:-} ]] || return 0
  tart_ended "$trial" || return 1
  jit_retire "$vm_home/vm-trial" "$trial"
}

# The trial's job, through gh: j_id, j_conclusion; false with j_why.
trial_job() { # <run> <attempt> <runner name> <since>
  local scratch err page lines count status started=$SECONDS
  j_id='' j_conclusion='' j_why=''
  if ! scratch=$(mktemp) || ! err=$(mktemp); then j_why='no scratch file'; return 1; fi
  while :; do
    lines=''
    for ((page = 1; page <= 20; page++)); do
      if ! bounded 20 env -u GH_TOKEN -u GITHUB_TOKEN "$gh_bin" api \
        "repos/$repo/actions/runs/$1/attempts/$2/jobs?per_page=100&page=$page" >"$scratch" 2>"$err" 7>&-; then
        j_why="the jobs of run $1 attempt $2 cannot be read: $(head -1 "$err" 2>/dev/null)"
        rm -f "$scratch" "$err"
        return 1
      fi
      if ! status=$(perl -MJSON::PP -e '
        my ($runner, $since) = @ARGV;
        my $d = eval { JSON::PP->new->decode(do { local $/; <STDIN> }) };
        exit 1 unless ref $d eq "HASH" && ref $d->{jobs} eq "ARRAY";
        printf "%d\n", scalar @{$d->{jobs}};
        for my $j (@{$d->{jobs}}) {
          next unless ref $j eq "HASH" && ($j->{runner_name} // "") eq $runner && ($j->{started_at} // "") ge $since;
          print join("\t", $j->{id} // "", $j->{status} // "", $j->{conclusion} // ""), "\n";
        }' "$3" "$4" <"$scratch"); then
        j_why="the jobs of run $1 attempt $2 cannot be parsed"
        rm -f "$scratch" "$err"
        return 1
      fi
      count=$(head -1 <<<"$status")
      lines+="$(tail -n +2 <<<"$status")"$'\n'
      ((count >= 100)) || break
    done
    lines=$(sed '/^$/d' <<<"$lines")
    case $(grep -c . <<<"$lines") in
      0) j_why="no job of run $1 attempt $2 ran on $3 since $4"; break ;;
      1) ;;
      *) j_why="more than one job of run $1 attempt $2 ran on $3 since $4"; break ;;
    esac
    IFS=$'\t' read -r j_id status j_conclusion <<<"$lines"
    if [[ ! $j_id =~ ^[0-9]+$ ]]; then j_why="the job's id is not a number ($j_id)"; j_id=''; break; fi
    [[ $status != completed ]] || break
    if ((SECONDS - started >= result_wait)); then
      j_why="job $j_id is $status at GitHub after $result_wait s" j_conclusion=''
      break
    fi
    sleep "$tick"
  done
  rm -f "$scratch" "$err"
  [[ -n $j_id && -z $j_why ]]
}
trial_field() { # <marker> <key>
  local word
  for word in $(head -1 "$t_out/$1" 2>/dev/null); do
    [[ $word != "$2="* ]] || { printf '%s\n' "${word#*=}"; return 0; }
  done
}
# Follows the trial clone through out/ until it powers off (0), or until a bound says to stop it (1, t_end why).
trial_follow() {
  local start=$SECONDS assigned_at='' asked_at='' done_at='' unfit_at='' seen=' ' marker
  while :; do
    kill -0 "$tart_run_pid" 2>/dev/null || { t_end='the guest powered itself off'; return 0; }
    for marker in $markers; do
      if [[ -f $t_out/$marker && $seen != *" $marker "* ]]; then
        seen+="$marker "
        say "$trial: out/$marker: $(head -1 "$t_out/$marker" 2>/dev/null)"
      fi
    done
    if [[ -z $assigned_at ]] && [[ -f $t_out/assigned || -f $t_out/job || -f $t_out/stop-refused ]]; then
      assigned_at=$SECONDS
    fi
    [[ -n $done_at || ! -f $t_out/done ]] || done_at=$SECONDS
    [[ -n $unfit_at || ! -f $t_out/unfit ]] || unfit_at=$SECONDS
    if [[ -n $unfit_at ]]; then
      # No runner started and no wrapper remains to answer an idle stop: only the power-off is still owed.
      ((SECONDS - unfit_at < end_wait)) || { t_end="the guest is unfit, but it did not power off within $end_wait s"; return 1; }
    elif [[ -n $done_at ]]; then
      ((SECONDS - done_at < end_wait)) || { t_end="its runner is done, but it did not power off within $end_wait s"; return 1; }
    elif [[ -n $assigned_at ]]; then
      ((SECONDS - assigned_at < job_bound)) || { t_end="its job outlived $job_bound_min min"; return 1; }
    elif [[ -n $asked_at ]]; then
      ((SECONDS - asked_at < answer_bound + end_wait)) || { t_end="the wrapper did not answer the stop within $answer_bound s"; return 1; }
    elif ((SECONDS - start >= idle_bound)); then
      if printf '' >"$t_out/.stop-request.tmp" 2>/dev/null && mv -f "$t_out/.stop-request.tmp" "$t_out/stop-request" 2>/dev/null; then
        asked_at=$SECONDS
        say "$trial: no job assigned within $idle_bound s; asked the wrapper to stop (out/stop-request)"
      else
        t_end="no job assigned within $idle_bound s, and out/stop-request cannot be written"
        return 1
      fi
    fi
    sleep "$tick"
  done
}
# Whether the trial clone's wrapper may have started: kickoff.sh opens out/wrapper.log as it starts it.
trial_wrapper_may_run() {
  local marker
  [[ ! -e $t_out/wrapper.log ]] || return 0
  for marker in $markers; do
    [[ $marker == stop-request || ! -e $t_out/$marker ]] || return 0
  done
  return 1
}
write_record() { # <summary>, from the trial's fields
  local file=$trials/$candidate
  if printf '%s\ncandidate=%s\ntrial=%s\nrun=%s\nattempt=%s\njob=%s\nconclusion=%s\nout=%s\nat=%s\nwhy=%s\n' \
    "$1" "$candidate" "$trial" "$t_run" "$t_attempt" "$j_id" "$j_conclusion" "$t_kept" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$t_why" >"$file.tmp" 2>/dev/null && mv -f "$file.tmp" "$file" 2>/dev/null; then
    say "the trial record $file: $1"
    return 0
  fi
  rm -f "$file.tmp" 2>/dev/null
  die "the trial record $file cannot be written ($1)"
}

do_trial() {
  candidate=${1:-}
  local machine runner since kick entry vms
  [[ $# -eq 1 && $candidate =~ ^maws-vm-candidate-[A-Za-z0-9._-]+$ ]] || usage
  machine=$(machine_name) || exit 1
  hold_check
  reserve_check
  none_running
  stopped_vm "$candidate"
  for entry in "$vm_home/vm-trial"/jit/maws-vm-trial-*; do
    [[ -d $entry ]] || continue
    tart_ended "${entry##*/}" || refuse "${entry##*/}: $tart_why"
    jit_retire "$vm_home/vm-trial" "${entry##*/}" || die 'the previous trial JIT config could not be revoked'
  done
  [[ -f $kit/vm/guest/kickoff.sh ]] || refuse "no installed kit at $kit (mac/install.sh --vm)"
  t_out=$vm_home/vm-trial/out
  mkdir -p "$trials" "$vm_home/vm-trial/cache" || die "$trials cannot be made"
  # Every clone starts from an empty out/: what is there is kept beside the records, not read as this trial's.
  if [[ -e $t_out && -n $(ls -A "$t_out" 2>/dev/null) ]]; then
    mv "$t_out" "$trials/unclaimed-$(stamp).out" || die "$t_out cannot be moved aside"
  fi
  mkdir -p "$t_out" || die "$t_out cannot be made"
  trial=maws-vm-trial-$(stamp)
  runner=ci-kit-mac-$machine-$trial
  trap 'trial_jit_cleanup || say "trial JIT cleanup pending; use --retire $trial after its verified stop"' EXIT
  jit_mint "$repo" "$machine" "$vm_home/vm-trial" vm-trial "$trial" || die 'no boot: trial JIT mint failed'
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  t_run='' t_attempt='' t_why='' t_kept='' j_id='' j_conclusion=''
  say "trying $candidate: $trial with its own JIT registration ($runner, ci-kit-mac-vm-trial alone)"
  tart_clone "$candidate" "$trial" >/dev/null 2>&1 || die "tart clone $candidate $trial failed"
  # shellcheck disable=SC2046 # one option a line, no space in any
  boot_vm "$trial" $(tart_shares "$kit" "$vm_home/vm-trial" "$trial")
  say "$trial: kickoff.sh vm-trial $trial"
  if kick=$(tart_kickoff "$trial" vm-trial "$kickoff_bound" 2>&1); then
    say "$trial: $(tail -1 <<<"$kick")"
    trial_follow
  elif trial_wrapper_may_run; then
    say "$trial: kickoff.sh failed ($(tail -1 <<<"$kick")), but out/ shows its wrapper; following it"
    trial_follow
  else
    t_end="kickoff.sh failed: $(tail -1 <<<"$kick")"
  fi
  say "$trial: $t_end"
  end_vm || die "$trial's end is not verified; no record is written, and it is left for the verified stop by hand"
  trial_jit_cleanup || die "local JIT cleanup failed; --retire $trial retries it"
  jit_reap "$vm_home/vm-trial" || say 'registration cleanup pending; the lane or the next maintenance step retries it'
  trap - EXIT
  vms=$(tart_vms) || die "Tart cannot list its VMs; $trial is stopped but not deleted"
  if [[ -n $(tart_state_in "$vms" "$trial") ]]; then
    tart_delete "$trial" >/dev/null 2>&1 || die "tart delete $trial failed; it is stopped, and --retire $trial deletes it"
  fi
  say "$trial: deleted"
  t_kept=$trials/$trial.out
  if mv "$t_out" "$t_kept" 2>/dev/null; then mkdir -p "$t_out"; else t_kept=$t_out; fi
  if [[ -f $t_kept/unfit ]]; then
    t_why="the guest started no runner: $(head -1 "$t_kept/unfit" 2>/dev/null)"
    write_record "trial of $candidate: no job"
    return 0
  fi
  if [[ ! -f $t_kept/job ]]; then
    t_why="no job reached the trial clone's hook (no out/job): $t_end"
    write_record "trial of $candidate: no job"
    return 0
  fi
  t_out=$t_kept
  t_run=$(trial_field job run) t_attempt=$(trial_field job attempt)
  if [[ ! ($t_run =~ ^[0-9]+$ && $t_attempt =~ ^[0-9]+$) ]]; then
    t_why="out/job names no run and attempt ($(head -1 "$t_kept/job" 2>/dev/null))"
    write_record "trial of $candidate: no job"
    return 0
  fi
  if ! trial_job "$t_run" "$t_attempt" "$runner" "$since"; then
    t_why=$j_why
    if [[ -n $j_id ]]; then write_record "trial of $candidate: run $t_run job $j_id, no conclusion"; return 0; fi
    write_record "trial of $candidate: run $t_run, no job id"
    return 0
  fi
  write_record "trial of $candidate: run $t_run job $j_id $j_conclusion"
}

do_promote() {
  local candidate=${1:-} golden key value r_candidate='' r_job='' r_conclusion='' c_state g_state old='' status
  [[ $# -eq 1 && $candidate =~ ^maws-vm-candidate-[A-Za-z0-9._-]+$ ]] || usage
  golden=maws-vm-golden-${candidate#maws-vm-candidate-}
  hold_check
  [[ -f $trials/$candidate ]] || refuse "no trial record for $candidate ($trials/$candidate): bake.sh --trial $candidate first"
  while IFS='=' read -r key value; do
    case $key in candidate) r_candidate=$value ;; job) r_job=$value ;; conclusion) r_conclusion=$value ;; esac
  done <"$trials/$candidate"
  [[ $r_candidate == "$candidate" ]] || refuse "the trial record $trials/$candidate names ${r_candidate:-no candidate}, not $candidate"
  [[ $r_job =~ ^[0-9]+$ ]] || refuse "the trial record names no job id ($(head -1 "$trials/$candidate")): no trial job ran"
  [[ $r_conclusion == success ]] || refuse "the trial job $r_job concluded ${r_conclusion:-nothing}, not success"
  pointer_lock
  tart_list=$(tart_vms) || refuse 'Tart cannot list its VMs'
  c_state=$(tart_state_in "$tart_list" "$candidate") g_state=$(tart_state_in "$tart_list" "$golden")
  if [[ -n $c_state && -n $g_state ]]; then
    refuse "both $candidate and $golden exist; which one the trial was cannot be told"
  elif [[ -n $c_state ]]; then
    stopped_vm "$candidate"
    tart_call 120 rename "$candidate" "$golden" >/dev/null 2>&1 6>&- || die "tart rename $candidate $golden failed"
    say "renamed $candidate to $golden (trial job $r_job, success)"
  elif [[ -n $g_state ]]; then
    say "$candidate is $golden already; the pointer is next"
  else
    refuse "neither $candidate nor $golden is among Tart's VMs"
  fi
  if [[ -f $golden_pointer ]]; then
    IFS= read -r old <"$golden_pointer" 2>/dev/null || old=''
    old=${old%%[[:space:]]*}
  fi
  if [[ $old == "$golden" ]]; then
    say "promoted already: the pointer names $golden"
    return 0
  fi
  if ! { printf '%s\n' "$golden" >"$golden_pointer.tmp" && mv -f "$golden_pointer.tmp" "$golden_pointer"; } 2>/dev/null; then
    rm -f "$golden_pointer.tmp" 2>/dev/null
    status=${old:-no golden}
    die "the pointer $golden_pointer cannot be written; it still names $status, which stays valid: run --promote $candidate again"
  fi
  say "promoted: the pointer names $golden (it named ${old:-nothing}); the launcher boots from it once released"
  [[ -z $old ]] || say "after the first green production job from $golden: bake.sh --retire $old"
}

do_retire() {
  local vm=${1:-} pointed='' status
  [[ $# -eq 1 && $vm =~ $vm_name_re ]] || usage
  [[ $vm =~ ^maws-vm-(golden|candidate|trial)-[A-Za-z0-9._-]+$ ]] ||
    refuse "$vm is not a golden, a candidate or a trial clone of the lane: --retire deletes nothing else"
  pointer_lock
  exists "$golden_pointer"
  case $? in
    0) IFS= read -r pointed <"$golden_pointer" 2>/dev/null || refuse "the pointer $golden_pointer cannot be read"
       pointed=${pointed%%[[:space:]]*} ;;
    1) ;;
    *) refuse "the pointer $golden_pointer cannot be read" ;;
  esac
  [[ $vm != "$pointed" ]] || refuse "$vm is the golden image the pointer names; promote another first"
  tart_list=$(tart_vms) || refuse 'Tart cannot list its VMs'
  if [[ $vm == maws-vm-trial-* ]]; then
    tart_ended "$vm" || refuse "$vm is not verified ended: $tart_why"
    jit_retire "$vm_home/vm-trial" "$vm" || die "local JIT cleanup failed for $vm"
    jit_reap "$vm_home/vm-trial" || say 'registration cleanup pending; the lane retries it'
  fi
  if [[ -z $(tart_state_in "$tart_list" "$vm") ]]; then
    say "retired already: $vm is not among Tart's VMs"
    return 0
  fi
  tart_ended "$vm"
  status=$?
  case $status in
    0) ;;
    1) refuse "$vm runs ($tart_why): stop it with the verified stop first" ;;
    *) refuse "whether $vm runs cannot be told ($tart_why)" ;;
  esac
  tart_delete "$vm" >/dev/null 2>&1 6>&- || die "tart delete $vm failed"
  say "retired: $vm deleted (the pointer names ${pointed:-nothing})"
}

command=${1:-}
shift || true
case $command in
  --bake) do_bake "$@" ;;
  --first-run) do_first_run "$@" ;;
  --register) do_register "$@" ;;
  --trial) do_trial "$@" ;;
  --promote) do_promote "$@" ;;
  --retire) do_retire "$@" ;;
  *) usage ;;
esac
