#!/bin/bash
# The VM lane's maintenance procedure (docs/mac-lane.md, "The VM lane's maintenance"): the coordinator's script for the
# steps that make, register, try, promote and retire the lane's images. The launcher (lane.sh) never runs any of them,
# and they never run beside it.
#
#   bake.sh --bake [--memory <MB>] [--maws <checkout>] [--name maws-vm-candidate-<id>]
#   bake.sh --register <candidate or golden>     one registration token a line on stdin, per identity still missing
#   bake.sh --trial <candidate>
#   bake.sh --promote <candidate>
#   bake.sh --retire <VM>
#
# THE HOLD. --bake, --register, --trial and --promote check it before anything else and refuse without it: a
# vm-hold.<owner> in ~/Library/Logs/ci-kit whose first line starts "maintenance" (CI-opt writes `maintenance since
# <time>`), no vm-reserved (a job clone may run while it stands), and the launcher's agent com.ssfskim.ci-kit.vm-lane
# not loaded (launchctl print), with no launcher holding vm-lane.lock. Each then holds vm-lane.lock itself for its run,
# so a launcher started out of order waits for the step instead of recovering beside it. Those that boot a VM (--bake,
# --register, --trial) also refuse while any maws-vm-* VM runs, and with less than CI_KIT_VM_DISK_RESERVE GB (40) free
# on the volume of ~/.tart. --retire needs no hold: nothing boots from a VM the golden pointer does not name, and a
# running one is never deleted.
#
# THE STEPS. Every one is safe to run again: nothing is deleted without a verified stop first (tart.sh: Tart lists it
# stopped and no `tart run` of it runs), and a step that dies leaves nothing automated to meet it.
# - --bake: `tart clone` of the base (CI_KIT_VM_BASE, ghcr.io/cirruslabs/macos-golden-gate-base:latest) to
#   maws-vm-candidate-<YYYYMMDD> (UTC; --name for another id), refused when that candidate or its golden name exists
#   (an earlier trial record of the name is moved aside, so only this candidate's own trial can authorize it);
#   `tart set --cpu 4 --memory <MB> --display 2560x1440pt` (--memory, 4096 until V1 decides between 3 and 4 GB); a run
#   with the installed kit (CI_KIT_VM_KIT, ~/ci-kit-vm/kit) and the MAWS checkout (--maws, CI_KIT_VM_MAWS,
#   ~/Developer/GitHub/MAWS) shared read-only; provision.sh's steps through `tart exec`, the free space read after each
#   (the lowest is printed, which the first refresh records; under CI_KIT_VM_DISK_FLOOR GB, 5, the bake stops); the
#   verified stop. It then prints the human's first-run window step, which is never scripted.
# - --register: boots the candidate or golden named, registers through config.sh each identity whose slot lacks one,
#   in this order: the production slot (~/ci-kit-vm/vm/identity: ci-kit-mac-<machine>-vm, labels ci-kit-mac-solo and
#   ci-kit-mac-vm) and the trial slot (~/ci-kit-vm/vm-trial/identity: ci-kit-mac-<machine>-vm-trial, the one label
#   ci-kit-mac-vm-trial), both --no-default-labels. Each takes the next token line on stdin, handed to the guest on the
#   exec's stdin (never an argument on either side); every token is read before the boot. The identity's three files
#   land in the slot (mode 600) and leave the image; then the verified stop.
# - --trial: a clone of the candidate, maws-vm-trial-<time>, booted and kicked off as the launcher boots a job clone,
#   but with the trial slot's shares (its identity, out/ and cache) and kickoff.sh's slot vm-trial, so its runner
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
result_wait=$(whole "${CI_KIT_VM_TRIAL_RESULT:-}" 120)
pointer_wait=$(whole "${CI_KIT_VM_POINTER_WAIT:-}" 120)
job_bound_min=$(minutes "${CI_KIT_VM_JOB_BOUND:-}" 50)
job_bound=$(seconds "$job_bound_min")
lane_agent=com.ssfskim.ci-kit.vm-lane
lane_lock=$ci_kit_logs/vm-lane.lock
reserved_file=$ci_kit_logs/vm-reserved
guest_shares='/Volumes/My Shared Files'
provision="$guest_shares/kit/vm/provision.sh"
identity_files='.runner .credentials .credentials_rsaparams'
markers='listening session-conflict assigned job refused stop-request stop-refused stop-raced stopped done'
vm_name_re='^[A-Za-z0-9][A-Za-z0-9._-]*$'

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
  [[ -n $owners ]] || refuse "no maintenance hold: write $ci_kit_logs/vm-hold.<session> ('maintenance since <time>') first"
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
  local memory=4096 name='' golden version sha pnpm machine
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
  say "baking $name from $base: --cpu 4 --memory $memory --display 2560x1440pt; runner $version, pnpm $pnpm, guest machine $machine-vm"
  tart_call 1800 clone "$base" "$name" >/dev/null 2>&1 || die "tart clone $base $name failed"
  tart_call 60 set "$name" --cpu 4 --memory "$memory" --display 2560x1440pt >/dev/null 2>&1 || die "tart set $name failed; $name stays, stopped"
  boot_vm "$name" "--dir=kit:$kit:ro" "--dir=maws:$maws:ro"
  in_guest 600 'the base (check)' /bin/bash "$provision" check
  disk_follow
  in_guest "$provision_wait" "Node 22 and pnpm $pnpm (node)" /bin/bash "$provision" node "$pnpm"
  disk_follow
  in_guest "$provision_wait" "the warm store (store)" /bin/bash "$provision" store
  disk_follow
  in_guest "$provision_wait" 'LibreOffice (libreoffice)' /bin/bash "$provision" libreoffice
  disk_follow
  in_guest 900 "the runner $version (runner)" /bin/bash "$provision" runner "$version" "$sha" "$machine-vm"
  disk_follow
  in_guest 900 'the compiled helpers (helpers)' /bin/bash "$provision" helpers
  disk_follow
  end_vm || die "$name is baked, but its stop is not verified"
  say "baked: $name, stopped; the lowest free space during the bake was $lowest GB"
  cat <<EOF

The human's first-run window step, once, on $name (Design, The image). In the mini's own GUI session, reached over
Screen Sharing from the MacBook (never VNC into the guest), with the maintenance hold still in place:
  1. Open Terminal on the mini and run:
       tart run --dir=maws:$maws:ro $name
     A window opens and the guest logs in as admin by itself. This one boot keeps the clipboard shared, so the
     commands below can be pasted in: nothing else runs on the mini under the hold, and a pasteboard does not outlive
     the guest's shutdown. Every other boot of the lane (job clones, trials, the bake's) runs with --no-clipboard.
  2. In the guest, open Terminal (Applications > Utilities > Terminal) and answer anything it asks on its first launch.
  3. In the guest, open LibreOffice from Applications, answer its first-run dialogs, and quit it.
  4. In the guest's Terminal run, first giving the shell the runner's PATH (its .path): node@22 is keg-only, so a
     new Terminal finds the base image's Node 24 and no pnpm, while every job gets that PATH:
       export PATH="\$(cat ~/actions-runner-maws/.path)"
       git -c safe.directory='*' clone "/Volumes/My Shared Files/maws" ~/maws-firstrun && cd ~/maws-firstrun &&
         pnpm install --frozen-lockfile && pnpm e2e:deliverables
     When macOS asks whether Electron may send notifications, answer it as the mini's own setting has it (System
     Settings > Notifications > Electron on the mini). Answer any other prompt the group raises the same way.
  5. In the guest's Terminal run:  cd && rm -rf ~/maws-firstrun && sudo shutdown -h now
     The window closes when the guest has powered off.
Then: bake.sh --register $name (first refresh only, tokens on stdin), bake.sh --trial $name, bake.sh --promote $name.
EOF
}

do_register() {
  local vm=${1:-} machine slot name labels token tokens=() needed=() i file
  [[ $# -eq 1 && $vm =~ ^maws-vm-(candidate|golden)-[A-Za-z0-9._-]+$ ]] || usage
  machine=$(machine_name) || exit 1
  hold_check
  reserve_check
  none_running
  stopped_vm "$vm"
  for slot in vm vm-trial; do
    for file in $identity_files; do
      [[ -f $vm_home/$slot/identity/$file ]] || { needed+=("$slot"); break; }
    done
  done
  ((${#needed[@]} > 0)) || refuse "both slots hold an identity already; remove a slot's identity/ to register it again"
  [[ ! -t 0 ]] || die "pipe one registration token a line on stdin, ${#needed[@]} of them (gh api -X POST repos/$repo/actions/runners/registration-token --jq .token)"
  for slot in "${needed[@]}"; do
    IFS= read -r token || true
    [[ -n $token ]] || die "${#needed[@]} registration token(s) needed on stdin, one a line (for ${needed[*]}); fewer were given"
    tokens+=("$token")
  done
  [[ -f $kit/vm/provision.sh ]] || refuse "no installed kit at $kit (mac/install.sh --vm)"
  for slot in vm vm-trial; do mkdir -p "$vm_home/$slot/identity" && chmod 700 "$vm_home/$slot/identity"; done
  say "registering ${needed[*]} in $vm"
  boot_vm "$vm" "--dir=kit:$kit:ro" "--dir=identity-vm:$vm_home/vm/identity" "--dir=identity-vm-trial:$vm_home/vm-trial/identity"
  for ((i = 0; i < ${#needed[@]}; i++)); do
    slot=${needed[i]}
    if [[ $slot == vm ]]; then
      name=ci-kit-mac-$machine-vm labels=ci-kit-mac-solo,ci-kit-mac-vm
    else
      name=ci-kit-mac-$machine-vm-trial labels=ci-kit-mac-vm-trial
    fi
    for file in $identity_files; do rm -f "$vm_home/$slot/identity/$file"; done
    say "$vm: registering $name with $labels (--no-default-labels) for the slot $slot"
    if ! printf '%s\n' "${tokens[i]}" | tart_call 300 exec -i "$vm" /bin/bash "$provision" register "$slot" "$name" "$labels" \
      "https://github.com/$repo" >>"$bake_log" 2>&1; then
      end_vm
      die "$vm: the registration of $name failed (see $bake_log)"
    fi
    tokens[i]=''
    for file in $identity_files; do
      [[ -f $vm_home/$slot/identity/$file ]] || { end_vm; die "$name: $file did not reach $vm_home/$slot/identity"; }
      chmod 600 "$vm_home/$slot/identity/$file"
    done
    say "$name registered; its identity is in $vm_home/$slot/identity"
  done
  end_vm || die "the identities are registered, but the stop of $vm is not verified"
  say "registered: ${needed[*]}; $vm holds no identity, stopped"
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
  local start=$SECONDS assigned_at='' asked_at='' done_at='' seen=' ' marker
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
    if [[ -n $done_at ]]; then
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
  local machine runner since kick file vms
  [[ $# -eq 1 && $candidate =~ ^maws-vm-candidate-[A-Za-z0-9._-]+$ ]] || usage
  machine=$(machine_name) || exit 1
  runner=ci-kit-mac-$machine-vm-trial
  hold_check
  reserve_check
  none_running
  stopped_vm "$candidate"
  for file in $identity_files; do
    [[ -f $vm_home/vm-trial/identity/$file ]] || refuse "the trial slot has no identity ($vm_home/vm-trial/identity lacks $file): bake.sh --register first"
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
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  t_run='' t_attempt='' t_why='' t_kept='' j_id='' j_conclusion=''
  say "trying $candidate: $trial under the trial slot's identity ($runner, ci-kit-mac-vm-trial alone)"
  tart_clone "$candidate" "$trial" >/dev/null 2>&1 || die "tart clone $candidate $trial failed"
  # shellcheck disable=SC2046 # one option a line, no space in any
  boot_vm "$trial" $(tart_shares "$kit" "$vm_home/vm-trial")
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
  vms=$(tart_vms) || die "Tart cannot list its VMs; $trial is stopped but not deleted"
  if [[ -n $(tart_state_in "$vms" "$trial") ]]; then
    tart_delete "$trial" >/dev/null 2>&1 || die "tart delete $trial failed; it is stopped, and --retire $trial deletes it"
  fi
  say "$trial: deleted"
  t_kept=$trials/$trial.out
  if mv "$t_out" "$t_kept" 2>/dev/null; then mkdir -p "$t_out"; else t_kept=$t_out; fi
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
  --register) do_register "$@" ;;
  --trial) do_trial "$@" ;;
  --promote) do_promote "$@" ;;
  --retire) do_retire "$@" ;;
  *) usage ;;
esac
