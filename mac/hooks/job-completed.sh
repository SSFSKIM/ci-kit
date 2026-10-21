#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_COMPLETED of every instance of the mac lane (I10): after a job, kill and log what it left under the runner's
# work directory, the orphaned test processes that once loaded the MacBook. Before that, it hands the job's end to the
# dialog watcher's drain (dialog-watch.sh --job-end), which stops the runner once the job is over if the watcher holds
# it, so a held runner takes no job after this one.
#
# This hook runs inside the job's Runner.Worker, as the job's last step and before the worker reports the job's result.
# So it never stops the runner itself: the listener would cancel the job, marked "The runner has received a shutdown
# signal", and the service wrapper would kill the listener 30 s later. It leaves the drain a process detached from the
# job instead, which waits for the worker to exit: in its own session, outside the workspace (the sweep spares it),
# without the job's RUNNER_TRACKING_ID (the worker kills every process left carrying it) and without this hook's output
# (the worker waits up to 5 s for it to close). The hook returns once that process is watching the worker, so the
# worker cannot exit unseen, and after 5 s at most: the job's end is never held up by the drain.
here=$(dirname "$0")
"$here/desktop-posture.sh" end || true
{
  [[ $here == /* ]] || here=$PWD/$here
  logs=$HOME/Library/Logs/ci-kit
  mkdir -p "$logs"
  ready=$(mktemp "${TMPDIR:-/tmp}/ci-kit-job-end.XXXXXX") || ready=
  (cd / && exec perl -MPOSIX=setsid -e 'setsid(); exec { $ARGV[0] } @ARGV; exit 127' \
    env -u RUNNER_TRACKING_ID /bin/bash "$here/dialog-watch.sh" --job-end "$PPID" "$ready") \
    </dev/null >/dev/null 2>>"$logs/dialog-watch.err.log" &
  waiter=$!
  for ((tries = 0; tries < 100 && ${#ready} > 0; tries++)); do
    [[ ! -s $ready ]] && kill -0 "$waiter" 2>/dev/null || break
    sleep 0.05
  done
  [[ -z $ready ]] || rm -f "$ready"
} || true
# On a Mac with shared instances, the job's admission (shared-hold.sh) goes once its sweep has gone through: the
# exclusive instance's hold, or a shared instance's running marker. After a failed sweep the exclusive hold stays up, so
# no shared job starts beside what the job left, and the dialog watcher reconciles it; a shared marker goes stale with
# its worker, and the next exclusive job's sweep tries again.
# shellcheck source=instances.sh
source "$here/instances.sh"
if [[ -n $(shared_instances) ]]; then
  lane=exclusive
  if shared_number "$(instance_root "$here")" >/dev/null; then lane=shared; fi
  node "$here/sweep.mjs" job-completed || exit
  "$here/shared-hold.sh" "$lane-end" "$PPID" || true
  exit 0
fi
exec node "$here/sweep.mjs" job-completed
