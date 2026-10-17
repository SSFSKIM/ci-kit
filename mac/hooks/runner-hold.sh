#!/bin/bash
# The program of the runner's LaunchAgent (docs/mac-lane.md): it runs the runner's own service wrapper, runsvc.sh, from
# the runner's directory (the agent's working directory), unless the dialog watcher holds the runner. The watcher's
# marker exists while a system dialog episode is open; this waits until it is gone, then starts the runner. The watcher
# stops an idle runner with SIGTERM, KeepAlive starts this again, and it waits; RunAtLoad after a reboot or login does
# the same, so nothing but the marker's removal brings a held runner back.
#
# Only a marker that is not there (ENOENT, a missing directory included) releases the runner. One that cannot be looked
# up, behind a directory that is not searchable for instance, holds it as the marker would, and the reason is logged.
#
# exec keeps this process, /bin/bash, which launchd started: the responsible process of every job stays /bin/bash.
marker=$HOME/Library/Logs/ci-kit/runner-drained
said=
while :; do
  # 0: the marker is there; 1: it is not; anything else: the lookup failed, and perl prints why.
  why=$(perl -e 'exit 0 if lstat $ARGV[0]; exit 1 if $!{ENOENT}; print "$!"; exit 2' "$marker" 2>&1)
  case $? in
    1) break ;;
    0) why="held by the dialog watcher ($(head -1 "$marker" 2>/dev/null))" ;;
    *) why="cannot tell whether the dialog watcher holds it ($marker: ${why:-the lookup failed}), so held as if it does" ;;
  esac
  if [[ $why != "$said" ]]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) runner-hold: $why; waiting"
    said=$why
  fi
  sleep "${CI_KIT_HOLD_POLL:-5}"
done
[[ -z $said ]] || echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) runner-hold: released; starting the runner"
exec ./runsvc.sh
