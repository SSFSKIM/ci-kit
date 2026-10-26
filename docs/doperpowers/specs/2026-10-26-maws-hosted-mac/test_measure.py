"""Tests for measure.py's pure logic. Run: python3 -m unittest discover -s <this directory>"""

import unittest
from datetime import datetime, timedelta, timezone

import measure

UTC = timezone.utc
SINCE = datetime(2026, 10, 19, tzinfo=UTC)
UNTIL = datetime(2026, 10, 26, tzinfo=UTC)
WAITER = ["self-hosted", "ci-kit-pool", "cpus-2"]


def job(name, runner="ci-kit-mac-mini", labels=("self-hosted", "macOS", "ARM64"), created="2026-10-20T10:00:00Z",
        queued_min=0, ran_min=0, conclusion="success", id_=1):
    created_at = measure.parse_utc(created)
    started = created_at.timestamp() + queued_min * 60
    completed = started + ran_min * 60
    iso = lambda t: datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"id": id_, "name": name, "runner_name": runner, "labels": list(labels), "conclusion": conclusion,
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
        jobs, src = measure.collect(gh, "o/r", "gate.yml", SINCE, UNTIL, timedelta(days=7))
        self.assertEqual(gh.jobs_fetched, [1])
        self.assertEqual(src["jobs"], 1)
        self.assertEqual(run(maws=jobs)["mac_queue"], {"n": 1, "median": 7, "p90": 7})


class Chunks(unittest.TestCase):
    def test_window_splits_into_chunks_covering_it(self):
        chunks = measure.chunks(SINCE, datetime(2026, 10, 20, 12, tzinfo=UTC), hours=24)
        self.assertEqual(chunks, [(SINCE, datetime(2026, 10, 20, tzinfo=UTC)),
                                  (datetime(2026, 10, 20, tzinfo=UTC), datetime(2026, 10, 20, 12, tzinfo=UTC))])
        self.assertEqual(measure.chunks(SINCE, SINCE, hours=24), [])


if __name__ == "__main__":
    unittest.main()
