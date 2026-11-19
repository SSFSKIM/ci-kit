# The gate ledger: what each gate costs, what it catches, and what landed without it — living spec

**Date.** 2026-11-19. **Status.** Design approved by the owner (2026-11-19, "설계안 전체"); revised the same day
after its adversarial review (Decision Log). Author: CI-opt.
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
- **Every red gate attempt carries what the record can prove about its cause**, and says so when it can prove
  nothing: infrastructure, flaky, fixed by changing a test, fixed by changing the product ("caught"), or
  unattributed with the reason it could not be attributed.
- **A weekly report per repository** shows, per gate, runner minutes and reds by cause. It nominates a gate for
  removal or demotion only when every one of its reds is explained and none was a catch; reds it could not
  attribute are listed for a person to read. A person decides; CI never removes a check.
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
  know. Neither tells a session that a failure may be ignored. The review of this spec showed three ways a
  rule-made label could call a real failure harmless (one passing shard, a narrower rerun, a different test
  failing on the base); wherever the record cannot exclude those, the answer is `unattributed`.
- **No check removed or quarantined by CI.** The report nominates. A check that guards a rare but costly failure is
  marked `keep` with its reason and is not nominated.
- **No test name, file or message in a public place.** MAWS's record is treated as private whatever the
  repository's visibility is: the store is the private sandbox's branch, and every log line this code prints in
  Actions carries counts only (the parent spec's rule).
- **No new credentials or permissions.** The collector uses the ci-kit GitHub App with the permissions it has
  (Actions read, Contents read); local commands use `gh`'s token. A design step that needs more is redesigned, not
  granted (M1's preflight decides which of two listed routes each repository uses).
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
  `version-bump` on a dispatch); `unknown`. The **scope key** adds what else distinguishes one execution from
  another: the nonce message's trailers other than `Gates`, and for the hand-run gate its filter, environment and
  peers. Two attempts are **comparable** when gate and scope key are equal.
- **Tree basis.** `exact`: the run tested exactly the tree recorded (a ci-gate ref, whose nonce commit is empty; a
  push to a branch). `pr-merge`: a `pull_request` run, which checks out GitHub's merge of the head into the base
  of that moment; the head's tree is recorded and the tested tree is not known.
- **Change.** For a ci-gate ref, its producer and label, unless the label is one a repository uses as a fallback
  for unrelated targets (`gate` in ci-kit's own `ci-gate`; the list is in `history/repos.json`), in which case the
  attempt has no change. For a `pull_request` run, the head branch's name.
- **Lane.** Where a job ran: `pool-gce`, `pool-ec2`, `mini-host`, `mini-guest`, `hosted-linux`, `hosted-macos`, or
  `manual-host` / `manual-guest` for the hand-run Mac gate.
- **Landing.** One update of a default branch: a push event with its `before` and `after` commits, from the
  repository activity API. What landed is the difference between the two, whatever the tip commit alone changed.
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
- [x] (2026-11-19 09:4xZ) Adversarial review: 12 blocking findings and 3 lesser, all taken (Decision Log).
- [ ] M1 — Job lines.
- [ ] M2 — The store kept small, watched, and fed by the hand-run gate.
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
   `pool-gce`, conclusion `success`, basis `exact`, and `e2e:desk-web` at 7.6 minutes (08:18:10Z to 08:25:45Z).
   All five repositories have job files for every day from 2026-10-22 on which they ran a gate.
2. **A gate attempt is not greener than its worst shard.** MAWS run 39962530337, attempt 1: `unit 2/4` failed and
   the other three shards passed after it. The gate attempt `unit` is `failed`, and nothing derived from it
   (cause, landing evidence, standing) reads it as green or as flaky.
3. **Causes say what the record shows, on cases whose cause is known.**
   - `infra`: MAWS run 44468141412's first `static-local` (runner lost in the setup step; the rerun got past it)
     and run 44472434480's `e2e:desk-web` (cancelled inside `playwright install`; its rerun got past it).
   - Not red at all: the jobs of a pull request run cancelled because a newer push superseded it (the executor
     names one from the store) are `superseded`.
   - `unattributed`: doperpowers pull request 481's `mods-types` failure of 2026-11-10 12:40Z (merged red: no later
     attempt in its change), and a setup failure that no later attempt on the same tree got past (the executor
     names one, or records that the store has none).
   - For `flaky`, `test-changed` and `caught` the executor of M3 takes two labelled attempts of each from the
     store, reads the runs behind them on GitHub, and records all six with their evidence in Surprises &
     Discoveries. A label the reading contradicts is a defect.
4. **The landing record reproduces the hand measurement, where their definitions agree**, for 2026-10-22 to
   2026-11-19. By the pull request check (the semantic GitHub's required check enforces): doperpowers 184 merged
   pull requests, 165 green, 2 red (410, 481), 17 unrun of which 15 in flight at the merge; ci-kit 116: 113, 0, 3;
   cua 69, all green; manim-master 207: 188 green and 19 with no gate required. The three doperpowers commits
   pushed with no pull request (f2c78808, 74ff0ff4, 06d4ea08) are landings and are `unrun`. For MAWS, and for
   "did the exact landed tree run" in every repository, the ledger's own definitions differ from the hand
   measurement's (push diffs, the path policy, full scope only); the executor records both sets of counts and what
   each difference comes from in Surprises & Discoveries.
5. **The report reads, and does not nominate what caught something.** `node history/report.mjs --store <dir> --repo
   SSFSKIM/doperpowers --week 2026-W47` prints a Markdown report with a row per gate and the sections of "The
   report" below. No gate with a `caught` or an `unattributed` red in its window is in the nominations; no gate
   that `~/.local/share/ci-analysis/verification-retro-1119/reds.md` credits with a product catch is nominated in
   MAWS's report.
6. **`ci-gate` gives context and changes nothing else.** With a status file in which gate `test` last failed on
   the default branch, `ci-gate` on a commit whose `test` fails prints the FAIL line followed by a `base:` line
   naming the commit, the time and the run. Verdict and exit code are as today. With no readable status file, or
   one older than 48 hours, the output is byte for byte today's.
7. **The hand-run gate is in the ledger and a MAWS session can read it.** After `history/manual-gate.mjs` imports
   run `24952ff2f8a4-20261119T054617Z` (RED 3/5), the store has its five job lines with their scope keys, and
   `ci-gate status --repo SSFSKIM/MAWS` prints MAWS's standing per gate and its known entries.
8. **Nothing public names a test.** The Actions log of the collection run that produced 1 to 5 contains no MAWS
   test name, file or message (`gh run view --log | grep` for three names taken from the store returns nothing).
9. **A dead collector is noticed.** With the store's newest commit made older than 36 hours (the check pointed at a
   test branch that is), ci-kit's guard workflow opens or updates the kit's alert issue.

## Design

### One collector, one store, more kinds of line

The per-test record already has the right home: a daily run in the private sandbox, ci-kit `main` as the code, the
App token, a branch as the store. The ledger adds files beside `runs/` under each `<owner>/<repo>/`:

| File | Holds | Written by |
|---|---|---|
| `attempts.json` | which (run, attempt) pairs are collected, and which are still open | M1 |
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
- **Jobs.** Read through GraphQL: the check runs of each run's head commit, with their steps and up to five
  annotations, batched many commits to a query. The measurement read every job of every attempt of 28 days of five
  repositories in about 190 queries (`gate-observe-1119/scripts/common.py` is the reference). *Rejected:* the REST
  jobs endpoint, one call per attempt: 8,367 attempts in the backfill.
- **Trees, ancestry, paths.** From the mirror, not the API. A run's nonce commit is fetched by id, which brings the
  tested commit with it; a pull request's head is fetched from `refs/pull/<n>/head`. The compare endpoint is not
  used: it lists at most 300 files and, for two commits where neither descends from the other, lists the later
  one's changes since their common ancestor, which hides a product edit that an amendment dropped.
- **Preflight.** M1 opens by proving, with the App token on the pool, for each of the five repositories: the run
  listing, the GraphQL check runs with steps and annotations, the activity listing of the default branch, the
  mirror clone, and a fetch by commit id of a nonce commit whose ref is gone. Its results go into Surprises &
  Discoveries. Where the activity listing is refused, that repository's landings are read from the mirror's
  first-parent history with the committer date as the time, and its lines say `time_basis: "commit"`.

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
- **`annotations`** are kept only when they match the kit's list of platform messages (the job was not started for
  billing; the runner lost communication; the operation was cancelled at the job's time limit), as the matched
  kind, never the text.
- **`copied_from`** names the earlier attempt whose shard a failed-jobs rerun carried over; such a line has no
  minutes.
- Skipped jobs are not written. Lines are idempotent by (run, attempt, job id).

### What a red gate attempt's cause is (M3)

A cause line is `{ run, attempt, gate, cause, why, evidence, context }`. Cancelled jobs of a run that was itself
cancelled while a later run existed for the same ref or head branch are `superseded`: they are not reds, and their
minutes are reported as superseded cost. For every other gate attempt that failed, the first rule that holds
decides:

| # | Cause | Holds when |
|---|---|---|
| 1 | `infra` | the pool's record says the job's runner was preempted; or an annotation of the platform kinds is present; or the attempt stopped in `setup` or `lost` and a comparable attempt on the same exact tree later got past that phase |
| 2 | `flaky` | the attempt failed in `test`, and a later comparable attempt on the same exact tree succeeded (every shard) |
| 3 | `test-changed` | the change's next comparable attempt that succeeded has a tree whose difference from this one, read from the mirror, lies wholly in paths matching the repository's `test_globs` |
| 4 | `caught` | the same, with any other path in the difference |
| 5 | `unattributed` | none of the above; `why` is one of `no-later-green` (the change ended red, or was abandoned), `setup-uncorroborated`, `timeout-uncorroborated`, `incomparable` (only attempts of another scope followed), `no-change` (no label to follow), `basis` (a `pr-merge` attempt, whose tree is not known, with no later attempt in its change) |

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
- *Not decided by rule:* whether a `caught` was a product bug or a scene an intended change had made wrong. The
  retrospective told those apart by reading. The report says so beside the count.

### A landing (M3)

A landing line holds the push event (`before`, `after`, time, `time_basis`), the tree and tree key of `after`,
the paths between `before` and `after`, the pull request number when the tip's message names one, the gates
required of it, and two verdicts.

- **Required gates.** In the ci-kit repositories: what ci-kit's own planner selects from `before`'s
  `.github/ci-kit.yml` for event `pr` and the landing's paths (`plan/config.mjs` `parseConfig` and
  `plan/select.mjs` `selectGates`, called as libraries, with the file read from the mirror). In MAWS: the
  `required` list in `history/repos.json` (`static`, `unit`, `probes`). A landing all of whose paths the path
  policy excludes is `exempt`.
- **`exact`: did the landed tree run.** For each required gate, the latest comparable-to-`full` gate attempt, with
  `basis: "exact"` and scope `full`, on the landing's tree key, completed before the landing. `green` when each
  succeeded; `red` when one failed; `unrun` otherwise, with `head_green: true` when the tip has a second parent
  whose tree key has them all green (a branch was gated and the merged tree was not).
- **`pr_check`: what a required check would have seen**, in the repositories that merge pull requests: the same,
  over the `pr-merge` attempts of the pull request's head commit (the tip's second parent, or
  `refs/pull/<n>/head` for a squash). `green`, `red`, or `unrun` with `inflight: true` and the job's eventual
  conclusion when it was running at the landing.
- **Override.** A landing whose tip message has a line `Ship-with: <reason>` carries the reason. This is how
  "ship with it" is said where a check is required: `gh pr merge --admin --body "Ship-with: <reason>"`, which
  writes it into the merge commit. *Rejected for now:* a `known_red` attribute on a gate in `.github/ci-kit.yml`
  that would make `verdict` pass. It changes what a green verdict means for every consumer, for a case the record
  shows 4 times in 576 merges; the report counts overrides, and that count is the argument if it grows.
- **Standing.** Each gate's observations on the default branch are the full, exact gate attempts on landings'
  tree keys and on default-branch push runs, each with the time it completed. An observation is used only by
  readers later than that time, and a landing with no observation leaves the previous one standing with its own
  commit and time, so a reader always sees which tree a standing is about and how old it is.

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

1. **Per gate:** attempts, runner minutes by lane (the Mac's apart), superseded minutes, reds by cause.
2. **Reds to read:** each gate's `unattributed` attempts, newest first, with their `why` and run links. This is the
   list a person reads to learn what a gate is really catching.
3. **Nominations:** a gate is nominated only when its window is covered (lines on at least 21 of the 28 days it
   could run and at least 20 attempts), it has no `caught` and no `unattributed` red in the window, and no `keep`
   entry. The line gives its runner minutes a week and its reds by cause, and says which lane they free. A gate
   that fails the coverage test is listed as "too little record", never nominated.
4. **Landings:** counts by both verdicts; each landing that was `red`, `unrun` and not in flight, or `head_green`,
   by commit; each override with its reason.
5. **Known entries:** in force, expiring within a week, expired.
6. **What the record cannot say:** the `caught` caveat; lanes with no lines that week; repositories whose landing
   times are commit times.

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

- A run line that is not its day's base keeps its counts, the hash of its ids, its failed cases and its skipped
  count; it no longer stores membership. A reader that asks whether a case ran and passed in such a run answers
  yes when the run's report is present, the case is in the day's base, and the case is not among the run's failed.
  *What this gives up:* a case deleted on a branch reads as passed there, which the parent spec rejected a daily
  snapshot for. Measured, the exactness costs 50 times its estimate, and the error it admits can only add a
  passing observation for a test that no longer exists, which no report acts on.
- Existing lines are rewritten once to the new shape. A pass loads the lines of the last 35 days only.

## Plan of Work

Constraints on every milestone:

- Node's built-ins, `git`, and the kit's vendored `yaml` only; tests are `node --test`, beside the existing ones in
  `test/history/`.
- A collection's Actions log prints counts only (acceptance 8).
- A daily pass stays under 600 REST calls and 100 GraphQL queries for all repositories together; the backfill is
  paced under 2,000 calls an hour. A repository in `history/repos.json` with no `jobs` list of reporting jobs takes
  no part in the per-test pass.
- The collector keeps what M0 gave it: bounded batches, oldest first, each durable on its own, memory bounded by a
  batch.
- The MacBook runs focused test files only (`node --test test/history/`), never the kit's whole suite, and never
  collects MAWS (the REST budget is shared with every session).
- Nothing is deployed and `v1` does not move: this work changes `history/`, `cli/`, `hooks/`, one guard workflow
  and docs.

### M1 — Job lines

At its end the store holds `attempts.json` and job lines for the five repositories from 2026-10-22 on, and the
daily run adds each day's.

- Touches: `history/repos.json` (every served repository: its gate workflows, default branch, `setup_steps`,
  `test_globs`, path policy, `required`, summary parts, fallback labels, vacuous events), `history/jobs.mjs` (a run
  and its check runs to job lines and gate attempts, pure), `history/mirror.mjs` (the clone, fetch by id, trees,
  tree keys, path differences), `history/collect.mjs` and `history/store.mjs` (the pass, `attempts.json`, the
  `jobs/` files), `lib/github.mjs` (the listings and the GraphQL query), the sandbox workflow (the mirror's
  credentials; by its own pull request), `test/history/`.
- Exposes: the job line; `gateAttempts(lines)` → attempts with result, scope, scope key, basis, tree key;
  `mirror.treeKey`, `mirror.paths(a, b)`, `mirror.isAncestor(a, b)`; `store.jobLines(fromDay, toDay)`.
- Decisions: "Reading GitHub cheaply and completely" above is the contract, preflight first. Lines are written by
  completion day. The backfill is the same pass over a longer window, in batches, under the paced budget.
- Does not touch: the per-test pass and its files; causes; anything outside the paths above.
- Proves: acceptance 1, 2 and 8. Its tests pin: shard folding, a missing shard (incomplete), a copied shard; a
  failed shard beside three passing ones; control jobs and summary parts; lane for each lane; `phase` for a setup
  failure, a test failure and a lost job; scope and scope key for a selected run and a vacuous event; a rerun of
  a run created 20 days ago being found; a day of more than 1,000 runs; a pass interrupted between batches
  resuming without a missing or doubled line.

### M2 — The store kept small, watched, and fed by the hand-run gate

At its end the per-test lines are small, a stale store raises the kit's alert, and the hand-run gate's runs are in
the ledger.

- Touches: `history/record.mjs`, `history/store.mjs`, `history/collect.mjs` (the slim line, the one-time rewrite,
  the 35-day load); `.github/workflows/pool-guard.yml` and its script (the store's newest commit older than 36
  hours is an alert, through the guard's existing alert issue); `history/manual-gate.mjs` (run directories to
  `jobs-manual/` lines: `workflow: "manual-gate"`, `run` the directory's name, scope and scope key from the run's
  filter, environment and peers, a job that bundles several groups written as one line per group with the job's
  minutes on the first, a refused or partial run as `incomplete`); `test/history/`.
- Consumes: M1's job line and store. Exposes: `jobs-manual/` lines readable through `store.jobLines`.
- Decisions: "The per-test record, kept small" above. The hand-run import is run on the MacBook by CI-opt
  (`node history/manual-gate.mjs --runs <dir> --store <dir>`, then a push that fetches and replays on a
  non-fast-forward). The retrospective's parser
  (`~/.local/share/ci-analysis/verification-retro-1119/scripts/`) is the reference for the directories' layout.
- Does not touch: causes; the report; `cli/`.
- Proves: acceptance 7's first half and 9. Its tests pin: a slim line answering "ran and passed" from the base; a
  store with old-shape lines read and rewritten; the import of a green run, a red run, a narrowed run and a
  refused run.

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
  `unattributed`; a superseded run; an amendment that drops a product edit and keeps a test edit being `caught`;
  `known` and `base_also_failed` appearing only as context; `case_match` in its three values; a landing whose tip
  is docs-only and whose push is not; a landing that changes only the excluded-path exception being not exempt;
  `head_green`; an in-flight `pr_check`; an override; an observation not used before its completion time.

### M4 — The weekly report and the status file

At its end the store holds a report for each of the last four ISO weeks per repository and a daily `status.json`.

- Touches: `history/report.mjs`, `history/status.mjs`, the sandbox workflow's steps (by its own pull request),
  `test/history/`.
- Consumes: M3's lines and `observations`. Exposes: `status.json`'s shape.
- Does not touch: `cli/`.
- Proves: acceptance 5. Its tests pin: a gate with one `unattributed` red is not nominated and its red is in
  "reds to read"; a gate with a `keep` entry is not nominated; a gate with too little record is listed as such;
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

    node --test test/history/                                        # every milestone's focused tests
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

## Outcomes & Retrospective

Pending — written at finish.
