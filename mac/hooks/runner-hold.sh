#!/bin/bash
# The program of the runner's LaunchAgent (docs/mac-lane.md): it runs the runner's own service wrapper, runsvc.sh, from
# the runner's directory (the agent's working directory), unless the dialog watcher holds the runner. The watcher's
# marker exists while a system dialog episode is open; this waits until it is gone, then starts the runner. The watcher
# stops an idle runner with SIGTERM, KeepAlive starts this again, and it waits; RunAtLoad after a reboot or login does
# the same, so nothing but the marker's removal brings a held runner back.
#
# exec keeps this process, /bin/bash, which launchd started: the responsible process of every job stays /bin/bash.
marker=$HOME/Library/Logs/ci-kit/runner-drained
held=
while [[ -e $marker ]]; do
  if [[ -z $held ]]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) runner-hold: held by the dialog watcher ($(head -1 "$marker" 2>/dev/null)); waiting"
    held=1
  fi
  sleep "${CI_KIT_HOLD_POLL:-5}"
done
[[ -z $held ]] || echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) runner-hold: released; starting the runner"
exec ./runsvc.sh
