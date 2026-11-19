# The gate ledger: what each gate costs, what it catches, and what merged without it — living spec

**Date.** 2026-11-19. **Status.** Design approved by the owner (2026-11-19, "설계안 전체"). Author: CI-opt.
Parents: `2026-10-15-ci-kit-design.md` (the kit) and `2026-10-21-test-history-design.md` (the per-test record this
builds on; its M3 is superseded by M2 and M5 here).

## Purpose

The owner's verification retrospective of 2026-11-19 found that most verification time was not buying product
safety. On the one Mac, over three days, 46% of the time went to red runs that were not product bugs, and 30 runs
(148 minutes) were made only to learn that a failure was not the change's own. The numbers took a day of hand work
to produce, because nothing records what a gate cost and what its failures turned out to be. The owner's ruling:
look for what to remove before what to add, and tell "fix now" from "ship with it".

After this work:

- **Every gate job leaves one line**: which gate, where it ran, how long, how it ended, on which tree. For all five
  repositories ci-kit serves, and for the hand-run Mac gate.
- **Every red job carries a cause**, decided by rule from the record: infrastructure, flaky, already red on the
  base, known and shipped with, fixed by changing the test, fixed by changing the product ("caught"), or
  unresolved.
- **A weekly report per repository** shows, per gate, minutes and reds by cause, and nominates gates that caught
  nothing for removal or demotion. A person decides; CI never removes a check on its own.
- **Every landing on a default branch is checked against its gates**: was the tree that landed the tree that was
  gated, and green? The count of landings that were not is visible each day.
- **`ci-gate` says, when a gate fails, whether the base already fails it or a recorded reason covers it**, so a
  session does not rerun to find out.

How to see it working: the acceptance section's commands reproduce the hand measurement of 2026-11-19 from the
store, print a weekly report, and show `ci-gate` naming a base-red failure.

### What it must not be

- **Not a gate.** Nothing here can turn a run red, hold a merge, or skip a test. Blocking is GitHub's branch
  protection (`ci / verdict` is a required check on cua, doperpowers, ci-kit and manim-master since 2026-11-19) and,
  in MAWS, the architect's rule. The ledger observes both.
- **No check removed or quarantined by CI.** The report nominates. A check that guards a rare but costly failure is
  marked `keep` with its reason and is not nominated again.
- **No test name, file or message in a public place.** MAWS's record is treated as private whatever the
  repository's visibility is: the store is the private sandbox's branch, and every log line this code prints in
  Actions carries counts only (the parent spec's rule).
- **No new credentials.** The collector uses the ci-kit GitHub App as today; local commands use `gh`'s token.
- **Not a cost report in dollars.** The owner's standing rule is that cost is never a reason to cut parallelism;
  the scarce things are wall time and the one Mac. The unit is minutes, by lane.

## Glossary

- **Gate run, nonce commit, producer, label, change.** As in `2026-10-21-test-history-design.md`'s Glossary;
  `history/provenance.mjs` implements them. A pull request's runs (event `pull_request`) form the change
  `pr:<number>`.
- **Gate.** What a job verifies, with shards folded: the job `unit 3/4` is the gate `unit`; a ci-kit job
  `ci / test` is the gate `test`. Control jobs (`plan`, `verdict`, `package cache`, MAWS's `plan`) are recorded with
  kind `control` and take no part in labels or reports.
- **Lane.** Where a job ran: `pool-gce`, `pool-ec2`, `mini-host`, `mini-guest`, `hosted-linux`, `hosted-macos`, or
  `manual-host` / `manual-guest` for the hand-run Mac gate. Read from the runner's name and labels.
- **Landing.** A commit that became the default branch's tip by a push: a merged pull request in the ci-kit
  repositories, a push tip in MAWS (from the repository activity API). Commits that arrive inside a multi-commit
  push are interior and are not landings.
- **Tree key.** A tree's identity for comparing a landing with a gated tree. It is the tree id, except where the
  repository's entry in `history/repos.json` names top-level directories to ignore (MAWS: `docs`), in which case it
  is the hash of the tree's top-level entries without them. Two commits with one tree key differ only in what the
  repository has declared outside its gates' reach.
- **The store.** Branch `test-history` of the private `SSFSKIM/ci-kit-sandbox`, written daily by the sandbox's
  `test-history.yml` running ci-kit `main`'s `history/collect.mjs`.
- **The hand-run Mac gate.** CI-opt's `manual-gate-mac`, which runs MAWS's Mac jobs on the Mac mini outside Actions
  while the account's billing lock lasts. Its runs live on CI-opt's MacBook under
  `~/.local/share/ci-opt/manual-gate/runs/<sha12>-<stamp>/`.

## Progress

- [x] (2026-11-19 08:5xZ) The measurement the design rests on: `~/.local/share/ci-analysis/gate-observe-1119/`
  (`report.md`, `merges.tsv`, `maws-93-split.tsv`, `scripts/`). Design presented and approved.
- [x] (2026-11-19 09:0xZ) Required check `ci / verdict` and auto-merge turned on (owner's decision; see Decision
  Log). Not part of this spec's code.
- [ ] M0 — The per-test collector runs again (in progress outside this spec: branch `history-repair`; see
  Surprises).
- [ ] M1 — Job lines.
- [ ] M2 — Causes and landings.
- [ ] M3 — The weekly report and the status file.
- [ ] M4 — `ci-gate` reads the status; known entries are recorded with it.
- [ ] M5 — The per-test condensation report (not before the per-test record holds 14 days).

## Acceptance

Each is run against the real store and GitHub's real record, not a fixture: the kit's unit tests use fakes, and
the retrospective named that as its gap.

1. **Job lines exist and are right.** After a collection, the store holds `SSFSKIM/MAWS/jobs/2026-11-19.jsonl`
   with one line per job of run 44486328066: gates `static`, `unit` (four shards), `probes`, `e2e:desk-web`, lane
   `pool-gce`, conclusion `success`, and `e2e:desk-web` at 7.6 minutes (08:18:10Z to 08:25:45Z). All five
   repositories have job files for every day from 2026-10-22.
2. **Causes match cases whose cause is known.** In the store: MAWS run 44472434480's `e2e:desk-web` (cancelled in
   `playwright install` at the job's timeout) and run 44468141412's first `static-local` (its runner was lost in
   the setup step) are `infra`; doperpowers pull request 481's `mods-types` failure of 2026-11-10 12:40Z is
   `unresolved` (it merged red, so its change has no later run). For `flaky`, `test-changed` and `caught` the
   executor of M2 takes one labelled job of each from the store, reads the two runs behind it on GitHub, and
   records the three with their evidence in Surprises & Discoveries; a label the reading contradicts is a defect.
3. **The landing record reproduces the hand measurement** for 2026-10-22 to 2026-11-19, from
   `gate-observe-1119/report.md`: doperpowers 184 merged pull requests, of them 165 green, 2 red (410, 481), 17
   unrun; ci-kit 116: 113, 0, 3; cua 69: all green; manim-master 207: 188 green and 19 with no gate required; MAWS
   309 landings outside `docs/`, of them 135 green by tree key and 79 whose merged tree never ran while the
   second parent's tree had a green run. A difference is explained in Surprises & Discoveries (the hand
   measurement is the oracle only where its own definition is the one this spec adopts).
4. **The report reads.** `node history/report.mjs --store <dir> --repo SSFSKIM/doperpowers --week 2026-W47` prints a
   Markdown report with a row per gate (runs, minutes, reds by cause, minutes per caught) and a nomination section
   that lists gates with no `caught` in the window by minutes, or says there are none.
5. **`ci-gate` names a base-red failure.** With a status file saying gate `test` is red on the default branch,
   `ci-gate` on a commit whose `test` fails prints the FAIL line followed by a `base:` line with the date and the
   run, and its exit code and verdict are unchanged. With no readable status file it prints exactly what it prints
   today.
6. **Nothing public names a test.** The Actions log of the collection run that produced 1 to 4 contains no MAWS
   test name, file or message (`gh run view --log | grep` for three names taken from the store returns nothing).

## Design

### One collector, one store, three more kinds of line

The per-test record already has the right home: a daily run in the private sandbox, ci-kit `main` as the code, the
App token, a branch as the store. The ledger adds files beside `runs/` under each `<owner>/<repo>/`:

| File | One line per | Written by |
|---|---|---|
| `jobs/<YYYY-MM-DD>.jsonl` | job of a gate run, by completion day (UTC) | M1 |
| `landings/<YYYY-MM-DD>.jsonl` | landing on the default branch, by push time | M2 |
| `labels/<YYYY-MM-DD>.jsonl` | red job, by the job's completion day | M2 |
| `known.json` | (one file) recorded reasons, see below | M4 |
| `status.json` | (one file) each gate's standing on the default branch, known entries | M3 |
| `reports/<ISO week>.md` | (one file a week) | M3 |

*Rejected:* a second service (the pool launcher already sees every `workflow_job` event and has a ledger of its
own). It would couple a reporting feature to the component that places runners, and the API record is complete
without it: run and job metadata are kept for more than a year, so a missed day is recollected, which a missed
webhook is not. *Rejected:* building it into the gates workflow as a step per job. Every job would need to write
somewhere, and the hand-run Mac gate and MAWS's own workflow would each need their own copy.

### A job line (M1)

    { "v": 1, "run": 44486328066, "attempt": 1, "workflow": "gate", "event": "push",
      "ref": "ci/pwdeps-55f4887d", "producer": "maws-ci-gate", "label": "pwdeps", "change": "maws-ci-gate:pwdeps",
      "gates": "static,unit,probes,e2e:desk-web", "selection": null,
      "tree": "<tree id>", "tested": null,
      "job_id": 135…, "job": "unit 3/4", "gate": "unit", "kind": "gate",
      "lane": "pool-gce", "runner": "ci-kit-gce-…",
      "created": "…Z", "started": "…Z", "completed": "…Z", "minutes": 7.7, "waited": 0.2,
      "conclusion": "success", "failed_step": null, "phase": null }

- **`tree` without a call.** A run listing carries `head_commit.tree_id`, and a nonce commit is empty, so it is the
  tested tree. `tested` (the tested commit) costs a commit lookup per run, and only cause-finding needs it, for the
  runs it compares; it is resolved then and written back. *Why:* MAWS alone makes about 150 gate runs a day; the
  per-run lookups were the per-test collector's largest REST cost.
- **`failed_step` and `phase`.** The first step that concluded `failure` or `cancelled`, by name, and its phase:
  `setup` when the name matches the repository's `setup_steps` patterns in `history/repos.json` (checkout, the setup
  actions, `Set up job`, installs the gate does not own), `post` for `Post …` steps, else `test`. A job that ended
  not successful with no step concluded so is `phase: "lost"`.
- **Which runs.** Runs of the workflows `history/repos.json` names for the repository (`ci` in the ci-kit
  repositories, `gate` in MAWS), any event, completed attempts only. A run is collected once per attempt and is
  idempotent by (run, attempt, job id). Skipped jobs are not written.
- **The hand-run Mac gate** has no run id. `history/manual-gate.mjs --runs <dir> --store <dir>` turns each run
  directory into job lines with `workflow: "manual-gate"`, `run` = the directory's name, `lane` from the job's
  place, `tree` from the run's recorded tree, and times and results from its `mini-run` job logs. It is run by hand
  on the MacBook and pushed with `gh`'s token; it is not in the daily run. The retrospective's parser
  (`~/.local/share/ci-analysis/verification-retro-1119/scripts/`) reads the same directories and is the reference
  for their layout.

### A red job's cause (M2)

A label line is `{ run, attempt, job_id, gate, cause, because }`, where `because` names the evidence (a run, a
path count, a known entry's id). The first rule that holds decides:

| # | Cause | Holds when |
|---|---|---|
| 1 | `known` | a `known.json` entry for this repository matches the gate (and the failing case, where the entry names one and the per-test record has the job) and the job completed on or after the entry's `since` |
| 2 | `infra` | `phase` is `setup` or `lost`; or the pool's ledger records the job's runner as preempted |
| 3 | `flaky` | a later completed job of the same gate on the same tree succeeded (a later attempt, or another run) |
| 4 | `base-red` | at the job's completion, the gate's latest completed job on the default branch's line was red (from `landings/` evidence, below), and the red began before this change's first run |
| 5 | `test-changed` | the change's next run in which the gate succeeded differs from this one only in paths matching the repository's `test_globs` |
| 6 | `caught` | that next run differs in any other path |
| 7 | `unresolved` | none of the above: no later success in the change, or the two commits cannot be compared |

- Rules 3 to 6 are the per-test spec's labels, applied to a job. Its amended-commit question (its Decision Log,
  2026-10-21, "amended commits break the change line") is decided here: when the next success's tested commit is
  not a descendant, the paths compared are the compare API's file list for the pair, which for two siblings is
  everything the later commit changed since their common ancestor; the label carries `because.relation:
  "sibling"`. That list is a superset of what changed between the two in every case but a file the amendment
  dropped, and a superset can only move a `test-changed` to `caught`, the conservative direction for a report that
  nominates removals.
- `known` is first because its point is that a decided failure is not judged again. `infra` precedes `flaky`
  because a lost runner whose rerun passes is the runner's fault, and the flaky list is for tests.
- A label is recomputed while its job is younger than 14 days (a later run can resolve an `unresolved`), then
  final.
- *Not decided by rule:* whether a `caught` was a bug in the product or a scene that an intended change had made
  wrong. The retrospective counted those apart by reading; the record cannot. The report says so where it prints
  the count.

### A landing (M2)

A landing line holds the commit, its tree and tree key, parents, the push or merge time, the pull request, the
gates required of it, each required gate's evidence (the latest completed job of that gate on the landing's tree
key that finished before the landing: run, conclusion, time), a verdict, and for a red or unrun landing with two
parents, the same evidence for the second parent's tree key.

- **Required gates.** In the ci-kit repositories: what ci-kit's own planner selects from the base's
  `.github/ci-kit.yml` for event `pr` and the files the landing changes (`plan/config.mjs` `parseConfig`,
  `plan/select.mjs` `selectGates`, called as libraries). In MAWS: the repository's `required` list in
  `history/repos.json` (`static`, `unit`, `probes`), with landings that change only ignored directories recorded as
  `exempt`.
- **Verdict.** `green`; `red` (a required gate's latest job failed or was cancelled); `unrun` (a required gate has
  no completed job on that tree key before the landing), with `inflight: true` when such a job was running at the
  landing and how it ended; `none-required`; `exempt`. For `unrun` with a second parent whose tree key had the
  gates green: `head-green`, the case where a branch was gated and the merged tree was not.
- **Override.** A `red` or `unrun` landing whose pull request body or merge commit message has a line
  `Ship-with: <reason>` carries that reason. This is how "ship with it" is said for a required check: the merge is
  made with `--admin` and the reason is written where the landing is. *Rejected for now:* a `known_red` attribute
  on a gate in `.github/ci-kit.yml` that would make `verdict` pass. It changes what a green verdict means in every
  consumer, for a case the record shows 4 times in 576 merges. The report counts overrides; if they become
  frequent, that count is the argument for the attribute.
- **The default branch's standing** per gate, which rule 4 and the status file need, is read off the landings in
  order: the latest landing with evidence for the gate gives its standing, and a default-branch push run, where a
  repository has them, counts as evidence for its commit.
- The measurement's scripts (`gate-observe-1119/scripts/*.py`) are the reference for the API calls that proved
  cheap: run listings by `created` window, check runs by commit through GraphQL, MAWS's push tips from the
  activity API. They used about 190 REST calls and 190 GraphQL queries for 28 days of five repositories.

### Known entries (M4, read from M2 on)

`known.json` under a repository's directory in the store:

    [ { "id": "maws-778", "gate": "e2e:panel", "case": "panel.spec.ts › at its minimum size, with a question waiting*",
        "reason": "#778: the banner steals the float card's body on the guest; fixed on ux-wave/fix-778-banner",
        "since": "2026-11-19", "review_by": "2026-11-26", "by": "ux-wave" },
      { "id": "keep-cross-build", "gate": "e2e:cross-build", "keep": true,
        "reason": "the only check of wire compatibility with installed builds; a miss strands a user's sessions",
        "since": "2026-11-19", "review_by": "2027-02-19", "by": "CI-opt" } ]

- An entry without `keep` says a failure is known and shipped with: its jobs label `known`, and `ci-gate` prints it.
  An entry with `keep` says a gate stays whatever it has caught: the report does not nominate it.
- Every entry has a reason and a `review_by`. Past that date the entry stops matching and the report lists it as
  expired, so a shipped-with failure comes back into view by itself. *Why a date, not a condition:* a condition
  ("until #778 lands") needs someone to notice it became true; a date needs nobody.
- `ci-gate known add --gate <g> [--case <pattern>] --reason <text> --review-by <date> [--keep]` and
  `ci-gate known list` edit the file through the contents API with `gh`'s token, from the repository the session is
  in. One place, as the owner asked: not the pull request, not a tracker row.

### The report and the status file (M3)

`history/report.mjs` reads a repository's `jobs/`, `labels/`, `landings/` and `known.json` for an ISO week and the
three before it, and writes `reports/<week>.md`:

1. Per gate: runs, minutes by lane, reds by cause, minutes per `caught` over the four weeks.
2. Nominations: gates with no `caught` in the four weeks and no `keep`, by minutes, each with what it did catch
   in the record's whole span. The line says what removal or demotion would save a week.
3. Landings: counts by verdict, each `red`, `unrun` (not in flight) and `head-green` landing by name, and each
   override with its reason.
4. Known entries: count in force, those expiring within a week, those expired.
5. What the record cannot say (the `caught` caveat above; lanes with no lines that week).

`status.json` is written in the same pass, daily: `{ as_of, gates: { <gate>: { standing, since, run } }, known:
[…entries in force…] }`. It exists so that `ci-gate` makes one small read.

The report is a file in the private store. CI-opt reads it weekly and relays what matters to the owner and each
repository's architect. *Rejected:* an issue or a mail per week: the owner reads the session's report stream, and
a second channel would be one more thing nobody watches, which is how this spec's M0 came to be needed.

### `ci-gate` at a failure (M4)

After a `FAIL` line, when the repository's `status.json` can be read with `gh`'s token (one contents call, made
at the first failure of an invocation), `cli/watch.mjs` prints one more line for that gate:

    FAIL test 2m10s log=/tmp/…
         base: red on main since 2026-11-18 (run 44262593045); status as of 2026-11-19T00:40Z
         known: maws-778: #778: the banner steals the float card's body on the guest (review by 2026-11-26)

`base:` when the gate's standing is red, `known:` for each entry in force that names the gate. Verdict, exit code
and every other line are unchanged, and a status file that is absent, unreadable or older than 48 hours prints
nothing. The session-start hook's text (`hooks/session-start.sh`) gains one sentence on these lines and one on
merging: where the default branch requires `ci / verdict`, `gh pr merge <n> --auto --merge --match-head-commit
<sha>` merges when the gates pass.

MAWS's `scripts/ci-gate.sh` is the architect's and is not touched; MAWS sessions read the same file with
`ci-gate known list` and the report.

## Plan of Work

Constraints on every milestone:

- Node's built-ins and the kit's vendored `yaml` only; tests are `node --test`, beside the existing ones in
  `test/history/`.
- A collection's Actions log prints counts only (acceptance 6).
- REST through `lib/github.mjs` with the App token in Actions; a collection pass stays under 1,500 calls, and a
  backfill is paced under 3,000 an hour.
- The MacBook runs focused test files only (`node --test test/history/`), never the kit's whole suite.
- The collector must keep the property M0 gives it: bounded memory, and progress that survives a failure.
- Nothing is deployed and `v1` does not move: this work changes `history/`, `cli/`, `hooks/` and docs, which reach
  users through ci-kit `main` (the sandbox checks it out) and the plugin's version.

### M0 — The per-test collector runs again

Outside this spec's execution: branch `history-repair` and its sandbox change, dispatched 2026-11-19 (Surprises).
M1 starts from `main` after it merges. What M1 relies on from it: `collect.mjs` works in bounded batches,
oldest first, each durable on its own; the sandbox workflow runs on the pool, takes the ci-kit ref as a dispatch
input, and alerts on failure.

### M1 — Job lines

At its end the store holds job lines for the five repositories from 2026-10-22 on, the daily run adds each day's,
and the hand-run Mac gate's runs can be added from the MacBook.

- Touches: `history/repos.json` (every served repository: its workflows, default branch, `setup_steps`,
  `test_globs`, `tree_ignore`, `required`), `history/jobs.mjs` (new: a run and its jobs to lines, pure),
  `history/collect.mjs` and `history/store.mjs` (a jobs pass and the `jobs/` files), `history/manual-gate.mjs`
  (new), `lib/github.mjs` (the listings it lacks), `test/history/`.
- Exposes: the job line above; `store.jobLines(fromDay, toDay)`.
- Decisions: lines are written by completion day; the pass keeps a per-repository watermark (the newest
  `updated_at` it has fully collected) in the store so a day's rerun of an old run is found by listing runs
  updated since it; the backfill is the same pass run from an empty watermark with the paced budget; a run listing
  is by `created` window, 100 a page.
- Does not touch: the per-test pass and its files; labels; anything outside `history/`, `lib/github.mjs` and tests.
- Proves: acceptance 1 and 6. Its tests pin: shard folding and control jobs; lane from runner name and labels for
  each lane; `phase` for a setup failure, a test failure, a lost job; idempotence by (run, attempt, job id); the
  watermark surviving a failed pass.

### M2 — Causes and landings

At its end every red job in the store has a label line, every landing since 2026-10-22 has a landing line, and both
are kept current by the daily run.

- Touches: `history/label.mjs`, `history/landings.mjs`, `history/known.mjs` (reading and matching only),
  `history/collect.mjs`, `test/history/`.
- Consumes: M1's job lines. Exposes: label and landing lines; `standing(gate, at)`.
- Decisions: the rule table and the landing definitions above are the contract; `tested` is resolved lazily and
  written back to the job line; the pool's preemption record is read from the launcher's ledger only if that is one
  call a pass (else rule 2 rests on `phase` alone, and the spec's Surprises says so).
- Does not touch: the report; `ci-gate`; `known.json`'s writing.
- Proves: acceptance 2 and 3. Its tests pin each rule with the rule above it failing to hold, the precedence of
  `known` over `infra` over `flaky`, the sibling comparison, a landing that was in flight, `head-green`, an
  override's reason, and the tree key with and without ignored directories.

### M3 — The weekly report and the status file

At its end the store holds a report for each of the last four ISO weeks per repository and a daily `status.json`.

- Touches: `history/report.mjs`, `history/status.mjs`, the sandbox workflow's steps (in
  `SSFSKIM/ci-kit-sandbox`, by its own pull request), `test/history/`.
- Consumes: M2's lines and `standing`. Exposes: `status.json`'s shape above.
- Does not touch: `cli/`.
- Proves: acceptance 4. Its tests pin: a gate with a `keep` entry is not nominated; an expired entry is listed
  and does not label; minutes per caught with zero caught prints a dash, not a division.

### M4 — `ci-gate` reads the status; known entries are recorded with it

At its end a session sees `base:` and `known:` lines at a failure and can record and list known entries.

- Touches: `cli/watch.mjs`, `cli/ci-gate.mjs`, `cli/args.mjs`, `history/known.mjs` (writing), `hooks/session-start.sh`,
  `docs/adopting.md`, the plugin's version, `test/`.
- Consumes: `status.json` and `known.json`.
- Does not touch: verdicts and exit codes; `.github/workflows/gates.yml`; MAWS.
- Proves: acceptance 5. Its tests pin: no status, no extra line; a stale status, no extra line; `known add`
  refusing an entry with no reason or no date.

M4 is this execution's last milestone: after its own proof it runs the whole acceptance section as written and
the kit's full suite through `ci-gate` on the branch.

### M5 — The per-test condensation report (a later sitting)

Not before the per-test record holds 14 days (about 2026-12-03 if M0 recovers seven), and not part of this
execution. The per-test spec's M3 reports (`flaky`, `fail-first`, `condense`), with its labels now those of M2
applied to a failing case. Its section is written into this spec when it starts.

## Concrete Steps

From a ci-kit worktree, with a local clone of the store (`git clone -b test-history
https://github.com/SSFSKIM/ci-kit-sandbox store`, kept outside the repository):

    node --test test/history/                                   # every milestone's focused tests
    node history/collect.mjs --store store --repo SSFSKIM/ci-kit # one small repository, with gh's token
    node history/report.mjs --store store --repo SSFSKIM/doperpowers --week 2026-W47
    gh workflow run test-history.yml -R SSFSKIM/ci-kit-sandbox -f <M0's ref input>=gate-ledger   # the real pass, on the pool

A local collection of MAWS is not made from the MacBook (the REST budget is shared with every session); MAWS is
collected by the dispatched run only.

## Surprises & Discoveries

- Observation: the per-test collector failed every day from 2026-10-22, 28 days, and the store held one day.
  Through 11-10 it ran out of memory (it held every new artifact's parsed report and wrote only at the end, so each
  failure left a larger backlog); from 11-11 the account's billing lock refused the hosted job. Nothing alerted.
  Evidence: `gh run view 42455727941 -R SSFSKIM/ci-kit-sandbox --log-failed` ("Reached heap limit"); 29 runs, 1
  success. Per-test history before about 11-12 is gone (artifacts live 7 days). Job-level history is not, which is
  why this ledger does not depend on artifacts.
- Observation: requiring gates costs almost nothing where they are already run on pull requests. Evidence:
  `gate-observe-1119/report.md`: 576 merges in four repositories, 22 would have been held, 18 of them only until a
  running job finished; manim-master, which already required `ci / verdict`, had none.
- Observation: no change loosened its own gates. Evidence: same report: 14 pull requests edited their gate
  definitions, none removed a gate that applied to it without a replacement. Reading definitions from the base
  branch, the retrospective's first proposal, was dropped.
- Observation: in MAWS, 79 of 309 landings outside `docs/` went to master on a merged tree that never ran, with
  the branch head gated. Evidence: `gate-observe-1119/maws-93-split.tsv`; the architect's reading (2026-11-19):
  a real gap until 11-16, closed by his rule that class 1a is green on the tree pushed.

## Decision Log

- Decision: verification. The spec is reviewed by `doperpowers:adversarial-reviewer` for design and buildability
  before execution; each milestone by the task reviewer; the branch by `doperpowers:review-code` at medium.
  Rationale: read-only tooling with a private store and no path to turn a run red; the costly mistakes are a wrong
  count believed and a private name printed, and acceptance 3 and 6 check those against the real record.
  Date/Author: 2026-11-19, CI-opt.
- Decision: `ci / verdict` required on cua, doperpowers and ci-kit (strict off, admins not enforced, a pull request
  required with no approvals), auto-merge allowed on those and manim-master. Rationale: the owner's choice on the
  measurement above. Rollback: `gh api -X DELETE repos/SSFSKIM/<repo>/branches/main/protection`.
  Date/Author: 2026-11-19, the owner; applied by CI-opt.

## Outcomes & Retrospective

Pending — written at finish.
