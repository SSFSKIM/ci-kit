#!/usr/bin/env python3
"""M4's collector for MAWS on GitHub's hosted Macs (2026-10-26-maws-hosted-mac-design.md, M4).

Reads MAWS's gate runs and maws-app's hosted runs in a window, with their jobs (every attempt), and prints and writes
as JSON: the Mac queue, with the mini's holds and the guest's off time beside it; the hosted share of e2e job-minutes
and the hosted queue, each whole and split by run kind; and the waiters' minutes, cost and deadline reds. Python 3
standard library, the caller's `gh` login, and `ssh` to the mini for its vm-lane.log (or a copy, --vm-lane-log).

    measure.py --since 2026-10-19T00:00:00Z --until 2026-10-26T00:00:00Z [--json out.json]

A job belongs to the window when it was created in it (half-open, [since, until)), so a rerun counts in the window it
ran in. Runs are listed from --lookback-days before --since (default 30, GitHub's limit on re-running a run), and
only the runs updated since --since have their jobs fetched: a run created weeks before and rerun in the window counts.

Run kinds: a run whose ci-gate commit carries `Lane: hosted` or `Lane: no-hosted` (--trial-lanes) is a trial or a
baseline, its placement forced; every other run is a default run, placed by gate.yml's lists (Lane: vm and vm-trial
host what HOSTED_MAC_E2E names, as a run with no lane does). A hosted job takes its private run's kind, through its
request's `MAWS-Run:` trailer.
"""

import argparse
import json
import math
import re
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
KINDS = ("default", "trial")
KIND_LABELS = {"default": "default runs (no Lane:, vm, vm-trial)", "trial": "trials and baselines (Lane: hosted, no-hosted)"}


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


def lane_of(message):
    """The run's `Lane:` trailer as gate-plan reads it: the last one, the key in any case; None when there is none."""
    lanes = [line.strip()[5:].strip().lower() for line in (message or "").split("\n")
             if line.strip().lower().startswith("lane:")]
    return lanes[-1] if lanes else None


def maws_run_of(app_run):
    """The private run a hosted run's request names (`MAWS-Run: <run id>/<attempt>`); None for a hand request."""
    message = (app_run.get("head_commit") or {}).get("message") or ""
    for line in message.split("\n"):
        if line.startswith("MAWS-Run:"):
            run_id = line[len("MAWS-Run:"):].strip().split("/")[0]
            return int(run_id) if run_id.isdigit() else None
    return None


def with_kinds(maws_runs, maws_jobs, app_runs, app_jobs, trial_lanes):
    """Each job with its run's kind (copies; the inputs stay as they were). A hosted job takes its private run's kind;
    one whose request names no listed private run (M1's hand requests) is a trial, and its run counts as unmatched."""
    kind = {r["id"]: "trial" if lane_of((r.get("head_commit") or {}).get("message")) in trial_lanes else "default"
            for r in maws_runs}
    source = {r["id"]: maws_run_of(r) for r in app_runs}
    maws = [dict(j, kind=kind.get(j.get("run_id"), "default")) for j in maws_jobs]
    app = [dict(j, kind=kind.get(source.get(j.get("run_id")), "trial")) for j in app_jobs]
    unmatched = sum(1 for r in app_runs if source[r["id"]] not in kind)
    return maws, app, unmatched


def hosted_share(app, mac):
    hosted_minutes = round(sum(run_minutes(j) for j in app), 2)
    mac_minutes = round(sum(run_minutes(j) for j in mac if j["name"].startswith("e2e:")), 2)
    total = hosted_minutes + mac_minutes
    return {"hosted_minutes": hosted_minutes, "mac_minutes": mac_minutes,
            "share": round(hosted_minutes / total, 4) if total else None}


def measure(maws_jobs, app_jobs, deadline_red_ids, *, since, until, spot_rate, waiter_labels, app_job, unread_logs=0):
    maws = [j for j in maws_jobs if in_window(j, since, until) and ran(j)]
    app = [j for j in app_jobs if in_window(j, since, until) and ran(j) and is_app_e2e(j, app_job)]
    mac = [j for j in maws if is_mac(j)]
    waiters = [j for j in maws if is_waiter(j, waiter_labels)]

    def of(jobs, kind):
        return [j for j in jobs if j.get("kind", "default") == kind]

    waiter_minutes = round(sum(run_minutes(j) for j in waiters), 2)
    return {
        "mac_queue": summarize([queue_minutes(j) for j in mac]),
        "hosted_share": hosted_share(app, mac),
        "hosted_share_by_kind": {k: hosted_share(of(app, k), of(mac, k)) for k in KINDS},
        "hosted_queue": summarize([queue_minutes(j) for j in app]),
        "hosted_queue_by_kind": {k: summarize([queue_minutes(j) for j in of(app, k)]) for k in KINDS},
        "waiters": {"jobs": len(waiters), "minutes": waiter_minutes,
                    "cost_usd": round(waiter_minutes * spot_rate, 4), "spot_rate_usd_per_minute": spot_rate,
                    "deadline_reds": sum(1 for j in waiters if j["id"] in deadline_red_ids),
                    "deadline_red_logs_unread": unread_logs},
    }


# ---- the mini's holds and the guest's off time ---------------------------------------------------------------------

def union(intervals):
    out = []
    for a, b in sorted(i for i in intervals if i[1] > i[0]):
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def clip(intervals, since, until):
    return [(max(a, since), min(b, until)) for a, b in intervals if b > since and a < until]


def minutes(intervals):
    return round(sum((b - a).total_seconds() for a, b in union(intervals)) / 60, 2)


def overlap_minutes(xs, ys):
    xs, ys = union(xs), union(ys)
    return minutes([(max(a, c), min(b, d)) for a, b in xs for c, d in ys if min(b, d) > max(a, c)])


def waiting_intervals(jobs, wants):
    """When each job whose labels `wants` waited in the queue: created to started, or to its cancel if it never ran."""
    out = []
    for j in jobs:
        if not wants(j.get("labels") or []):
            continue
        end = j.get("started_at") if j.get("runner_name") else j.get("completed_at")
        if end and parse_utc(end) > parse_utc(j["created_at"]):
            out.append((parse_utc(j["created_at"]), parse_utc(end)))
    return out


def wants_host(labels, guest_labels):
    """A job the host's hold keeps waiting: one for a Mac that does not ask for the guest alone."""
    mac = "macOS" in labels or any(label.startswith(MAC_RUNNER_PREFIX) for label in labels)
    return mac and not set(labels) <= set(guest_labels)


def off_reason(reason):
    """A no-boot reason with its numbers and detail dropped, so one cause sums as one row."""
    held = re.match(r"([^:\s]+): \w+ since ", reason)
    if held:
        return f"held: {held[1]}"
    return re.sub(r"\d+", "N", re.split(r": | \(", reason)[0])


def guest_off_intervals(log_text, log_end):
    """vm-lane.log's lane states as (from, to, reason) for the times the guest could not boot. The log writes a state
    when it changes, so a state lasts to the next state line; a no-boot for want of a queued job is idle, not off, and a
    stopped lane is off until it starts again."""
    states = []
    for line in log_text.splitlines():
        stamp, _, rest = line.partition(" vm-lane ")
        if not rest:
            continue
        if rest.startswith("no boot: no queued job for the guest"):
            state = None
        elif rest.startswith("no boot: "):
            state = off_reason(rest[len("no boot: "):])
        elif rest.startswith("stopping on SIGTERM"):
            state = "lane stopped"
        elif rest.startswith(("booting ", "starting ")):
            state = None
        else:
            continue  # a guest's own lines and the lane's notes leave the state as it was
        states.append((parse_utc(stamp), state))
    ends = [t for t, _ in states[1:]] + [log_end]
    return [(t, end, state) for (t, state), end in zip(states, ends) if state and end > t]


def mini_report(issues, log_text, maws_jobs, *, since, until, now, hold_prefix, guest_labels, log_source):
    """The minutes the mini's host was held (its alert issues, open to closed) and its guest off (vm-lane.log), within
    the window, each also counted only while a job that wanted that desktop was queued."""
    mac_waits = waiting_intervals(maws_jobs, lambda labels: wants_host(labels, guest_labels))
    held = sorted((i for i in issues if i["title"].startswith(hold_prefix) and "pull_request" not in i),
                  key=lambda i: i["created_at"])
    spans = [(i, parse_utc(i["created_at"]), parse_utc(i["closed_at"]) if i["closed_at"] else now) for i in held]
    spans = [(i, a, b) for i, a, b in spans if b > since and a < until]
    hold_iv = clip([(a, b) for _, a, b in spans], since, until)
    holds = {"minutes": minutes(hold_iv), "minutes_with_host_job_queued": overlap_minutes(hold_iv, mac_waits),
             "issues": [{"number": i["number"], "title": i["title"], "from": i["created_at"], "to": i["closed_at"]}
                        for i, _, _ in spans]}

    guest = {"source": log_source, "log_from": None, "minutes": None, "minutes_with_guest_job_queued": None,
             "by_reason": {},
             "note": "minutes counts idle minutes too (no guest job queued); minutes_with_guest_job_queued does not"}
    if log_text is not None:
        first = next((line.split(" ", 1)[0] for line in log_text.splitlines() if " vm-lane " in line), None)
        off = [(a, b, r) for a, b, r in guest_off_intervals(log_text, min(now, until)) if b > since and a < until]
        off_iv = clip([(a, b) for a, b, _ in off], since, until)
        by_reason = {}
        for a, b, reason in off:
            by_reason[reason] = round(by_reason.get(reason, 0) + minutes(clip([(a, b)], since, until)), 2)
        guest_waits = waiting_intervals(maws_jobs, lambda labels: any(label in guest_labels for label in labels))
        guest.update(log_from=first, minutes=minutes(off_iv), by_reason=by_reason,
                     minutes_with_guest_job_queued=overlap_minutes(off_iv, guest_waits))
    return {"holds": holds, "guest_off": guest}


def render(out):
    def mins(x):
        return "n/a" if x is None else f"{x:.1f} min"

    def queue(s):
        return f"{s['n']} jobs, median {mins(s['median'])}, p90 {mins(s['p90'])}"

    def share(s):
        pct = "n/a" if s["share"] is None else f"{s['share'] * 100:.1f}%"
        return f"{pct} of e2e job-minutes (hosted {s['hosted_minutes']:.1f}, {MAC_RUNNER_PREFIX}* {s['mac_minutes']:.1f})"

    lines = [f"mac queue: {queue(out['mac_queue'])}"]
    if "mini" in out:
        holds, guest = out["mini"]["holds"], out["mini"]["guest_off"]
        alerts = ", ".join(f"#{i['number']}" for i in holds["issues"]) or "none"
        lines.append(f"  mini held: {mins(holds['minutes'])}, {mins(holds['minutes_with_host_job_queued'])} of them with "
                     f"a host job queued (alerts {alerts})")
        if guest["minutes"] is None:
            lines.append(f"  guest off: n/a ({guest['source']})")
        else:
            lines.append(f"  guest off: {mins(guest['minutes'])} counting idle minutes, "
                         f"{mins(guest['minutes_with_guest_job_queued'])} with a guest-lane job queued "
                         f"(vm-lane.log from {guest['log_from']}, {guest['source']})")
            for reason, m in sorted(guest["by_reason"].items(), key=lambda kv: -kv[1]):
                lines.append(f"    {m:8.1f} min  {reason}")
    lines.append(f"hosted share: {share(out['hosted_share'])}")
    lines += [f"  {KIND_LABELS[k]}: {share(out['hosted_share_by_kind'][k])}" for k in KINDS]
    lines.append(f"hosted queue: {queue(out['hosted_queue'])}")
    lines += [f"  {KIND_LABELS[k]}: {queue(out['hosted_queue_by_kind'][k])}" for k in KINDS]
    w = out["waiters"]
    lines.append(
        f"waiters: {w['jobs']} jobs, {w['minutes']:.1f} min, ${w['cost_usd']:.2f} at ${w['spot_rate_usd_per_minute']}/min;"
        f" deadline reds {w['deadline_reds']}"
        + (f" ({w['deadline_red_logs_unread']} failed waiters' logs unreadable)" if w["deadline_red_logs_unread"] else ""))
    return "\n".join(lines)


def chunks(since, until, hours):
    out, a = [], since
    while a < until:
        b = min(a + timedelta(hours=hours), until)
        out.append((a, b))
        a = b
    return out


# ---- GitHub, through gh; the mini, through ssh ---------------------------------------------------------------------

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

    def list_pages(self, path):
        """Every item of a listing that answers a bare array, a page at a time until a short page."""
        items, page = [], 1
        while True:
            body = self.get(f"{path}&per_page={PER_PAGE}&page={page}")
            items += body
            if len(body) < PER_PAGE:
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
    """The runs updated since `since` (created up to `lookback` before it) and all their jobs."""
    try:
        listed = list_runs(gh, repo, workflow, since - lookback, until)
    except NotFound:
        return [], [], {"repo": repo, "workflow": workflow, "found": False, "runs_listed": 0, "runs": 0, "jobs": 0}
    # A run last updated before the window has no job in it; the listing is a page per 100 runs, the jobs a call per run.
    runs = [r for r in listed if parse_utc(r["updated_at"]) >= since]
    jobs = list_jobs(gh, repo, runs)
    return runs, jobs, {"repo": repo, "workflow": workflow, "found": True, "runs_listed": len(listed),
                        "runs": len(runs), "jobs": sum(1 for j in jobs if in_window(j, since, until))}


def list_hold_issues(gh, repo, since):
    """The issues touched since `since` (a hold closed in the window was), and every open one (a hold still on)."""
    issues = {i["number"]: i for i in gh.list_pages(f"repos/{repo}/issues?state=all&since={iso(since)}")}
    issues.update({i["number"]: i for i in gh.list_pages(f"repos/{repo}/issues?state=open")})
    return list(issues.values())


def read_vm_lane_log(path, host):
    """The guest lane's log: a local copy when given, else `cat` over ssh. (text or None, how it was read)."""
    if path:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(), f"file {path}"
    remote = "~/Library/Logs/ci-kit/vm-lane.log"
    p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, f"cat {remote}"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        return None, f"unread: ssh {host}: {p.stderr.strip() or f'exit {p.returncode}'}"
    return p.stdout, f"ssh {host} cat {remote}"


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
    ap.add_argument("--lookback-days", type=float, default=30,
                    help="list runs created this long before --since, for reruns in the window (GitHub's re-run limit)")
    ap.add_argument("--trial-lanes", default="hosted,no-hosted",
                    help="the Lane: values that make a run a trial or a baseline")
    ap.add_argument("--holds-repo", default="SSFSKIM/ci-kit-sandbox", help="where ci-kit files the mini's alerts")
    ap.add_argument("--hold-title", default="ci-kit alert: mini:", help="the title prefix of a mini alert")
    ap.add_argument("--guest-labels", default="ci-kit-mac-vm,ci-kit-mac-vm-trial",
                    help="the labels of a job that waits for the guest (the MAC_VM_E2E lane and its trial slot)")
    ap.add_argument("--vm-lane-log", help="a copy of the mini's ~/Library/Logs/ci-kit/vm-lane.log (default: read over ssh)")
    ap.add_argument("--mini-host", default="mini", help="the ssh host the log is read from")
    args = ap.parse_args(argv)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    until = args.until or now
    if until <= args.since:
        ap.error("--until must be after --since")
    split = lambda s: [x for x in s.split(",") if x]
    waiter_labels = split(args.waiter_labels)
    lookback = timedelta(days=args.lookback_days)

    gh = Gh()
    maws_runs, maws_jobs, maws_src = collect(gh, args.maws_repo, args.maws_workflow, args.since, until, lookback)
    app_runs, app_jobs, app_src = collect(gh, args.app_repo, args.app_workflow, args.since, until, lookback)
    maws_jobs, app_jobs, unmatched = with_kinds(maws_runs, maws_jobs, app_runs, app_jobs, split(args.trial_lanes))
    app_src["runs_without_a_listed_private_run"] = unmatched
    reds, unread = read_deadline_reds(gh, args.maws_repo,
                                      failed_waiter_ids(maws_jobs, args.since, until, waiter_labels))
    issues = list_hold_issues(gh, args.holds_repo, args.since)
    log_text, log_source = read_vm_lane_log(args.vm_lane_log, args.mini_host)

    out = {"window": {"since": iso(args.since), "until": iso(until)}}
    out.update(measure(maws_jobs, app_jobs, reds, since=args.since, until=until, spot_rate=args.spot_rate,
                       waiter_labels=waiter_labels, app_job=args.app_job, unread_logs=unread))
    out["mini"] = mini_report(issues, log_text, maws_jobs, since=args.since, until=until, now=now,
                              hold_prefix=args.hold_title, guest_labels=split(args.guest_labels),
                              log_source=log_source)
    out["sources"] = [maws_src, app_src]
    out["params"] = {"app_job": args.app_job, "waiter_labels": waiter_labels, "lookback_days": args.lookback_days,
                     "mac_runner_prefix": MAC_RUNNER_PREFIX, "trial_lanes": split(args.trial_lanes),
                     "holds_repo": args.holds_repo, "hold_title": args.hold_title,
                     "guest_labels": split(args.guest_labels)}
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
              + (f"{s['runs_listed']} runs listed, {s['runs']} updated since --since, {s['jobs']} jobs in the window"
                 if s["found"] else "no such workflow"))
    if unmatched:
        print(f"  {unmatched} hosted runs name no listed private run (hand requests), counted as trials")
    print(f"api calls {gh.calls}; json {path}")


if __name__ == "__main__":
    sys.exit(main())
