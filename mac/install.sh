#!/bin/bash
# Installs the mac lane (I10, docs/mac-lane.md) on this Mac: GitHub Actions runners for SSFSKIM/MAWS, each run by a
# LaunchAgent in the logged-in GUI session, with the job hooks that kill what a job left under its work directory; and
# the dialog watcher, the LaunchAgent com.ssfskim.ci-kit.dialog-watch, which alerts on a system dialog on screen every
# 60 s and keeps the runners stopped while one holds the desktop.
#
# The runners are the machine's instances:
# - the exclusive instance, ~/actions-runner-maws, com.ssfskim.ci-kit.mac-runner, labelled self-hosted, macOS, ARM64 and
#   ci-kit-mac: every job it runs runs alone on the desktop;
# - --shared <n> shared instances, ~/actions-runner-maws-<i> for i = 2…n+1, com.ssfskim.ci-kit.mac-runner-<i>, named
#   ci-kit-mac-<machine>-<i> and labelled ci-kit-mac-shared alone, so only a job that asks for that label reaches them.
#   They run beside each other, never beside an exclusive job (hooks/shared-hold.sh).
#
#   gh api -X POST repos/SSFSKIM/MAWS/actions/runners/registration-token --jq .token |
#     ssh <mac> <kit>/mac/install.sh --name ci-kit-mac-<machine>    register, then install
#   ssh <mac> <kit>/mac/install.sh               re-run on a registered runner: refresh and reload
#   ssh <mac> <kit>/mac/install.sh --shared 2    two shared instances (a token on stdin registers new ones)
#   ssh <mac> <kit>/mac/install.sh --vm          the VM lane's launcher as well (installed disabled), or --no-vm to remove it
#   ssh <mac> <kit>/mac/install.sh --display 2560x1440@2x  require this main display before jobs (kept on re-runs)
#   ssh mini <kit>/mac/install.sh --home        the exclusive home-desktop label (mini only; kept on re-runs)
#   ssh <mac> <kit>/mac/install.sh --check       the prerequisites only
#   ssh <mac> <kit>/mac/install.sh --disabled    install, but leave every runner's LaunchAgent unloaded and disabled
#   ssh <mac> <kit>/mac/install.sh --uninstall   unload and remove every LaunchAgent (the registrations and files stay)
#
# --name is needed only to register (the mini is ci-kit-mac-mini). There is no default: the runner's config replaces a
# registration of the same name, so a default would let a new Mac take over the mini's. A re-run keeps the registered
# name and refuses another. The part after ci-kit-mac- is the machine's short name ("the mini"): lowercase letters,
# digits and '-', since it is in every alert title (docs/mac-lane.md), and not ending in -<number> where it is new or
# has shared instances, since a shared instance's runner name ends so. The runners' .env and the watcher's LaunchAgent
# carry it to the hooks as CI_KIT_MACHINE for their messages and alerts; a shared instance's .env adds
# CI_KIT_SHARED_DESKTOP=1.
#
# --display is logical width x height and backing scale, handed to every instance and the watcher as CI_KIT_DISPLAY.
# No setting keeps the old unchecked display behavior. --home registers the exclusive instance with ci-kit-mac-home;
# an existing registration keeps its labels (a reminder is printed on every re-run). The exclusive .env remembers
# both settings; shared instances inherit only the display check. Neither option changes the desktop.
#
# --shared sets the count of shared instances. Without it, a re-run keeps the count installed (their LaunchAgents), and
# a fresh machine gets none: sharing is opted into. A shared instance keeps the enabled state launchd has for it across
# re-runs, and a new one is installed disabled (a state launchd cannot report counts as disabled), so a refresh never
# turns one on or off; --disabled leaves every instance disabled. Shared instances above the count are unloaded and
# their LaunchAgents removed; their registrations and directories stay.
#
# The registration token is read from stdin, only when some instance is not registered yet, and handed to the runner's
# config through its environment, never its arguments or a file. Re-running refreshes every instance's hooks (each its
# own copy, under its own directory), environment and LaunchAgent; it refuses while a job is running on any instance.
# Before stopping each instance it checks again, waiting for two equal idle reads five seconds apart (or stopped).
# After two hours it leaves that instance alone, finishes the other work, and exits nonzero naming what needs a retry.
# The watcher runs in every mode: --disabled turns off the runners, not the alerts. Prerequisites are checked first
# and a gap stops the install: they are reported, never installed.
#
# --vm installs the VM lane (docs/mac-lane.md, the VM lane): the launcher's LaunchAgent com.ssfskim.ci-kit.vm-lane
# (mac/vm/com.ssfskim.ci-kit.vm-lane.plist), the slots' directories under ~/ci-kit-vm (vm and vm-trial, each with
# jit/, out/ and cache/, and trials/), and the installed kit ~/ci-kit-vm/kit, a copy of this mac/ directory plus
# setup/, plan/ and vendor/ (the applier and its imports), published with the hooks' staged swap, which the launcher runs from and every clone is shown read-only. Every host
# instance's .env gains CI_KIT_VM_RESERVATION (the absolute vm-reserved path, for MAWS's verdict-time load read), and an
# exclusive instance registered now carries ci-kit-mac-solo too; an existing registration's labels are changed by hand
# (the docs say how). The launcher's agent is installed disabled; a re-run keeps the state launchd has for it, as a
# shared instance's, and --disabled leaves it disabled. Like --shared's count, the lane is kept by a re-run without
# --vm (it is installed when its LaunchAgent is); --no-vm unloads and removes its agent and the .env path, keeping
# ~/ci-kit-vm. With the lane installed or asked for, the install refuses while the lane's reservation stands (a guest
# may run) or the maintenance procedure holds it (a vm-hold.<owner> of kind maintenance), and so does --uninstall,
# which removes the launcher's agent with the rest. Without the lane, nothing of it is installed or read.
set -euo pipefail

REPO_URL=https://github.com/SSFSKIM/MAWS
RUNNER_PREFIX=ci-kit-mac-
RUNNER_LABELS=ci-kit-mac # the exclusive instance's; the runner adds self-hosted, macOS and ARM64 itself
SHARED_LABELS=ci-kit-mac-shared # a shared instance's only label: registered with --no-default-labels
SOLO_LABEL=ci-kit-mac-solo # with the VM lane, the exclusive instance's too: a job wanting a desktop to itself, either one
RUNNER_VERSION=2.338.0
RUNNER_SHA256=df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2
AGENT=com.ssfskim.ci-kit.mac-runner
WATCH_AGENT=com.ssfskim.ci-kit.dialog-watch
RUNNER_DIR=$HOME/actions-runner-maws
LOG_DIR=$HOME/Library/Logs/ci-kit
LAUNCH_AGENTS=$HOME/Library/LaunchAgents
WATCH_PLIST=$LAUNCH_AGENTS/$WATCH_AGENT.plist
# The watcher's hold on the runners (dialog-watch.sh): while it exists, each runner's agent waits instead of starting it.
DRAIN_MARKER=$LOG_DIR/runner-drained
# The exclusive job's hold on the shared instances (hooks/shared-hold.sh).
SHARED_HOLD=$LOG_DIR/shared-hold
# The VM lane: its launcher's agent, its home, the installed kit, and the reservation a guest stands under.
VM_AGENT=com.ssfskim.ci-kit.vm-lane
VM_PLIST=$LAUNCH_AGENTS/$VM_AGENT.plist
VM_HOME=$HOME/ci-kit-vm
VM_KIT=$VM_HOME/kit
VM_RESERVED=$LOG_DIR/vm-reserved
# The launcher's own lock, which every maintenance step (vm/bake.sh) also holds for its run.
VM_LOCK=$LOG_DIR/vm-lane.lock
# The PATH jobs and hooks start with: Homebrew's tools, then the system's. Jobs install their own Node and pnpm.
RUNNER_PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
here=$(cd "$(dirname "$0")" && pwd)
domain=gui/$(id -u)
tmp=
staged=()
kit_staged=
cleanup() {
  local dir
  for dir in ${staged[@]+"${staged[@]}"}; do rm -rf "$dir"; done
  if [[ -n $tmp ]]; then rm -rf "$tmp"; fi
}
trap 'cleanup; if [[ -n $kit_staged ]]; then rm -rf "$kit_staged"; fi' EXIT

say() { echo "ci-kit mac: $*"; }
die() { echo "ci-kit mac: $*" >&2; exit 1; }

# Instance 1 is the exclusive instance; 2 and above are shared.
root_of() { if (($1 == 1)); then echo "$RUNNER_DIR"; else echo "$RUNNER_DIR-$1"; fi; }
agent_of() { if (($1 == 1)); then echo "$AGENT"; else echo "$AGENT-$1"; fi; }
plist_of() { echo "$LAUNCH_AGENTS/$(agent_of "$1").plist"; }
log_name_of() { if (($1 == 1)); then echo mac-runner; else echo "mac-runner-$1"; fi; }
title_of() { if (($1 == 1)); then echo 'the runner'; else echo "shared runner $1"; fi; }
# Every instance this Mac has: the exclusive one, and each shared one with a directory or a LaunchAgent.
present_instances() {
  local path n
  {
    echo 1
    for path in "$RUNNER_DIR"-* "$LAUNCH_AGENTS/$AGENT"-*.plist; do
      [[ -e $path ]] || continue
      n=${path%.plist} n=${n##*-}
      if [[ $n =~ ^[1-9][0-9]*$ ]] && ((n >= 2)); then echo "$n"; fi
    done
  } | sort -nu
}
installed_shared() { # the count of shared instances with a LaunchAgent: what a re-run keeps
  local path n count=0
  for path in "$LAUNCH_AGENTS/$AGENT"-*.plist; do
    n=${path%.plist} n=${n##*-}
    if [[ -e $path && $n =~ ^[1-9][0-9]*$ ]] && ((n >= 2)); then count=$((count + 1)); fi
  done
  echo "$count"
}

# bootout returns while a job is still shutting down, and bootstrap fails (5: Input/output error) until it is gone.
unload() { # <label>
  launchctl bootout "$domain/$1" 2>/dev/null || true
  for _ in $(seq 1 60); do launchctl print "$domain/$1" >/dev/null 2>&1 || break; sleep 1; done
}
# Whether a job runs on any instance, by the kernel's executable paths (hooks/runner-state.py), which a command line
# need not match: a runner that updated itself runs from bin.<version>. An unreadable answer counts as a job. Prints the
# instance that runs one.
job_running() {
  local n state
  for n in $(present_instances); do
    state=$(python3 -I "$here/hooks/runner-state.py" "$(root_of "$n")" 2>/dev/null) || state=unknown
    if [[ $state != idle* && $state != stopped ]]; then
      echo "$n"
      return 0
    fi
  done
  return 1
}
refuse_job() { # <instance>
  if (($1 == 1)); then die 'a job is running on this runner; re-run when it is idle'; fi
  die "a job is running on shared runner $1; re-run when every instance is idle"
}

# Recheck each instance at its stop, not just before staging. As in the watcher's drain, an offer changes the
# listener's log before its worker exists: two identical idle reads five seconds apart cover that acquisition gap.
# No work goes between the final read and bootout. A failed read is not permission to stop a runner.
# A timeout skips this instance, not the rest of publication: the hooks and .env are already live by step 6.
idle_wait=${CI_KIT_INSTALL_IDLE_WAIT:-7200} # two hours covers a MAWS job's roughly 100-minute maximum
[[ $idle_wait =~ ^(0|[1-9][0-9]{0,5})$ ]] || die 'CI_KIT_INSTALL_IDLE_WAIT must be seconds (0 to 999999)'
pending=()
unload_idle() { # <instance>
  local root agent title state previous= start=$SECONDS notice=$SECONDS
  root=$(root_of "$1") agent=$(agent_of "$1") title=$(title_of "$1")
  while :; do
    state=$(python3 -I "$here/hooks/runner-state.py" "$root" 2>/dev/null) || state=unknown
    if [[ $state == stopped || ( $state == idle\ * && $state == "$previous" ) ]]; then
      unload "$agent"
      return 0
    fi
    if ((SECONDS - start >= idle_wait)); then
      say "timeout waiting for $title to be idle ($state); left running as it was, restart/removal pending"
      pending+=("$agent")
      return 1
    fi
    if ((SECONDS >= notice)); then
      say "waiting for $title to be idle before stopping it ($state; $((SECONDS - start)) s elapsed, limit $idle_wait s)"
      notice=$((SECONDS + 60))
    fi
    previous=$state
    sleep 5
  done
}

# The VM lane. Its reservation means a guest may run, whose kit share a publish would pull from under it and whose
# launcher a reload would restart; a maintenance hold means the procedure runs with the launcher booted out, which a
# reload would bring back. Either refuses, before anything changes. A lookup that fails counts as a reservation.
vm_installed() { [[ -e $VM_PLIST || -L $VM_PLIST ]]; }
vm_reserved() { perl -e 'exit 1 if !lstat $ARGV[0] && $!{ENOENT}; exit 0' "$VM_RESERVED"; }
vm_refusals() {
  local file line
  if vm_reserved; then
    die "the VM lane's reservation stands ($(head -1 "$VM_RESERVED" 2>/dev/null || echo unreadable)): a guest may run; re-run when it is gone"
  fi
  for file in "$LOG_DIR"/vm-hold.*; do
    [[ -f $file && $file != *.tmp ]] || continue
    IFS= read -r line <"$file" 2>/dev/null || line=''
    [[ $line != maintenance* ]] ||
      die "the VM lane's maintenance procedure holds it (${file##*/}: $line); re-run after its release"
  done
}
# The launcher booted out, then the reservation read again: one written between the first read and the bootout is a
# guest the launcher booted, so a launcher that was loaded is brought back (it adopts the guest), and the step refuses.
vm_quiesce() {
  local loaded=
  if launchctl print "$domain/$VM_AGENT" >/dev/null 2>&1; then loaded=1; fi
  unload "$VM_AGENT"
  vm_reserved || return 0
  if [[ -n $loaded ]]; then launchctl bootstrap "$domain" "$VM_PLIST" 2>/dev/null || true; fi
  die "the VM lane booted a guest meanwhile ($(head -1 "$VM_RESERVED" 2>/dev/null || echo unreadable)); its launcher is back as it was; re-run when the guest is gone"
}
# The lane's lock, taken once its launcher is booted out and held until just before the launcher is loaded again: a
# maintenance step started since the first read (which booting the launcher out let pass bake.sh's own check) holds
# it, and none can start while the kit is published. The reservation and the holds are read again under it. A refusal
# here leaves the launcher booted out: the procedure needs it so.
vm_fence() {
  mkdir -p "$LOG_DIR"
  exec 7>>"$VM_LOCK" || die "$VM_LOCK cannot be opened"
  perl -MFcntl=:flock -e 'open(my $fh, ">>&=", 7) or exit 2; local $SIG{ALRM} = sub { exit 1 }; alarm shift;
    exit(flock($fh, LOCK_EX) ? 0 : 1)' "${CI_KIT_VM_LOCK_WAIT:-10}" ||
    die "the VM lane's lock ($VM_LOCK) is held: a maintenance step runs (vm/bake.sh); the launcher stays booted out; re-run after the procedure's release"
  vm_refusals
}
vm_unfence() {
  exec 7>&-
}
# Publishes a staged directory at a fixed path in one exchange (Darwin's RENAME_SWAP), so a reader finds either the old
# set or the new one, never a gap between two renames. After it the staged path holds the old set; after a first
# install it no longer exists.
swap_in() { # <staged> <live>
  python3 -I - "$1" "$2" <<'PY'
import ctypes
import os
import sys

staged, live = sys.argv[1:]
if os.path.lexists(live):
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    swap = libc.renamex_np
    swap.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    swap.restype = ctypes.c_int
    if swap(os.fsencode(staged), os.fsencode(live), 0x00000002):  # RENAME_SWAP (stdio.h)
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), live)
else:
    os.rename(staged, live)  # First install: no old directory to exchange.
PY
}

usage() { awk 'NR > 1 && !/^#/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
mode=enabled
name=
shared=
vm=
display=
display_given=
home=
while (($# > 0)); do
  case $1 in
    --check) mode=check ;;
    --disabled) mode=disabled ;;
    --uninstall) mode=uninstall ;;
    --name) (($# > 1)) || usage; name=$2; shift ;;
    --shared) (($# > 1)) || usage; shared=$2; shift ;;
    --display) (($# > 1)) || usage; display=$2; display_given=1; shift ;;
    --home) home=1 ;;
    --vm) vm=1 ;;
    --no-vm) vm=0 ;;
    *) usage ;;
  esac
  shift
done
# The name lands in .env and the hooks' messages: keep it to what a runner name needs.
[[ -z $name || $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "--name takes letters, digits, '.', '_' and '-' (got '$name')"
[[ -z $shared || $shared =~ ^[0-8]$ ]] || die "--shared takes a count of shared instances, 0 to 8 (got '$shared')"

if [[ $mode == uninstall ]]; then
  [[ -z $name && -z $shared && -z $vm && -z $display_given && -z $home ]] || usage
  if running=$(job_running); then refuse_job "$running"; fi
  if vm_installed; then vm_refusals; fi
  agents='' roots=''
  for n in $(present_instances); do
    unload_idle "$n" || continue
    rm -f "$(plist_of "$n")"
    agents+="${agents:+, }$(agent_of "$n")" roots+="${roots:+, }$(root_of "$n")"
  done
  # Keep the watcher, holds and VM lane intact while any instance could still be running a job.
  ((${#pending[@]} == 0)) || die "uninstall pending for ${pending[*]}; idle instances removed, watcher and holds kept; re-run when idle"
  lane=''
  if vm_installed; then
    vm_quiesce
    vm_fence
    rm -f "$VM_PLIST"
    lane=", and the VM lane's $VM_AGENT ($VM_HOME stays)"
  fi
  unload "$WATCH_AGENT"
  rm -f "$WATCH_PLIST" "$DRAIN_MARKER" "$SHARED_HOLD" "$LOG_DIR"/shared-running-*
  say "uninstalled: $WATCH_AGENT and $agents are unloaded and removed$lane; the registration and $roots stay (docs/mac-lane.md)"
  exit 0
fi
# Whether the lane is wanted: --vm or --no-vm says; otherwise a re-run keeps what is installed.
vm_before=
if vm_installed; then vm_before=1; fi
[[ -n $vm ]] || vm=${vm_before:-0}

# These machine settings survive the .env rewrite below; read data, never source the runner's environment as code.
if [[ -f $RUNNER_DIR/.env ]]; then
  while IFS='=' read -r key value; do
    case $key in
      CI_KIT_DISPLAY) [[ -n $display_given ]] || display=$value ;;
      CI_KIT_HOME) [[ $value != 1 ]] || home=1 ;;
    esac
  done <"$RUNNER_DIR/.env"
fi
if [[ -n $display_given || -n $display ]]; then
  [[ $display =~ ^[1-9][0-9]*x[1-9][0-9]*@[1-9][0-9]*([.][0-9]+)?x$ ]] ||
    die "--display takes positive logical dimensions and backing scale, e.g. 2560x1440@2x (got '$display')"
fi

# 1. Runner infrastructure: Node >= 22.12 on the PATH jobs and hooks get, pnpm through corepack,
# a native compiler, Python and git. Project applications belong to the repository's setup declaration,
# which jobs apply after registration; requiring them here would prevent a fresh host from reaching setup.
gaps=()
probe() { # <name> <command…>: prints the command's first line, or records a gap
  local name=$1 out
  shift
  if out=$(PATH=$RUNNER_PATH "$@" 2>&1); then say "ok $name: $(head -1 <<<"$out")"; else gaps+=("$name ($(head -1 <<<"$out"))"); fi
}
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || gaps+=("an Apple-silicon Mac (this is $(uname -sm))")
probe 'node >= 22.12' node -e 'const [a, b] = process.versions.node.split(".").map(Number);
  console.log(process.versions.node); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)'
probe corepack corepack --version
probe 'Xcode command line tools (clang)' xcrun clang --version
probe python3 python3 --version
probe git git --version
# The VM lane's launcher runs Tart from the PATH its LaunchAgent gives it: Tart's own directory, first.
tart_dir=
if ((vm == 1)); then
  probe 'Tart (the VM lane)' tart --version
  if tart_path=$(PATH=$RUNNER_PATH:$PATH command -v tart 2>/dev/null); then tart_dir=$(dirname "$tart_path"); fi
fi
if ((${#gaps[@]} > 0)); then
  for gap in "${gaps[@]}"; do echo "ci-kit mac: missing: $gap" >&2; done
  die 'prerequisites missing; nothing installed'
fi
[[ $mode == check ]] && exit 0

if running=$(job_running); then refuse_job "$running"; fi
if ((vm == 1)) || [[ -n $vm_before ]]; then vm_refusals; fi

# 2. The runners' names, and what each instance becomes, before anything changes, so every refusal over them leaves the
# Mac as it was. A registered runner keeps its name: .runner (JSON behind a byte-order mark) has it. An unregistered
# exclusive instance takes --name; a shared one is named after it.
registered_name() { # <instance root>
  python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8-sig"))["agentName"])' \
    "$1/.runner" 2>/dev/null
}
new_machine=
if [[ -f $RUNNER_DIR/.runner ]]; then
  RUNNER_NAME=$(registered_name "$RUNNER_DIR") || RUNNER_NAME=
  [[ -n $RUNNER_NAME ]] || die "cannot read the runner's name from $RUNNER_DIR/.runner"
  [[ -z $name || $name == "$RUNNER_NAME" ]] ||
    die "this runner is registered as $RUNNER_NAME; to rename it, remove it (docs/mac-lane.md) and register again with --name $name"
else
  [[ -n $name ]] || die "name the runner to register it: --name ${RUNNER_PREFIX}<machine> (the mini is ${RUNNER_PREFIX}mini)"
  RUNNER_NAME=$name
  new_machine=1
fi
machine=${RUNNER_NAME#"$RUNNER_PREFIX"}
[[ -n $machine ]] || machine=$RUNNER_NAME
# MAWS reads open alerts by their title, ci-kit alert: <machine>: …, with [a-z0-9-]+ for the machine.
[[ $machine =~ ^[a-z0-9-]+$ ]] ||
  die "the machine's short name, '$machine' in $RUNNER_NAME, takes lowercase letters, digits and '-' (docs/mac-lane.md)"
[[ -n $shared ]] || shared=$(installed_shared)
last=$((shared + 1))
# ci-kit-mac-mini-2 is the mini's first shared instance: a machine named mini-2 would replace its registration.
if [[ $machine =~ -[0-9]+$ ]] && { [[ -n $new_machine ]] || ((shared > 0)); }; then
  die "the machine's short name, '$machine', ends in -<number>, as a shared instance's runner name does; pick another (docs/mac-lane.md)"
fi
names=("$RUNNER_NAME")
for ((n = 2; n <= last; n++)); do
  expected=$RUNNER_PREFIX$machine-$n
  if [[ -f $(root_of "$n")/.runner ]]; then
    found=$(registered_name "$(root_of "$n")") || found=
    [[ $found == "$expected" ]] ||
      die "$(root_of "$n") is registered as '${found:-unreadable}', not $expected; remove it (docs/mac-lane.md) and re-run"
  fi
  names+=("$expected")
done
# Whether each instance ends enabled. The exclusive one is unless --disabled. A shared one installed before keeps the
# state launchd has for it, and a new one starts disabled. launchd prints `"<label>" => enabled` (false on older macOS)
# for an enabled agent; anything else, a failed read included, is disabled.
enabled=(1)
[[ $mode != disabled ]] || enabled=('')
launchd_states=
for ((n = 2; n <= last; n++)); do
  if [[ $mode == disabled || ! -f $(plist_of "$n") ]]; then
    enabled+=('')
    continue
  fi
  [[ -n $launchd_states ]] || launchd_states=$(launchctl print-disabled "$domain" 2>/dev/null) || launchd_states=-
  if grep -Eq "\"$(agent_of "$n")\" => (enabled|false)\$" <<<"$launchd_states"; then enabled+=(1); else enabled+=(''); fi
done
# The launcher likewise: kept as launchd has it across a re-run, installed disabled, disabled by --disabled.
vm_enabled=
if ((vm == 1)) && [[ $mode != disabled && -n $vm_before ]]; then
  [[ -n $launchd_states ]] || launchd_states=$(launchctl print-disabled "$domain" 2>/dev/null) || launchd_states=-
  if grep -Eq "\"$VM_AGENT\" => (enabled|false)\$" <<<"$launchd_states"; then vm_enabled=1; fi
fi
token=
for ((n = 1; n <= last; n++)); do
  [[ ! -f $(root_of "$n")/.runner ]] || continue
  [[ -t 0 ]] && die 'pipe a registration token on stdin (gh api -X POST repos/SSFSKIM/MAWS/actions/runners/registration-token --jq .token)'
  IFS= read -r token || true
  [[ -n $token ]] || die 'no registration token on stdin'
  break
done

# 3. The runners' files, at a pinned version (each updates itself from there).
tarball=actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz
for ((n = 1; n <= last; n++)); do
  root=$(root_of "$n")
  [[ ! -x $root/config.sh ]] || continue
  if [[ ! -f ${tmp:-/nonexistent}/$tarball ]]; then
    [[ -n $tmp ]] || tmp=$(mktemp -d)
    say "downloading runner $RUNNER_VERSION"
    curl -fsSL -o "$tmp/$tarball" "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/$tarball"
    echo "$RUNNER_SHA256  $tmp/$tarball" | shasum -a 256 -c --quiet - || die "checksum mismatch for $tarball"
  fi
  mkdir -p "$root"
  tar -xzf "$tmp/$tarball" -C "$root"
done

# 4. Registration, once each. Repository level: a personal account cannot register a runner any higher. Not ephemeral:
# the hooks clean between jobs. A shared instance carries its one label and none of the defaults, so no job written for
# the exclusive instance (self-hosted, macOS, ARM64), nor a bare self-hosted one, can reach it.
for ((n = 1; n <= last; n++)); do
  root=$(root_of "$n")
  [[ ! -f $root/.runner ]] || continue
  exclusive_labels=$RUNNER_LABELS
  ((vm == 0)) || exclusive_labels+=",$SOLO_LABEL"
  [[ -z $home ]] || exclusive_labels+=",ci-kit-mac-home"
  labels=(--labels "$exclusive_labels")
  ((n == 1)) || labels=(--labels "$SHARED_LABELS" --no-default-labels)
  (cd "$root" && ACTIONS_RUNNER_INPUT_TOKEN=$token ./config.sh --unattended --url "$REPO_URL" \
    --name "${names[n - 1]}" "${labels[@]}" --work _work --replace)
done
token=

# 5. The hooks, a full copy in each instance, so a runner never depends on where the kit is checked out and each hook
# acts on the instance that runs it (the sweep finds its _work from where it sits); and the environment the runner gives
# every job and hook. English messages: the jobs parse tool output, and the mini's locale is Korean.
hook_files=(job-started.sh job-completed.sh desktop-check.sh desktop-posture.sh dialog.sh dialog-watch.sh runner-hold.sh
  runner-state.py sweep.mjs strays.mjs terminate.mjs instances.sh shared-hold.sh desktop-lock.sh vm-claim.sh)
mkdir -p "$LOG_DIR" "$LAUNCH_AGENTS"
# The compiled helpers are optional: without the cursor park jobs start with the cursor where it is, and without the
# window list the dialog check sees a dialog only in front (dialog.sh). A failed compiler may leave output, which must
# not be published as a working helper.
[[ -n $tmp ]] || tmp=$(mktemp -d)
helpers=()
compile() { # <helper> <what is lost without it>
  if xcrun swiftc -O -o "$tmp/$1" "$here/hooks/$1.swift" 2>"$LOG_DIR/$1-build.log"; then
    helpers+=("$1")
  else
    rm -f "$tmp/$1"
    say "warning: $1 did not compile (see $LOG_DIR/$1-build.log); $2"
  fi
}
compile cursor-park 'jobs start without the cursor park; with --display configured, the display check refuses jobs'
compile window-list 'the dialog check sees a dialog only in front'
# Every instance's set is staged and checked before any goes live. A sibling keeps staging on the same volume.
for ((n = 1; n <= last; n++)); do
  root=$(root_of "$n")
  mkdir -p "$root/ci-kit"
  dir=$(mktemp -d "$root/ci-kit/.hooks.XXXXXX")
  staged+=("$dir")
  for file in "${hook_files[@]}"; do cp "$here/hooks/$file" "$dir/"; done
  for helper in ${helpers[@]+"${helpers[@]}"}; do cp "$tmp/$helper" "$dir/$helper"; done
  chmod +x "$dir/"*.sh
  for file in "${hook_files[@]}"; do
    [[ -f $dir/$file && -r $dir/$file ]] || die "staged hook missing or unreadable: $file"
    if [[ $file == *.sh ]]; then
      [[ -x $dir/$file ]] || die "staged hook not executable: $file"
      bash -n "$dir/$file"
    fi
  done
  for helper in ${helpers[@]+"${helpers[@]}"}; do
    [[ -x $dir/$helper ]] || die "staged $helper not executable"
  done
done
# Two renames (old -> backup, staged -> hooks) leave a gap at the fixed paths in .env. Darwin's RENAME_SWAP
# exchanges both directories in one operation, so a job starting now still finds a complete set at hooks/.
# The VM lane's kit is staged and checked with them, and published only once its launcher is booted out (step 6).
if ((vm == 1)); then
  mkdir -p "$VM_HOME"
  kit_staged=$(mktemp -d "$VM_HOME/.kit.XXXXXX")
  cp -R "$here/." "$kit_staged/"
  # The guest sees only this installed kit. Keep the applier's relative imports intact beside mac/'s contents.
  for dir in setup plan vendor; do cp -R "$here/../$dir" "$kit_staged/$dir"; done
  find "$kit_staged/hooks" "$kit_staged/vm" -name '*.sh' -exec chmod +x {} +
  for file in vm/lane.sh vm/lane-reads.sh vm/tart.sh vm/bake.sh vm/hold.sh vm/provision.sh vm/guest/guest.sh vm/guest/diag.sh \
    vm/guest/kickoff.sh vm/guest/wrapper.sh vm/guest/hooks/common.sh vm/guest/hooks/job-started.sh \
    vm/guest/hooks/job-completed.sh vm/guest/hooks/desktop-check.sh hooks/cursor-park.swift hooks/window-list.swift \
    vm/setup.mjs setup/apply.mjs setup/hash.mjs plan/config.mjs plan/glob.mjs vendor/yaml/dist/index.js \
    install.sh "${hook_files[@]/#/hooks/}"; do
    [[ -f $kit_staged/$file && -r $kit_staged/$file ]] || die "staged kit file missing or unreadable: $file"
  done
  while IFS= read -r -d '' file; do
    [[ -x $file ]] || die "staged kit file not executable: ${file#"$kit_staged"/}"
    bash -n "$file"
  done < <(find "$kit_staged/hooks" "$kit_staged/vm" -name '*.sh' -print0)
fi
# An installed launcher is booted out before anything goes live, so it boots no guest into the swap; a guest it booted
# just before refuses the install with nothing changed (vm_quiesce). Then the lane's lock, held through the kit's
# publication, with the reservation and the holds read again under it (vm_fence).
if [[ -n $vm_before ]]; then vm_quiesce; fi
if ((vm == 1)) || [[ -n $vm_before ]]; then vm_fence; fi
for ((n = 1; n <= last; n++)); do
  swap_in "${staged[n - 1]}" "$(root_of "$n")/ci-kit/hooks"
done
# After an exchange staging holds the old set; after a first install it no longer exists.
cleanup
staged=() tmp=
for ((n = 1; n <= last; n++)); do
  root=$(root_of "$n")
  {
    echo LANG=en_US.UTF-8
    echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$root/ci-kit/hooks/job-started.sh"
    echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$root/ci-kit/hooks/job-completed.sh"
    echo "CI_KIT_MACHINE=$machine"
    [[ -z $display ]] || echo "CI_KIT_DISPLAY=$display"
    [[ -z $home || $n != 1 ]] || echo CI_KIT_HOME=1
    ((n == 1)) || echo CI_KIT_SHARED_DESKTOP=1
    ((vm == 0)) || echo "CI_KIT_VM_RESERVATION=$VM_RESERVED"
  } >"$root/.env"
  echo "$RUNNER_PATH" >"$root/.path"
  cp "$root/bin/runsvc.sh" "$root/runsvc.sh"
done

# 6. The LaunchAgents, reloaded so a re-run takes effect: the watcher's first, so it runs whatever becomes of the
# runners'. Each runner's program, runner-hold.sh, waits while the watcher's marker holds the runners, so an install
# never starts a runner into an open dialog episode: it starts when the episode closes.
for ((n = 1; n <= last; n++)); do
  sed -e "s|__AGENT__|$(agent_of "$n")|g" -e "s|__RUNNER_DIR__|$(root_of "$n")|g" -e "s|__LOG_DIR__|$LOG_DIR|g" \
    -e "s|__LOG_NAME__|$(log_name_of "$n")|g" "$here/$AGENT.plist" >"$(plist_of "$n")"
  plutil -lint -s "$(plist_of "$n")"
done
sed -e "s|__HOOKS_DIR__|$RUNNER_DIR/ci-kit/hooks|g" -e "s|__LOG_DIR__|$LOG_DIR|g" -e "s|__PATH__|$RUNNER_PATH|g" \
  -e "s|__MACHINE__|$machine|g" -e "s|__DISPLAY__|$display|g" "$here/$WATCH_AGENT.plist" >"$WATCH_PLIST"
plutil -lint -s "$WATCH_PLIST"
unload "$WATCH_AGENT"
launchctl enable "$domain/$WATCH_AGENT"
launchctl bootstrap "$domain" "$WATCH_PLIST"
say "the dialog watcher $WATCH_AGENT runs"
seen=()
for ((n = 1; n <= last; n++)); do
  agent=$(agent_of "$n")
  if ! unload_idle "$n"; then seen+=(-); continue; fi
  if [[ -z ${enabled[n - 1]} ]]; then
    launchctl disable "$domain/$agent"
    what=$agent
    ((n == 1)) || what="${names[n - 1]} ($agent)"
    say "installed, disabled: $what is not loaded (enable: launchctl enable $domain/$agent && launchctl bootstrap $domain $(plist_of "$n"))"
    seen+=(-)
    continue
  fi
  seen+=("$(stat -f %z "$LOG_DIR/$(log_name_of "$n").out.log" 2>/dev/null || echo 0)")
  launchctl enable "$domain/$agent"
  launchctl bootstrap "$domain" "$(plist_of "$n")"
done
# Shared instances above the count: unloaded and their LaunchAgents removed; the registrations and directories stay.
for n in $(present_instances); do
  ((n > last)) && [[ -f $(plist_of "$n") ]] || continue
  unload_idle "$n" || continue
  rm -f "$(plist_of "$n")"
  say "removed: $(agent_of "$n") is unloaded and its LaunchAgent removed; its registration and $(root_of "$n") stay"
done
# The VM lane, its launcher booted out (step 5): the kit published, the slots made, and its LaunchAgent reloaded as
# launchd had it; or, with --no-vm, its LaunchAgent removed.
if ((vm == 1)); then
  swap_in "$kit_staged" "$VM_KIT"
  rm -rf "$kit_staged"
  kit_staged=
  mkdir -p "$VM_HOME/trials"
  for slot in vm vm-trial; do
    mkdir -p "$VM_HOME/$slot/jit" "$VM_HOME/$slot/out" "$VM_HOME/$slot/cache"
    chmod 700 "$VM_HOME/$slot/jit"
  done
  lane_path=$RUNNER_PATH
  if [[ -n $tart_dir && ":$RUNNER_PATH:" != *":$tart_dir:"* ]]; then lane_path=$tart_dir:$RUNNER_PATH; fi
  sed -e "s|__KIT_DIR__|$VM_KIT|g" -e "s|__LOG_DIR__|$LOG_DIR|g" -e "s|__PATH__|$lane_path|g" -e "s|__MACHINE__|$machine|g" \
    "$here/vm/$VM_AGENT.plist" >"$VM_PLIST"
  plutil -lint -s "$VM_PLIST"
  unload "$VM_AGENT"
  # The kit is published: the launcher, loaded next, must not find this install holding its lock.
  vm_unfence
  if [[ -n $vm_enabled ]]; then
    launchctl enable "$domain/$VM_AGENT"
    launchctl bootstrap "$domain" "$VM_PLIST"
    say "the VM lane's launcher $VM_AGENT runs from $VM_KIT (its log: $LOG_DIR/vm-lane.log)"
  else
    launchctl disable "$domain/$VM_AGENT"
    say "installed, disabled: the VM lane's launcher $VM_AGENT is not loaded (enable: launchctl enable $domain/$VM_AGENT && launchctl bootstrap $domain $VM_PLIST)"
  fi
  if [[ -z $vm_before && -z $new_machine ]]; then
    say "$RUNNER_NAME keeps its labels: add $SOLO_LABEL to its registration by hand (docs/mac-lane.md, the VM lane)"
  fi
elif [[ -n $vm_before ]]; then
  rm -f "$VM_PLIST"
  say "removed: the VM lane's launcher $VM_AGENT is unloaded and its LaunchAgent removed; $VM_HOME stays"
fi
if [[ -n $home ]]; then
  if [[ -n $new_machine ]]; then
    say "$RUNNER_NAME registered with ci-kit-mac-home (only the home Mac carries this label)"
  else
    say "$RUNNER_NAME keeps its labels: ensure ci-kit-mac-home is on its registration by hand (docs/mac-lane.md, Adding a Mac)"
  fi
fi
held=
[[ ! -e $DRAIN_MARKER ]] || held=$(head -1 "$DRAIN_MARKER")
for ((n = 1; n <= last; n++)); do
  [[ ${seen[n - 1]} != - ]] || continue
  if [[ -n $held ]]; then
    say "loaded, held by the dialog watcher ($held): ${names[n - 1]} starts when the episode closes"
    continue
  fi
  out_log=$LOG_DIR/$(log_name_of "$n").out.log
  for _ in $(seq 1 30); do
    if tail -c +$((${seen[n - 1]} + 1)) "$out_log" 2>/dev/null | grep -q 'Listening for Jobs'; then
      if ((n == 1)); then
        say "running: ${names[n - 1]} listens for jobs of $REPO_URL"
      else
        say "running: ${names[n - 1]} listens for jobs of $REPO_URL that ask for $SHARED_LABELS"
      fi
      continue 2
    fi
    sleep 1
  done
  die "$(title_of "$n") did not report 'Listening for Jobs' within 30 s; see $out_log and $(root_of "$n")/_diag"
done
((${#pending[@]} == 0)) || die "restart/removal pending for ${pending[*]}; files published and other agents finished; re-run when idle"
