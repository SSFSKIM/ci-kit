#!/usr/bin/env python3
"""M4's collector for MAWS on GitHub's hosted Macs (2026-10-26-maws-hosted-mac-design.md, M4).

Reads MAWS's gate runs and maws-app's hosted runs in a window, with their jobs (every attempt), and prints and writes
as JSON: the Mac queue, the hosted share of e2e job-minutes, the hosted queue, and the waiters' minutes, cost and
deadline reds. Python 3 standard library and the caller's `gh` login.

    measure.py --since 2026-10-19T00:00:00Z --until 2026-10-26T00:00:00Z [--json out.json]

A job belongs to the window when it was created in it (half-open, [since, until)), so a rerun counts in the window it
ran in. Runs are listed from --lookback-hours before --since, so a run created just before the window still yields
its jobs created in it.
"""

import argparse
import json
import math
import statistics
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

MAC_RUNNER_PREFIX = "ci-kit-mac-"  # the mini host, ci-kit-mac-mini, and its guest, ci-kit-mac-mini-maws-vm-job-*
DEADLINE_RED = "hosted: no result by"
RUNS_SEARCH_CAP = 1000  # the runs API answers at most this many runs for one `created` query
PER_PAGE = 100


# ---- pure logic ----------------------------------------------------------------------------------------------------

def parse_utc(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def percentile(values, q):
    """Nearest rank: the smallest value with at least q percent of the values at or below it."""
    ordered = sorted(values)
    return ordered[max(0, math.ceil(q / 100 * len(ordered)) - 1)]


def summarize(minutes):
    if not minutes:
        return {"n": 0, "median": None, "p90": None}
    return {"n": len(minutes), "median": round(statistics.median(minutes), 2), "p90": round(percentile(minutes, 90), 2)}


def ran(job):
    """The job got a runner and finished. A job skipped or cancelled in the queue has no runner."""
    return bool(job.get("runner_name")) and bool(job.get("started_at")) and bool(job.get("completed_at"))


def in_window(job, since, until):
    return since <= parse_utc(job["created_at"]) < until


def queue_minutes(job):
    return (parse_utc(job["started_at"]) - parse_utc(job["created_at"])).total_seconds() / 60


def run_minutes(job):
    return max(0.0, (parse_utc(job["completed_at"]) - parse_utc(job["started_at"])).total_seconds() / 60)


def is_mac(job):
    return (job.get("runner_name") or "").startswith(MAC_RUNNER_PREFIX)


def is_waiter(job, waiter_labels):
    """A hosted group's private job: `e2e:<group>` on the waiter's pool box. No other e2e job asks for that box."""
    return job["name"].startswith("e2e:") and sorted(job.get("labels") or []) == sorted(waiter_labels)


def is_app_e2e(job, app_job):
    """maws-app's hosted test job: `<app_job>`, or `<app_job>:<group>` / `<app_job> (<matrix>)` should it be split."""
    name = job["name"]
    return name == app_job or name.startswith(app_job + ":") or name.startswith(app_job + " (")


def is_deadline_red(log_text):
    return DEADLINE_RED in log_text


def failed_waiter_ids(maws_jobs, since, until, waiter_labels):
    """The waiters whose logs may hold a deadline red: those in the window that ran and failed."""
    return [j["id"] for j in maws_jobs
            if in_window(j, since, until) and ran(j) and is_waiter(j, waiter_labels) and j.get("conclusion") == "failure"]


def measure(maws_jobs, app_jobs, deadline_red_ids, *, since, until, spot_rate, waiter_labels, app_job, unread_logs=0):
    maws = [j for j in maws_jobs if in_window(j, since, until) and ran(j)]
    app = [j for j in app_jobs if in_window(j, since, until) and ran(j) and is_app_e2e(j, app_job)]
    mac = [j for j in maws if is_mac(j)]
    waiters = [j for j in maws if is_waiter(j, waiter_labels)]

    hosted_minutes = round(sum(run_minutes(j) for j in app), 2)
    mac_minutes = round(sum(run_minutes(j) for j in mac if j["name"].startswith("e2e:")), 2)
    total = hosted_minutes + mac_minutes
    waiter_minutes = round(sum(run_minutes(j) for j in waiters), 2)
    return {
        "mac_queue": summarize([queue_minutes(j) for j in mac]),
        "hosted_share": {"hosted_minutes": hosted_minutes, "mac_minutes": mac_minutes,
                         "share": round(hosted_minutes / total, 4) if total else None},
        "hosted_queue": summarize([queue_minutes(j) for j in app]),
        "waiters": {"jobs": len(waiters), "minutes": waiter_minutes,
                    "cost_usd": round(waiter_minutes * spot_rate, 4), "spot_rate_usd_per_minute": spot_rate,
                    "deadline_reds": sum(1 for j in waiters if j["id"] in deadline_red_ids),
                    "deadline_red_logs_unread": unread_logs},
    }


def render(out):
    def minutes(x):
        return "n/a" if x is None else f"{x:.1f} min"

    def queue(s):
        return f"{s['n']} jobs, median {minutes(s['median'])}, p90 {minutes(s['p90'])}"

    share, w = out["hosted_share"], out["waiters"]
    pct = "n/a" if share["share"] is None else f"{share['share'] * 100:.1f}%"
    lines = [
        f"mac queue: {queue(out['mac_queue'])}",
        f"hosted share: {pct} of e2e job-minutes (hosted {share['hosted_minutes']:.1f}, "
        f"{MAC_RUNNER_PREFIX}* {share['mac_minutes']:.1f})",
        f"hosted queue: {queue(out['hosted_queue'])}",
        f"waiters: {w['jobs']} jobs, {w['minutes']:.1f} min, ${w['cost_usd']:.2f} at ${w['spot_rate_usd_per_minute']}/min;"
        f" deadline reds {w['deadline_reds']}"
        + (f" ({w['deadline_red_logs_unread']} failed waiters' logs unreadable)" if w["deadline_red_logs_unread"] else ""),
    ]
    return "\n".join(lines)


def chunks(since, until, hours):
    out, a = [], since
    while a < until:
        b = min(a + timedelta(hours=hours), until)
        out.append((a, b))
        a = b
    return out


# ---- GitHub, through gh --------------------------------------------------------------------------------------------

class NotFound(Exception):
    pass


class Gh:
    def __init__(self):
        self.calls = 0
        self._lock = threading.Lock()

    def get(self, path, raw=False):
        with self._lock:
            self.calls += 1
        # A job log holds terminal escapes, which gh refuses to write unless allowed; the text is searched, not printed.
        cmd = ["gh", "api", *(["--allow-escape-sequences"] if raw else []), path]
        for attempt in range(3):  # a week's window is about a thousand calls; one 5xx should not lose them
            p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
            if p.returncode == 0:
                return p.stdout if raw else json.loads(p.stdout)
            if "HTTP 404" in p.stderr:
                raise NotFound(path)
            time.sleep(2 ** attempt)
        raise RuntimeError(f"gh api {path}: {p.stderr.strip()}")

    def pages(self, path, key):
        """Every item under `key`, a page at a time until total_count is reached."""
        items, page = [], 1
        while True:
            body = self.get(f"{path}&per_page={PER_PAGE}&page={page}")
            items += body[key]
            if not body[key] or len(items) >= body["total_count"]:
                return items
            page += 1


def list_runs(gh, repo, workflow, since, until):
    """Runs created in [since, until], a day per query, halved again when a query would reach the API's cap."""
    runs = {}

    def fetch(a, b):
        path = f"repos/{repo}/actions/workflows/{workflow}/runs?created={iso(a)}..{iso(b)}"
        total = gh.get(f"{path}&per_page=1")["total_count"]
        if total >= RUNS_SEARCH_CAP and b - a > timedelta(minutes=10):
            mid = a + (b - a) / 2
            fetch(a, mid)
            fetch(mid, b)
        elif total:
            for r in gh.pages(path, "workflow_runs"):
                runs[r["id"]] = r

    for a, b in chunks(since, until, hours=24):
        fetch(a, b)
    return list(runs.values())


def list_jobs(gh, repo, runs):
    def one(run):
        return gh.pages(f"repos/{repo}/actions/runs/{run['id']}/jobs?filter=all", "jobs")

    with ThreadPoolExecutor(max_workers=4) as pool:
        return [j for jobs in pool.map(one, runs) for j in jobs]


def read_deadline_reds(gh, repo, job_ids):
    reds, unread = set(), 0
    for job_id in job_ids:
        try:
            if is_deadline_red(gh.get(f"repos/{repo}/actions/jobs/{job_id}/logs", raw=True)):
                reds.add(job_id)
        except (NotFound, RuntimeError):
            unread += 1
    return reds, unread


def collect(gh, repo, workflow, since, until, lookback):
    try:
        runs = list_runs(gh, repo, workflow, since - lookback, until)
    except NotFound:
        return [], {"repo": repo, "workflow": workflow, "found": False, "runs": 0, "jobs": 0}
    jobs = list_jobs(gh, repo, runs)
    return jobs, {"repo": repo, "workflow": workflow, "found": True, "runs": len(runs),
                  "jobs": sum(1 for j in jobs if in_window(j, since, until))}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--since", required=True, type=parse_utc, help="window start, UTC ISO 8601")
    ap.add_argument("--until", type=parse_utc, default=None, help="window end, UTC ISO 8601 (default: now)")
    ap.add_argument("--json", dest="json_path", help="where to write the JSON (default: measure-<since>-<until>.json)")
    ap.add_argument("--maws-repo", default="SSFSKIM/MAWS")
    ap.add_argument("--maws-workflow", default="gate.yml")
    ap.add_argument("--app-repo", default="SSFSKIM/maws-app")
    ap.add_argument("--app-workflow", default="hosted-mac.yml")
    ap.add_argument("--app-job", default="e2e", help="maws-app's hosted test job's name")
    ap.add_argument("--waiter-labels", default="self-hosted,ci-kit-pool,cpus-2", help="the waiter's runs-on labels")
    ap.add_argument("--spot-rate", type=float, default=0.0006, help="the waiter box's spot rate, USD per minute")
    ap.add_argument("--lookback-hours", type=float, default=6,
                    help="list runs created this long before --since, for their jobs created in the window")
    args = ap.parse_args(argv)
    until = args.until or datetime.now(timezone.utc).replace(microsecond=0)
    if until <= args.since:
        ap.error("--until must be after --since")
    waiter_labels = [s for s in args.waiter_labels.split(",") if s]
    lookback = timedelta(hours=args.lookback_hours)

    gh = Gh()
    maws_jobs, maws_src = collect(gh, args.maws_repo, args.maws_workflow, args.since, until, lookback)
    app_jobs, app_src = collect(gh, args.app_repo, args.app_workflow, args.since, until, lookback)
    reds, unread = read_deadline_reds(gh, args.maws_repo,
                                      failed_waiter_ids(maws_jobs, args.since, until, waiter_labels))

    out = {"window": {"since": iso(args.since), "until": iso(until)}}
    out.update(measure(maws_jobs, app_jobs, reds, since=args.since, until=until, spot_rate=args.spot_rate,
                       waiter_labels=waiter_labels, app_job=args.app_job, unread_logs=unread))
    out["sources"] = [maws_src, app_src]
    out["params"] = {"app_job": args.app_job, "waiter_labels": waiter_labels, "lookback_hours": args.lookback_hours,
                     "mac_runner_prefix": MAC_RUNNER_PREFIX}
    out["api_calls"] = gh.calls

    stamp = lambda t: t.strftime("%Y%m%dT%H%MZ")
    path = args.json_path or f"measure-{stamp(args.since)}-{stamp(until)}.json"
    with open(path, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")

    print(f"window {out['window']['since']} .. {out['window']['until']}")
    print(render(out))
    for s in out["sources"]:
        print(f"source {s['repo']} {s['workflow']}: "
              + (f"{s['runs']} runs listed, {s['jobs']} jobs in the window" if s["found"] else "no such workflow"))
    print(f"api calls {gh.calls}; json {path}")


if __name__ == "__main__":
    sys.exit(main())
