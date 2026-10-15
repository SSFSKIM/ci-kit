#!/bin/bash
# Installs the mac lane (I10, docs/mac-lane.md) on this Mac, the mini: a GitHub Actions runner for SSFSKIM/MAWS in
# ~/actions-runner-maws, labelled self-hosted, macOS, ARM64, ci-kit-mac, with the job hooks that kill what a job left
# under its work directory, run by the LaunchAgent com.ssfskim.ci-kit.mac-runner in the logged-in GUI session.
#
#   gh api -X POST repos/SSFSKIM/MAWS/actions/runners/registration-token --jq .token | ssh mini <kit>/mac/install.sh
#   ssh mini <kit>/mac/install.sh --check       the prerequisites only
#   ssh mini <kit>/mac/install.sh --disabled    install, but leave the LaunchAgent unloaded and disabled
#
# The registration token is read from stdin, only when the runner is not registered yet, and handed to the runner's
# config through its environment, never its arguments or a file. Re-running refreshes the hooks, the runner's
# environment and the LaunchAgent; it refuses while a job is running, since reloading the agent would kill the job.
# Prerequisites are checked first and a gap stops the install: they are reported, never installed.
set -euo pipefail

REPO_URL=https://github.com/SSFSKIM/MAWS
RUNNER_NAME=ci-kit-mac-mini
RUNNER_LABELS=ci-kit-mac # the runner adds self-hosted, macOS and ARM64 itself
RUNNER_VERSION=2.338.0
RUNNER_SHA256=df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2
AGENT=com.ssfskim.ci-kit.mac-runner
RUNNER_DIR=$HOME/actions-runner-maws
LOG_DIR=$HOME/Library/Logs/ci-kit
PLIST=$HOME/Library/LaunchAgents/$AGENT.plist
# The PATH jobs and hooks start with: Homebrew's tools, then the system's. Jobs install their own Node and pnpm.
RUNNER_PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
here=$(cd "$(dirname "$0")" && pwd)
domain=gui/$(id -u)

say() { echo "ci-kit mac: $*"; }
die() { echo "ci-kit mac: $*" >&2; exit 1; }

mode=enabled
case ${1:-} in
  '') ;;
  --check) mode=check ;;
  --disabled) mode=disabled ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

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

# 2. The runner's files, at a pinned version (it updates itself from there).
if [[ ! -x $RUNNER_DIR/config.sh ]]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  tarball=actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz
  say "downloading runner $RUNNER_VERSION"
  curl -fsSL -o "$tmp/$tarball" "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/$tarball"
  echo "$RUNNER_SHA256  $tmp/$tarball" | shasum -a 256 -c --quiet - || die "checksum mismatch for $tarball"
  mkdir -p "$RUNNER_DIR"
  tar -xzf "$tmp/$tarball" -C "$RUNNER_DIR"
fi

# 3. Registration, once. Repository level: a personal account cannot register a runner any higher. Not ephemeral: the
# hooks clean between jobs.
if [[ ! -f $RUNNER_DIR/.runner ]]; then
  [[ -t 0 ]] && die 'pipe a registration token on stdin (gh api -X POST repos/SSFSKIM/MAWS/actions/runners/registration-token --jq .token)'
  IFS= read -r token || true
  [[ -n $token ]] || die 'no registration token on stdin'
  (cd "$RUNNER_DIR" && ACTIONS_RUNNER_INPUT_TOKEN=$token ./config.sh --unattended --url "$REPO_URL" \
    --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work --replace)
  unset token
fi

# 4. The hooks, copied into the runner so it never depends on where the kit is checked out, and the environment the
# runner gives every job and hook. English messages: the jobs parse tool output, and this Mac's locale is Korean.
mkdir -p "$RUNNER_DIR/ci-kit/hooks" "$LOG_DIR" "$(dirname "$PLIST")"
rm -f "$RUNNER_DIR/ci-kit/hooks/"*
cp "$here/hooks/job-started.sh" "$here/hooks/job-completed.sh" "$here/hooks/sweep.mjs" "$here/hooks/strays.mjs" \
  "$here/hooks/terminate.mjs" "$RUNNER_DIR/ci-kit/hooks/"
chmod +x "$RUNNER_DIR/ci-kit/hooks/"*.sh
cat >"$RUNNER_DIR/.env" <<EOF
LANG=en_US.UTF-8
ACTIONS_RUNNER_HOOK_JOB_STARTED=$RUNNER_DIR/ci-kit/hooks/job-started.sh
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$RUNNER_DIR/ci-kit/hooks/job-completed.sh
EOF
echo "$RUNNER_PATH" >"$RUNNER_DIR/.path"
cp "$RUNNER_DIR/bin/runsvc.sh" "$RUNNER_DIR/runsvc.sh"

# 5. The LaunchAgent, reloaded so a re-run takes effect.
sed -e "s|__RUNNER_DIR__|$RUNNER_DIR|g" -e "s|__LOG_DIR__|$LOG_DIR|g" "$here/$AGENT.plist" >"$PLIST"
plutil -lint -s "$PLIST"
# bootout returns while the runner is still shutting down, and bootstrap fails (5: Input/output error) until it is gone.
launchctl bootout "$domain/$AGENT" 2>/dev/null || true
for _ in $(seq 1 60); do launchctl print "$domain/$AGENT" >/dev/null 2>&1 || break; sleep 1; done
if [[ $mode == disabled ]]; then
  launchctl disable "$domain/$AGENT"
  say "installed, disabled: $AGENT is not loaded (enable: launchctl enable $domain/$AGENT && launchctl bootstrap $domain $PLIST)"
  exit 0
fi
out_log=$LOG_DIR/mac-runner.out.log
seen=$(stat -f %z "$out_log" 2>/dev/null || echo 0)
launchctl enable "$domain/$AGENT"
launchctl bootstrap "$domain" "$PLIST"
for _ in $(seq 1 30); do
  if tail -c +$((seen + 1)) "$out_log" 2>/dev/null | grep -q 'Listening for Jobs'; then
    say "running: $RUNNER_NAME listens for jobs of $REPO_URL"
    exit 0
  fi
  sleep 1
done
die "the runner did not report 'Listening for Jobs' within 30 s; see $out_log and $RUNNER_DIR/_diag"
