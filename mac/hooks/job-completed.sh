#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_COMPLETED of the mac runner (I10): after a job, kill and log what it left under the runner's
# work directory, the orphaned test processes that once loaded the MacBook. Before that, it hands the job's end to the
# dialog watcher's drain (dialog-watch.sh --job-end), which stops the runner once the job is over if the watcher holds
# it, so a held runner takes no job after this one.
#
# This hook runs inside the job's Runner.Worker, as the job's last step and before the worker reports the job's result.
# So it never stops the runner itself: the listener would cancel the job, marked "The runner has received a shutdown
# signal", and the service wrapper would kill the listener 30 s later. It leaves the drain a process detached from the
# job instead, which waits for the worker to exit: in its own session, outside the workspace (the sweep spares it),
# without the job's RUNNER_TRACKING_ID (the worker kills every process left carrying it) and without this hook's output
# (the worker waits up to 5 s for it to close).
here=$(dirname "$0")
"$here/desktop-posture.sh" end || true
{
  [[ $here == /* ]] || here=$PWD/$here
  logs=$HOME/Library/Logs/ci-kit
  mkdir -p "$logs"
  (cd / && exec perl -MPOSIX=setsid -e 'setsid(); exec { $ARGV[0] } @ARGV; exit 127' \
    env -u RUNNER_TRACKING_ID /bin/bash "$here/dialog-watch.sh" --job-end "$PPID") \
    </dev/null >/dev/null 2>>"$logs/dialog-watch.err.log" &
} || true
exec node "$here/sweep.mjs" job-completed
