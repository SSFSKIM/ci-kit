# The gate ledger: what each gate costs, what it catches, and what landed without it — living spec

**Date.** 2026-11-19. **Status.** Design approved by the owner (2026-11-19, "설계안 전체"); revised twice the same
day, after each of its adversarial review's two passes (Decision Log). Author: CI-opt.
Parents: `2026-10-15-ci-kit-design.md` (the kit) and `2026-10-21-test-history-design.md` (the per-test record this
builds on; its M3 is superseded by M3 and M6 here).

## Purpose

The owner's verification retrospective of 2026-11-19 found that most verification time was not buying product
safety. On the one Mac, over three days, 46% of the time went to red runs that were not product bugs, and 30 runs
(148 minutes) were made only to learn that a failure was not the change's own. The numbers took a day of hand work
to produce, because nothing records what a gate cost and what its failures turned out to be. The owner's ruling:
look for what to remove before what to add, and tell "fix now" from "ship with it".

After this work:

- **Every gate job leaves one line**: which gate, where it ran, how long, how it ended, on which tree and with
  what scope. For all five repositories ci-kit serves, and for the hand-run Mac gate.
- **Every red gate attempt carries what the record shows about it**, and says so when it shows nothing: lost to
  infrastructure, green on a rerun of the same tree, followed by a green that changed only tests, followed by a
  green that changed the product, or unattributed with the reason.
- **A weekly report per repository** shows, per gate, runner minutes and reds by cause. It nominates a gate for
  removal or demotion only when its record is long enough and it had no red but infrastructure's. A gate whose
  other reds all passed on a rerun or went green on a test-only change is listed as a candidate with each of those
  reds to read, because neither observation proves the product was not at fault; reds the record could not
  attribute are listed too. A person decides; CI never removes a check.
- **Every update of a default branch is checked against its gates**: did the tree that landed run, in full, and
  green? The count of landings that did not is visible each day.
- **`ci-gate` gives context at a failure**: when the same gate last ran on the default branch and how it ended, and
  any recorded reason that names the gate. It is context for the session's judgment, never a verdict.

How to see it working: the acceptance section's commands reproduce the hand measurement of 2026-11-19 from the
store, print a weekly report, and show `ci-gate` printing the context lines.

### What it must not be

- **Not a gate.** Nothing here can turn a run red, hold a merge, or skip a test. Blocking is GitHub's branch
  protection (`ci / verdict` is a required check on cua, doperpowers, ci-kit and manim-master since 2026-11-19) and,
  in MAWS, the architect's rule. The ledger observes both.
- **Not a disposition.** A cause is a statement of what the record shows, and a context line says what it does not
  know. Neither tells a session that a failure may be ignored. The review of this spec showed ways a rule-made
  label could call a real failure harmless (one passing shard, a narrower rerun, a different test failing on the
  base, a product deadlock reaching the time limit, an intermittent product fault passing on a rerun, a weakened
  assertion); a cause is therefore named for the observation, never for a conclusion, and where the record shows
  nothing the answer is `unattributed`.
- **No check removed or quarantined by CI.** The report nominates. A check that guards a rare but costly failure is
  marked `keep` with its reason and is not nominated.
- **No test name, file or message in a public place.** MAWS's record is treated as private whatever the
  repository's visibility is: the store is the private sandbox's branch, and every log line this code prints in
  Actions carries counts only (the parent spec's rule).
- **No new credentials or permissions.** The collector uses the ci-kit GitHub App with the permissions it has
  (Actions read, Contents read) where the App is installed, and the sandbox run's own `GITHUB_TOKEN` for a public
  repository it is not installed on (doperpowers, cua: public data, no grant; `token` in `history/repos.json`); local
  commands use `gh`'s token. A design step that needs more is redesigned, not
  granted (M1's preflight proves each read with the token the daily run has).
- **Not a report of time saved.** Four shards of eight minutes are 32 runner minutes and eight minutes of
  anyone's wait. The unit is runner minutes by lane, with the Mac's minutes shown apart because the one Mac is the
  scarce machine; the report never calls a sum of them elapsed time.

## Glossary

- **Gate run, nonce commit, producer, label.** As in `2026-10-21-test-history-design.md`'s Glossary;
  `history/provenance.mjs` implements them.
- **Gate.** What a job verifies, with shards folded: the job `unit 3/4` belongs to the gate `unit`; a ci-kit job
  `ci / test` is the gate `test`. Control jobs (`plan`, `verdict`, `package cache`) are recorded with kind
  `control` and take no part in causes or reports. Where a repository has a summary job whose cost is in other
  jobs (MAWS's hosted `static` over `static-local` and `static / …`), `history/repos.json` names the parts, and the
  parts' minutes are the gate's.
- **Gate attempt.** All of one gate's jobs in one (run, attempt), with the shards a rerun copied from the earlier
  attempt counted toward its result and not toward its minutes. It **succeeded** only when every shard its job
  names announce (`k/n`) succeeded; it **failed** when any did not; otherwise it is **incomplete**. The gate
  attempt, never a single job, is the unit of every cause and every landing.
- **Scope.** What a gate attempt actually exercised: `full`; `selected` (a `Selection: affected` trailer, whether or
  not selection fell back to the whole suite, as the parent spec's landing rule has it); `narrowed` (the hand-run
  gate with a test filter, or a gate on an event `history/repos.json` lists as vacuous for it, such as doperpowers'
  `version-bump` on a dispatch); `unknown`. The **scope key** adds what else decides what an execution exercised
  or where, and nothing that merely varies between two executions of the same work: the values of the trailers
  `history/repos.json` lists as semantic for the repository (in MAWS, the runner, the selection, the lane, the
  live flag, the peers and the mini copies; never the nonce, the backlog and demand snapshots or the coverage
  notes), and for the hand-run gate its filter, environment, peers and whether the job is a mini copy. Two
  attempts are **comparable** when gate and scope key are equal and neither scope is `unknown`.
- **Tree basis.** `exact`: the run tested exactly the tree recorded (a ci-gate ref, whose nonce commit is empty; a
  push to a branch). `pr-merge`: a `pull_request` run, which checks out GitHub's merge of the head into the base
  of that moment; the head's tree is recorded and the tested tree is not known.
- **Change.** For a ci-gate ref, its producer and label, unless the label is one a repository uses as a fallback
  for unrelated targets (`gate` in ci-kit's own `ci-gate`; the list is in `history/repos.json`), in which case the
  attempt has no change. For a `pull_request` run, the pull request's number when the run names one, else the
  head branch's name (a name alone can be reused by a later pull request).
- **Lane.** Where a job ran: `pool-gce`, `pool-ec2`, `mini-host`, `mini-guest`, `hosted-linux`, `hosted-macos`, or
  `manual-host` / `manual-guest` for the hand-run Mac gate.
- **Landing.** One update of a default branch: an activity event (`push`, `force_push`, `pr_merge`,
  `merge_queue_merge`; a merge by the pull request button is `pr_merge`, not `push`) with its `before` and `after`
  commits, from the repository activity API. What landed is the difference between the two, whatever the tip commit alone changed.
- **Tree key.** A tree's identity for comparing a landing with a gated tree: the tree id, unless the repository's
  entry in `history/repos.json` gives a path policy. MAWS's policy is its own (`.github/scripts/gate-affected.mjs`):
  `docs/` is outside the gates' reach except `docs/doperpowers/evidence/`, which a unit test reads. The key is then
  the hash of the tree with the excluded paths removed.
- **The mirror.** A bare clone of a served repository without file contents (`--filter=blob:none`), made in the
  collection job with the App token. Trees, ancestry and path differences are read from it; commits no ref reaches
  any more (nonce commits, pull request heads) are fetched into it by id.
- **The store.** Branch `test-history` of the private `SSFSKIM/ci-kit-sandbox`, written daily by the sandbox's
  `test-history.yml` running ci-kit `main`'s `history/collect.mjs` on the pool.
- **The hand-run Mac gate.** CI-opt's `manual-gate-mac`, which runs MAWS's Mac jobs on the Mac mini outside Actions
  while the account's billing lock lasts. Its runs live on CI-opt's MacBook under
  `~/.local/share/ci-opt/manual-gate/runs/<sha12>-<stamp>/`.

## Progress

- [x] (2026-11-19 08:5xZ) The measurement the design rests on: `~/.local/share/ci-analysis/gate-observe-1119/`
  (`report.md`, `merges.tsv`, `maws-93-split.tsv`, `scripts/`). Design presented and approved.
- [x] (2026-11-19 09:0xZ) Required check `ci / verdict` and auto-merge turned on (Decision Log).
- [x] (2026-11-19 09:2xZ) M0 — the per-test collector runs again: ci-kit #219 (merge 7cc2381), sandbox #86
  (merge 8304e4c); proof run 44486730875 (349 lines in 9 batches, 0 errors). The store holds 10-21 and 11-12 to
  11-19.
- [x] (2026-11-19 09:1xZ) Adversarial review: 12 blocking findings and 3 lesser, all taken (Decision Log).
- [x] (2026-11-19 09:2xZ) Its second pass: 8 blocking findings and 2 lesser on the revision, folded (Decision
  Log). The review ends here; the counterexamples it gave are test pins and acceptance cases.
- [x] (2026-11-20 02:2xZ) M1 — Job lines: 890528d..d78c85a, task review converged after two fix rounds; backfill
  from 10-22 in the store; acceptance 1, 2 and 8 met (M1's report).
- [x] (2026-11-20 03:5xZ) M2 — The store kept small, watched, and fed by the hand-run gate: d5e07ae..9b4c438, task
  review converged after two fix rounds; acceptance 7's first half and 9 met (M2's report); sandbox #95, #97.
- [ ] M3 — Landings and causes.
- [ ] M4 — The weekly report and the status file.
- [ ] M5 — `ci-gate`'s context lines and known entries.
- [ ] M6 — The per-test condensation report (a later sitting).

## Acceptance

Each is run against the real store and GitHub's real record, not a fixture: the kit's unit tests use fakes, and
the retrospective named that as its gap. Every collection below is the sandbox's workflow on the pool with the App
token; a run made with `gh`'s token proves nothing about the daily run.

1. **Job lines exist and are right.** After a collection the store holds `SSFSKIM/MAWS/jobs/2026-11-19.jsonl`
   with one line per job of run 44486328066: gates `static`, `unit` (four shards), `probes`, `e2e:desk-web`, lane
   `pool-gce` for the gates' own jobs (`plan` and the `static` summary job run on `hosted-linux`), conclusion `success`, basis `exact`, and `e2e:desk-web` at 7.6 minutes (08:18:10Z to 08:25:45Z).
   All five repositories have job files for every day from 2026-10-22 on which they ran a gate.
2. **A gate attempt is not greener than its worst shard.** MAWS run 39962530337, attempt 1: `unit 2/4` failed and
   the other three shards passed after it. The gate attempt `unit` is `failed`; nothing derived from it (cause,
   landing evidence, standing) reads it as green, and its sibling shards' success is not a later pass of its tree.
3. **Causes say what the record shows, on cases whose cause is known.**
   - `infra`: MAWS run 44468141412's first `static-local` (runner lost in the setup step; the rerun got past it)
     and run 44478359816's `e2e:desk-web` (stalled at its time limit inside `playwright install`; run 44487801654
     on the same tree got past it). Run 44472434480, named here first, does not hold: its rerun stalled in the same
     step and nothing on its tree got past it, so it is `unattributed` (`setup-uncorroborated`), as it should be.
   - Not red at all: the jobs of a pull request run cancelled because a newer push superseded it (the executor
     names one from the store) are `superseded`.
   - `unattributed`: doperpowers pull request 481's `mods-types` failure of 2026-11-10 12:40Z (merged red: no later
     attempt in its change), and a setup failure that no later attempt on the same tree got past (the executor
     names one, or records that the store has none).
   - For `rerun-green`, `test-only-diff` and `product-diff` the executor of M3 takes two labelled attempts of each
     from the store, reads the runs behind them on GitHub, and records all six with their evidence in Surprises &
     Discoveries. A label whose stated observation the reading contradicts is a defect.
4. **The landing record agrees with the hand measurement, or says why not**, for 2026-10-22 to 2026-11-19. Fixed
   points by `pr_check`: doperpowers' pull request 481 is `red`; 410 is `green` (its check, run 40596123672,
   passed; the red the hand measurement counted was a `ci-gate` push six minutes later, run 40596797028, which is
   a cause line). The three doperpowers commits pushed with no pull request (f2c78808, 74ff0ff4, 06d4ea08) are
   landings and are `unrun`. The hand measurement's totals, which mixed the two kinds of run: doperpowers 184
   merged pull requests, 165 green, 2 red, 17 unrun of which 15 in flight; ci-kit 116: 113, 0, 3; cua 69, all
   green; manim-master 207: 188 green and 19 with no check (`none`). The executor sets the ledger's `pr_check`
   counts beside these and explains every difference by pull request number in Surprises & Discoveries; a
   difference left unexplained is a defect. For MAWS, and for "did the exact landed tree run" in every repository,
   the definitions differ by design (push diffs, the path policy, full scope only), and both sets of counts are
   recorded with what each difference comes from.
5. **The report reads, and does not nominate what caught something.** `node history/report.mjs --store <dir> --repo
   SSFSKIM/doperpowers --week 2026-W47` prints a Markdown report with a row per gate and the sections of "The
   report" below. No gate with any red but `infra` in its window is in the nominations; no gate with a
   `product-diff` or an `unattributed` red is among the candidates; no gate that
   `~/.local/share/ci-analysis/verification-retro-1119/reds.md` credits with a product catch is nominated in MAWS's
   report.
6. **`ci-gate` gives context and changes nothing else.** With a status file in which gate `test` last failed on
   the default branch, `ci-gate` on a commit whose `test` fails prints the FAIL line followed by a `base:` line
   naming the commit, the time and the run. Verdict and exit code are as today. With no readable status file, or
   one older than 48 hours, the output is byte for byte today's.
7. **The hand-run gate is in the ledger and a MAWS session can read it.** After `history/manual-gate.mjs` imports
   run `24952ff2f8a4-20261119T054617Z` (RED 3/5: a build and five test jobs, the last a mini copy bundling two
   groups), the store has seven lines: the build as `control`; `e2e:panel` failed, `e2e:code` and `e2e:remote`
   succeeded; and the mini copies of `e2e:remote` (succeeded), `e2e:panel` (failed) and `e2e:code` (succeeded),
   each copy an attempt apart from its direct job. `ci-gate status --repo SSFSKIM/MAWS` prints MAWS's standing per
   gate and its known entries.
8. **Nothing public names a test.** The Actions log of the collection run that produced 1 to 5 contains no MAWS
   test name, file or message (`gh run view --log | grep` for three names taken from the store returns nothing).
9. **A dead collector is noticed.** With the guard pointed at a test branch whose marker is older than 36 hours
   and whose newest commit is fresh, the sandbox's guard workflow opens or comments on the alert issue.

## Design

### One collector, one store, more kinds of line

The per-test record already has the right home: a daily run in the private sandbox, ci-kit `main` as the code, the
App token, a branch as the store. The ledger adds files beside `runs/` under each `<owner>/<repo>/`:

| File | Holds | Written by |
|---|---|---|
| `attempts.json` | which (run, attempt) pairs are collected, which are still open, and when each day was listed | M1 |
| `collected.json` (the store's root) | the collector's marker: when a pass last ended complete | M2 |
| `jobs/<YYYY-MM-DD>.jsonl` | one line per job of a gate run, by completion day (UTC) | M1 |
| `jobs-manual/<YYYY-MM-DD>.jsonl` | the same, for the hand-run Mac gate | M2 |
| `landings/<YYYY-MM-DD>.jsonl` | one line per update of the default branch | M3 |
| `causes/<YYYY-MM-DD>.jsonl` | one line per red gate attempt, by its completion day | M3 |
| `status.json` | each gate's observations on the default branch; known entries in force | M4 |
| `reports/<ISO week>.md` | the weekly report | M4 |
| `known.json` | recorded reasons | M5 (read from M3 on) |

The hand-run gate and the known entries have files of their own because they are written from other machines
while the daily run writes the rest: disjoint files make every concurrent write a trivial merge.

*Rejected:* a second service (the pool launcher already sees every `workflow_job` event and has a ledger of its
own). It would couple a reporting feature to the component that places runners, and the API record is complete
without it: run and job metadata are kept for more than a year, so a missed day is recollected, which a missed
webhook is not. *Rejected:* a step in every gate job. Every job would need somewhere to write, and the hand-run
gate and MAWS's own workflow would each need their own copy.

### Reading GitHub cheaply and completely (M1)

The first draft of this design listed runs "updated since" a watermark. GitHub's run listing filters by creation
only, a rerun keeps its run's creation date, and a filtered listing stops at 1,000 results. So:

- **Runs.** Each pass lists every gate workflow's runs by `created`, one UTC day per request, over the last 35 days
  (reruns are possible for 30); a day whose `total_count` exceeds 1,000 is split by hour. A (run, attempt) not in
  `attempts.json`, or in it as open, is work. An attempt is closed when its run is completed and its jobs are
  written; an attempt still running stays open and is read again next pass. About 35 requests a repository a pass.
- **Jobs.** One REST call per (run, attempt): the attempt's jobs, 100 a page (`lib/github.mjs` `attemptJobs`,
  which the per-test pass calls today for the same attempts). It is the only source that names a job's runner, its
  labels and the attempt a job ran in. In the listing of a failed-jobs rerun every job carries the new attempt's
  number and a new id; a job carried over from an earlier attempt is the one that completed before it was created
  (`completed_at < created_at`, its times, runner and steps copied), and `copied_from` is the latest earlier attempt
  whose job of the same name is not itself a copy (the preflight, Surprises & Discoveries). The pass fetches each attempt's
  jobs once, for the job lines and the per-test pass both, and records the attempt in `attempts.json`.
  Annotations are read for unsuccessful jobs only, one call each (`annotations`); where they are refused (a private
  repository: the endpoint needs Checks read, which the App lacks) the job's log is read instead, one call, matched
  and never printed, and a job with neither keeps `annotations: []`. *Rejected:* GraphQL check runs,
  which this spec's first revision chose for their batching: a check run has steps and annotations but no runner,
  no labels and no attempt of its own, so neither the lane nor a copied shard can be read from it.
- **Discovery once a pass.** The sandbox workflow calls the collector in a loop of batches. The first call of a
  pass makes the run listing and keeps its result (the open attempts, oldest first, and the time of the listing)
  in `attempts.json`; later batches of that pass take work from it without listing again.
- **Coverage.** `attempts.json` records, per repository and day, when the day was last listed in full. A day is
  **covered** when it was listed after it ended and every attempt found for it is closed. A backfill that has not
  reached a day leaves it uncovered, and the report counts covered days only.
- **Budget.** From the measurement, not a guess: 35 listing calls a repository a pass (175), one jobs call per new
  attempt (8,367 attempts in the 28 days measured, about 300 a day), one annotations call per unsuccessful job,
  and the per-test pass's artifact downloads. A daily pass is held under 1,500 REST calls on the App's token (the
  installation's own allowance, at least 5,000 an hour, which the launcher shares and no session does). The
  collector counts its calls, takes no new work at the limit, and prints the count. The backfill is the same pass
  over a longer window, paced under 2,000 calls an hour: about five hours.
- **Trees, ancestry, paths.** From the mirror, not the API. A run's nonce commit is fetched by id, which brings the
  tested commit with it; a pull request's head is fetched from `refs/pull/<n>/head`. The compare endpoint is not
  used: it lists at most 300 files and, for two commits where neither descends from the other, lists the later
  one's changes since their common ancestor, which hides a product edit that an amendment dropped.
- **Preflight.** M1 opens by proving, with the App token on the pool, for each of the five repositories: the run
  listing; the jobs of both attempts of one run that was rerun for its failed jobs, with each job's runner and
  labels and a carried-over shard read from the answer; the annotations of one failed job; the activity listing
  of the default branch; the mirror clone; and a fetch by commit id of a nonce commit whose ref is gone. Its
  results go into Surprises & Discoveries. Where the activity listing is refused, that repository has no landing
  lines and the report says so. *Rejected:* reading landings from first-parent history instead. It cannot tell one
  push of three commits from three pushes, nor a gate that finished between a commit's creation and its push, so
  its counts would be invented.

### A job line (M1)

    { "v": 1, "run": 44486328066, "attempt": 1, "workflow": "gate", "event": "push",
      "ref": "ci/pwdeps-55f4887d", "producer": "maws-ci-gate", "label": "pwdeps", "change": "maws-ci-gate:pwdeps",
      "gates": "static,unit,probes,e2e:desk-web", "scope": "full", "scope_key": "<hash>",
      "head": "<nonce or head commit>", "tested": "<tested commit>", "tree": "<tree id>", "basis": "exact",
      "job_id": 135…, "job": "unit 3/4", "gate": "unit", "shard": [3, 4], "kind": "gate", "copied_from": null,
      "lane": "pool-gce", "runner": "ci-kit-gce-…",
      "started": "…Z", "completed": "…Z", "minutes": 7.7,
      "conclusion": "success", "run_conclusion": "success",
      "failed_step": null, "phase": null, "annotations": [] }

- **`basis: "pr-merge"`** lines carry the head's tree in `head_tree` and `tree: null`.
- **`failed_step` and `phase`** say where a job stopped, not why: the first step that concluded `failure` or
  `cancelled`, and `setup` when its name matches the repository's `setup_steps` patterns in `history/repos.json`,
  `post` for `Post …` steps, else `test`. A job that ended unsuccessfully with no such step has `phase: "lost"`.
- **`annotations`** are kept only when they match the kit's list of platform messages (`not-started`: the job was
  not started for billing; `runner-lost`: the runner lost communication; `time-limit`: the operation was cancelled
  at the job's time limit), as the matched kind, never the text.
- **`copied_from`** names the earlier attempt whose shard a failed-jobs rerun carried over; such a line has no
  minutes.
- Skipped jobs are not written. Lines are idempotent by (run, attempt, job id).
- Lines are filed by completion day, so one gate attempt can span two days' files (shards across midnight; a copy
  is filed on its gate's `available` day). A reader of a window loads one day's margin on each side and attributes
  each gate attempt to the window by its `available`.

### What a red gate attempt's record shows (M3)

A cause line is `{ run, attempt, gate, cause, why, evidence, context }`. Cancelled jobs of a run that was itself
cancelled while a later run existed for the same ref or change are `superseded`: they are not reds, and their
minutes are reported as superseded cost. A gate attempt whose every unsuccessful job was cancelled from outside (none
failed, none reached its time limit) with no such later run is `cancelled`: someone stopped it, which says nothing of
the product either way; it is not a red, and its minutes are reported as cancelled cost beside superseded. For every other gate attempt that failed, each of its unsuccessful jobs
is first read on its own:

- **lost:** the pool's record says the job's runner was preempted; or the job has a `runner-lost` or `not-started`
  annotation; or the job stopped in `setup` or `lost` and a comparable attempt on the same exact tree later got
  that shard past that phase.
- **failed:** anything else, a job that reached its time limit included. A time limit is an outcome, not a cause:
  a deadlock in the product reaches it too.

Then the first rule that holds decides the attempt:

| # | Cause | Holds when |
|---|---|---|
| 1 | `infra` | every unsuccessful job of the attempt is lost |
| 2 | `rerun-green` | a later comparable attempt on the same exact tree succeeded (every shard) |
| 3 | `test-only-diff` | the change's next comparable attempt that succeeded has a tree whose difference from this one, read from the mirror, lies wholly in paths matching the repository's `test_globs` |
| 4 | `product-diff` | the same, with any other path in the difference |
| 5 | `unattributed` | none of the above; `why` is one of `no-later-green` (the change ended red, or was abandoned), `setup-uncorroborated`, `incomparable` (only attempts of another scope followed), `no-change` (no change to follow), `basis` (a `pr-merge` attempt, whose tree is not known, with no later attempt in its change) |

- **A cause is named for what the record shows, and none is an exoneration.** `rerun-green` is what a flaky test
  looks like, and what an intermittent fault in the product looks like (the retrospective has one, fixed in MAWS
  pull request 763). `test-only-diff` is what a wrong test looks like, and what a weakened assertion looks like.
  `product-diff` is what a catch looks like, and what a scene that an intended change made wrong looks like. The
  retrospective told each pair apart by reading; the report keeps the three apart and proposes removal on none of
  them (Nominations).
- An attempt with one shard lost and another failed is not `infra`: rule 1 needs every unsuccessful job lost.
- A job that reached its time limit is never cancelled from outside, never superseded and never `cancelled`: it
  ended on its own, as a product deadlock does.

- Rules 2 to 4 need `basis: "exact"` on both attempts, except that two `pr-merge` attempts of one head commit
  count as the same tree for rule 2 only when the base branch did not move between them.
- The difference in rules 3 and 4 is between the two trees themselves, so a sibling (an amended commit) is
  compared as exactly as a descendant, and renames count under both names.
- `infra` needs corroboration because where a job stopped is not why: a change that breaks the lockfile fails in
  setup, and that is the change's failure.
- **Context is not a cause.** A cause line's `context` may hold `base_also_failed` (the gate's latest observation
  on the default branch at that time was a failure: commit, time, run) and `known` (ids of entries in force that
  name the gate, each with `case_match`: `yes` when the per-test record has the attempt's failing cases and all of
  them match the entry's pattern, `no` when some do not, `unverified` when the record has no cases for it). A
  failure on the base does not explain a failure on the change, because the two may be different tests; the
  context is there so a reader can compare them in one look.
- A cause is recomputed while its attempt is younger than 14 days, then final.
- *Known limit:* a gate that compares the tree with the default branch of the moment (doperpowers'
  `version-bump`) can differ between two runs of one tree. Its `rerun-green` says the base moved as often as it
  says anything about the test; the report's last section names such gates.

### A landing (M3)

A landing line holds the push event (`before`, `after`, time), the tree and tree key of `after`, the paths
between `before` and `after`, the pull request, the gates required of it, and two verdicts. The pull request is
the number the tip's message names, with `pr_link: "parent"` when the mirror's `refs/pull/<n>/head` is the tip's
second parent and `pr_link: "message"` when the tip has one parent (a squash) and the message is all there is.

- **Required gates.** In the ci-kit repositories: what ci-kit's own planner selects from `before`'s
  `.github/ci-kit.yml` for event `pr` and the landing's paths (`plan/config.mjs` `parseConfig` and
  `plan/select.mjs` `selectGates`, called as libraries, with the file read from the mirror). In MAWS: the
  `required` list in `history/repos.json` (`static`, `unit`, `probes`). A landing all of whose paths the path
  policy excludes is `exempt`: exempt from the gates named here, which says nothing of a separate docs check.
- **`exact`: did the landed tree run.** For each required gate, the latest comparable-to-`full` gate attempt, with
  `basis: "exact"` and scope `full`, on the landing's tree key, completed before the landing. `green` when each
  succeeded; `red` when one failed; `unrun` otherwise, with `head_green: true` when the tip has a second parent
  whose tree key has them all green (a branch was gated and the merged tree was not).
- **`pr_check`: what the required check saw**, in the repositories that merge pull requests: the conclusion, as
  it stood at the landing, of the repository's verdict job (`ci / verdict`; `verdict_job` in `history/repos.json`)
  in the latest `pull_request` run of the pull request's head commit (the tip's second parent, or
  `refs/pull/<n>/head` for a squash). `green`; `red`; `unrun` with `inflight: true` and the job's eventual
  conclusion when it was running at the landing; or `none` when that head has no `pull_request` run (a change no
  gate applies to). It is the check's own result, not the plan recomputed, so a workflow or plan failure reads as
  the check read it. A `ci-gate` push made for the same head is a gate attempt with its own cause line and takes
  no part in this verdict.
- **Override.** A landing whose tip message has a line `Ship-with: <reason>` carries the reason. This is how
  "ship with it" is said where a check is required: `gh pr merge --admin --body "Ship-with: <reason>"`, which
  writes it into the merge commit. *Rejected for now:* a `known_red` attribute on a gate in `.github/ci-kit.yml`
  that would make `verdict` pass. It changes what a green verdict means for every consumer, for a case the record
  shows 4 times in 576 merges; the report counts overrides, and that count is the argument if it grows.
- **Standing.** Each gate's observations on the default branch are the full, exact gate attempts on landings'
  tree keys and on default-branch push runs, each with the time it completed. An observation is used only by
  readers later than both that time and its landing's push, and a landing with no observation leaves the previous
  one standing with its own commit and time, so a reader always sees which tree a standing is about and how old
  it is.

### Known entries (read from M3 on, written in M5)

`known.json` under a repository's directory in the store:

    [ { "id": "maws-778", "gate": "e2e:panel", "case": "panel.spec.ts › at its minimum size, with a question waiting*",
        "reason": "#778: the banner steals the float card's body on the guest; fixed on ux-wave/fix-778-banner",
        "since": "2026-11-19", "review_by": "2026-11-26", "by": "ux-wave" },
      { "id": "keep-cross-build", "gate": "e2e:cross-build", "keep": true,
        "reason": "the only check of wire compatibility with installed builds; a miss strands a user's sessions",
        "since": "2026-11-19", "review_by": "2027-02-19", "by": "CI-opt" } ]

- An entry without `keep` records a failure someone decided to ship with. An entry with `keep` records that a gate
  stays whatever it has caught; it is read only by the report's nominations.
- Every entry has a reason and a `review_by`, checked whenever an entry is read, so an expired entry is never
  shown as in force. Past its date it appears in the report as expired, and the shipped-with failure comes back
  into view by itself. *Why a date, not a condition:* a condition ("until #778 lands") needs someone to notice it
  became true; a date needs nobody.
- `ci-gate known add --gate <g> [--case <pattern>] --reason <text> --review-by <date> [--keep] [--repo <r>]` and
  `ci-gate known list` edit and read the file through the contents API on the store's branch with `gh`'s token.
  A write sends the blob id it read and, on a conflict, reads again and reapplies its one entry. One place, as the
  owner asked.

### The report and the status file (M4)

`history/report.mjs` reads a repository's files for an ISO week and the three before it and writes
`reports/<week>.md`:

1. **Per gate:** attempts, runner minutes by lane (the Mac's apart), superseded minutes, reds by cause, and on the
   same line its `cancelled` attempts and minutes (a person can stop a hanging job before its time limit, so a
   reader of a gate's reds sees how many of its attempts were stopped by hand).
2. **Reds to read:** each gate's `unattributed` attempts, newest first, with their `why` and run links. This is the
   list a person reads to learn what a gate is really catching.
3. **Nominations:** a gate is nominated only when its window is covered (at least 21 covered days of the 28 with
   lines, and at least 20 attempts), its only reds in the window are `infra`, and it has no `keep` entry. The line
   gives its runner minutes a week and says which lane they free. A gate that fails the coverage test is listed as
   "too little record", never nominated.
   **Candidates to read:** a covered gate with no `product-diff` and no `unattributed` red and no `keep` entry,
   whose other reds are `rerun-green` or `test-only-diff`. It is listed with each of those reds linked and its
   `cancelled` attempts and minutes, under the
   sentence that a rerun's pass does not rule out an intermittent product fault and a test-only change may have
   weakened the test. The report proposes nothing for it; a person who has read the reds may.
4. **Landings:** counts by both verdicts; each landing that was `red`, `unrun` and not in flight, or `head_green`,
   by commit; each override with its reason.
5. **Known entries:** in force, expiring within a week, expired.
6. **What the record cannot say:** what each cause's name leaves open; lanes with no lines that week; days not
   covered; repositories with no landing record; gates that compare with the default branch of the moment.

`status.json`, written in the same daily pass: `{ as_of, gates: { <gate>: { result, commit, at, run } }, known:
[…entries in force…] }`.

The report is a file in the private store; CI-opt reads it weekly and relays what matters to the owner and each
repository's architect. *Rejected:* an issue or a mail a week. The owner reads the session's report stream, and a
second channel would be one more thing nobody watches. What must not depend on anyone reading is that the
collector is alive, which M2's guard covers.

### `ci-gate` at a failure (M5)

After a `FAIL` line, when the repository's `status.json` can be read with `gh`'s token (one contents call, made at
an invocation's first failure) and is younger than 48 hours, `cli/watch.mjs` prints for that gate:

    FAIL test 2m10s log=/tmp/…
         base: test last ran on main at 3f2a91c (2026-11-18T10:49Z) and failed, run 44262593045. The failures may differ: compare before rerunning.
         known: maws-778 (review by 2026-11-26): #778: the banner steals the float card's body on the guest. Whether this failure is that one is not checked.

`base:` only when the gate's latest observation is a failure; `known:` for each entry in force without `keep` that
names the gate. Everything else `ci-gate` prints, its verdict and its exit code are unchanged. `ci-gate status
[--repo <r>]` prints a repository's whole status file and known entries, for sessions whose gates do not run
through this CLI (MAWS, whose `scripts/ci-gate.sh` is the architect's and is not touched).

The session-start hook's text (`hooks/session-start.sh`) gains one sentence on these lines and one on merging:
where the default branch requires `ci / verdict`, `gh pr merge <n> --auto --merge --match-head-commit <sha>` merges
when the gates pass, and a merge past a red gate is `--admin --body "Ship-with: <reason>"`.

### The per-test record, kept small (M2)

M0's proof run measured what the parent spec had guessed: a per-test run line is about 185 KB, not "a few KB",
because a line stores its membership as a difference from the day's one base and branches differ from it by
thousands of cases. The store grew 64 MB in eight days, every pass loads every line, and the pass's peak memory
(616 MB at 64 MB of lines) would reach the heap's limit in about a month.

- A run line that is not its day's base keeps its counts, the hash of its ids, the hash of its skipped ids (a line
  holds both today) and its failed cases; it no longer stores membership. A reader that asks whether a case ran
  and passed in such a run answers `passed` only when the run's two hashes equal the base's (the same cases ran
  and the same were skipped) and the case is not among the run's failed; otherwise `unknown`. A run selected by
  `--affected`, or one that skipped other cases, therefore says nothing about the cases it did not fail.
  *What this gives up:* passing observations from runs whose membership differs from the day's base. Measured, the
  exactness costs 50 times its estimate. *Rejected:* answering `passed` for every case of the base that did not
  fail (this spec's first revision). It reports thousands of unselected and skipped cases as passed, and M6 reads
  exactly that signal.
- Existing lines are rewritten once to the new shape, from the exact membership they hold. The exact lines stay in
  the branch's history, which is never rewritten. A pass loads the lines of the last 35 days only.

## Plan of Work

Constraints on every milestone:

- Node's built-ins, `git`, and the kit's vendored `yaml` only; tests are `node --test`, beside the existing ones in
  `test/history/`.
- A collection's Actions log prints counts only (acceptance 8).
- A daily pass stays under 1,500 REST calls for all repositories together, counted and printed by the collector;
  the backfill is paced under 2,000 calls an hour ("Reading GitHub cheaply and completely"). A repository in
  `history/repos.json` with no `jobs` list of reporting jobs takes no part in the per-test pass.
- The collector keeps what M0 gave it: bounded batches, oldest first, each durable on its own, memory bounded by a
  batch.
- The MacBook runs focused test files only (`node --test test/history/`), never the kit's whole suite, and never
  collects MAWS (the REST budget is shared with every session).
- Nothing is deployed and `v1` does not move: this work changes `history/`, `cli/`, `hooks/` and docs in ci-kit,
  and the sandbox's workflows by their own pull requests.

### M1 — Job lines

At its end the store holds `attempts.json` and job lines for the five repositories from 2026-10-22 on, and the
daily run adds each day's.

- Touches: `history/repos.json` (every served repository: its gate workflows, default branch, `setup_steps`,
  `test_globs`, path policy, `required`, `verdict_job`, summary parts, fallback labels, vacuous events, semantic
  trailers), `history/jobs.mjs` (a run and its attempt's jobs to job lines and gate attempts, pure),
  `history/mirror.mjs` (the clone, fetch by id, trees, tree keys, path differences), `history/collect.mjs` and
  `history/store.mjs` (the pass, `attempts.json`, the `jobs/` files, the call count), `lib/github.mjs` (the
  listings), the sandbox workflow (the mirror's credentials; by its own pull request), `test/history/`.
- Exposes: the job line; `gateAttempts(lines)` → attempts with result, scope, scope key, basis, tree key;
  `mirror.treeKey`, `mirror.paths(a, b)`, `mirror.isAncestor(a, b)`; `store.jobLines(fromDay, toDay)`;
  `store.covered(repo, day)`.
- Decisions: "Reading GitHub cheaply and completely" above is the contract, preflight first. Lines are written by
  completion day. The backfill is the same pass over a longer window, in batches, under the paced budget. Each
  repository's semantic trailers are listed by reading its own `ci-gate` script: a trailer is semantic when it
  changes which tests run or where, and not when it reports state.
- Does not touch: the per-test pass's lines and reports (it only takes its jobs from the shared fetch); causes;
  anything outside the paths above.
- Proves: acceptance 1, 2 and 8. Its tests pin: shard folding, a missing shard (incomplete), a copied shard read
  from a rerun's listing; a failed shard beside three passing ones; control jobs and summary parts; lane for each
  lane; `phase` for a setup failure, a test failure and a lost job; scope and scope key for a selected run and a
  vacuous event; two runs of one tree that differ in nonce and backlog trailers being comparable, two that differ
  in runner not, and two of unknown scope not; a rerun of a run created 20 days ago being found; a day of more
  than 1,000 runs; a pass's second batch making no listing call; work stopping at the call limit; a day with an
  open attempt not being covered; a pass interrupted between batches resuming without a missing or doubled line.

### M2 — The store kept small, watched, and fed by the hand-run gate

At its end the per-test lines are small, a stale store raises the kit's alert, and the hand-run gate's runs are in
the ledger.

- Touches: `history/record.mjs`, `history/store.mjs`, `history/collect.mjs` (the slim line, the one-time rewrite,
  the 35-day load; the marker `collected.json` at the store's root, written when a pass ends with every
  repository's work taken: the time, and per repository its last covered day); the sandbox's workflows, by their
  own pull request (`store-guard.yml`: daily on the pool, it reads the marker and, when it is older than 36
  hours, opens or comments on the sandbox's `ci-kit-alert` issue by the route `test-history.yml`'s alert step
  uses; and `test-history.yml`'s push: a rejected push fetches, rebases and pushes again, three times at most);
  `history/manual-gate.mjs` (run directories to `jobs-manual/` lines: `workflow: "manual-gate"`, `run` the
  directory's name, `job_id` the summary row's id, scope and scope key from the run's filter, environment and
  peers; the run's build as kind `control`; a job that bundles several groups written as one line per group,
  `job_id` `<row id>:<group>`, each with its own exit and its segment's minutes where the run's log has them,
  else the job's minutes on the first; a mini copy marked in its scope key, so it is an attempt of its own and
  never joins the direct job's; a refused or partial run as `incomplete`); `test/history/`.
- Consumes: M1's job line and store. Exposes: `jobs-manual/` lines readable through `store.jobLines`.
- Decisions: "The per-test record, kept small" above. The hand-run import is run on the MacBook by CI-opt
  (`node history/manual-gate.mjs --runs <dir> --store <dir>`, then a push that fetches and replays on a
  non-fast-forward). The retrospective's parser
  (`~/.local/share/ci-analysis/verification-retro-1119/scripts/`) is the reference for the directories' layout.
  The guard reads the collector's own marker and lives in the sandbox. *Rejected:* the store's newest commit as
  the sign of life (a hand-run import or a `known add` keeps it fresh over a dead collector), and ci-kit's pool
  guard as the place (its token reads issues and writes none, and this work grants nothing).
- Does not touch: causes; the report; `cli/`.
- Proves: acceptance 7's first half and 9. Its tests pin: a slim line answering `passed` when its hashes equal the
  base's, and `unknown` for a case a selected run left out and for a case it skipped; a store with old-shape lines
  read and rewritten; the import of a green run, a red run, a narrowed run and a refused run; a bundled job whose
  two groups ended differently; a mini copy and its direct job staying two attempts.

### M3 — Landings and causes

At its end every landing since 2026-10-22 has a landing line, every red gate attempt has a cause line, and both
are kept current by the daily run.

- Touches: `history/landings.mjs`, `history/cause.mjs`, `history/known.mjs` (reading and matching only),
  `history/collect.mjs`, `test/history/`.
- Consumes: M1's exposures and M2's lines. Exposes: landing and cause lines; `observations(gate)`.
- Decisions: the cause table and the landing definitions above are the contract. The pool's preemption record is
  read from the launcher's ledger only if that is one call a pass; otherwise rule 1 rests on annotations and
  corroboration, and Surprises & Discoveries says so.
- Does not touch: the report; `ci-gate`; `known.json`'s writing.
- Proves: acceptance 3 and 4. Its tests pin: each rule with the one above it not holding; a full red followed by
  a narrower green staying `unattributed` (`incomparable`); a setup failure by a broken lockfile staying
  `unattributed`; a job at its time limit not being lost; an attempt with one shard preempted and another failing
  an assertion not being `infra`; a superseded run; an amendment that drops a product edit and keeps a test edit
  being `product-diff`; a pull request whose check passed and whose later `ci-gate` push failed reading `green`
  by `pr_check`, with the push's own cause line; a head with no `pull_request` run reading `none`;
  `known` and `base_also_failed` appearing only as context; `case_match` in its three values; a landing whose tip
  is docs-only and whose push is not; a landing that changes only the excluded-path exception being not exempt;
  `head_green`; an in-flight `pr_check`; an override; an observation not used before its completion time.

### M4 — The weekly report and the status file

At its end the store holds a report for each of the last four ISO weeks per repository and a daily `status.json`.

- Touches: `history/report.mjs`, `history/status.mjs`, the sandbox workflow's steps (by its own pull request),
  `test/history/`.
- Consumes: M3's lines and `observations`. Exposes: `status.json`'s shape.
- Does not touch: `cli/`.
- Proves: acceptance 5. Its tests pin: a gate with one `unattributed` red is in neither list and its red is in
  "reds to read"; a gate with one `rerun-green` or `test-only-diff` red is a candidate with that red linked, and
  not a nomination; a gate with a `keep` entry is in neither; a gate with too little record is listed as such;
  an expired entry is listed and is not in `status.json`; summary parts' minutes roll up to their gate.

### M5 — `ci-gate`'s context lines and known entries

At its end a session sees the context lines at a failure, can record and list known entries, and can read any
repository's status.

- Touches: `cli/watch.mjs`, `cli/ci-gate.mjs`, `cli/args.mjs`, `history/known.mjs` (writing), `hooks/session-start.sh`,
  `docs/adopting.md`, the plugin's version, `test/`.
- Consumes: `status.json` and `known.json`.
- Does not touch: verdicts and exit codes; `.github/workflows/gates.yml`; MAWS.
- Proves: acceptance 6 and 7's second half. Its tests pin: no status, a stale status and an unreadable store each
  printing exactly today's output; a `keep` entry and an expired entry not printed; `known add` refusing an entry
  with no reason or no date; two adds whose reads raced both ending in the file.

M5 is this execution's last milestone: after its own proof it runs the whole acceptance section as written and
the kit's full suite through `ci-gate` on the branch.

### M6 — The per-test condensation report (a later sitting)

Not before the per-test record holds 14 days (about 2026-12-03), and not part of this execution. The parent
spec's M3 reports (`flaky`, `fail-first`, `condense`), with this spec's causes applied to a failing case. Its
section is written into this spec when it starts.

## Concrete Steps

From a ci-kit worktree, with a local clone of the store kept outside the repository (`git clone -b test-history
https://github.com/SSFSKIM/ci-kit-sandbox ~/.local/share/ci-kit/store`):

    node --test test/history/*.test.mjs                              # every milestone's focused tests
    node history/collect.mjs --store ~/.local/share/ci-kit/store --repo SSFSKIM/ci-kit --limit 40   # one small repository, gh's token
    node history/report.mjs --store ~/.local/share/ci-kit/store --repo SSFSKIM/doperpowers --week 2026-W47
    gh workflow run test-history.yml -R SSFSKIM/ci-kit-sandbox -f ci-kit-ref=gate-ledger   # the real pass, on the pool

The last is how every acceptance item's collection is made. `ci-kit-ref`, `limit` and `budget` are the dispatch
inputs M0 added.

## Surprises & Discoveries

- Observation: the per-test collector failed every day from 2026-10-22, 28 days, and the store held one day.
  Through 11-10 it ran out of memory; from 11-11 the account's billing lock refused the hosted job. Nothing
  alerted. The memory grew with the backlog because every id kept from a report was a substring of the report's
  text, which Node keeps whole while any substring lives.
  Evidence: `gh run view 42455727941 -R SSFSKIM/ci-kit-sandbox --log-failed` ("Reached heap limit"); M0's local
  check (2 ids from each of 30 reports held 85 MB; copied, 10 MB). Per-test history before about 11-12 is gone.
- Observation: a per-test run line is about 185 KB and the store grows about 10 MB a day.
  Evidence: proof run 44486730875: 349 lines, 64 MB, peak memory 281 MB with nothing to parse and 616 MB at the end.
- Observation: requiring gates costs almost nothing where they already run on pull requests.
  Evidence: `gate-observe-1119/report.md`: 576 merges in four repositories, 22 would have been held, 18 of them
  only until a running job finished; manim-master, which already required `ci / verdict`, had none.
- Observation: no change loosened its own gates. Evidence: the same report: 14 pull requests edited their gate
  definitions, none removed a gate that applied to it without a replacement. Reading definitions from the base
  branch, the retrospective's first proposal, was dropped.
- Observation: a required check on a pull request does not prove the landed tree ran. In the measurement's sample
  the head's tree differs from the landed tree for 81 of 207 manim-master pull requests and 33 of 184 in
  doperpowers (the base had moved). Evidence: the adversarial review's count over `merges.tsv`. This is why a
  landing has two verdicts.
- Observation: in MAWS, most landings outside `docs/` in the window went to master on a merged tree that never
  ran, with the branch head gated; the architect read it as a real gap until 11-16 and now gates the tree he
  pushes. The first count (79 of 309) took a push's tip alone as what landed and ignored all of `docs/`. Recounted
  by hand with each push's whole difference and MAWS's path policy: 880 pushes, 465 exempt, and of the other 415,
  170 with the three gates green on the pushed tree, 124 with some of them, 85 with no green run on the pushed
  tree while the branch head had one (by week 42, 31, 4, 8), 23 direct pushes with none, 13 with none at the head
  either. That recount still credits any succeeded run whatever its scope, which the ledger does not; acceptance 4
  records the ledger's counts beside these. Evidence: `gate-observe-1119/maws-93-split.tsv` (the first count) and
  the recount's output in this spec's commit message.
- Observation: a pull request's check and a `ci-gate` push for the same head are different records, and the hand
  measurement mixed them. doperpowers' pull request 410 was counted red; its check passed (run 40596123672) and
  the red was a `ci-gate` push six minutes later (run 40596797028).
  Evidence: `gh api repos/SSFSKIM/doperpowers/actions/runs/<id>` for both.
- Observation: a GraphQL check run names no runner, no labels and no attempt, so the lane and a copied shard can
  only be read from the REST listing of an attempt's jobs. Evidence: GitHub's GraphQL reference for `CheckRun`;
  the measurement's query (`gate-observe-1119/scripts/common.py`) read names, outcomes and times only.

- Observation: M1's preflight (App token, on the pool; sandbox `ledger-preflight.yml`, runs 44498395656 and
  44499134717). MAWS, manim-master and ci-kit: the run listing by creation day, both attempts' jobs of a failed-jobs
  rerun, the default branch's activity, the tree-only mirror (at most 19 MB and 2 s), a nonce commit fetched by id
  after its ref was gone, and `refs/pull/<n>/head` all read. Four things the design had wrong or did not know:
  (1) a failed-jobs rerun's listing gives every job the new attempt's number and a new id; a carried-over job is
  told only by `completed_at < created_at` (MAWS 44468141412: 16 of 18 jobs; manim-master 42450145084: 4 of 6;
  ci-kit 40122425522: 1 of 3). (2) The App is not installed on doperpowers or cua; every read fails at minting.
  (3) Annotations answer 403 on the private manim-master (Checks read needed); its job logs read. A lost runner's
  job has no log (404). (4) A merge by the pull request button is activity `pr_merge`, not `push`: ci-kit's newest
  `push` on main is 2026-10-21. Also: the run listing carries the head's tree, message and pull requests, so
  trailers need no per-run call; MAWS's `static` summary and `plan`, `docs`, `e2e:cross-build` run on hosted
  runners (MAWS is public, so the billing lock does not stop them).
  Evidence: the runs' logs, saved under `~/.local/share/ci-kit/gate-ledger/`; M1's report.

- Observation: M1's build and backfill. A `pull_request` run's listing almost never names its pull request (ci-kit:
  275 such runs in 35 days, none with a `pull_requests` entry), so its change falls back to `branch:<head_branch>`.
  The sandbox run's `GITHUB_TOKEN` reports 5,000 calls an hour on this account, not the documented 1,000; the
  collector still paces it at 800. The backfill took about six hours of collection (about 1.8 calls an attempt in
  MAWS, plus one relisting per dispatch), drained by run 44643104737; the daily-shaped run 44649983576 then made 199
  App and 82 `GITHUB_TOKEN` calls. 29 transient failures (502s on job listings, two network errors) stayed queued
  and closed on a later batch. Lines at the end: MAWS 38,419, manim-master 8,216, ci-kit 1,582, doperpowers 13,668,
  cua 6,603; every repository covers each of the 29 days from 10-22. The retired Hetzner pool's runners appear in
  October (lane `pool-hetzner`); 877 MAWS jobs cancelled before any runner have no lane and 0 minutes.
  Evidence: M1's report, part 3; store commit 88f04d1.

- Observation: around 2026-11-01 09:00Z (the US fall-back hour) GitHub stamped jobs completed before they were
  created: 117 first-attempt lines. They are not copies (a first attempt has none); their raw stamps are kept and
  their minutes may read 0. Left as is: one hour of the record. Evidence: M1's report, part 4.

- Observation: M2. The per-test record went from 75 MB (392 lines over 9 days) to 1.0 MB; 390 lines rewritten, none
  failing its hash; the rewrite took 334 MB peak in the pool's batch (run 44663851867). ci-kit `main`'s collector
  never reads a held line's membership, so it runs on the small store unchanged (proved by running main's own
  `store.mjs`, `record.mjs` and `provenance.mjs` against a rewritten copy). The hand-run record: 360 run directories,
  211 with a summary, 752 lines; 149 directories were planned and never sent to the mini and write no lines.
  `node --test test/history/` fails to resolve a directory on this Node 22; `node --test test/history/*.test.mjs`
  runs the files. Evidence: M2's report.

- Observation: M3's acceptance 3 on the record (store d66d56b, collection 44676449415). `infra`: MAWS 44468141412
  `static` (a `runner-lost` part; the summary's failure beside it is the part's), 44478359816 `e2e:desk-web` and
  44476737149 (corroborated on their trees); 44472434480 is `setup-uncorroborated` (acceptance 3 revised).
  `superseded`: doperpowers 44489998299 (pull request 532) by 44490765334. `unattributed`: doperpowers 42817698515
  `mods-types` (`basis`, pull request 481 merged red); MAWS 41995538110 `e2e:library` (`setup-uncorroborated`).
  Read on GitHub, none contradicting its label: `rerun-green` doperpowers 44479636843 → 44482863597 and cua
  44499632695 → 44502837065 (same trees); `test-only-diff` doperpowers 44508395215 → 44511346953 (a test script)
  and ci-kit 40844185287 → 40845071091 (a test file); `product-diff` doperpowers 44517481738 → 44520503188 (a
  product script and a test script) and ci-kit 40012863651 → 40013078049 (the launcher and a spec doc).
  The pool's preemption record is not read: it is comments on the sandbox's pool-ledger issues, hundreds a day, not
  one call a pass. A GCE preemption fails its running step ("The operation was canceled."), so it stays `failed` and
  usually reads `rerun-green` after the launcher's rerun.
  Evidence: M3's report, "Acceptance 3".
- Observation: acceptance 4, `pr_check` beside the hand measurement (10-22 to the hand's cut-offs). doperpowers:
  hand 184 (165 green, 2 red, 17 unrun), ledger 183 landed (139 green, 2 red, 38 unrun in flight, 4 none) and 370
  missing. ci-kit: 116 (113, 0, 3) against 116 (107 green, 9 in flight). cua: 69 green against 68 green and 1 in
  flight. manim-master: 207 (188 green, 19 none) against 204 green, with 121, 122 and 169 missing. Every difference:
  - in flight at the merge, the hand having taken a `ci-gate` push's green: doperpowers 338, 339, 348, 374, 382,
    383, 398, 401, 402, 419, 423, 424, 429, 431, 441, 442, 445, 448, 450, 479, 509, and 427 and 428 (whose checks
    then went red); ci-kit 98, 148, 162, 169, 176; cua 262;
  - merged in the seconds between the last gate job and the verdict job: doperpowers 380, ci-kit 139;
  - no `pull_request` run of the head yet at the merge (`none`): doperpowers 365, 366, 524, 528;
  - red at the merge, the hand having taken a push's green: doperpowers 426;
  - a push's red, the check green: doperpowers 410 (the spec's case);
  - a gate the base's config required and the head's check did not run, the check green: doperpowers 336, 463;
  - none required by the hand, the verdict job run and green: manim-master 109, 117, 123, 132, 135, 138, 141, 191,
    197, 219, 223, 228, 253, 255, 280, 281, 298 (17 of them `exact: exempt`);
  - no landing: manim-master 121, 122, 169 (not on master's first-parent line, by the hand's own note) and
    doperpowers 370, whose merge GitHub's activity listing lacks: the next event's `before` is its commit and the
    event before ends elsewhere. It is the only real chain break in the five repositories; the listing's times are
    also out of order at the 2026-11-01 fall-back hour.
  `exact`, different by design: doperpowers 91 green, 1 red, 94 unrun (15 `head_green`); ci-kit 49 green, 67
  unrun (9); cua 38 green, 31 unrun; manim-master 64 green, 17 exempt, 123 unrun (60). MAWS, counts only: 884
  landings (863 `push`, 21 `pr_merge`; the recount 880 pushes), 465 exempt (465), 419 others (415): 206 green, 2 red,
  211 unrun (98 with some of the three gates green on the tree, 113 with none; 54 `head_green`), against the
  recount's 170, 124 and 121. The tree key carries almost all of the difference (by tree id: 123, 116, 180); scope
  changes nothing in this window; latest attempt against any green moves one landing.
  Evidence: M3's report, "Acceptance 4".
- Observation: MAWS's attempts cancelled from outside with no later run for their ref or change: 1,751 (1,236 never
  got a runner), mostly a session interrupting `ci-gate`; cua 61, doperpowers 10, manim-master 17. Read as reds they
  would have been 1,452 `unattributed` and 193 `product-diff` (an interrupted gate credited with a catch). MAWS's
  sessions give each retry a new label, so 1,032 of its 1,100 failed `no-later-green` reds have no later attempt in
  their change: rules 3 and 4 seldom apply there. doperpowers' sessions merge before the check ends, having gated the
  head by a `ci-gate` push (38 of 183 in flight). Evidence: M3's report, Discoveries.

## Decision Log

- Decision: verification. The spec is reviewed by `doperpowers:adversarial-reviewer` for design and buildability
  before execution; each milestone by the task reviewer; the branch by `doperpowers:review-code` at medium.
  Rationale: tooling that cannot turn a run red; the costly mistakes are a wrong count believed, a failure called
  harmless, and a private name printed, and acceptance 2 to 5 and 8 check those against the real record.
  Date/Author: 2026-11-19, CI-opt.
- Decision: `ci / verdict` required on cua, doperpowers and ci-kit (strict off, admins not enforced, a pull request
  required with no approvals), auto-merge allowed on those and manim-master. Rationale: the owner's choice on the
  measurement. Rollback: `gh api -X DELETE repos/SSFSKIM/<repo>/branches/main/protection`.
  Date/Author: 2026-11-19, the owner; applied by CI-opt.
- Decision: the adversarial review's 15 findings are all taken, and they changed the design's shape, not only its
  details. The unit of evidence is the gate attempt with a scope and a tree basis, not the job; a cause is what the
  record proves and otherwise `unattributed`; a failure on the base and a known entry are context, never a cause;
  nominations require every red explained; a landing is a push with its whole difference, judged by MAWS's own
  path policy and by two verdicts; trees and paths come from a mirror, runs from creation windows and an attempt
  index, jobs from GraphQL; the hand-run gate and known entries have files of their own. Rejected alternative:
  keeping the first draft's job-level rules with caveats in the report. Three of them could call a real failure
  harmless (one green shard; a narrower rerun; a different test red on the base), which is the opposite of what
  the ledger is for.
  Date/Author: 2026-11-19, CI-opt.
- Decision: per-test run lines drop per-run membership (the parent spec's "exact per run"). Rationale and what it
  gives up: "The per-test record, kept small". Date/Author: 2026-11-19, CI-opt.
- Decision: the review's second pass is folded and is the last. What changed: jobs are read by the attempt's REST
  listing, once, shared with the per-test pass (a GraphQL check run has no runner and no attempt), with discovery
  once a pass, covered days, and a budget from the measured counts; each unsuccessful job is read as lost or
  failed before an attempt is `infra`, and a time limit is not lost; the causes are named for observations
  (`rerun-green`, `test-only-diff`, `product-diff`) and only an infra-only gate is nominated, the others being
  candidates to read; the scope key takes semantic trailers only; `pr_check` is the verdict job's own result; a
  repository without the activity listing has no landing record; a slim per-test line answers `passed` only on
  equal hashes; the stale-store guard reads the collector's marker from the sandbox; the hand-run import's rows
  follow the real run. Not taken: proof that a newer run caused a cancellation (a cancelled run with a newer run
  for its ref is counted as superseded cost either way, and is never a red), and a base identity for gates that
  compare with the default branch (a known limit, named in the report). Rationale for stopping: the second pass
  found faults in what the first revision added, each with a concrete counterexample; those are now pins, and a
  third pass would review their wording, which the milestone reviews do against code.
  Date/Author: 2026-11-19, CI-opt.

- Decision: the preflight's four findings resolved in place (2026-11-19, M1). A copy is read by
  `completed_at < created_at`, and `copied_from` is the latest earlier attempt with a non-copied job of that name.
  doperpowers and cua, public, are read with the sandbox run's `GITHUB_TOKEN` (`token: "actions"` in
  `history/repos.json`, proved by the preflight before use), not by adding them to the App's installation: the App
  holds Actions write, Administration write and Issues write, so installing it there is a grant on two more
  repositories, which "What it must not be" excludes. Where annotations are refused the log is read; where neither
  exists rule 1 rests on phase and corroboration, which leaves more `unattributed`, the safe direction. A landing
  is any of the four activity types that move a branch. Until this branch merges, the daily scheduled run runs
  ci-kit `main`, so the ledger's collections in this execution are dispatched with `ci-kit-ref=gate-ledger`.
  Date/Author: 2026-11-19, the executing session.

- Decision: M1's gaps, as built. The ledger's pass is `history/ledger.mjs`, called per repository by
  `collect.mjs`; its store is `openLedger(root, alias)` in `store.mjs` (`jobLines(from, to)`, `covered(day)`), apart
  from the per-test `openStore`, which loads every per-test line. A job line also carries `tree_key` (equal to
  `tree` without a path policy; `null` on `pr-merge`), so `gateAttempts` stays pure over lines. Lanes come from the
  runner's name, then a hosted label; a job that never got a runner has no lane and 0 minutes; `pool-hetzner` names
  the retired pool. MAWS's names: `plan` and `e2e-build*` are `control`; `static` is its summary job and its parts
  together; a `(mini copy)`, `(mini overflow)` or `(EC2 overflow)` job is its gate with the variant in the scope
  key; Actions' bundled mini copy is one gate `e2e:a+b`; a name GitHub left unexpanded is `control`. A
  `workflow_dispatch` run of MAWS is scope `unknown` (its inputs are not in the record: `opaque_events`). MAWS's
  semantic trailers: `Runner`, `Class1a`, `Lane`, `Hosted-Route`, `Selection`, `Affected`, `DefaultBeside`, `Live`,
  `Peer`, `MiniCopy`; the ci-kit repositories have none. Budget: per token kind, a pass cap (App 1,500, Actions 600)
  and an hour cap (2,000, 800) counted in `attempts.json` across batches; a dispatch's `calls` input lifts the pass
  cap for a backfill. The per-test pass takes its jobs from the ledger's shared fetch and sweeps the runs the ledger
  closed in the batch. Until merge the sandbox passes the ledger's settings as environment, which `main`'s collector
  ignores. Date/Author: 2026-11-20, the executing session (M1's executor; folded by the controller).

- Decision: M1's task review folded (2026-11-20). The call budget is checked before every REST request (pagination,
  retries and the per-test pass included); reaching it is not an error but `more` with a wait, and a real
  rate-limit answer stops the pass resumably. A gate attempt is `succeeded` only with one shard count n and every
  shard 1..n. A gate attempt all of whose jobs are copies carries `copied: true` and is not an execution: no cause,
  observation, attempt count or later green reads it. Every gate attempt carries `available`, the completion of its
  latest fresh job; a copy line is filed on that day, so any window holding an attempt's fresh jobs folds it whole.
  A job of a first attempt is never a copy (GitHub stamped jobs completed before created near the 2026-11-01
  fall-back hour). A summary job's line carries `role: "summary"`: it counts toward the result, not toward minutes
  or lanes. Platform kinds are matched on the platform's own messages only (exact annotation text; the runner's
  `##[error]` lines in a log's tail), and an ambiguous line is left unclassified. Errors print the request's method
  and path, never a response body, git's stderr or an exception's message. The per-test sweep marks a run swept
  only after a batch that reached it cleanly. Date/Author: 2026-11-20, the executing session.

- Decision: M1's second review folded (2026-11-20). Kinds read from a job's log are kept in `log_kinds`, apart from
  `annotations`, and M3 counts a log's `runner-lost` as lost only with phase `lost`; `not-started` is taken only from
  the billing messages on a job that never started (no runner, no step that ran). A copy is filed on its own gate's
  `available` day. After a real rate-limit answer the token is not used again in that pass, in any repository or
  phase (`pass.rate_limited` in `attempts.json`). A stop at the hour's cap is `more` with a wait; at the pass's cap,
  a clean end. Date/Author: 2026-11-20, the executing session.

- Decision: M2's gaps, as built (2026-11-20). The live store was made small now, not at merge (main's collector is
  indifferent to it); until merge the daily run writes old-shape lines, which the branch's collector makes small when
  it loads them. A one-time rewrite is marked by `<alias>/record.json` and runs before the per-test pass. A small
  line answers `failed`, `passed` or `unknown`; one that does not rebuild to its hash keeps counts with `hash: null`.
  The marker is written only by a batch over every repository that leaves none queued, pending, unclean or
  rate-limited. Hand-run lines: `run` the directory's name, `event: "manual"`, `change: null` (no change is followed
  across hand-run runs), a job never run or with no tests has `conclusion: null`, and `gateAttempts` reads a null
  conclusion as incomplete unless another job failed. The hand-run scope key also holds the place (host or guest), the
  live flag and a script override: they decide where or what ran (the Glossary's rule), and the safe direction is
  fewer comparable pairs. The mini's statuses 4, 5, 6 are `runner-lost`, 124 `time-limit`, 7 (memory) unclassified.
  A bundle's groups take their times and exits from the runner's step markers in the job's log. Tree keys of hand-run
  lines are read from MAWS's local clone, read only. The guard has its own issue title and runs at 12:00 UTC.
  Date/Author: 2026-11-20, the executing session.

- Decision: M2's task review folded (2026-11-20). Every store file is written to a temporary file beside it and
  renamed into place, and the workflow never commits `*.tmp` (the sandbox pushes even after a collector's exit 1, so
  an in-place short write could have published a truncated file; this supersedes M1's recorded non-atomic writes).
  The guard arms itself: it checks the marker only once ci-kit `main`'s `history/collect.mjs` writes
  `collected.json`, so the merge arms it; a `force` dispatch checks either way; a marker time that does not parse or
  lies ahead of the clock is unreadable. A bundled group's result comes only from its own `steps.tsv` slot and the
  tests in its segment: none of its own is no conclusion, and only a shared setup failure before any group ran
  applies to all; its minutes are its slot's, and the bundle's overhead is charged to no group. A re-import keeps a
  line's tree key when it cannot compute one for the same tree, and replaces a job's line on whatever day it was filed.
  Date/Author: 2026-11-20, the executing session.

- Decision: M2's second review folded (2026-11-20). A bundled slot's exit is its test's, whatever the value; only
  the job's supervisor status gives `runner-lost` or `time-limit`. Without a `steps.tsv` row the group's own log
  markers decide; an ended slot without log times takes the job's end; a slot that started and never ended is
  charged to the job's end with no conclusion. Left as is: such an interrupted slot has no `available` (the record
  holds none), and a re-import's cross-day move writes the source before the destination (a re-import with
  `--git-dir` restores any key lost to a failed write). Date/Author: 2026-11-20, the executing session.

- Decision: an attempt cancelled from outside with no later run is `cancelled`, not a red (2026-11-20, M3). The spec
  left it to the rules, which made 1,751 MAWS interruptions into reds and credited 193 of them with a product catch.
  A cancellation is someone's act and shows nothing of the product, as `superseded` does; a job at its time limit is
  never one. Its minutes are cancelled cost. Rejected: keeping them reds flagged `cancelled: true` for M4 to set
  apart: every reader would need the flag, and a missed one counts an interruption as a catch.
  Date/Author: 2026-11-20, the executing session.
- Decision: M3's gaps, as built (2026-11-20). `history/derive.mjs` reads the store, lists activity, fetches the
  mirror and writes landings and causes; `cause.mjs` and `landings.mjs` stay pure. Superseded is by a later run for
  the ref or the change (MAWS makes a ref per commit). A job cancelled before any runner took it is never lost by
  corroboration. A summary job that failed beside a failed part is the part's failure. Phase is re-read from
  `failed_step`, and MAWS's `setup_steps` add `Set up runner`, the browser install, `download-artifact` and
  `cache/restore`. Rule 1's corroboration for `pr-merge` uses rule 2's sameness. `why` adds `unreadable` (the next
  green exists, the mirror could not read the difference), and its order is `setup-uncorroborated`, `basis`,
  `incomparable`, `no-change`, `unreadable`, `no-later-green`. A cause line is keyed by (run, attempt, gate, scope
  key), filed by `available`. `pr_check` reads the latest `pull_request` run of the head created before the landing,
  its latest attempt begun before it; a run created after is `none`. Standing is the observation of the newest landed
  tree usable before the reader's time, `{ result, commit, at, run, attempt, tree_key, landed }`. The activity
  listing refused (not a rate limit) leaves a repository with no landing lines; a listing cut short leaves the
  base's movement unknown to rule 2. A known entry's `case` is `<file> › <title>` (file whole or by name), `*`
  matching anything, in force from `since` through `review_by` inclusive. The mirror fetches `refs/pull/*/head`
  once a pass, and a pull request run's change is resolved to `pr:<n>` per branch when lines are read (doperpowers
  241 of 241, ci-kit 25 of 25, cua 105 of 105, manim-master 144 of 155), else `branch:`. `Merge pull request #n:
  <title>` names its pull request. A dispatch's `derive-from` recomputes from a day. Date/Author: 2026-11-20, the
  executing session.

## Outcomes & Retrospective

Pending — written at finish.
