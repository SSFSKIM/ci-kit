#!/bin/bash
# Sourced by the hooks, the runner's wrapper and the dialog watcher: the lane's instances on this Mac
# (docs/mac-lane.md).
#
# - The exclusive instance: ~/actions-runner-maws, LaunchAgent com.ssfskim.ci-kit.mac-runner, today's labels. Every job
#   it runs runs alone on the desktop.
# - Shared instances n >= 2: ~/actions-runner-maws-<n>, LaunchAgent com.ssfskim.ci-kit.mac-runner-<n>, the one label
#   ci-kit-mac-shared, so only a job that asks for it reaches them. They run beside each other, never beside an
#   exclusive job: the job hooks of both kinds decide under one lock (shared-hold.sh).
#
# Each instance runs its own copy of the hooks, under its own directory, so a hook's instance is the directory its copy
# sits in (<instance>/ci-kit/hooks): the sweep finds its _work the same way.
lane_root=$HOME/actions-runner-maws
lane_agent=com.ssfskim.ci-kit.mac-runner
shared_hold=$HOME/Library/Logs/ci-kit/shared-hold

instance_root() { # <hooks dir>: the instance whose copy of the hooks that is
  (cd "$1/../.." 2>/dev/null && pwd)
}
shared_number() { # <instance root>: prints n for a shared instance; false for the exclusive one (or anything else)
  [[ ${1##*/} =~ ^actions-runner-maws-([1-9][0-9]*)$ ]] && ((BASH_REMATCH[1] >= 2)) && printf '%s\n' "${BASH_REMATCH[1]}"
}
instance_agent() { # <instance root>: its LaunchAgent's label
  local n
  if n=$(shared_number "$1"); then printf '%s-%s\n' "$lane_agent" "$n"; else printf '%s\n' "$lane_agent"; fi
}
instance_title() { # <instance root>: how the logs name it
  local n
  if n=$(shared_number "$1"); then printf 'shared runner %s\n' "$n"; else printf 'the runner\n'; fi
}
on_instance() { # <instance root>: where a log line happened, for a shared instance; nothing for the exclusive one
  local n
  if n=$(shared_number "$1"); then printf ' on shared runner %s\n' "$n"; fi
}
shared_instances() { # the shared instances' roots, by number: every ~/actions-runner-maws-<n> directory, n >= 2
  local dir n
  for dir in "$lane_root"-*; do
    n=$(shared_number "$dir") && [[ -d $dir ]] && printf '%s %s\n' "$n" "$dir"
  done | sort -n | cut -d ' ' -f 2-
}
