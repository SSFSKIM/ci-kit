#!/bin/bash
# The bake's provisioning (docs/mac-lane.md, the VM lane's maintenance): run inside a candidate image, never a job
# clone, by bake.sh through `tart exec <vm> /bin/bash '/Volumes/My Shared Files/kit/vm/provision.sh' <step> …`, one step
# a call, each safe to run again. It makes the image what the guest's kickoff, wrapper and hooks need (guest/):
#
#   check                                the base: macOS's version, Homebrew, python3 (installed when the system's
#                                        cannot run runner-state.py) and the Swift compiler
#   disk <GB>                            the APFS container grown into the disk bake.sh set to <GB> (below), verified
#   quiet                                Spotlight indexing off and the measured background services disabled and
#                                        booted out, read back; the settings persist into every fresh clone
#   display                              the display at 2560x1440 with scaling on, through displayplacer (installed
#                                        from its tap), read back: `tart set --display` does not reach the guest's
#                                        mode, and the mode set here persists into every clone
#   node <pnpm version>                  Node 22 (Homebrew's node@22) and pnpm through corepack, on the runner's PATH
#   setup                                the shared MAWS declaration applied in bake mode, with install, in a scratch
#                                        clone; ~/.ci-kit holds its setup-hash and quarantined-apps for first-run
#   runner <version> <sha256> <machine>  the runner at install.sh's pin in ~/actions-runner-maws, its .env and .path
#                                        (env below), and ~/ci-kit -> the kit share, which keeps a space out of the
#                                        hook paths
#   workrepo [owner/repository]          a shallow master from the read-only maws share in the runner's work folder,
#                                        with GitHub as origin: checkout reuses its objects and fetches only the delta
#   env <machine>                        the runner's .env and .path alone
#   helpers                              cursor-park and window-list compiled into ~/ci-kit-helpers (the kit share is
#                                        read-only, and the guest's hooks look there)
#   register <slot> <name> <labels> <url>
#                                        config.sh with the registration token read from stdin (never an argument),
#                                        then the identity (.runner, .credentials, .credentials_rsaparams) moved to the
#                                        identity-<slot> share and out of the image, which holds no runner identity
#
# <machine> is the guest's CI_KIT_MACHINE, <host machine>-vm, so a guest's refusal never reads as the host's. Bash 3.2.
set -euo pipefail
export HOME=${HOME:-/Users/admin}
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=guest/guest.sh
source "$here/guest/guest.sh"
# The PATH the runner gives every job and hook (.path): Node 22 first, then Homebrew's tools, then the system's.
runner_path=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
# The registration's work folder. A fresh bake has no .runner yet; workrepo uses this same setting until it does.
runner_work=_work
export PATH=$runner_path NONINTERACTIVE=1 HOMEBREW_NO_ENV_HINTS=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
fail() {
  echo "provision: $*" >&2
  exit 1
}
say() {
  echo "provision: $*"
}
gb() { # <bytes>
  awk -v bytes="$1" 'BEGIN { printf "%.1f GB", bytes / 1e9 }'
}

# THE DISK. bake.sh grows the stopped candidate's disk (tart set --disk-size); the container macOS runs from takes the
# new space only by a resize in the guest, which is how Tart's FAQ (disk resizing) and the guest agent's own resizer
# (tart-guest-agent --resize-disk, internal/diskresizer) do it: `diskutil repairDisk`, then `diskutil apfs
# resizeContainer <container> 0`. A container grows only into space right after it, and the golden-gate base keeps its
# recovery container there (its template: recovery_partition "keep"; the agent's resizer is documented for images
# without one), so the recovery container is removed first, as the FAQ does: the lane's guests never update macOS in
# place (a new base is a new bake) and never boot to recovery. The FAQ removes it from recoveryOS; here it is removed
# from the running system (SIP is off in the base), which V4's first bake proves or refutes: the step fails unless the
# container ends up holding the whole disk but at most disk_slack bytes (the iBoot system container and the GPT).
disk_slack=1000000000
# diskutil as root (the base image's passwordless sudo); CI_KIT_VM_DISKUTIL stands in for it in tests.
root_diskutil() {
  if [[ -n ${CI_KIT_VM_DISKUTIL:-} ]]; then "$CI_KIT_VM_DISKUTIL" "$@"; else sudo -n /usr/sbin/diskutil "$@"; fi
}
# The physical disk holding the one APFS container, found as the guest agent's resizer finds it: l_disk, l_size, l_apfs
# and l_apfs_size (the container's physical store), l_recovery (the immediately following recovery container, or -).
# Before touching the disk, accept only the base layout: iBoot, APFS, optional recovery, then free space. Recovery
# may already be gone on a repeated step; any other partition order is unsupported and left untouched.
layout() {
  local line
  line=$(root_diskutil list -plist physical | python3 -I -c '
import plistlib, sys
disks = plistlib.loads(sys.stdin.buffer.read()).get("AllDisksAndPartitions", [])
seen = "; ".join("%s: %s" % (d.get("DeviceIdentifier", "?"), ", ".join(
    "%s(%s)" % (p.get("DeviceIdentifier", "-"), p.get("Content", "?"))
    for p in d.get("Partitions", []))) for d in disks)
found = [(disk, i) for disk in disks for i, p in enumerate(disk.get("Partitions", []))
         if p.get("Content") == "Apple_APFS"]
if len(found) != 1:
    sys.exit("unsupported disk layout (%d APFS containers, not one): %s" % (len(found), seen))
disk, i = found[0]
parts = disk["Partitions"]
part = parts[i]
after = parts[i + 1:]
recovery = "-"
if after and after[0].get("Content") == "Apple_APFS_Recovery":
    recovery = after[0]["DeviceIdentifier"]
    after = after[1:]
if ([p.get("Content") for p in parts[:i]] != ["Apple_APFS_ISC"]
        or any(p.get("Content") != "Free Space" for p in after)):
    sys.exit("unsupported disk layout (expected iBoot, APFS, optional recovery, then free space): " + seen)
print(disk["DeviceIdentifier"], disk["Size"], part["DeviceIdentifier"], part["Size"], recovery)') || return 1
  read -r l_disk l_size l_apfs l_apfs_size l_recovery <<<"$line"
}
# The guest agent's daemon (Cirrus's images run it at boot as a LaunchDaemon, tart-guest-agent --run-daemon) tries the
# same repair and resize itself when the disk has room the partitions do not use; its attempt is let finish first, so
# two diskutil sequences never work the disk at once. Its log has one outcome line after "attempting to resize disk".
agent_resize_wait() {
  local log=${CI_KIT_VM_DAEMON_LOG:-/tmp/tart-guest-daemon.log} waited=0 said=''
  while [[ $(grep -E 'attempting to resize disk|skipping disk resizing|failed to resize disk|successfully resized the disk' "$log" 2>/dev/null | tail -1) == *'attempting to resize disk'* ]]; do
    ((waited < 600)) || fail "the guest agent's own disk resize has not ended after 600 s ($log)"
    [[ -n $said ]] || { say "waiting for the guest agent's own disk resize to end ($log)"; said=1; }
    sleep 1
    waited=$((waited + 1))
  done
}

# THE QUIET IMAGE. Probe 4 (2026-10-23) took the fresh clone's 19-test document run from 154.1 s to 107.8 s
# (mean test sums, three interleaved runs each, all green) with indexing off and exactly these launchd overrides.
# Nothing of WindowServer, TCC, LaunchServices or fseventsd is changed. The list is explicit, not a match against
# today's loaded jobs: a service that is idle at bake time must stay disabled when the clone next boots too.
# The command paths, like diskutil's above, can be replaced by test stand-ins; system changes use passwordless sudo.
quiet_launchctl() { # <domain> <command> <target>
  local domain=$1
  shift
  if [[ $domain == system ]]; then
    "${CI_KIT_VM_SUDO:-/usr/bin/sudo}" -n "${CI_KIT_VM_LAUNCHCTL:-/bin/launchctl}" "$@"
  else
    "${CI_KIT_VM_LAUNCHCTL:-/bin/launchctl}" "$@"
  fi
}
quiet_service() { # <domain> <label>
  local domain=$1 target=$1/$2 status
  quiet_launchctl "$domain" disable "$target" || fail "cannot disable $target"
  # An absent job (113 from print) is already out, whether this step ran before or a later macOS removed the label.
  # Keep its override and verify it below anyway: absence alone never proves a persistent disable. Other lookup
  # errors fail the bake. A job may disappear between print and bootout; only a second not-found makes that harmless.
  if quiet_launchctl "$domain" print "$target" >/dev/null 2>&1; then
    if ! quiet_launchctl "$domain" bootout "$target"; then
      status=0
      quiet_launchctl "$domain" print "$target" >/dev/null 2>&1 || status=$?
      ((status == 113)) || fail "cannot boot out $target"
    fi
  else
    status=$?
    ((status == 113)) || fail "cannot read $target (launchctl print exited $status)"
    say "$target is not loaded; keeping its disabled override"
  fi
}

write_env() { # <machine>
  [[ $1 =~ ^[a-z0-9-]+$ ]] || fail "env takes the guest's machine name (got '$1')"
  [[ -d $vm_runner ]] || fail "no runner at $vm_runner"
  {
    echo LANG=en_US.UTF-8
    echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$HOME/ci-kit/vm/guest/hooks/job-started.sh"
    echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$HOME/ci-kit/vm/guest/hooks/job-completed.sh"
    echo "CI_KIT_MACHINE=$1"
    echo CI_KIT_VM_GUEST=1
    if [[ -f $HOME/.ci-kit/setup-hash ]]; then
      printf 'CI_KIT_SETUP_HASH=%s\n' "$(cat "$HOME/.ci-kit/setup-hash")"
    fi
  } >"$vm_runner/.env"
  echo "$runner_path" >"$vm_runner/.path"
  ln -sfn "$vm_shares/kit" "$HOME/ci-kit"
  say "$vm_runner/.env and .path written; $HOME/ci-kit -> $vm_shares/kit"
}

step=${1:-}
shift || true
case $step in
  check)
    say "macOS $(sw_vers -productVersion)"
    command -v brew >/dev/null || fail 'no Homebrew in the base image'
    if ! python3 -I -c 'import ctypes, json' >/dev/null 2>&1; then
      say 'python3 cannot run runner-state.py; installing python from Homebrew'
      brew install python
    fi
    say "$(python3 --version)"
    xcrun --find swiftc >/dev/null || fail 'no Swift compiler (the Xcode command line tools) in the base image'
    ;;
  disk)
    [[ ${1:-} =~ ^[1-9][0-9]*$ ]] || fail "disk takes the disk's size in GB, as bake.sh set it (got '${1:-}')"
    agent_resize_wait
    layout || fail 'the physical disk cannot be read (diskutil list -plist physical)'
    ((l_size >= $1 * 1000000000)) || fail "the disk $l_disk is $(gb "$l_size"), under the $1 GB bake.sh set (tart set --disk-size did not take)"
    if ((l_size - l_apfs_size > disk_slack)); then
      say "the container $l_apfs is $(gb "$l_apfs_size") of the $(gb "$l_size") disk $l_disk; growing it"
      if [[ $l_recovery != - ]]; then
        say "removing the recovery container $l_recovery, which sits between $l_apfs and the disk's free space"
        root_diskutil eraseVolume free free "$l_recovery" || root_diskutil apfs deleteContainer "$l_recovery" ||
          fail "the recovery container $l_recovery could not be removed"
      fi
      root_diskutil repairDisk "$l_disk" <<<yes || fail "diskutil repairDisk $l_disk failed"
      root_diskutil apfs resizeContainer "$l_apfs" 0 || fail "diskutil apfs resizeContainer $l_apfs 0 failed"
      layout || fail 'the physical disk cannot be read after the resize'
      ((l_size - l_apfs_size <= disk_slack)) ||
        fail "the container $l_apfs is $(gb "$l_apfs_size") of the $(gb "$l_size") disk $l_disk after the resize: it did not grow into the disk"
    fi
    say "the container $l_apfs is $(gb "$l_apfs_size") of the $(gb "$l_size") disk $l_disk; / has $(df -g / | awk 'NR == 2 { print $4 }') GiB free"
    ;;
  quiet)
    export LC_ALL=C
    mdutil=${CI_KIT_VM_MDUTIL:-/usr/bin/mdutil}
    "${CI_KIT_VM_SUDO:-/usr/bin/sudo}" -n "$mdutil" -a -i off || fail 'cannot turn Spotlight indexing off'
    indexing=$("$mdutil" -a -s) || fail 'cannot read Spotlight indexing (mdutil -a -s)'
    # Check every reported volume, not just the first disabled line, and require the system and data volumes. mdutil
    # reports only mounted volumes: the first bake (10-23) read / and /System/Volumes/Data alone, while probe 4's booted
    # clone of a golden also listed /System/Volumes/Preboot. So Preboot, like any other volume, must read disabled when
    # it is reported but is not required. Empty, partial or unfamiliar output cannot certify the image.
    python3 -I -c '
import sys
lines = [line.strip() for line in sys.stdin if line.strip()]
volumes = lines[::2]
valid = (len(lines) % 2 == 0
         and {"/:", "/System/Volumes/Data:"} <= set(volumes)
         and all(volume.startswith("/") and volume.endswith(":") for volume in volumes)
         and all(status == "Indexing disabled." for status in lines[1::2]))
sys.exit(0 if valid else 1)' <<<"$indexing" || fail "Spotlight indexing is not verified disabled on every volume: $indexing"
    say "$indexing"
    gui_services=(BiomeAgent assistantd biomesyncd chronod corespotlightd duetexpertd intelligencecontextd
      jetpackassetd knowledge-agent managedcorespotlightd mediaanalysisd passd photoanalysisd remindd
      siriinferenced siriknowledged spotlightknowledged suggestd triald)
    system_services=(AssetCacheTetheratorService PerfPowerServices audioanalyticsd)
    for domain in "gui/$(id -u)" system; do
      if [[ $domain == system ]]; then services=("${system_services[@]}"); else services=("${gui_services[@]}"); fi
      for service in "${services[@]}"; do quiet_service "$domain" "com.apple.$service"; done
      disabled=$(quiet_launchctl "$domain" print-disabled "$domain") || fail "cannot read disabled services in $domain"
      for service in "${services[@]}"; do
        # launchctl versions print either disabled/enabled or true/false. Compare the entire quoted label literally
        # (its dots are not regex wildcards); an absent override, or an explicitly enabled one, fails the bake.
        awk -v label="\"com.apple.$service\"" '
          $1 == label && $2 == "=>" && ($3 == "disabled" || $3 == "true") { found = 1 }
          END { exit !found }' <<<"$disabled" || fail "$domain/com.apple.$service is not disabled in launchctl print-disabled"
        say "$domain/com.apple.$service disabled and not loaded"
      done
    done
    ;;
  display)
    [[ -x $vm_displayplacer ]] || brew install jakehilborn/jakehilborn/displayplacer
    [[ -x $vm_displayplacer ]] || fail "displayplacer did not install ($vm_displayplacer)"
    vm_display || fail "the display mode cannot be read ($vm_displayplacer list)"
    if ! vm_display_right; then
      say "the display is $dp_res scaling:$dp_scaling; setting $vm_display_res scaling:on"
      "$vm_displayplacer" "id:$dp_id res:$vm_display_res scaling:on" || fail "displayplacer could not set $vm_display_res scaling:on"
      vm_display || fail "the display mode cannot be read after displayplacer set it ($vm_displayplacer list)"
    fi
    vm_display_right || fail "the display is $dp_res scaling:$dp_scaling after displayplacer set $vm_display_res scaling:on"
    say "display $dp_id: $dp_res scaling:on (every clone of the image keeps it)"
    ;;
  node)
    [[ ${1:-} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "node takes pnpm's version (got '${1:-}')"
    brew list node@22 >/dev/null 2>&1 || brew install node@22
    node_bin=$(brew --prefix node@22)/bin
    [[ $("$node_bin/node" --version) == v22.* ]] || fail "node@22 is $("$node_bin/node" --version)"
    [[ -x $node_bin/corepack ]] || "$node_bin/npm" install -g --prefix "$(brew --prefix node@22)" corepack
    "$node_bin/corepack" enable --install-directory "$node_bin" pnpm
    "$node_bin/corepack" install --global "pnpm@$1"
    [[ $(pnpm --version) == "$1" ]] || fail "pnpm is $(pnpm --version), not $1"
    say "node $(node --version), pnpm $(pnpm --version)"
    ;;
  setup)
    [[ -f $vm_shares/kit/setup/apply.mjs ]] || fail "no setup applier in the installed kit at $vm_shares/kit (refresh with mac/install.sh --vm)"
    scratch=$HOME/maws-setup
    trap 'rm -rf "$scratch"' EXIT
    rm -rf "$scratch"
    # Read committed master, not the host's edits or its git config. The clone owns its objects, not share hardlinks.
    git -c safe.directory='*' clone --quiet --no-local --depth=1 --single-branch --branch master --no-tags "$vm_shares/maws" "$scratch"
    say "MAWS declaration at $(git -C "$scratch" rev-parse HEAD) (setup)"
    node "$here/setup.mjs" "$vm_shares/kit" "$scratch"
    ;;
  runner)
    version=${1:-} sha=${2:-}
    [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $sha =~ ^[0-9a-f]{64}$ ]] || fail 'runner takes <version> <sha256> <machine>'
    tarball=actions-runner-osx-arm64-$version.tar.gz
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL -o "$tmp/$tarball" "https://github.com/actions/runner/releases/download/v$version/$tarball"
    echo "$sha  $tmp/$tarball" | shasum -a 256 -c --quiet - || fail "checksum mismatch for $tarball"
    rm -rf "$vm_runner"
    mkdir -p "$vm_runner"
    tar -xzf "$tmp/$tarball" -C "$vm_runner"
    write_env "${3:-}"
    say "runner $version in $vm_runner"
    ;;
  workrepo)
    source "$here/../repo.sh"
    target_repo=${1:-$(ci_kit_repo)}
    [[ -d $vm_runner ]] || fail "no runner at $vm_runner"
    # .runner is JSON (possibly with a BOM). Honor its workFolder when provision is repeated on a configured runner;
    # normal bakes precede registration, whose --work uses runner_work below. No identity is made or kept here.
    work=$(python3 -I -c '
import json, os, sys
runner, default = sys.argv[1:]
config = os.path.join(runner, ".runner")
work = default
if os.path.exists(config):
    with open(config, encoding="utf-8-sig") as f:
        work = json.load(f).get("workFolder")
if not isinstance(work, str) or not work.strip():
    sys.exit("invalid runner workFolder")
print(os.path.join(runner, work))' "$vm_runner" "$runner_work") || fail 'cannot read the runner workFolder'
    repo=$work/MAWS/MAWS
    # --no-local goes through upload-pack: --depth is honored, with no hardlinks, alternates or source config copied.
    # A single master tip is enough for the next --depth=1 fetch to negotiate its existing tree; full history buys
    # no transfer saving. Never copy the host's working tree (edits, dependencies, auth or locks).
    git -c safe.directory='*' -C "$vm_shares/maws" rev-parse --verify refs/heads/master >/dev/null || fail 'the maws share has no master'
    rm -rf "$repo"
    mkdir -p "${repo%/*}"
    git -c safe.directory='*' clone --quiet --no-local --depth=1 --single-branch --branch master --no-tags "$vm_shares/maws" "$repo"
    # checkout v7's prepareExistingDirectory requires .git and this exact origin (no .git suffix), then detaches,
    # deletes local branches and runs clean -ffdx / reset --hard HEAD. A fresh clone satisfies those checks.
    git -C "$repo" remote set-url origin "https://github.com/$target_repo"
    say "MAWS work repository $repo: master $(git -C "$repo" rev-parse --short HEAD), $(du -sk "$repo" | awk '{print $1}') KiB (tree and .git)"
    ;;
  env)
    write_env "${1:-}"
    ;;
  helpers)
    mkdir -p "$HOME/ci-kit-helpers"
    for helper in cursor-park window-list; do
      xcrun swiftc -O -o "$HOME/ci-kit-helpers/.$helper.tmp" "$vm_shares/kit/hooks/$helper.swift"
      mv -f "$HOME/ci-kit-helpers/.$helper.tmp" "$HOME/ci-kit-helpers/$helper"
    done
    say "helpers in $HOME/ci-kit-helpers; display $("$HOME/ci-kit-helpers/cursor-park" --describe 2>/dev/null || echo unreadable)"
    ;;
  register)
    slot=${1:-} name=${2:-} labels=${3:-} url=${4:-}
    [[ $slot =~ ^[a-z0-9-]+$ && $name =~ ^[A-Za-z0-9._-]+$ && -n $labels && $url == https://github.com/* ]] ||
      fail 'register takes <slot> <runner name> <labels> <repository url>, the token on stdin'
    IFS= read -r token || true
    [[ -n $token ]] || fail 'no registration token on stdin'
    dest=$vm_shares/identity-$slot
    [[ -d $dest && -w $dest ]] || fail "the identity-$slot share is not shown read-write at $dest"
    cd "$vm_runner" 2>/dev/null && [[ -x ./config.sh && -f .env && -f .path ]] || fail "no provisioned runner at $vm_runner"
    for file in $vm_identity_files; do rm -f "$file"; done
    # config.sh rewrites .path from its own PATH and adds to .env (the runner's env.sh): the bake's are put back.
    cp .env .env.bake && cp .path .path.bake
    status=0
    env -i HOME="$HOME" USER="${USER:-admin}" PATH="$runner_path" LANG=en_US.UTF-8 ACTIONS_RUNNER_INPUT_TOKEN="$token" \
      ./config.sh --unattended --url "$url" --name "$name" --labels "$labels" --no-default-labels --work "$runner_work" --replace ||
      status=$?
    token=''
    mv -f .env.bake .env && mv -f .path.bake .path
    ((status == 0)) || fail "config.sh failed ($status)"
    for file in $vm_identity_files; do
      [[ -f $file ]] || fail "config.sh left no $file"
      cp "$file" "$dest/$file.tmp" && mv -f "$dest/$file.tmp" "$dest/$file"
    done
    for file in $vm_identity_files; do rm -f "$file"; done
    rm -rf _diag
    say "$name registered with $labels; its identity is in the identity-$slot share, and none is left in $vm_runner"
    ;;
  *)
    fail "unknown step '${step}' (check, disk, quiet, display, node, setup, runner, workrepo, env, helpers, register)"
    ;;
esac
