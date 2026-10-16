#!/bin/bash
# Installs the pool's guard on this Mac, the mini (docs/pool.md, "The guard on the mini"): the LaunchAgent
# com.ssfskim.ci-kit.guard runs host/guard.mjs from this checkout at load and every 10 minutes.
#
#   host/guard-install.sh              install or reload, then show the first cycle's log
#   host/guard-install.sh --uninstall  unload the agent and remove its plist (the log and credentials stay)
#
# Credentials are files in ~/.config/ci-kit/, mode 0600, never arguments: hcloud_token (required), and app_id with
# app.pem (the GitHub App) for the whole guard. Without the App's files the guard runs its Hetzner half only.
# Run it from the checkout that stays (~/Developer/GitHub/ci-kit on main); re-running reloads the agent.
set -euo pipefail

AGENT=com.ssfskim.ci-kit.guard
PLIST=$HOME/Library/LaunchAgents/$AGENT.plist
LOG_DIR=$HOME/Library/Logs/ci-kit
CRED_DIR=$HOME/.config/ci-kit
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
domain=gui/$(id -u)

say() { echo "ci-kit guard: $*"; }
die() { echo "ci-kit guard: $*" >&2; exit 1; }

unload() {
  launchctl bootout "$domain/$AGENT" 2>/dev/null || true
  for _ in $(seq 1 30); do launchctl print "$domain/$AGENT" >/dev/null 2>&1 || return 0; sleep 1; done
  die "$AGENT is still loaded after bootout"
}

case ${1:-} in
  '') ;;
  --uninstall) unload; rm -f "$PLIST"; say "uninstalled $AGENT (log $LOG_DIR/guard.log and $CRED_DIR kept)"; exit 0 ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

node=$(command -v node) || die "node not found on PATH; the guard needs Node >= 22"
major=$("$node" -p 'process.versions.node.split(".")[0]')
((major >= 22)) || die "node $("$node" --version) at $node is too old; the guard needs Node >= 22"
[[ -f $CRED_DIR/hcloud_token ]] || die "no Hetzner token at $CRED_DIR/hcloud_token (mode 0600)"
if [[ -f $CRED_DIR/app_id && -f $CRED_DIR/app.pem ]]; then mode='whole guard (Hetzner and the GitHub App)'
else mode='Hetzner half only (no app_id and app.pem: no ledger rows, alerts or wake)'; fi

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
sed -e "s|__NODE__|$node|" -e "s|__GUARD__|$here/guard.mjs|" -e "s|__PATH__|$(dirname "$node"):/usr/bin:/bin|" \
  -e "s|__LOG_DIR__|$LOG_DIR|" "$here/$AGENT.plist" >"$PLIST.tmp"
plutil -lint -s "$PLIST.tmp"
mv "$PLIST.tmp" "$PLIST"

log=$LOG_DIR/guard.log
seen=$(stat -f %z "$log" 2>/dev/null || echo 0)
unload
launchctl enable "$domain/$AGENT"
launchctl bootstrap "$domain" "$PLIST"
say "loaded $AGENT: $here/guard.mjs at load and every 10 min; $mode"
# The first cycle runs at load: show it.
for _ in $(seq 1 60); do
  if launchctl print "$domain/$AGENT" 2>/dev/null | grep -q 'last exit code = [0-9]'; then break; fi
  sleep 1
done
tail -c +$((seen + 1)) "$log" 2>/dev/null | sed 's/^/  /'
launchctl print "$domain/$AGENT" | grep 'last exit code' | sed 's/^[[:space:]]*/  /'
