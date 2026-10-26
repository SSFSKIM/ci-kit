"""Tests for measure.py's pure logic. Run: python3 -m unittest discover -s <this directory>"""

import unittest
from datetime import datetime, timedelta, timezone

import measure

UTC = timezone.utc
SINCE = datetime(2026, 10, 19, tzinfo=UTC)
UNTIL = datetime(2026, 10, 26, tzinfo=UTC)
WAITER = ["self-hosted", "ci-kit-pool", "cpus-2"]


def job(name, runner="ci-kit-mac-mini", labels=("self-hosted", "macOS", "ARM64"), created="2026-10-20T10:00:00Z",
        queued_min=0, ran_min=0, conclusion="success", id_=1, run_id=None):
    created_at = measure.parse_utc(created)
    started = created_at.timestamp() + queued_min * 60
    completed = started + ran_min * 60
    iso = lambda t: datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"id": id_, "run_id": run_id, "name": name, "runner_name": runner, "labels": list(labels), "conclusion": conclusion,
            "created_at": created, "started_at": iso(started), "completed_at": iso(completed)}


def skipped(name, labels=("self-hosted", "macOS", "ARM64")):
    t = "2026-10-20T10:00:00Z"
    return {"id": 9, "name": name, "runner_name": None, "labels": list(labels), "conclusion": "skipped",
            "created_at": t, "started_at": t, "completed_at": t}


def run(maws=(), app=(), reds=(), spot_rate=0.0006):
    return measure.measure(list(maws), list(app), set(reds), since=SINCE, until=UNTIL, spot_rate=spot_rate,
                           waiter_labels=WAITER, app_job="e2e")


class Percentiles(unittest.TestCase):
    def test_median_odd_and_even(self):
        self.assertEqual(measure.summarize([3, 1, 2]), {"n": 3, "median": 2, "p90": 3})
        self.assertEqual(measure.summarize([1, 2, 3, 4])["median"], 2.5)

    def test_p90_is_nearest_rank(self):
        values = list(range(1, 11))  # 1..10: rank ceil(9) = 9
        self.assertEqual(measure.percentile(values, 90), 9)
        self.assertEqual(measure.percentile(list(range(1, 21)), 90), 18)
        self.assertEqual(measure.percentile([5], 90), 5)
        self.assertEqual(measure.percentile([4, 1, 3, 2], 90), 4)

    def test_empty(self):
        self.assertEqual(measure.summarize([]), {"n": 0, "median": None, "p90": None})


class Classification(unittest.TestCase):
    def test_mac_is_host_and_guest_by_runner_name(self):
        self.assertTrue(measure.is_mac(job("e2e:x", runner="ci-kit-mac-mini")))
        self.assertTrue(measure.is_mac(job("e2e:x", runner="ci-kit-mac-mini-maws-vm-job-vm-20261025T224551Z")))
        self.assertFalse(measure.is_mac(job("unit", runner="ci-kit-ec2-abc12", labels=WAITER)))
        self.assertFalse(measure.is_mac(skipped("packaged")))

    def test_waiter_is_an_e2e_job_on_the_waiter_box(self):
        self.assertTrue(measure.is_waiter(job("e2e:document-app", runner="ci-kit-ec2-x", labels=WAITER), WAITER))
        self.assertTrue(measure.is_waiter(
            job("e2e:document-app", runner="ci-kit-ec2-x", labels=reversed(WAITER)), WAITER))
        # probes runs on the same box but is no waiter; desk-web (POOL_E2E) runs e2e on cpus-4.
        self.assertFalse(measure.is_waiter(job("probes", runner="ci-kit-ec2-x", labels=WAITER), WAITER))
        self.assertFalse(measure.is_waiter(job("e2e:desk-web", runner="ci-kit-ec2-x",
                                               labels=["self-hosted", "ci-kit-pool", "cpus-4"]), WAITER))

    def test_app_e2e_job_by_name(self):
        self.assertTrue(measure.is_app_e2e(job("e2e", runner="GitHub Actions 1", labels=["macos-26"]), "e2e"))
        self.assertTrue(measure.is_app_e2e(job("e2e:document-app", labels=["macos-26"]), "e2e"))
        self.assertTrue(measure.is_app_e2e(job("e2e (3)", labels=["macos-26"]), "e2e"))
        self.assertFalse(measure.is_app_e2e(job("e2e-build"), "e2e"))
        self.assertFalse(measure.is_app_e2e(job("result", labels=["ubuntu-latest"]), "e2e"))

    def test_ran_needs_a_runner(self):
        self.assertTrue(measure.ran(job("e2e:x", conclusion="cancelled")))
        self.assertFalse(measure.ran(skipped("e2e:x")))
        cancelled_in_queue = dict(skipped("e2e:x"), conclusion="cancelled")
        self.assertFalse(measure.ran(cancelled_in_queue))
        in_progress = dict(job("e2e:x"), completed_at=None, conclusion=None)
        self.assertFalse(measure.ran(in_progress))

    def test_window_is_by_job_creation_half_open(self):
        self.assertTrue(measure.in_window(job("x", created="2026-10-19T00:00:00Z"), SINCE, UNTIL))
        self.assertFalse(measure.in_window(job("x", created="2026-10-26T00:00:00Z"), SINCE, UNTIL))
        self.assertFalse(measure.in_window(job("x", created="2026-10-18T23:59:59Z"), SINCE, UNTIL))

    def test_deadline_red_line(self):
        log = "2026-10-26T03:00:00.1Z hosted: no result by 2026-10-26T03:00:00Z: the hosted job was still queued\n"
        self.assertTrue(measure.is_deadline_red(log))
        self.assertFalse(measure.is_deadline_red("hosted: failure https://github.com/x\n"))


class Measure(unittest.TestCase):
    def test_empty_window(self):
        out = run()
        self.assertEqual(out["mac_queue"], {"n": 0, "median": None, "p90": None})
        self.assertEqual(out["hosted_queue"], {"n": 0, "median": None, "p90": None})
        self.assertIsNone(out["hosted_share"]["share"])
        self.assertEqual(out["waiters"]["minutes"], 0)
        self.assertEqual(out["waiters"]["cost_usd"], 0)
        self.assertEqual(out["waiters"]["deadline_reds"], 0)
        self.assertIn("n/a", measure.render(out))

    def test_mac_queue_counts_every_mac_job_that_ran(self):
        out = run(maws=[
            job("e2e:a", queued_min=10, ran_min=5),
            job("unit:darwin", queued_min=30, ran_min=5),
            job("e2e:b", runner="ci-kit-mac-mini-maws-vm-job-vm-1", queued_min=20, ran_min=5),
            job("static", runner="ci-kit-ec2-a", labels=["self-hosted", "ci-kit-pool", "cpus-16"], queued_min=99),
            skipped("packaged"),
            job("e2e:late", queued_min=99, created="2026-10-26T00:00:01Z"),
        ])
        self.assertEqual(out["mac_queue"], {"n": 3, "median": 20, "p90": 30})

    def test_hosted_share_counts_e2e_minutes_not_waiters(self):
        out = run(
            maws=[
                job("e2e:a", ran_min=30),                         # Mac e2e: counted
                job("unit:darwin", ran_min=100),                  # Mac, not e2e: not counted
                job("e2e:b", runner="ci-kit-ec2-x", labels=WAITER, ran_min=12),   # waiter: not counted
                job("e2e:desk-web", runner="ci-kit-ec2-y", labels=["self-hosted", "ci-kit-pool", "cpus-4"],
                    ran_min=40),                                  # pool e2e: not counted
            ],
            app=[
                job("e2e", runner="GitHub Actions 7", labels=["macos-26"], queued_min=4, ran_min=10),
                job("plan", runner="GitHub Actions 8", labels=["ubuntu-latest"], ran_min=50),
                dict(skipped("e2e", labels=["macos-26"]), conclusion="cancelled"),
            ])
        self.assertEqual(out["hosted_share"], {"hosted_minutes": 10, "mac_minutes": 30, "share": 0.25})
        self.assertEqual(out["hosted_queue"], {"n": 1, "median": 4, "p90": 4})

    def test_waiters_minutes_cost_and_deadline_reds(self):
        out = run(maws=[
            job("e2e:a", runner="ci-kit-ec2-x", labels=WAITER, ran_min=50, id_=11),
            job("e2e:b", runner="ci-kit-ec2-y", labels=WAITER, ran_min=95, conclusion="failure", id_=12),
            job("e2e:c", runner="ci-kit-ec2-z", labels=WAITER, ran_min=5, conclusion="failure", id_=13),
        ], reds={12})
        self.assertEqual(out["waiters"]["jobs"], 3)
        self.assertEqual(out["waiters"]["minutes"], 150)
        self.assertAlmostEqual(out["waiters"]["cost_usd"], 0.09)
        self.assertEqual(out["waiters"]["deadline_reds"], 1)

    def test_failed_waiters_are_the_ones_whose_logs_are_read(self):
        maws = [
            job("e2e:a", runner="ci-kit-ec2-x", labels=WAITER, conclusion="success", id_=1),
            job("e2e:b", runner="ci-kit-ec2-x", labels=WAITER, conclusion="failure", id_=2),
            job("e2e:c", runner="ci-kit-mac-mini", conclusion="failure", id_=3),
            job("e2e:d", runner="ci-kit-ec2-x", labels=WAITER, conclusion="failure", id_=4,
                created="2026-10-27T00:00:00Z"),
        ]
        self.assertEqual(measure.failed_waiter_ids(maws, SINCE, UNTIL, WAITER), [2])


class FakeGh:
    """The two run and job listings collect() reads, answered from fixtures; records which runs' jobs were fetched."""

    def __init__(self, runs, jobs):
        self.runs, self.jobs, self.jobs_fetched = runs, jobs, []

    def _created(self, path):
        a, b = path.split("created=")[1].split("&")[0].split("..")
        a, b = measure.parse_utc(a), measure.parse_utc(b)
        return [r for r in self.runs if a <= measure.parse_utc(r["created_at"]) <= b]

    def get(self, path, raw=False):
        return {"total_count": len(self._created(path))}

    def pages(self, path, key):
        if key == "workflow_runs":
            return self._created(path)
        run_id = int(path.split("/runs/")[1].split("/")[0])
        self.jobs_fetched.append(run_id)
        return self.jobs[run_id]


class Collect(unittest.TestCase):
    def test_a_run_created_days_before_and_rerun_in_the_window_is_counted(self):
        old_rerun = {"id": 1, "created_at": "2026-10-14T09:00:00Z", "updated_at": "2026-10-20T11:00:00Z"}
        old_untouched = {"id": 2, "created_at": "2026-10-14T09:00:00Z", "updated_at": "2026-10-14T10:00:00Z"}
        gh = FakeGh([old_rerun, old_untouched], {
            1: [job("e2e:a", created="2026-10-14T09:00:05Z", id_=10),
                job("e2e:a", created="2026-10-20T10:00:00Z", queued_min=7, ran_min=5, id_=11)],
            2: [job("e2e:b", created="2026-10-14T09:00:05Z", id_=20)],
        })
        runs, jobs, src = measure.collect(gh, "o/r", "gate.yml", SINCE, UNTIL, timedelta(days=7))
        self.assertEqual([r["id"] for r in runs], [1])
        self.assertEqual(gh.jobs_fetched, [1])
        self.assertEqual(src["jobs"], 1)
        self.assertEqual(run(maws=jobs)["mac_queue"], {"n": 1, "median": 7, "p90": 7})


def maws_run(id_, lane=None, event="push"):
    msg = "ci-gate nonce\n\nNonce: 1-2\nGates: e2e:a\nRunner: macos\n" + (f"Lane: {lane}\n" if lane else "")
    return {"id": id_, "event": event, "head_commit": {"message": msg}}


def app_run(id_, maws_run_field):
    msg = f"MAWS e7ab5da39615 e2e:a\n\nMAWS-Source: abc\nMAWS-Run: {maws_run_field}\nHosted-Group: a\n"
    return {"id": id_, "event": "push", "head_commit": {"message": msg}}


HOSTED = ["macos-26"]


class RunKinds(unittest.TestCase):
    def test_lane_trailer_last_wins_case_insensitive(self):
        self.assertEqual(measure.lane_of("x\n\nNonce: 1\nLane: hosted\n"), "hosted")
        self.assertEqual(measure.lane_of("x\n\nlane: VM\nLane:  no-hosted \n"), "no-hosted")
        self.assertIsNone(measure.lane_of("x\n\nNonce: 1\nRunner: macos\n"))
        self.assertIsNone(measure.lane_of(None))

    def test_maws_run_trailer(self):
        self.assertEqual(measure.maws_run_of(app_run(1, "40305340291/1")), 40305340291)
        self.assertIsNone(measure.maws_run_of(app_run(1, "m1/1")))  # M1's hand requests name no private run
        self.assertIsNone(measure.maws_run_of({"id": 1, "head_commit": None}))

    def test_jobs_take_their_run_kind_and_hosted_jobs_their_private_run_kind(self):
        maws_runs = [maws_run(1, "hosted"), maws_run(2), maws_run(3, "vm"), maws_run(4, "no-hosted"),
                     maws_run(5, "vm-trial")]
        maws_jobs = [job("e2e:a", run_id=r, id_=r) for r in (1, 2, 3, 4, 5)]
        app_runs = [app_run(100, "1/1"), app_run(101, "2/1"), app_run(102, "m1/1"), app_run(103, "999/2"),
                    app_run(104, "3/1")]
        app_jobs = [job("e2e", labels=HOSTED, run_id=r, id_=r) for r in (100, 101, 102, 103, 104)]
        m, a, unmatched = measure.with_kinds(maws_runs, maws_jobs, app_runs, app_jobs, ["hosted", "no-hosted"])
        self.assertEqual([j["kind"] for j in m], ["trial", "default", "default", "trial", "default"])
        self.assertEqual([j["kind"] for j in a], ["trial", "default", "trial", "trial", "default"])
        self.assertEqual(unmatched, 2)
        self.assertNotIn("kind", maws_jobs[0])  # the inputs are left as they were

    def test_share_and_queue_split_by_kind(self):
        out = run(
            maws=[dict(job("e2e:a", ran_min=30), kind="default"), dict(job("e2e:b", ran_min=60), kind="trial"),
                  dict(job("unit:darwin", ran_min=99), kind="default")],
            app=[dict(job("e2e", labels=HOSTED, queued_min=2, ran_min=10), kind="default"),
                 dict(job("e2e", labels=HOSTED, queued_min=8, ran_min=20), kind="trial"),
                 dict(job("e2e", labels=HOSTED, queued_min=9, ran_min=20), kind="trial")])
        self.assertEqual(out["hosted_share_by_kind"]["default"],
                         {"hosted_minutes": 10, "mac_minutes": 30, "share": 0.25})
        self.assertEqual(out["hosted_share_by_kind"]["trial"], {"hosted_minutes": 40, "mac_minutes": 60, "share": 0.4})
        self.assertEqual(out["hosted_queue_by_kind"]["default"], {"n": 1, "median": 2, "p90": 2})
        self.assertEqual(out["hosted_queue_by_kind"]["trial"], {"n": 2, "median": 8.5, "p90": 9})
        self.assertEqual(out["hosted_share"]["share"], round(50 / 140, 4))  # the whole is unchanged

    def test_a_window_whose_hosted_minutes_are_all_trials(self):
        out = run(maws=[dict(job("e2e:a", ran_min=30), kind="default")],
                  app=[dict(job("e2e", labels=HOSTED, ran_min=10), kind="trial")])
        self.assertEqual(out["hosted_share_by_kind"]["default"], {"hosted_minutes": 0, "mac_minutes": 30, "share": 0.0})
        self.assertEqual(out["hosted_share_by_kind"]["trial"], {"hosted_minutes": 10, "mac_minutes": 0, "share": 1.0})
        self.assertEqual(out["hosted_queue_by_kind"]["default"]["n"], 0)

    def test_empty_window_by_kind(self):
        out = run()
        for kind in ("default", "trial"):
            self.assertIsNone(out["hosted_share_by_kind"][kind]["share"])
            self.assertEqual(out["hosted_queue_by_kind"][kind]["n"], 0)


def t(hhmm, day=20):
    return datetime(2026, 10, day, int(hhmm[:2]), int(hhmm[3:]), tzinfo=UTC)


class Intervals(unittest.TestCase):
    def test_union_clip_minutes_and_overlap(self):
        u = measure.union([(t("10:00"), t("10:30")), (t("10:20"), t("11:00")), (t("12:00"), t("12:10"))])
        self.assertEqual(u, [(t("10:00"), t("11:00")), (t("12:00"), t("12:10"))])
        self.assertEqual(measure.minutes(u), 70)
        self.assertEqual(measure.clip(u, t("10:30"), t("12:05")), [(t("10:30"), t("11:00")), (t("12:00"), t("12:05"))])
        self.assertEqual(measure.overlap_minutes(u, [(t("10:50"), t("12:05"))]), 15)
        self.assertEqual(measure.minutes([]), 0)

    def test_waiting_intervals_of_matching_jobs(self):
        vm = ["ci-kit-mac-vm"]
        jobs = [job("e2e:a", labels=vm, created="2026-10-20T10:00:00Z", queued_min=20, ran_min=5),
                dict(skipped("e2e:b", labels=vm), created_at="2026-10-20T11:00:00Z",
                     completed_at="2026-10-20T11:15:00Z", conclusion="cancelled"),  # cancelled in the queue
                skipped("e2e:c", labels=vm),                                        # never queued
                job("e2e:d", created="2026-10-20T10:00:00Z", queued_min=50)]        # the host's
        waits = measure.waiting_intervals(jobs, lambda labels: "ci-kit-mac-vm" in labels)
        self.assertEqual(waits, [(t("10:00"), t("10:20")), (t("11:00"), t("11:15"))])


def issue(number, title, created, closed, pr=False):
    out = {"number": number, "title": title, "created_at": created, "closed_at": closed}
    if pr:
        out["pull_request"] = {}
    return out


LOG = """\
2026-10-20T09:00:00Z vm-lane starting (pid 1, slot vm, mode always); recovery first
2026-10-20T09:00:05Z vm-lane no boot: no queued job for the guest
2026-10-20T10:00:00Z vm-lane no boot: memory available 56%, under the floor of 57%
2026-10-20T10:10:00Z vm-lane registration cleanup pending: JIT reap: DELETE failed (HTTP 422)
2026-10-20T10:20:00Z vm-lane no boot: memory pressure 2, not 1 (pressure 2, available 27%, swap 577 MB)
2026-10-20T10:30:00Z vm-lane booting maws-vm-job-vm-20261020T103000Z from the golden image g: 1 ci-kit-mac-vm job(s)
2026-10-20T10:31:00Z vm-lane maws-vm-job-vm-20261020T103000Z: its guest agent answers after 20 s
2026-10-20T11:00:00Z vm-lane no boot: cua_repl: timed since 2026-10-20T10:59:00Z
2026-10-20T11:05:00Z vm-lane stopping on SIGTERM (idle); a guest and its reservation stay for the next start
2026-10-20T11:15:00Z vm-lane starting (pid 2, slot vm, mode always); recovery first
2026-10-20T11:15:00Z vm-lane no boot: memory available 40%, under the floor of 57%
"""


class Mini(unittest.TestCase):
    def report(self, issues=(), log=LOG, jobs=(), until=UNTIL, now=None):
        return measure.mini_report(list(issues), log, list(jobs), since=SINCE, until=until,
                                   now=now or until, hold_prefix="ci-kit alert: mini:",
                                   guest_labels=["ci-kit-mac-vm", "ci-kit-mac-vm-trial"], log_source="fixture")

    def test_holds_are_the_mini_alerts_clipped_to_the_window(self):
        issues = [
            issue(56, "ci-kit alert: mini: Display since …", "2026-10-20T07:52:00Z", "2026-10-20T09:31:00Z"),
            issue(55, "ci-kit alert: ec2: SecurityAgent", "2026-10-20T07:00:00Z", None),
            issue(53, "ci-kit alert: mini: a pull request", "2026-10-20T07:00:00Z", "2026-10-20T08:00:00Z", pr=True),
            issue(17, "ci-kit alert: mini: before", "2026-10-18T23:00:00Z", "2026-10-19T00:30:00Z"),
            issue(16, "ci-kit alert: mini: long gone", "2026-10-10T23:00:00Z", "2026-10-11T00:30:00Z"),
            issue(60, "ci-kit alert: mini: still open", "2026-10-25T23:00:00Z", None),
        ]
        jobs = [job("e2e:a", created="2026-10-20T09:00:00Z", queued_min=60),
                job("e2e:b", labels=["ci-kit-mac-solo"], created="2026-10-25T23:50:00Z", queued_min=5),
                job("static", runner="ci-kit-ec2-x", labels=WAITER, created="2026-10-20T08:00:00Z", queued_min=60),
                # a job for the guest alone waits on the guest's state, not the host's hold
                job("e2e:c", labels=["ci-kit-mac-vm"], created="2026-10-20T08:00:00Z", queued_min=60)]
        holds = self.report(issues, jobs=jobs)["holds"]
        self.assertEqual(holds["minutes"], 99 + 30 + 60)
        self.assertEqual(holds["minutes_with_host_job_queued"], 31 + 5)
        self.assertEqual([i["number"] for i in holds["issues"]], [17, 56, 60])
        self.assertEqual(holds["issues"][2]["to"], None)

    def test_guest_off_reads_the_lane_states(self):
        off = self.report(until=datetime(2026, 10, 20, 12, tzinfo=UTC))["guest_off"]
        self.assertEqual(off["log_from"], "2026-10-20T09:00:00Z")
        self.assertEqual(off["by_reason"], {
            "memory available N%, under the floor of N%": 20 + 45,
            "memory pressure N, not N": 10,
            "held: cua_repl": 5,
            "lane stopped": 10,
        })
        self.assertEqual(off["minutes"], 90)
        self.assertIn("idle", off["note"])

    def test_guest_off_counts_the_minutes_a_guest_job_was_queued(self):
        jobs = [job("e2e:a", labels=["ci-kit-mac-vm"], created="2026-10-20T10:15:00Z", queued_min=15),
                job("e2e:b", labels=["ci-kit-mac-solo"], created="2026-10-20T10:00:00Z", queued_min=60)]
        off = self.report(jobs=jobs, until=datetime(2026, 10, 20, 12, tzinfo=UTC))["guest_off"]
        self.assertEqual(off["minutes_with_guest_job_queued"], 15)

    def test_the_last_state_runs_to_the_read_not_past_it(self):
        off = self.report(until=datetime(2026, 10, 26, tzinfo=UTC), now=datetime(2026, 10, 20, 11, 25, tzinfo=UTC))
        self.assertEqual(off["guest_off"]["by_reason"]["memory available N%, under the floor of N%"], 20 + 10)

    def test_an_unread_log_and_an_empty_window(self):
        out = measure.mini_report([], None, [], since=SINCE, until=UNTIL, now=UNTIL, hold_prefix="ci-kit alert: mini:",
                                  guest_labels=["ci-kit-mac-vm"], log_source="unread: ssh mini: timed out")
        self.assertEqual(out["holds"]["minutes"], 0)
        self.assertIsNone(out["guest_off"]["minutes"])
        self.assertEqual(out["guest_off"]["source"], "unread: ssh mini: timed out")
        text = measure.render(dict(run(), mini=out))
        self.assertIn("unread: ssh mini: timed out", text)


class Chunks(unittest.TestCase):
    def test_window_splits_into_chunks_covering_it(self):
        chunks = measure.chunks(SINCE, datetime(2026, 10, 20, 12, tzinfo=UTC), hours=24)
        self.assertEqual(chunks, [(SINCE, datetime(2026, 10, 20, tzinfo=UTC)),
                                  (datetime(2026, 10, 20, tzinfo=UTC), datetime(2026, 10, 20, 12, tzinfo=UTC))])
        self.assertEqual(measure.chunks(SINCE, SINCE, hours=24), [])


if __name__ == "__main__":
    unittest.main()
