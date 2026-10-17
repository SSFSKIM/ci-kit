#!/bin/bash
# Installs the host janitor (I11, docs/host.md) on this Mac: the LaunchAgent com.ssfskim.ci-kit.janitor runs
# host/janitor.mjs from this checkout at load and every 30 minutes, in the logged-in user's session.
#
#   host/install.sh              live: kills orphaned one-shot test processes
#   host/install.sh --dry-run    logs would-kill lines and kills nothing
#   host/install.sh --uninstall  unloads the agent and removes its plist (logs and report stay)
#
# Run it from the checkout that stays (~/Developer/GitHub/ci-kit on main), not from a worktree that will be removed:
# the agent runs the janitor where this script is. Re-running reloads the agent, so switching modes is a re-run.
# On the mini: ssh mini '~/Developer/GitHub/ci-kit/host/install.sh [--dry-run]'.
set -euo pipefail

AGENT=com.ssfskim.ci-kit.janitor
PLIST=$HOME/Library/LaunchAgents/$AGENT.plist
LOG_DIR=$HOME/Library/Logs/ci-kit
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
domain=gui/$(id -u)

say() { echo "ci-kit janitor: $*"; }
die() { echo "ci-kit janitor: $*" >&2; exit 1; }

unload() {
  launchctl bootout "$domain/$AGENT" 2>/dev/null || true
  # bootout can return before the job is gone, and bootstrap fails until it is.
  for _ in $(seq 1 30); do launchctl print "$domain/$AGENT" >/dev/null 2>&1 || return 0; sleep 1; done
  die "$AGENT is still loaded after bootout"
}

mode=live
case ${1:-} in
  '') ;;
  --dry-run) mode=dry-run ;;
  --uninstall) unload; rm -f "$PLIST"; say "uninstalled $AGENT (logs and report kept in $LOG_DIR)"; exit 0 ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

# Use the same profile-free lookup at install and at every run. No versioned nvm directory is persisted in the plist.
# The janitor also calls ps, git, tart (for the VM report, where installed) and osascript.
agent_path="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
PATH=$agent_path /bin/bash "$here/run-node.sh" --version || die 'the janitor needs Node >= 22'
dry_run_arg=''
[[ $mode == dry-run ]] && dry_run_arg='<string>--dry-run</string>'

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
sed -e "s|__RUN_NODE__|$here/run-node.sh|" -e "s|__JANITOR__|$here/janitor.mjs|" -e "s|__DRY_RUN__|$dry_run_arg|" \
  -e "s|__PATH__|$agent_path|" -e "s|__LOG_DIR__|$LOG_DIR|" "$here/$AGENT.plist" >"$PLIST.tmp"
plutil -lint -s "$PLIST.tmp"
mv "$PLIST.tmp" "$PLIST"

unload
launchctl enable "$domain/$AGENT"
launchctl bootstrap "$domain" "$PLIST"
say "loaded $AGENT ($mode): $here/janitor.mjs at load and every 30 min"
say "log $LOG_DIR/janitor.log, report $LOG_DIR/report.md, errors $LOG_DIR/janitor.err"
