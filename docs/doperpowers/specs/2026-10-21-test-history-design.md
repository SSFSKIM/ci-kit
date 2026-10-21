# Test history: run less, from evidence — living spec

**Date.** 2026-10-21. **Status.** Direction approved by the owner (2026-10-21, async: "측정부터 단계적으로", measure first,
step by step). Author: CI-opt. Parent: `2026-10-15-ci-kit-design.md` (the kit).

## Purpose

The owner asked for a CI-optimization skill in ci-kit: run only the tests a change touches, and condense a suite by
asking of each test "has this ever failed in a way that indicated an actual regression?". Both need evidence ci-kit does
not keep today. A test's outcome lives only in its job's log, for as long as GitHub keeps the log. Nobody can say which
tests have ever failed, which failures were flakes, or which tests only ever pass.

The pressure is real and growing. MAWS's unit gate is class 1a's longest job (see Glossary). It took 295 s on 10-18 and
469 s on 10-21: 59% longer in three days, while the test count grew 23% (18.0k → 22.3k tests, 1365 → 1612 files). On
10-20 there were about four unit runs per landing (≈75 runs, 18 merges to master), and unit is two thirds of MAWS's GCE
spend ($1.55 that day, a $46 month at that rate against the $50 budget).

After this work:

- **Every gate run leaves a per-test record.** For each run there is a row naming the tests that failed, with a line of
  why. For each day there is a snapshot of the suite: every test that existed and each file's duration. The record is
  kept in the private sandbox repo past GitHub's log retention.
- **Failures are labelled from that record.** Each failure is marked flaky (the same tree passed), test-changed (only test
  files changed before it passed) or caught (source changed before it passed). "Caught" is the owner's "actual
  regression".
- **Reports a repo's sessions act on.** The flaky tests to quarantine, an order that runs likely failures first, and a
  condensation report: the tests that never caught anything, ranked by what they cost. The report nominates; the repo
  decides. In MAWS the tests are also the spec, so deleting one is a product decision, never a CI rule.
- **Selection where it is safe.** Iteration runs test only what the change touches. The run a landing relies on stays
  full.
- **A skill that carries what worked.** `ci-kit:optimize` teaches a repo's sessions the method and the mechanisms. It is
  written last, from the cases that proved out.

### What it must not be

- **No test is skipped at landing.** Selection applies to iteration runs only. A landing needs a full green run on the
  head's tree (M4 makes this checkable).
- **No test deleted or quarantined by CI on its own.** History nominates; a repo's session or architect decides, and
  records the decision in that repo.
- **No MAWS test names in a public place.** The collector runs in `SSFSKIM/ci-kit-sandbox`, which is private. Its store
  is a branch there. ci-kit's public code reads and writes it, but no public log ever prints a test name. This follows
  the parent spec's rule for alerts.
- **No new credentials.** The collector reads artifacts with the ci-kit GitHub App that the pool already uses
  (`CI_KIT_APP_ID` / `CI_KIT_APP_KEY`, already sandbox secrets). It writes its own repo with `GITHUB_TOKEN`.
- **No change to how a run passes or fails.** Writing and uploading the record never turns a run red: the steps run
  `if: !cancelled()`, and a missing report is ignored.

## Glossary

- **Gate run.** One run of a repo's gate workflow, `.github/workflows/gate.yml` in MAWS. `ci-gate` pushes the tested tree
  plus one empty commit (a "nonce" commit, whose message carries the `Gates:` trailers) to `ci/<label>-<sha8>`. So a
  run's `head_sha` is the nonce commit and its parent is the tested commit.
- **Class 1a.** MAWS's pre-landing gate set: `static`, `unit` and `probes`, on the GCE pool.
- **JUnit XML.** The common test-report format that vitest (`--reporter=junit`), `node --test`
  (`--test-reporter=junit`), Playwright and pytest all write. Each `<testcase classname=… name=… time=…>` has an
  optional `<failure>`, `<error>` or `<skipped/>`.
- **Change.** The work one session iterates on before a landing. Its runs share a `ci-gate` label (the branch name less
  `ci/` and the `-<sha8>` suffix), and each run's tested commit descends from the previous one's.

## Progress

- [x] (2026-10-21 06:3xZ) Spec written; owner's direction recorded.
- [ ] M1 — MAWS writes and uploads unit's JUnit report.
- [ ] M2 — ci-kit's collector and the sandbox store.
- [ ] M3 — Labels and reports (starts when the store holds ≥ 14 days).
- [ ] M4 — Selection for iteration runs (with the MAWS architect).
- [ ] M5 — Unit overhead experiment (independent; any time).
- [ ] M6 — The `ci-kit:optimize` skill.

## Design

**Format: JUnit XML, parsed once.** Every runner the kit's repos use can write JUnit (vitest in MAWS and cua, `node
--test` in ci-kit and MAWS's script tests, Playwright for e2e, pytest in manim-master). One parser therefore covers every
repo. *Rejected:* vitest's JSON reporter. It carries more, but only for vitest, and every other runner would need its own
parser.

**Transport: one artifact per job.** A job writes its reports under `ci-results/` and uploads them as
`test-results-<job>`, with `retention-days: 7`, `if-no-files-found: ignore`, and the step `if: ${{ !cancelled() }}`.
*Rejected:* pushing the record from the job itself. Jobs run on three kinds of runner (GCE pool, the mini, hosted), so
every job would need write credentials, and a red job would have to push.

**Store: a branch in the sandbox, kept compact.** The store is branch `test-history` of `SSFSKIM/ci-kit-sandbox`, and
it never merges anywhere.
- `<owner>/<repo>/runs/<YYYY-MM-DD>.jsonl` (the run's creation day, UTC) holds one line per (run, attempt, job), sorted
  by run id then job name. A line is about 1 KB. It carries no per-test pass list; a pass is "in the day's suite, not
  failed or skipped in that run".
- `<owner>/<repo>/suite/<YYYY-MM-DD>.json.gz` holds one snapshot per job name per day, taken from that day's last green
  run of the job. It lists every test id with its file, and each file's duration. These snapshots are the denominator:
  they record which tests existed, and when.
- MAWS's volume: about 75 unit lines a day (≈ 75 KB), plus one gzipped suite a day (≈ 300 KB). That is about 10 MB a
  month in git.

*Rejected:* full per-run reports in git (≈ 5 MB a run, 11 GB a month); a GCS bucket (new credentials in a sandbox
workflow); the ledger issue (its comments are for the pool's ledger, and too small). A test **id** is
`<file> > <name>`, with the JUnit classname as the file. Vitest writes the describe path into the name as `a > b > test`.

**Collector: `history/` in ci-kit, run daily by the sandbox.** `history/collect.mjs` takes a repo and a window. It
lists the repo's gate runs in the window and, for each attempt, the artifacts named `test-results-*`. It downloads and
unzips each one, parses the JUnit, and merges the lines into the store idempotently by key. It also writes the day's
suite snapshot. Every run collects the last 3 days, so a missed day is caught up while the artifacts are still kept
(7 days). The sandbox workflow `test-history.yml` runs it daily at 00:40 UTC and on `workflow_dispatch`:
1. check out ci-kit `main` (public) as the code;
2. check out the sandbox's `test-history` branch as the store, creating it on first use;
3. mint the App token;
4. run the collector;
5. commit and push only when the store changed.

Its log prints counts, never test names. The repos come from `history/repos.json`, which starts as `["SSFSKIM/MAWS"]`.

**Labels (M3).** For a failing test T in run R of change C: find C's next run R′ (same label, later tested commit
descending from R's) in which T passed.
- Same tree as R, or R′ is a re-run attempt of R → **flaky**.
- Only test files differ between the two tested trees (paths matching the repo's test globs) → **test-changed**.
- Any other file differs → **caught**.
- No later passing run of C → **unresolved**, and so a failure on master or a test that was deleted is never miscounted.

**Reports (M3), from ≥ 14 days.**
- `flaky`: tests with any flaky label, with dates and runs.
- `fail-first`: tests ordered by recent failures. A repo can feed this to its runner where the runner supports ordering
  (vitest `sequence`). Doing so is the repo's choice.
- `condense`: tests that existed for the whole window and never caught anything, grouped by file and ranked by the
  file's total time. Duplicate-mode projects are reported as projects. MAWS's `renderer-compiled` re-runs every renderer
  suite under the React Compiler and costs 19% of unit file time, so it is the first case for the owner's question.
  Each report is a Markdown file under `<repo>/reports/` on the store branch, and is posted to the repo's architect.

**Selection (M4).** Its decisions are settled with the MAWS architect before M4's execution is written. The starting
proposal:
- `ci-gate --affected` passes the changed files (from the merge base with the default branch) to the gate in a
  `Changed:` trailer.
- MAWS's plan narrows unit to `vitest related <files>` and e2e to the groups a path map names.
- A run made this way is marked `Selection: affected` in its summary.
- The landing check accepts only a run without that mark on the head's tree.
- The full suite still runs on every landing candidate, so what selection misses is caught before master. Selection
  can miss what the module graph cannot see: fixtures, config, JSON read at run time, build output.

**Overhead (M5).** In MAWS, 56% of vitest's worker time is import, transform and environment setup, not tests (10-21:
tests 44%, import 27%, transform 16%, environment 12%). The experiment measures the options vitest offers without
dropping a test, each as a class 1a run on the pool against the same tree: dependency optimization for the web
projects; `isolate: false` for node projects whose suites pass with it. An option is adopted only with a green run and
a measured gain. The repo's architect lands it.

**The skill (M6).** `skills/optimize/SKILL.md` in ci-kit's plugin. It carries the method #96 used:
1. measure each job's time and cost;
2. find the critical path;
3. find work that sits on the wrong job;
4. propose with numbers and with the condition each change must keep.

It also carries how to use `--affected` and the reports, and what CI must never decide alone. It is written from what
M1–M5 proved.

## Plan of Work

### M1 — MAWS writes and uploads unit's JUnit report

At the end, every MAWS gate run that runs `unit` or `unit:darwin` uploads `test-results-unit` (or
`test-results-unit-darwin`), holding `ci-results/unit.xml` with all 22k test cases. The job log and step summary are
unchanged.

- `.github/workflows/gate.yml`, job `unit`, test step: run `pnpm test --maxWorkers="$cores" --reporter=default
  --reporter=github-actions --reporter=junit --outputFile.junit=ci-results/unit.xml`. With no `--reporter`, vitest 5
  under GitHub Actions uses exactly `default` and `github-actions`, so naming both keeps today's output and annotations.
  Then add an upload step: `actions/upload-artifact@v7`, the same version the file uses for e2e.
- Job `unit-darwin`: the same reporters on its `vitest run`, with artifact `test-results-unit-darwin`.
- No other job in M1: static's and probes' runners are `node --test` (seconds, M3 can add them), and e2e's reporters
  belong to measured groups (later, with the architect).

Proof: a class 1a run on the pool is green, and its artifacts list shows `test-results-unit`. Its `unit.xml` has as many
`<testcase` as the log's `Tests` line counts (passed plus skipped). The unit log's last lines (`Test Files`, `Tests`)
and annotations are as before. The PR goes to the MAWS architect, who lands it.

### M2 — The collector and the store

At the end, `node history/collect.mjs --repo SSFSKIM/MAWS --store <dir> --since <day>` fills a store directory from the
repo's runs. The sandbox workflow runs it daily, and the `test-history` branch holds MAWS's runs from M1's landing on.

- `history/junit.mjs`: `parseJUnit(xml) → { cases: [{ file, name, status: 'passed'|'failed'|'skipped', ms, message }] }`.
  A dependency-free tag scanner: ci-kit has no runtime dependencies. It handles attributes in either quote style, the
  XML entities, CDATA, self-closing `<testcase/>`, and `<error>` as a failure. `message` is the first line of the
  failure's `message` attribute or body, cut to 300 characters.
- `history/record.mjs`: `runLine({ run, attempt, job, cases }) → object` and `suiteSnapshot({ day, job, cases }) →
  object`, plus `mergeLines(existing, incoming)`, idempotent by `run.id/attempt/job`. These are pure functions.
- `history/collect.mjs`: the CLI. It uses `lib/github.mjs`'s client if that fits; otherwise a small fetch wrapper with
  the token from `GH_TOKEN`. Artifact zips are unpacked with the system `unzip` into a temp dir. It prints one count line
  per repo: runs, jobs, failures, files written.
- `history/repos.json`: `["SSFSKIM/MAWS"]`.
- ci-kit-sandbox `.github/workflows/test-history.yml`, as in Design. It runs on `ubuntu-latest`, has `permissions:
  contents: write`, and uses `concurrency: test-history`.
- Tests in `test/history/*.test.mjs` (node --test):
  - JUnit fixtures from vitest 5, `node --test` and Playwright, cut from real reports, with any MAWS names replaced;
  - the label-free record and merge functions;
  - the collector against a fake GitHub (the pattern `test/github.test.mjs` uses), including an artifact that is
    missing, a re-run attempt, and an idempotent second pass.

Proof:
- `npm test` is green, and `ci-gate` on the branch is GREEN.
- After merge, a `workflow_dispatch` of `test-history.yml` writes the first day's files.
- The run's log shows counts only.
- `git show test-history:SSFSKIM/MAWS/runs/<day>.jsonl | wc -l` matches the day's unit jobs since M1 landed.

### M3–M6

Each is written here in full when its condition holds:
- M3 when the store holds 14 days;
- M4 when the architect has agreed the landing rule;
- M5 at any free slot (it needs only pool runs);
- M6 after M3–M5.

## Verification

- Spec: one adversarial review (`doperpowers:adversarial-reviewer`), run while M1 is built.
- M1: class 1a on the pool, then the MAWS architect lands it.
- M2: `doperpowers:reviewer-medium` on the PR before merge.
- M3–M6: named when each is written.

## Decision Log

- 2026-10-21: Order fixed by the owner: record first (M1–M2), then selection (M4), then overhead (M5), then the skill
  (M6). Labels and reports (M3) wait for data.

## Surprises & Discoveries

- 2026-10-21: Unit's duration grows about 2.5× faster than its test count (295 → 469 s against 18.0k → 22.3k tests,
  10-18 → 10-21). Heavy suites are being added, and per-file overhead dominates (above). The 100 slowest files are 55%
  of file time. The two `App.test.tsx` runs (plain and compiled) are 91 s.

## Outcomes & Retrospective

(At completion.)
