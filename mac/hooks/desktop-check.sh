#!/bin/bash
# Part of the mac runner's job-started hook: make the mini's desktop the same before every job.
#
# - A system dialog in front refuses the job at once. An e2e job under a modal alert fails group after group on focus
#   and pasteboard (2026-10-16: seven groups red, UserNotificationCenter frontmost). Dialogs are the human's to dismiss;
#   this never tries to clear one.
# - Finder in front, where focus falls when the last job's e2e app quits, is replaced by Terminal: some of MAWS's paste
#   and to-human results depend on the app in front, so every job starts from the same one. `open -a Terminal` goes
#   through LaunchServices (no Apple Events, no Automation consent); the job fails fast if Terminal is not in front
#   within about 5 s. It acts only before the job, so MAWS's own MAWS_E2E_FOREGROUND=1 is never fought.
#
# The frontmost app is read with lsappinfo alone: AppleScript or System Events would raise TCC prompts on the mini.
# When it cannot be read, the job is not blocked; the miss is logged.
set -uo pipefail

log() {
  mkdir -p "$HOME/Library/Logs/ci-kit"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) desktop-check run=${GITHUB_RUN_ID:--} job=${GITHUB_JOB:--} $*" |
    tee -a "$HOME/Library/Logs/ci-kit/mac-runner-hooks.log"
}

# `lsappinfo info -only name -only bundleid` prints `"LSDisplayName"="<name>"` and `"CFBundleIdentifier"="<id>"`, or,
# on macOS 27, `"<name>" ASN:0x…: …` and `bundleID="<id>"`. The name is localized (Terminal is `터미널` on the mini), so
# Finder and Terminal are told by bundle id, and by name only where no bundle id is printed.
read_front() {
  local info
  info=$(lsappinfo info -only name -only bundleid "$(lsappinfo front 2>/dev/null)" 2>/dev/null) || info=''
  name=$(sed -n -E 's/^"LSDisplayName"="(.*)"$/\1/p; s/^"([^"]*)" ASN:.*/\1/p' <<<"$info" | head -1)
  bundle=$(sed -n -E 's/^"CFBundleIdentifier"="(.*)"$/\1/p; s/^[[:space:]]*bundleID="([^"]*)".*/\1/p' <<<"$info" | head -1)
}
is_app() { # <bundle id> <name>: whether the frontmost app read last is that app
  [[ $bundle == "$1" || (-z $bundle && $name == "$2") ]]
}

read_front
if [[ -z $name ]]; then
  log "could not read the frontmost app; not blocking the job"
  exit 0
fi

case $name in
  UserNotificationCenter | CoreServicesUIAgent | SecurityAgent | loginwindow)
    log "frontmost is $name: a system dialog holds focus; failing the job"
    echo "ci-kit: a system dialog ($name) holds focus on the mini — dismiss it there and rerun" >&2
    exit 1
    ;;
esac

if ! is_app com.apple.finder Finder; then
  log "frontmost is $name"
  exit 0
fi

before=$name
if ! open -a Terminal; then
  log "frontmost before=$before; open -a Terminal failed; failing the job"
  echo "ci-kit: could not open Terminal on the mini ($before is in front) — check its desktop and rerun" >&2
  exit 1
fi
for _ in 1 2 3 4 5 6 7 8 9 10; do
  read_front
  is_app com.apple.Terminal Terminal && break
  sleep 0.5
done
log "frontmost before=$before after=${name:-unreadable}"
if [[ -z $name ]]; then
  log "could not read the frontmost app after opening Terminal; not blocking the job"
elif ! is_app com.apple.Terminal Terminal; then
  echo "ci-kit: Terminal did not come to the front on the mini ($name is) — check its desktop and rerun" >&2
  exit 1
fi
