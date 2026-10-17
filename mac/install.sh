#!/bin/bash
# Installs the mac lane (I10, docs/mac-lane.md) on this Mac: a GitHub Actions runner for SSFSKIM/MAWS in
# ~/actions-runner-maws, labelled self-hosted, macOS, ARM64, ci-kit-mac, with the job hooks that kill what a job left
# under its work directory, run by the LaunchAgent com.ssfskim.ci-kit.mac-runner in the logged-in GUI session; and the
# dialog watcher, the LaunchAgent com.ssfskim.ci-kit.dialog-watch, which alerts on a system dialog in front every 60 s
# and keeps the runner stopped while one holds the desktop.
#
#   gh api -X POST repos/SSFSKIM/MAWS/actions/runners/registration-token --jq .token |
#     ssh <mac> <kit>/mac/install.sh --name ci-kit-mac-<machine>    register, then install
#   ssh <mac> <kit>/mac/install.sh               re-run on a registered runner: refresh and reload
#   ssh <mac> <kit>/mac/install.sh --check       the prerequisites only
#   ssh <mac> <kit>/mac/install.sh --disabled    install, but leave the runner's LaunchAgent unloaded and disabled
#   ssh <mac> <kit>/mac/install.sh --uninstall   unload and remove both LaunchAgents (the registration and files stay)
#
# --name is needed only to register (the mini is ci-kit-mac-mini). There is no default: the runner's config replaces a
# registration of the same name, so a default would let a new Mac take over the mini's. A re-run keeps the registered
# name and refuses another. The part after ci-kit-mac- is the machine's short name ("the mini"): lowercase letters,
# digits and '-', since it is in every alert title (docs/mac-lane.md). The runner's .env and the watcher's LaunchAgent
# carry it to the hooks as CI_KIT_MACHINE for their messages and alerts.
#
# The registration token is read from stdin, only when the runner is not registered yet, and handed to the runner's
# config through its environment, never its arguments or a file. Re-running refreshes the hooks, the runner's
# environment and both LaunchAgents; it refuses while a job is running, since reloading the agent would kill the job.
# The watcher runs in every mode: --disabled turns off the runner, not the alerts. Prerequisites are checked first and
# a gap stops the install: they are reported, never installed.
set -euo pipefail

REPO_URL=https://github.com/SSFSKIM/MAWS
RUNNER_PREFIX=ci-kit-mac-
RUNNER_LABELS=ci-kit-mac # the runner adds self-hosted, macOS and ARM64 itself
RUNNER_VERSION=2.338.0
RUNNER_SHA256=df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2
AGENT=com.ssfskim.ci-kit.mac-runner
WATCH_AGENT=com.ssfskim.ci-kit.dialog-watch
RUNNER_DIR=$HOME/actions-runner-maws
LOG_DIR=$HOME/Library/Logs/ci-kit
PLIST=$HOME/Library/LaunchAgents/$AGENT.plist
WATCH_PLIST=$HOME/Library/LaunchAgents/$WATCH_AGENT.plist
# The watcher's record that it stopped the runner (dialog-watch.sh); it starts the runner again only while this exists.
DRAIN_MARKER=$LOG_DIR/runner-drained
# The PATH jobs and hooks start with: Homebrew's tools, then the system's. Jobs install their own Node and pnpm.
RUNNER_PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
here=$(cd "$(dirname "$0")" && pwd)
domain=gui/$(id -u)
tmp=
staged_hooks=
reload_watch=
cleanup() {
  if [[ -n $staged_hooks ]]; then rm -rf "$staged_hooks"; fi
  if [[ -n $tmp ]]; then rm -rf "$tmp"; fi
  # A failure after the watcher was unloaded still leaves it running, on what was installed.
  if [[ -n $reload_watch ]]; then load_watch || true; fi
}
trap cleanup EXIT

say() { echo "ci-kit mac: $*"; }
die() { echo "ci-kit mac: $*" >&2; exit 1; }

# bootout returns while a job is still shutting down, and bootstrap fails (5: Input/output error) until it is gone.
unload() { # <label>
  launchctl bootout "$domain/$1" 2>/dev/null || true
  for _ in $(seq 1 60); do launchctl print "$domain/$1" >/dev/null 2>&1 || break; sleep 1; done
}
load_watch() {
  reload_watch=
  launchctl enable "$domain/$WATCH_AGENT"
  launchctl bootstrap "$domain" "$WATCH_PLIST"
}

usage() { awk 'NR > 1 && !/^#/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
mode=enabled
name=
while (($# > 0)); do
  case $1 in
    --check) mode=check ;;
    --disabled) mode=disabled ;;
    --uninstall) mode=uninstall ;;
    --name) (($# > 1)) || usage; name=$2; shift ;;
    *) usage ;;
  esac
  shift
done
# The name lands in .env and the hooks' messages: keep it to what a runner name needs.
[[ -z $name || $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "--name takes letters, digits, '.', '_' and '-' (got '$name')"

if [[ $mode == uninstall ]]; then
  [[ -z $name ]] || usage
  if pgrep -qf "$RUNNER_DIR/bin/Runner.Worker"; then die 'a job is running on this runner; re-run when it is idle'; fi
  unload "$WATCH_AGENT"
  unload "$AGENT"
  rm -f "$WATCH_PLIST" "$PLIST" "$DRAIN_MARKER"
  say "uninstalled: $WATCH_AGENT and $AGENT are unloaded and removed; the registration and $RUNNER_DIR stay (docs/mac-lane.md)"
  exit 0
fi

# 1. Prerequisites (MAWS's gate-offload plan §3.6): Node >= 22.12 on the PATH jobs get (MAWS's engines; its plan job and
# the hooks run node from PATH), pnpm through corepack, a compiler for native modules such as node-pty, and LibreOffice
# for the document groups. LibreOffice is found, not run: a first launch can raise a Gatekeeper prompt, which is the
# human's to answer.
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
probe 'LibreOffice (soffice)' bash -c 'command -v soffice && test -x /Applications/LibreOffice.app/Contents/MacOS/soffice ||
  { echo "soffice or /Applications/LibreOffice.app missing"; exit 1; }'
if ((${#gaps[@]} > 0)); then
  for gap in "${gaps[@]}"; do echo "ci-kit mac: missing: $gap" >&2; done
  die 'prerequisites missing; nothing installed'
fi
[[ $mode == check ]] && exit 0

if pgrep -qf "$RUNNER_DIR/bin/Runner.Worker"; then die 'a job is running on this runner; re-run when it is idle'; fi

# 2. The runner's name, before anything changes, so every refusal over it leaves the Mac as it was. A registered
# runner keeps its name: .runner (JSON behind a byte-order mark) has it. An unregistered one takes --name.
if [[ -f $RUNNER_DIR/.runner ]]; then
  RUNNER_NAME=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8-sig"))["agentName"])' \
    "$RUNNER_DIR/.runner" 2>/dev/null) || RUNNER_NAME=
  [[ -n $RUNNER_NAME ]] || die "cannot read the runner's name from $RUNNER_DIR/.runner"
  [[ -z $name || $name == "$RUNNER_NAME" ]] ||
    die "this runner is registered as $RUNNER_NAME; to rename it, remove it (docs/mac-lane.md) and register again with --name $name"
else
  [[ -n $name ]] || die "name the runner to register it: --name ${RUNNER_PREFIX}<machine> (the mini is ${RUNNER_PREFIX}mini)"
  RUNNER_NAME=$name
fi
machine=${RUNNER_NAME#"$RUNNER_PREFIX"}
[[ -n $machine ]] || machine=$RUNNER_NAME
# MAWS reads open alerts by their title, ci-kit alert: <machine>: …, with [a-z0-9-]+ for the machine.
[[ $machine =~ ^[a-z0-9-]+$ ]] ||
  die "the machine's short name, '$machine' in $RUNNER_NAME, takes lowercase letters, digits and '-' (docs/mac-lane.md)"

# 3. The runner's files, at a pinned version (it updates itself from there).
if [[ ! -x $RUNNER_DIR/config.sh ]]; then
  tmp=$(mktemp -d)
  tarball=actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz
  say "downloading runner $RUNNER_VERSION"
  curl -fsSL -o "$tmp/$tarball" "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/$tarball"
  echo "$RUNNER_SHA256  $tmp/$tarball" | shasum -a 256 -c --quiet - || die "checksum mismatch for $tarball"
  mkdir -p "$RUNNER_DIR"
  tar -xzf "$tmp/$tarball" -C "$RUNNER_DIR"
fi

# 4. Registration, once. Repository level: a personal account cannot register a runner any higher. Not ephemeral: the
# hooks clean between jobs.
if [[ ! -f $RUNNER_DIR/.runner ]]; then
  [[ -t 0 ]] && die 'pipe a registration token on stdin (gh api -X POST repos/SSFSKIM/MAWS/actions/runners/registration-token --jq .token)'
  IFS= read -r token || true
  [[ -n $token ]] || die 'no registration token on stdin'
  (cd "$RUNNER_DIR" && ACTIONS_RUNNER_INPUT_TOKEN=$token ./config.sh --unattended --url "$REPO_URL" \
    --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work --replace)
  unset token
fi

# 5. The hooks, copied into the runner so it never depends on where the kit is checked out, and the environment the
# runner gives every job and hook. English messages: the jobs parse tool output, and the mini's locale is Korean.
mkdir -p "$RUNNER_DIR/ci-kit" "$LOG_DIR" "$(dirname "$PLIST")"
# A sibling keeps staging on the same volume. Nothing touches the live set until every required file is ready.
staged_hooks=$(mktemp -d "$RUNNER_DIR/ci-kit/.hooks.XXXXXX")
hook_files=(job-started.sh job-completed.sh desktop-check.sh desktop-posture.sh dialog.sh dialog-watch.sh runner-worker.py
  sweep.mjs strays.mjs terminate.mjs)
for file in "${hook_files[@]}"; do cp "$here/hooks/$file" "$staged_hooks/"; done
chmod +x "$staged_hooks/"*.sh
# The cursor park is optional. A failed compiler may leave output, which must not be published as a working helper.
if ! xcrun swiftc -O -o "$staged_hooks/cursor-park" "$here/hooks/cursor-park.swift" 2>"$LOG_DIR/cursor-park-build.log"; then
  rm -f "$staged_hooks/cursor-park"
  say "warning: cursor-park did not compile (see $LOG_DIR/cursor-park-build.log); jobs start without the cursor park"
fi
for file in "${hook_files[@]}"; do
  [[ -f $staged_hooks/$file && -r $staged_hooks/$file ]] || die "staged hook missing or unreadable: $file"
  if [[ $file == *.sh ]]; then
    [[ -x $staged_hooks/$file ]] || die "staged hook not executable: $file"
    bash -n "$staged_hooks/$file"
  fi
done
if [[ -f $staged_hooks/cursor-park ]]; then
  [[ -x $staged_hooks/cursor-park ]] || die 'staged cursor-park not executable'
fi
# Two renames (old -> backup, staged -> hooks) leave a gap at the fixed paths in .env. Darwin's RENAME_SWAP
# exchanges both directories in one operation, so a job starting now still finds a complete set at hooks/.
python3 -I - "$staged_hooks" "$RUNNER_DIR/ci-kit/hooks" <<'PY'
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
# After an exchange staging holds the old set; after a first install it no longer exists.
rm -rf "$staged_hooks"
staged_hooks=
cat >"$RUNNER_DIR/.env" <<EOF
LANG=en_US.UTF-8
ACTIONS_RUNNER_HOOK_JOB_STARTED=$RUNNER_DIR/ci-kit/hooks/job-started.sh
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$RUNNER_DIR/ci-kit/hooks/job-completed.sh
CI_KIT_MACHINE=$machine
EOF
echo "$RUNNER_PATH" >"$RUNNER_DIR/.path"
cp "$RUNNER_DIR/bin/runsvc.sh" "$RUNNER_DIR/runsvc.sh"

# 6. The LaunchAgents, reloaded so a re-run takes effect. The watcher stops and starts the runner's agent while a dialog
# holds the desktop, so it is unloaded while the runner's is reloaded, and its marker goes: after an install, whether
# the runner runs is this mode's. If a dialog episode is still open, the watcher stops the runner again once it is
# idle. The watcher is loaded last, in every mode.
sed -e "s|__RUNNER_DIR__|$RUNNER_DIR|g" -e "s|__LOG_DIR__|$LOG_DIR|g" "$here/$AGENT.plist" >"$PLIST"
plutil -lint -s "$PLIST"
sed -e "s|__HOOKS_DIR__|$RUNNER_DIR/ci-kit/hooks|g" -e "s|__LOG_DIR__|$LOG_DIR|g" -e "s|__PATH__|$RUNNER_PATH|g" \
  -e "s|__MACHINE__|$machine|g" "$here/$WATCH_AGENT.plist" >"$WATCH_PLIST"
plutil -lint -s "$WATCH_PLIST"
unload "$WATCH_AGENT"
reload_watch=1
rm -f "$DRAIN_MARKER"
unload "$AGENT"
if [[ $mode == disabled ]]; then
  launchctl disable "$domain/$AGENT"
  load_watch
  say "installed, disabled: $AGENT is not loaded (enable: launchctl enable $domain/$AGENT && launchctl bootstrap $domain $PLIST)"
  say "the dialog watcher $WATCH_AGENT runs"
  exit 0
fi
out_log=$LOG_DIR/mac-runner.out.log
seen=$(stat -f %z "$out_log" 2>/dev/null || echo 0)
launchctl enable "$domain/$AGENT"
launchctl bootstrap "$domain" "$PLIST"
for _ in $(seq 1 30); do
  if tail -c +$((seen + 1)) "$out_log" 2>/dev/null | grep -q 'Listening for Jobs'; then
    load_watch
    say "running: $RUNNER_NAME listens for jobs of $REPO_URL; the dialog watcher $WATCH_AGENT runs"
    exit 0
  fi
  sleep 1
done
die "the runner did not report 'Listening for Jobs' within 30 s; see $out_log and $RUNNER_DIR/_diag"
