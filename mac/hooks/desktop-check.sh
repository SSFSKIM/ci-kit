#!/bin/bash
# Part of the mac runner's job-started hook: refuse a job at once when a system dialog holds focus on the mini's
# desktop. An e2e job under a modal alert fails group after group on focus and pasteboard (2026-10-16: seven groups
# red, UserNotificationCenter frontmost), so the job is failed with what to do instead.
#
# The frontmost app is read with lsappinfo alone: AppleScript or System Events would raise TCC prompts on the mini.
# When it cannot be read, the job is not blocked; the miss is logged.
set -uo pipefail

log() {
  mkdir -p "$HOME/Library/Logs/ci-kit"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) desktop-check run=${GITHUB_RUN_ID:--} job=${GITHUB_JOB:--} $*" |
    tee -a "$HOME/Library/Logs/ci-kit/mac-runner-hooks.log"
}

# `lsappinfo info -only name` prints either `"LSDisplayName"="<name>"` or, on macOS 27, `"<name>" ASN:0x…: …`.
info=$(lsappinfo info -only name "$(lsappinfo front 2>/dev/null)" 2>/dev/null) || info=''
name=$(sed -n -E 's/^"LSDisplayName"="(.*)"$/\1/p; s/^"([^"]*)" ASN:.*/\1/p' <<<"$info" | head -1)
if [[ -z $name ]]; then
  log "could not read the frontmost app (lsappinfo printed: ${info:-nothing}); not blocking the job"
  exit 0
fi

case $name in
  UserNotificationCenter | CoreServicesUIAgent | SecurityAgent | loginwindow)
    log "frontmost is $name: a system dialog holds focus; failing the job"
    echo "ci-kit: a system dialog ($name) holds focus on the mini — dismiss it there and rerun" >&2
    exit 1
    ;;
esac
log "frontmost is $name"
