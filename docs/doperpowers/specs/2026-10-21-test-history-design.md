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

- **Every gate run leaves a per-test record.** For each (run, attempt, job) the record holds:
  - exactly which tests ran, failed and were skipped;
  - which commit and tree were tested;
  - which change the run belongs to;
  - what changed since that change's previous run.

  It is kept in the private sandbox repo past GitHub's retention of logs and artifacts.
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
  head's tree; M4 marks every selected run so it cannot pass for one.
- **No test deleted or quarantined by CI on its own.** History nominates; a repo's session or architect decides, and
  records the decision in that repo.
- **No MAWS test names in a public place.** The collector runs in `SSFSKIM/ci-kit-sandbox`, which is private. Its store
  is a branch there. ci-kit's public code reads and writes it, but no public log ever prints a test name. This follows
  the parent spec's rule for alerts.
- **No new credentials.** The collector reads artifacts and commits with the ci-kit GitHub App that the pool already uses
  (`CI_KIT_APP_ID` / `CI_KIT_APP_KEY`, already sandbox secrets). It writes its own repo with `GITHUB_TOKEN`.
- **No new way for a gate to go red.** The upload step is `continue-on-error`. It runs only when this job's own test step
  ran. A missing report is ignored.
  - Accepted residue: vitest writes the JUnit file inside the test command. A write failure there would fail the step,
    but it is the same failure as the runner's workspace being unwritable, which fails the job anyway.

## Glossary

- **Gate run.** One run of a repo's gate workflow, `.github/workflows/gate.yml` in MAWS. Both producers push the tested
  commit plus one empty commit on top (the "nonce" commit). So a run's `head_sha` is the nonce commit, and its first
  parent is the tested commit. The producers name the ref differently:
  - MAWS's `scripts/ci-gate.sh` pushes `ci/<label>-<sha8>`; its nonce message carries `Gates:` and `Class1a:` trailers.
  - ci-kit's `ci-gate` pushes `ci/<label>-<sha8>-<nonce6>` (`cli/naming.mjs`); its message carries a `CI-Gates:`
    trailer.
- **Class 1a.** MAWS's pre-landing gate set: `static`, `unit` and `probes`, on the GCE pool.
- **JUnit XML.** The common test-report format that vitest (`--reporter=junit`), `node --test`
  (`--test-reporter=junit`), Playwright and pytest all write. Each `<testsuite>` (one per test file) has a `time`; each
  `<testcase classname=… name=… time=…>` has an optional `<failure>`, `<error>` or `<skipped/>`.
- **Case id.** `(project, file, name)`. The **project** is the vitest project, and is empty for runners without
  projects. MAWS runs the renderer's files twice, once plain and once under the React Compiler (`renderer-compiled`),
  so the file alone does not name a case. MAWS writes the classname as `<project>:<file>` (M1).
- **Change.** The work one session iterates on before a landing. Its runs share a producer, a label, and a line of tested
  commits each descending from the last. A run whose change cannot be determined has none; it is never guessed.

## Progress

- [x] (2026-10-21 06:3xZ) Spec written; owner's direction recorded.
- [x] (2026-10-21 07:0xZ) Adversarial review: seven findings, all taken (Decision Log).
- [x] (2026-10-21 08:2xZ) M1 — MAWS writes and uploads unit's JUnit report: MAWS #99, merge 4d34b1d12. Class 1a
  pool green 39557488356 (22,360 cases = the `Tests` line; upload 1 s); unit:darwin green on the mini 39559203378
  (`test-results-unit-darwin-1`); an injected upload error left its step green (39555148333).
- [x] (2026-10-21 07:57Z) M2 — ci-kit's collector and the sandbox store: ci-kit #63 (merge 81230ef03), sandbox #22
  (merge 2929ccbb0). Two `reviewer-medium` rounds (5 then 2 findings, all fixed with tests; residue in ci-kit #62).
  First `workflow_dispatch` 39565155535 green through the App: 6 artifacts, 8 lines (6 present, 2 missing: the first M1
  run's unsuffixed name and the fault-injection run), 0 errors, 5 files on `test-history`; its log carries counts only.
  Reconstructed membership equals the log's `Tests` line on three runs (22,360; 22,360; 22,454).
- [ ] M3 — Labels and reports (starts when the store holds ≥ 14 days).
- [ ] M4 — Selection for iteration runs: agreed and written 08:1xZ; ci-kit #64 merged (919f0f6); MAWS #101, class 1a
  green 39575096972, `unit:darwin` proof 39576855823; landed ee9ecace6 (MAWS DL 82). Follow-up: `docs/` exempt but
  for `docs/doperpowers/evidence`. Open: a real selected run in the store.
- [ ] M5 — Unit overhead experiment: written 2026-10-21 08:0xZ (arms S, C, D, I). B = MAWS 0ddd2012f. Experiment done
  11:4xZ; open until #104 lands.
  (09:5xZ) Baseline, S, S′, C's ceiling, D and I measured (Surprises); none of S, S′, D, I adopted. C's ceiling
  cleared the 10% bar, and its cold half showed most of the gain needs no delivered cache (arm C0, running); the
  delivery question went to CI-opt.
  (10:3xZ) C0 adopted (−50 s); it is the combined commit, since no other arm was adopted. MAWS #104 opened from
  current master, class 1a pool green 39582732641; CI-opt sends it to the architect and schedules `unit:darwin`.
  Compiler-only numbers sent to CI-opt for the architect. CI-opt chose the master-ref delivery (Decision Log); its arm
  CD is running, measured against C0.
  (11:1xZ) CD not adopted (−13 s against C0); both its checks passed (Surprises). Compiler-only waits for desk-web to
  build with the compiler (the architect's condition): branch `unit-compiler-only`, head be9d36aab, on top of #104,
  pushed and not opened; CI-opt opens it when the desk lane has deployed.
- [ ] M6 — The `ci-kit:optimize` skill.

## Design

**Format: JUnit XML, parsed once.** Every runner the kit's repos use can write JUnit (vitest in MAWS and cua, `node
--test` in ci-kit and MAWS's script tests, Playwright for e2e, pytest in manim-master). One parser therefore covers every
repo. *Rejected:* vitest's JSON reporter. It carries more, but only for vitest, and every other runner would need its own
parser.

**Transport: one artifact per job attempt.** A job writes its reports under `ci-results/` and uploads them as
`test-results-<job>-<run_attempt>`. The attempt in the name is the only place an artifact says which attempt made it:
the artifact API lists artifacts by run, not by attempt. The upload step's rules:
- `retention-days: 7`, `if-no-files-found: ignore`, `continue-on-error: true`;
- it runs only when this job's test step ran (its outcome is success or failure), so a job whose checkout or setup
  failed uploads nothing;
- the test step removes `ci-results/` first, so a self-hosted runner's persistent workspace never ships a report an
  earlier job left. MAWS's e2e upload guards on checkout for the same reason.

*Rejected:* pushing the record from the job itself. Jobs run on three kinds of runner (GCE pool, the mini, hosted), so
every job would need write credentials, and a red job would have to push.

**Store: a branch in the sandbox, exact per run, compact by deltas.** The store is branch `test-history` of
`SSFSKIM/ci-kit-sandbox`; it never merges anywhere. Under `<owner>/<repo>/`:
- `runs/<YYYY-MM-DD>.jsonl`, by the job's completion day (UTC): one line per (run, attempt, job), sorted by run, attempt
  and job. A line holds:
  - **provenance:**
    - run id, attempt, workflow, event, `head_branch`, `head_sha`;
    - the tested commit and its tree;
    - the producer (`maws-ci-gate`, `ci-kit-ci-gate`, or `other` for pushes and dispatches);
    - the label: the ref less `ci/` and the producer's suffix, or null for `other`;
    - the gates trailer;
    - job id, job name, runner name, job conclusion, started and completed times;
    - artifact id, name and creation time.
  - **report status:** `present`, `missing` (the job ran its tests but no artifact exists) or `unparseable`.
  - **membership:** exactly which case ids ran, as a delta from that job's base set for the day (see below): `added`
    and `removed` ids, plus a hash of the full sorted id list so a reader can check the reconstruction.
  - **outcomes:** failed case ids, each with the first line of its message (≤ 300 characters); skipped ids as a delta
    from the base's skipped set; per-project counts and total time.
  - **previous run of the change:**
    - its run id and attempt;
    - the relation of the two tested commits: `same-tree`, `descendant` or `unknown`;
    - the paths changed between them (from the compare API, marked truncated past its limit).

    Computed at collection, while the refs and commits are still reachable.
- `base/<YYYY-MM-DD>/<job>.json.gz`: that job's first complete report collected for the day. It holds the sorted case
  ids, the skipped set, and each `(project, file)`'s duration from `<testsuite time>`. A run line's membership refers to
  it.
- `durations/<YYYY-MM-DD>/<job>.json.gz`: `(project, file)` durations from the day's last complete green report of the
  job. This is the sampled cost that M3's ranking uses, labelled as sampled.

Volume for MAWS: a run line is a few KB (deltas and failures are small), so ≈ 75 lines ≈ 300 KB a day. A base or
durations file is ≈ 200 KB gzipped. In all, about 20 MB a month in git.

*Rejected:*
- one daily snapshot as the denominator (the first draft). Different branches run different suites, so a test deleted
  on one branch would still read as passed there.
- full per-run reports in git (≈ 5 MB a run).
- a GCS bucket (new credentials).
- the ledger issue.

**Collector: `history/` in ci-kit, run daily by the sandbox.** `history/collect.mjs --repo <r> --store <dir>`:
1. Lists the repo's artifacts named `test-results-*`, newest first, until the ones it has already stored. Listing by
   artifact rather than by run creation day also finds a fresh attempt of an older run.
2. For each new artifact, reads its run, the attempt (from the artifact name) and that attempt's jobs.
3. Resolves the tested commit (the nonce commit's first parent) and its tree.
4. Downloads the artifact and unzips it.
5. Checks the report is this job's: its `<testsuite timestamp>`s fall within the job's start and end.
6. Parses the report and writes the run line, creating the day's base if there is none.
7. Finds the change's previous run in the store (same producer and label, latest tested commit that the compare API
   reports as an ancestor or same tree) and records the relation and changed paths.

It also lists the last 3 days' runs and gives a `missing` line to each job in the repo's reporting set
(`history/repos.json`) that completed without a matching artifact. The collector is idempotent by (run, attempt, job).
The sandbox workflow `test-history.yml` runs daily at 00:40 UTC and on `workflow_dispatch`:
1. check out ci-kit `main` (public) as the code;
2. check out the sandbox's `test-history` branch as the store, creating it on first use;
3. mint the App token;
4. run the collector;
5. commit and push only when the store changed.

Its log prints counts only, never a test name or path. The repos come from `history/repos.json`, which starts as
`[{ "repo": "SSFSKIM/MAWS", "jobs": ["unit", "unit:darwin"] }]` (the jobs that upload a report).

**Labels (M3).** For a failing case T in run R of change C: find C's next run R′ (after R in the change's line, or a
later attempt of R) in which T ran and passed.
- R′ is a later attempt of R, or R′'s relation to R is `same-tree` → **flaky**.
- Every path changed from R to R′ matches the repo's test globs → **test-changed**.
- Any other path changed → **caught**.
- No such R′, or a link in the chain is `unknown` → **unresolved**. A failure on master, a test deleted before it
  passed, and a run with no change are never counted.

**Reports (M3), from ≥ 14 days.**
- `flaky`: cases with any flaky label, with dates and runs.
- `fail-first`: cases ordered by recent failures. A repo can feed this to its runner where the runner supports ordering
  (vitest `sequence`). Doing so is the repo's choice.
- `condense`: cases present through the whole window that never caught anything, grouped by `(project, file)` and
  ranked by sampled cost (the file's sampled duration × the runs that ran it). Duplicate-mode projects are reported as
  projects. MAWS's `renderer-compiled` costs 19% of unit file time, so it is the first case for the owner's question.

Each report is a Markdown file under `<repo>/reports/` on the store branch, and is posted to the repo's architect.

**Selection (M4).** Agreed with the MAWS architect on 2026-10-21 (Decision Log). An iteration run may test only what
a change can reach; a landing never does. About three of every four MAWS unit runs are iteration runs on trees that
never land (10-20: 18 landings, about 75 unit runs).
- **Opt-in per call.** `scripts/ci-gate.sh --affected` sends the change's paths, with their git status, from the merge
  base with `origin/master` to the tested commit.
- **The mark.** A run made this way is marked in three places a reader cannot miss:
  - the run's display title (the pushed commit's subject), so `gh run list` and `gh run view` show `affected`;
  - a `Selection: affected` trailer;
  - the run's summary.
- **What runs.** MAWS's plan narrows `unit`, and `unit:darwin` when it runs, to the tests `vitest related` finds for the
  changed paths. Other jobs run as asked; e2e selection is out of M4.
- **Fallbacks.** The plan runs the full suite, and says why in the summary, when the change touches what the module
  graph cannot see:
  - the lockfile or any `package.json`;
  - any vitest or vite config, or test support;
  - gate files (`.github/`, `scripts/`);
  - any path outside the source and test trees;
  - a deleted or renamed non-test file, since `related` cannot follow a path that is gone;
  - any changed file in the source or test trees that is not a script module: fixtures, snapshots, Markdown guides,
    and CSS read as text (vitest's `related` walk drops `?raw`, `?inline` and `?asset` imports).
- **Source readers.** Some suites read a whole source tree through `fs`, a lint or a build rather than an import.
  Examples: a token guard that scans `src/renderer`, the bundle guards that read `out/`, and the desk-hub suites
  that reach `apps/desk-hub/src` through a Worker bundle. A named map, from each such tree to the suites that read it,
  adds those suites to the related set when the tree changes. Making those trees fallbacks would run the full suite on
  nearly every change. A reading suite missing from the map is caught by the landing's full class 1a.
- **Landing rule.** A marked run never counts as landing evidence, even when a fallback made it run the full suite. A
  full class 1a on the head's tree stays required, so what selection misses is caught before master. A marked run that
  is red counts as red.
- **Enforcement.** The architect checks by hand; the mark exists to make that check impossible to get wrong. Children's
  briefs say iteration runs may use `--affected` and the hand-back's class 1a is a full run.
- **History.** The collector records a run's selection. A selected run is never a day's base, and its membership is
  stored as an explicit list when that is smaller than the delta from the base.

**Overhead (M5).** In MAWS, 55% of vitest's worker time is import, transform and environment setup, not tests (run
39564672977: `Duration 414.16s (tests 45%, import 27%, transform 15%, environment 12%)`). Vitest 5 itself prints that
`renderer-compiled`'s transforms are "re-done on every run" and suggests `fsModuleCache`. The run also has a tail that
is not overhead at all: vitest's default sequencer queues files project by project in name order, so the two
`-timing` projects run last, and their two `App.test.tsx` (42 s and 44 s) run nearly alone. The last other file
finished at +370 s and the run at +414 s, with 2 to 4 of 8 workers busy in between (Surprises).

The experiment measures options that change how the suite runs, never which tests run. Each option is an arm on a
scratch commit off one master commit, run unit-only on the pool:
- **S, schedule:** a sequencer that starts the longest files first, across projects;
- **C, transform cache:** `fsModuleCache`, first as a ceiling (two runs in one job, the second warm), then with a cache
  the pool can supply to a fresh VM, built only if the ceiling is worth it;
- **D, dependency optimization** for the happy-dom projects;
- **I, `isolate: false`** for the node projects whose suites pass with it.

An option is adopted only with green runs and a measured gain (M5 has the rule). The repo's architect lands it.
Running the renderer suites under the React Compiler only, dropping the plain `renderer` project, is not an M5 option:
it changes what is tested. It goes to the architect as a proposal with M5's numbers.

**The skill (M6).** `skills/optimize/SKILL.md` in ci-kit's plugin. It carries the method #96 used:
1. measure each job's time and cost;
2. find the critical path;
3. find work that sits on the wrong job;
4. propose with numbers and with the condition each change must keep.

It also carries how to use `--affected` and the reports, and what CI must never decide alone. It is written from what
M1–M5 proved.

## Plan of Work

### M1 — MAWS writes and uploads unit's JUnit report

At the end, every MAWS gate run that runs `unit` or `unit:darwin` uploads `test-results-unit-<attempt>` (or
`test-results-unit-darwin-<attempt>`) holding all of the run's test cases. The job log, step summary and annotations
are as before.

- `vitest.config.ts`: when `MAWS_TEST_JUNIT` is set, `reporters` is `default`, `github-actions` (under GitHub Actions)
  and `junit`, with:
  - `outputFile` set to the variable;
  - `classnameTemplate: '{displayName}:{filename}'`, which gives the project and the file;
  - `includeConsoleOutput: false`.

  These first two are what vitest 5 picks with no reporter named, so naming them keeps today's output. Unset, the
  config names no reporter.
- `.github/workflows/gate.yml`, jobs `unit` and `unit-darwin`, test step:
  - give it an `id`;
  - set `MAWS_TEST_JUNIT=ci-results/unit.xml` (`unit-darwin.xml`);
  - remove `ci-results/` first.
- Then, in both jobs, the upload step as in Design (`actions/upload-artifact@v7`, the version the file uses for e2e).
- `.gitignore`: `ci-results/`.
- No other job in M1:
  - static's and probes' runners are `node --test` (seconds; M3 can add them);
  - e2e's reporters belong to measured groups (later, with the architect).

Proof:
- A class 1a run on the pool is green.
- Its artifacts list shows `test-results-unit-1`, whose `unit.xml` has as many `<testcase` elements as the log's `Tests`
  line counts.
- The unit log's last lines (`Test Files`, `Tests`) are as before.
- Fault injection on a scratch branch: an upload step pointed at an invalid artifact name fails while the job stays
  green.

The PR goes to the MAWS architect, who lands it.

### M2 — The collector and the store

At the end, `node history/collect.mjs --repo SSFSKIM/MAWS --store <dir>` fills a store directory from the repo's
artifacts. The sandbox workflow runs it daily, and the `test-history` branch holds MAWS's runs from M1's landing on.

- `history/junit.mjs`: `parseJUnit(xml) → { suites: [{ project, file, ms, timestamp }], cases: [{ project, file,
  name, status: 'passed'|'failed'|'skipped', ms, message }] }`.
  - It is a dependency-free tag scanner: ci-kit has no runtime dependencies.
  - It handles attributes in either quote style, the XML entities, CDATA, a self-closing `<testcase/>`, and `<error>` as
    a failure.
  - `project` and `file` are split from a `<project>:<file>` classname when the part before the colon is not a path;
    otherwise the project is empty.
- `history/record.mjs` holds the pure functions:
  - building a run line from (run, attempt, job, artifact, provenance, parsed report, base);
  - building a base and a durations snapshot;
  - reconstructing a run's full membership from its line and base, checked against the stored hash;
  - merging lines idempotently.
- `history/provenance.mjs`:
  - the producer and label from a ref name, for both producers' formats and `other`;
  - the tested commit and tree;
  - the change's previous run and the relation and paths between them, through the compare API.
- `history/collect.mjs`: the CLI, using `lib/github.mjs` or `lib/github-app.mjs` where they fit. Artifact zips are
  unpacked with the system `unzip` into a temp dir. It prints one count line per repo: artifacts, lines,
  missing/unparseable, failures, files written. It prints no names.
- `history/repos.json`: as in Design.
- ci-kit-sandbox `.github/workflows/test-history.yml`, as in Design. It runs on `ubuntu-latest`, has `permissions:
  contents: write`, and uses `concurrency: test-history`.
- Tests in `test/history/*.test.mjs` (node --test):
  - JUnit fixtures from vitest 5 with two projects running the same file with opposite outcomes (from MAWS's real
    report shape, names replaced), `node --test` and Playwright;
  - a suite whose `<testsuite time>` is not the sum of its cases (hooks);
  - membership reconstruction across two branches with different suites and a deleted test;
  - a report whose timestamps fall outside the job (rejected, not ingested);
  - against a fake GitHub (the pattern `test/github.test.mjs` uses): two attempts of one run both done before the first
    collection; a fresh attempt of a run older than any window; a job with no artifact (`missing`); both producers'
    ref names and a dispatch run; a second pass that changes nothing.

Proof:
- `npm test` is green, and `ci-gate` on the branch is GREEN.
- After merge, a `workflow_dispatch` of `test-history.yml` writes the first day's files, and its log shows counts only.
- For one run, the reconstructed membership's size equals that job's `Tests` line (passed plus skipped).

### M5 — Unit overhead experiment

At the end, MAWS's `unit` job is shorter by a measured amount and runs the same tests in the same projects. Every arm's
numbers are in this spec, adopted or not, and the adopted arms are one MAWS PR the architect lands.

Method:
- **One base.** `B` is MAWS master when the experiment starts. Each arm is one scratch commit on `B`, in its own
  worktree.
- **Runs.** `scripts/ci-gate.sh <worktree> --gates unit --class1a pool --label m5-<arm>-<n>`, with the script from a
  fresh worktree (the old clone's copy lacks `--class1a`). At most two runs at once, because the pool also serves
  MAWS's landings. Each arm, the baseline included, gets three runs; a run that ci-gate reruns after a GCE preemption
  counts once, by its final attempt.
- **Measures per run:**
  - the test step's `Duration` line with its breakdown;
  - the test step's and the job's wall time (the jobs API's step times);
  - the `Test Files` and `Tests` lines;
  - the schedule, from the per-file `✓` lines' log timestamps: when the last file outside the `-timing` projects
    finished, and when the run ended.
- **Comparison.** Against the baseline arm's median from the same base, never older runs: VMs vary, and master's suite
  grows daily.
- No full suite runs on the MacBook (its load makes them slow; friction #18). One focused file while writing an arm is
  fine.

Arms:
- **S, schedule.** `test.sequence.sequencer`, a subclass of vitest's `BaseSequencer` whose `sort` keeps the base rules
  (failed first, then longer, then larger) but drops the grouping by project. A fresh VM has no results cache, so the
  base falls back to file size. If size does not put both `App.test.tsx` early (check in the schedule), the sequencer
  puts the `-timing` projects' files first: the config itself names them as the whole-app and real-time suites.
- **C, transform cache.**
  - *Ceiling first.* The arm's test step runs the suite twice with `fsModuleCache` on, into an empty cache: the first
    run shows the cost of writing the cache, the second the warm run.
  - If the warm run beats the baseline by less than 10%, C stops there, recorded.
  - Otherwise, choose how a fresh VM gets a cache, measure the restore, and run it as the arm. The candidates:
    - baked into the pool image by ci-kit's warm step (weekly);
    - `actions/cache`, saved from a run on master's ref (a `ci/` ref's cache is visible only to that ref; check whether
      any run uses master's ref);
    - anything better found.
  - How long a cache stays useful is measured from master's history over the last 14 days. Vitest drops the whole cache
    when the lockfile changes, and every module's key includes the content of `vitest.config.ts` and the files it
    imports, so count the commits that changed either.
  - *Correctness.* Vitest's key covers the module's id and content, the environment's resolved config, plugin names,
    the config file and its imports, and the lockfile. It does not cover tsconfig or any other file a transform reads,
    so the cache a VM receives must be keyed on those too.
  - One scratch run shows that a source file changed after the cache was built runs as changed: a planted failing
    assertion fails.
- **D, dependency optimization** for the happy-dom projects. This is vitest's `deps.optimizer`, under whichever key
  vitest 5 applies to happy-dom's environment.
- **I, `isolate: false`** for `node` and `artifacts`.
  - Files that fail without isolation move to an isolated project the config names, if they are few (at most about 5%
    of the project's files); otherwise I stops, recorded.
  - Isolation leaks depend on which files share a worker, and that varies from run to run. So I also needs one green run
    under `--sequence.shuffle`. Its three green runs are the minimum, not proof: a flake traced to I after landing
    reverts it.

Adoption rule:
- An arm is adopted when:
  - its three runs are green;
  - its `Test Files` and `Tests` lines equal the baseline's;
  - its median test step beats the baseline's by more than the baseline's own spread (max − min) and by at least 15 s.
- The adopted arms then run together as one commit, three green runs. The PR reports that gain against the baseline.
- The config also reaches `unit:darwin` on the mini. The PR gets one `unit:darwin` run before landing, scheduled
  through the mini's coordinator, as #99's was.

Deliverables:
- A MAWS PR from a fresh branch on current master, holding only the adopted arms, each with its comment in the config
  or gate.yml. Its body carries the table (each arm's median, spread and counts) and the class 1a pool run, green. It
  goes to the architect, who lands it.
- If C's delivery needs ci-kit (the bake), a ci-kit PR, reviewed by `doperpowers:reviewer-medium`.
- A proposal to the architect, separate from the PR, on running the renderer suites under the compiler only, with the
  numbers. It changes what is tested, so it is theirs to decide.

Cost: about 15 to 20 unit-only runs at about $0.014 each, under $0.50 of GCE.

Proof:
- Every arm's row is in Surprises & Discoveries, adopted or not.
- The combined commit's three runs are green, and the PR's class 1a pool run is green.

### M4 — Selection for iteration runs

At the end, `scripts/ci-gate.sh <worktree> --gates unit --class1a pool --affected` runs only the unit tests the change
can reach. The run is marked `affected` in its title, its trailer and its summary, and the store records it as a
selected run. Without `--affected`, every run is exactly as today.

MAWS (one PR, which the architect lands):
- **`scripts/ci-gate.sh --affected`.**
  - It fetches `origin/master` and takes the change's paths with their status (`git diff --name-status -M` from the merge
    base to the tested commit). A stale `origin/master` only widens the set.
  - It puts them in the pushed commit's message, one trailer line per path, beside `Selection: affected`.
  - The commit's subject becomes `ci-gate: <short> affected`, which is the run's display title.
  - Above a bound on paths, it sends no list, and the plan runs the full suite with the reason "too many paths". Choose
    the bound so the message stays well under the runner's environment-variable limit, and say why in a comment.
  - The header's usage text documents the flag and the landing rule.
- **`.github/scripts/gate-plan.mjs`** decides, as a pure function its test file covers:
  - whether `unit` and `unit:darwin` run `related` with a list of paths, or the full suite with a reason, by the fallback
    rules in Design;
  - "outside the source and test trees" means any path not under `src/`, `test/`, `apps/<app>/src/` or
    `apps/<app>/test/`;
  - the source-reader map is found by reading the suites (`readFileSync`, `readdir`, `glob`, lints, builds, spawned
    bundles in test files and test support), and kept in one place with a comment: a suite that starts reading a
    source tree must be added there;

  It writes the decision to the plan's outputs and one line to the summary:
  - `Selection: affected — <n> paths, unit runs vitest related`, or
  - `Selection: affected — full suite: <reason>`.

  A run without the trailer is unchanged: no output differs, and no summary line is added.
- **`.github/workflows/gate.yml`**, the test steps of `unit` and `unit-darwin`, when the plan gives a list:
  - they run vitest's `related` mode on the paths that still exist, with `--passWithNoTests` for a change no test
    reaches;
  - `unit:darwin` keeps its own file set (`scripts/darwin-unit-files.sh`) and runs only the files in both sets;
  - the JUnit report, the upload and the step names stay as they are.
- **`.github/scripts/gate-plan.test.mjs`** covers:
  - each fallback;
  - a rename and a delete of a test file (selection holds) and of a non-test file (full);
  - the bound;
  - a run with no trailer, whose outputs are byte-identical to today's.

ci-kit (one PR, `doperpowers:reviewer-medium`, merged by CI-opt; the sandbox workflow reads `main`, so no tag moves):
- `history/provenance.mjs` reads the `Selection:` trailer from the tested run's head commit. The run line gets
  `selection: 'affected'` or `null`.
- `history/record.mjs`:
  - a selected run never becomes a day's base;
  - a run line stores its membership (and its skipped set) as an explicit list when that is shorter than the delta
    from the base, or when the day has no base yet;
  - `membershipOf` and `skippedOf` read both forms and still check the hash.
- Tests in `test/history/` for these cases, and for a day whose first report is a selected run.

Proof:
- `node --test .github/scripts/gate-plan.test.mjs` passes, and so does ci-kit's `npm test`.
- Scratch runs off the PR branch, unit only, on the pool:
  1. **A source-only change.** A comment edit in one module, run with `--affected`. `gh run list` shows `affected` in
     the title. The summary gives the path count. The `Tests` line is a small fraction of the full suite's, and the JUnit
     report names only files related to the module. Record the unit job's wall time against a full run.
  2. **A planted failure.** A failing assertion in a test file related to the edited module, with `--affected`: the run
     is red.
  3. **A fallback.** A change that touches `package.json`, or a fixture directory from the list, with `--affected`:
     the full suite runs, and the summary says why.
- The PR head's class 1a on the pool, without `--affected`, is green. That run is the landing evidence.
- One `unit:darwin` run with `--affected` on the mini, scheduled through CI-opt (never inside a hold), runs the
  intersection.
- After both PRs land, the next collection records one selected run with `selection: 'affected'`. Its membership
  reconstructs to its `Tests` line, and the day's base is not that run.

### M3, M6

Each is written here in full when its condition holds:
- M3 when the store holds 14 days;
- M6 after M3–M5.

## Verification

- Spec: one adversarial review (`doperpowers:adversarial-reviewer`), done (Decision Log).
- M1: class 1a on the pool plus the fault injection, then the MAWS architect lands it.
- M2: `doperpowers:reviewer-medium` on the PR before merge.
- M5: the numbers are checked by the spec's owner against the run logs; the MAWS PR is landed by the architect; a ci-kit
  PR, if C needs one, gets `doperpowers:reviewer-medium`. No separate spec review: M5 is an experiment whose every
  adoption is gated on green runs and the architect.
- M4: the scratch runs above, checked by the spec's owner; the MAWS PR is landed by the architect; the ci-kit PR gets
  `doperpowers:reviewer-medium` before merge.
- M3, M6: named when each is written.

## Decision Log

- 2026-10-21: Order fixed by the owner: record first (M1–M2), then selection (M4), then overhead (M5), then the skill
  (M6). Labels and reports (M3) wait for data.
- 2026-10-21: Adversarial review (astra) found seven gaps in the first draft; all were taken.
  1. **Per-run membership.** The first draft inferred a pass from the day's last green suite, which is wrong across
     branches. Each run now records its exact membership, as a delta from a daily base.
  2. **Project in the case id.** Vitest's default JUnit drops the project, so `renderer` and `renderer-compiled` cases
     merged. MAWS now writes `<project>:<file>`. Checked locally: `renderer:src/renderer/src/app/MainBuildRow.test.tsx`.
  3. **Provenance resolved at collection.** The record now stores the tested commit, tree, producer, label and previous
     run. Both producers' ref formats are covered; the first draft knew only MAWS's.
  4. **No new red gate.** The upload is `continue-on-error`; report writing is accepted as residue.
  5. **Attempts.** Artifact names carry the attempt, and discovery is by artifact, not by run creation day.
  6. **File durations.** These are kept from `<testsuite time>`, not summed from cases.
  7. **Report ownership.** The upload runs only after this job's test step; `ci-results/` is cleared first; ingestion
     checks the report's timestamps.

- 2026-10-21 (M2, open for M3): **amended commits break the change line.** Sessions amend, so two runs of one change
  can test sibling commits. `compare` then says `diverged`, and the later run has no previous run. As built, M3 would
  label such a failure `unresolved`. The likely fix is a `rewritten` relation whose paths come from the merge base (a
  superset of what changed). Decide it when M3 is written, with real lines to check it against.

- 2026-10-21 (M5 written): **arms and rule.** The arms change how the suite runs, never which tests run. S
  (schedule) was added after reading a run's per-file timestamps; it is the cheapest arm and carries no test risk. C is
  measured as a ceiling before any delivery is built, because delivering a cache to a fresh VM needs either ci-kit's
  bake or a master-ref save, and neither is worth building for a small ceiling. I needs a shuffled run on top of three
  greens, because isolation leaks depend on which files share a worker. The strongest alternative was to measure every
  arm in one combined run. It lost because one run cannot attribute a gain or a failure to an arm. Running the renderer
  suites only under the compiler would save the most (`renderer`'s 256 s of summed test time), but it drops a tested
  configuration, so it goes to the architect as a proposal, not as an arm.
- 2026-10-21 (M5 running): choices the method left open.
  - **S′ replaced S.** S as written (base rules across every project) was red on its first run: two desk-hub suites
    that time real leases failed while the compiled renderer's transforms ran beside them. S′ is the spec's own
    fallback, the `-timing` projects first and the rest in vitest's order, so no other suite's neighbours change.
  - **D's include list** was chosen by importing single files locally: `radix-ui`, `zod`, `shiki`, `katex`. Wider
    lists broke locally (`@tiptap/react` bundled a second ProseMirror; `streamdown` and `@y/prosemirror` pulled browser
    builds of Node packages). D stopped after one red run with no gain.
  - **I's exceptions are a rule, not a list.** The first run without isolation failed 17 files (2.6% of `node`), 16
    of them suites that mock modules. Without isolation a worker keeps its mocker and module graph from file to file,
    so which mocking suite fails depends on the schedule. The exceptions are therefore every suite that calls
    `vi.mock` or `vi.doMock`, read from the files when the config loads (as `compiled-suites.ts` does): 84 of 615 in
    `node` (14%) and 2 of 144 in `artifacts`. That is above the 5% the plan named. It ran anyway, because the failing
    set was 2.6% and the rule is its stable form. I then fell short of the adoption bar on time, so the 5% decided
    nothing.
  - **The shuffled run shuffles files only** (`--sequence.shuffle.files`): isolation leaks depend on which files share
    a worker, and shuffling tests inside a file tests something I does not change.
  - **Two more baseline runs as a drift check**, after the arms (39578117722, 39578826466: test steps 424 s and
    446 s). They are outside the rule's baseline; they show the baseline did not drift while the arms ran.
  - **A fifth arm, V, tried locally and dropped:** vitest's own hint on the baseline names `pool: 'vmThreads'` for
    happy-dom (`renderer`'s environment created 436 times, 204–237 s). Under it, files that pass a `Uint8Array` across
    the context boundary fail (Yjs frames in `artifacts-dom`: "a frame that is not bytes"; one renderer file in a
    1-in-12 sample), and `MessageChannel` is missing. Passing would mean changing tests, so no pool run was spent.
  - **A sixth arm, C0: `--fsModuleCache` on a fresh checkout, no delivered cache.** C's cold runs, which only write the
    cache, beat the baseline (Surprises). C0 is that run as the unit job's own step, three runs under the rule. Its
    gain needs no delivery, so it does not wait on the delivery decision.
- 2026-10-21 (M5, CI-opt's decision on C's delivery): **a cache saved from master's ref, no bake.**
  - The pool image's weekly bake is out: a delivered cache goes stale at a median of 10.8 h (Surprises), and a bake
    change alters every repo's pool image.
  - The delivery is `actions/cache`, saved by a job on MAWS master's ref (readable from every `ci/` ref). The job runs on
    a push to master that changes the key's files, and daily. Pool spend is not a constraint (the owner's ruling).
  - It is its own arm, CD, in a follow-up PR on top of C0. Its gain counts the restore inside it and is judged by the
    same rule against C0, not the old baseline. Its proofs: a planted failure in a cached source module fails, and a
    changed vitest config import restores nothing.
- 2026-10-21 (M4 agreed with the MAWS architect): **the landing rule and the mark.**
  - A run marked `Selection: affected` never counts as landing evidence, even when a fallback ran the full suite; a red
    marked run counts as red.
  - The architect enforces this by hand, so the mark goes into the run's display title as well as the trailer and the
    summary.
  - Opt-in per call; children's briefs allow it for iteration runs only.
  - The architect added three fallbacks: any path outside the source and test trees, a deleted or renamed non-test
    file, and directories tests read through `fs` or a glob. The same selection applies to `unit:darwin`.
  - "Source and test trees" includes `apps/<app>/src` and `apps/<app>/test`, since the desk's apps are vitest projects
    of the same run (CI-opt's reading, confirmed by the architect; `apps/<app>/e2e` is outside). `e2e/` and `docs/`
    changes run the full unit suite by this rule. Whether they could select nothing is left for the store's data.
  - Amended after the build's probe of vitest 5.0.2, and agreed by the architect (gate-offload DL 82 at landing):
    - the architect's fs/glob rule became two rules: a non-script file in the source or test trees runs the full
      suite, and a source-reader map adds the reading suites;
    - read literally, the fs/glob rule would have run the full suite on nearly every change, because several suites
      read whole source trees (`src/renderer`, `src/`, `out/`);
    - the probe also found that vitest's `related` walk drops query imports: `tokens.css` selected 0 suites although
      four suites import it `?raw`.
  - The strongest alternative was the plan job computing the change itself. It lost because the plan checks out only
    `package.json` and `.github` sparsely, with no history, and a full fetch there costs every run.
  - The collector changes (never a selected base; an explicit list when shorter) follow from the store's delta design:
    a selected run of 200 cases against a 22,500-case base would otherwise store about 22,300 removed ids per line.
  - Built in ci-kit #64 (merge 919f0f6; `reviewer-medium` found nothing material; gate green 39568163133):
    - a selected run, a fallback that ran the full suite included, sets neither a day's base nor its durations, since
      the durations snapshot must cover every file;
    - the explicit form is `ids`, chosen when its serialized UTF-8 size is smaller than the delta's;
    - new skipped sets carry a hash, and old lines' skipped deltas without one are checked by count only;
    - the existing store (8 lines, 6 reports, 112,440 memberships) reconstructs with the new readers.
- 2026-10-21 (shards, ci-kit #69): **the collector reads a sharded job as one line.** MAWS shards `unit` across VMs for
  wall time: a matrix of jobs `unit <k>/<n>`, each uploading `test-results-unit-<k>of<n>-<attempt>`. Unsharded runs
  (`--affected` iterations, and every run before the switch) keep `unit` and `test-results-unit-<attempt>` and read as
  before. An attempt's n shards make one line of `unit`, so bases, durations, selection and the change links run across
  the switch:
  - its report is the union of the shards', each checked against its own shard's job;
  - it carries the earliest start, the latest completion and the worst conclusion; `shards` holds each shard's job, id,
    runner, times, conclusion and artifact;
  - it waits while a shard runs; it is `missing` when every shard ran its tests and an artifact is absent; an attempt in
    which a shard did not run its tests has none, since a shard from another attempt never completes a set; mixed shard
    counts are refused.

  So a run whose shard GCE preempted (ci-gate reruns that job alone) leaves no report. Completing the rerun from the
  copied shards' earlier artifacts would recover it; that is the owner's call.

## Surprises & Discoveries

- 2026-10-21 (M2): what the build found, and what the collector does about it.
  - **A case id is not unique.** MAWS repeats 15 titles within one (project, file). The nth occurrence's id carries
    `n` as a fourth element.
  - **Volume is about twice the estimate.** A `unit` base is 731 KB gzipped (estimated ≈ 200 KB), so the store grows
    about 25 MB a month. A run line is 1.4 KB green, and 17.7 KB with a 95-case delta. This is acceptable for now; if it
    matters later, a base can be written only when the suite changes.
  - **Refs are gone by collection.** MAWS's ci-gate deletes its `ci/` ref after the run. Commits stay readable by sha:
    `git/commits` works, but `compare` works only in its three-dot form (two-dot returns 404 on a dangling commit).
  - **"Re-run failed jobs" lists copied jobs.** Such an attempt lists every job, including the copied ones with their
    old times. A job whose `completed_at` is before its `created_at` is a copy and is skipped.
  - **"Missing" needs a definition.** A job is `missing` only when its upload step ran and produced no artifact. A report
    stamped outside its job is `rejected`, a fourth status.
  - **Discovery rule (collector step 1).** Listing until the stored artifacts could lose a failed older one, so every pass
    lists down to the artifacts' 8-day lifetime and skips known ids.
  - **Search and late arrivals (step 7).** The previous-run search reads the whole store, and a run that arrives late
    relinks the later line of its change.
  - **Errors vs `unparseable`.** Only an archive or JUnit defect makes a report `unparseable`. Any other failure is an
    error, retried by the next pass. A pass with errors still pushes what it wrote and then shows red.
  - **`node --test` writes no file into its JUnit (Node 22).** Every classname is `test`. Static's and probes' reports
    (M3) need a per-file run or a reporter that writes the file.

- 2026-10-21: Unit's duration grows about 2.5× faster than its test count (295 → 469 s against 18.0k → 22.3k tests,
  10-18 → 10-21). Heavy suites are being added, and per-file overhead dominates (above). The 100 slowest files are 55%
  of file time. The two `App.test.tsx` runs (plain and compiled) are 91 s.

- 2026-10-21 (M5 prep): **the longest files run last.** Run 39564672977's per-file lines, by log timestamp:
  - each project's files finish in a block, in project-name order (`artifacts` first, `renderer-compiled-timing` and
    `renderer-timing` last);
  - the last file outside the `-timing` projects finished at +370 s;
  - the two `App.test.tsx` finished at +412 s and +414 s, with test times of 42 s and 44 s, so they started at about
    +370 s with at most 4 of 8 workers busy around them.

  The cause is vitest 5's `BaseSequencer.sort`: it orders by project name before duration or size. Also seen: the first
  `renderer-compiled` file finished 16 s after the last `renderer` file. The likely cause is the React Compiler's
  transforms, unverified.

- 2026-10-21 (M4, MAWS half): what the build found. MAWS #101, head ebe0d6af5; landing evidence 39575096972, class 1a on
  the pool without `--affected`, green.
  - **Proofs.** All unit-only on the pool:
    - a one-line comment change in a renderer module, run 39570557690, green:
      - 136 files and 2,006 tests ran, against 22,450 in a full run;
      - the unit job took 234 s against 471–499 s for full runs (test step 177 s against 421–445 s);
      - the JUnit report's (project, file) pairs equal vitest's related set computed locally;
    - a planted failure, run 39571488563: red;
    - a fixture file added, run 39573713454: green, ran the full suite with the reason in the summary.
  - **The renderer's graph is dense.** A leaf sidebar module reaches about 130 suites, both `App.test.tsx` among them,
    and vitest's graph walk costs about 34 s. Expect about half a full unit job for a renderer change, not a tenth.
  - **The rule rarely selects for a landing-sized change.** Replaying the plan over the last 200 landings' whole diffs,
    10 would select:
    - 143 fall back for a path outside the trees, almost always `docs/` (141 of the 200 landings touch it);
    - gate files 29, too many paths 11, data 4, support 3.

    Exempting `docs/` would give 45, and `docs/` with `e2e/` 63. `docs/` cannot be exempted wholesale:
    `src/shared/plugins/cli.test.ts` reads `docs/doperpowers/evidence`. Iteration runs are earlier branch states, so
    10/200 is a floor. The store's `selection` field will show the real rate. A `docs/` exemption, less the evidence
    directory, went to the architect as a follow-up.
  - **How it is built.**
    - The paths travel as `Affected:` trailer lines with an `Affected-Count:`, capped at 200 paths (the 93rd
      percentile of files per landing; one environment variable is capped at 128 KiB).
    - The decision is a pure function in `gate-affected.mjs`.
    - Both unit jobs run `unit-related.mjs` through vitest's `startVitest` API, because the CLI cannot combine
      related mode with file filters, which `unit:darwin`'s intersection needs.
  - **Proving the branch needed a workaround.** The branch itself changes `.github/` and `scripts/`, so a change
    taken from master always falls back as a gate file. The proofs ran from a scratch clone whose `origin/master` was
    pinned at the PR head. The MAWS friction tracker has the row.
  - **Two runs for the collector's proof.** Run 39573713454 is a selected run that ran the full suite: it must not
    become a day's base. Run 39571488563 is a red selected run.

- 2026-10-21 (M5): the arms' runs. B = MAWS 0ddd2012f; every run unit-only on the pool, each on a
  `c3d-highcpu-8` spot VM in `us-central1-a` (the GCE ledger). Test step and job in seconds; Duration is vitest's.
  Every green run counted `1612 passed | 8 skipped (1620)` files and `22373 passed | 80 skipped (22453)` tests.

  | Arm | Runs | Test step (median, spread) | Duration median | Tail: last other file → end | Verdict |
  |---|---|---|---|---|---|
  | Baseline | 39566832678, 39566874932, 39568056678 | 449, 435, 477 (449, 42) | 443.7 (tests 45%, import 27%, transform 16%, environment 12%) | +391 → +444, +384 → +431, +418 → +471 | the reference |
  | S, size across projects | 39568222090 | 399, red | 393.9 | none (App.test.tsx done at +234) | red: 2 desk-hub real-time suites failed |
  | S′, `-timing` first | 39571640636, 39572998936, 39574256403 | 439, 423, 418 (423, 21) | 419.2 | none | not adopted: −26 s, under the 42 s spread |
  | C, ceiling, cold → warm in one job | 39569475316, 39573317257, 39575395042 | cold 429, 403, 398; warm 390, 349, 364 (warm 364) | warm 359.7 (tests 50%, import 32%, environment 15%, transform 2%) | +7 to +8 s | cleared the 10% bar: −85 s (−19%) |
  | C0, `--fsModuleCache`, empty cache, no delivery | 39580469603, 39580535339, 39581673554 | 399, 387, 418 (399, 31) | 394.8 (tests 44%, import 28%, transform 14%, environment 13%) | +387 → +395, +376 → +384, +406 → +414 | **adopted**: −50 s (−11%) |
  | CD, C0 plus a cache restored from an earlier run of the same key (stand-in for master's) | saved by 39585864153; restored 39587199314, 39587213818, 39587230745 | restore 3 + test 400, 344, 383 = 403, 347, 386 (386) | 378.7 (transform 2%) | +388 → +396, +333 → +340, +371 → +379 | not adopted: −13 s against C0 (its spread 31) |
  | H, C0 plus a parallel pre-read of the checkout (hydration test) | 39591017524, 39591077339, 39591139217 | pre-read 10, 10, 9 + test 379, 382, 392 = 389, 392, 401 (392) | 378.6 | +367 → +375, +372 → +379, +381 → +388 | not adopted: test step −17 s, net −7 s against C0 |
  | D, `deps.optimizer.client` | 39570695200 | 455, red | 448.7 | +395 → +449 | red, no gain; stopped |
  | I, exploration (no exceptions) | 39569413560 | 411, red | 405.7 | +356 → +406 | 17 files red, 16 of them mocking suites |
  | I, mocking suites isolated | 39571997873, 39575551870, 39577464231; shuffled 39576834456 | 391, 423, 434 (423, 43); shuffled 405, green | 417.6 (tests 46%, import 23–24%) | +339 → +385, +364 → +418, +380 → +428 | not adopted: −26 s, under the 42 s spread |

  - **The tail was transform work, not test work.** Each `-timing` project has its own Vite server, so it transforms
    the whole app again, on demand, while its two files run at the end. With `fsModuleCache` on, a project reuses
    the transforms another project of the same plugins and resolve config wrote earlier in the run: `App.test.tsx`'s
    tests took 7–9 s instead of 42–52 s, in the cold runs as in the warm ones. Locally, `renderer-timing` read 202 of
    its 784 modules from what `renderer` had written. S′ removed the tail but ran `App.test.tsx` at the start, where it
    took 66–68 s under the start's contention, so it gained little.
  - **C's cold runs beat the baseline**: Duration 426.5, 400.7, 396.3 (median 400.7) against 443.7. On the same VM,
    the warm run saved a further 41, 56 and 37 s (median 41 s, about 10%), mostly in `renderer-compiled`, whose block
    shrank from 90–95 s to 74–86 s. The cache was 232 MB in 6,973 files.
  - **How long a delivered cache would stay valid.** In the last 14 days, 24 first-parent master commits changed the
    lockfile (10, which makes vitest drop the whole cache) or a vitest config file or its imports (the root config 18,
    `compiled-suites.ts` 1, the desk apps' configs 3; a commit can change several), which re-keys every module of the projects it configures. With
    `tsconfig*.json`, which the delivered cache must also be keyed on, there were 33. The median gap between two such
    commits is 10.8 h (the longest 98 h), and 10 of the 14 days had one. A weekly bake would be stale within a day.
  - **The baseline's spread is about 10% of a run.** Five baseline runs on the same commit and VM type took 424–477 s.
    An arm must beat the median by more than the three-run spread (42 s), so a real gain of 20–40 s cannot be adopted
    from three runs. S′ and I both measured −26 s, and all six of their runs were below the baseline median.
  - **Running the renderer suites under the compiler only** (the proposal, not an arm), on top of C0:
    - the config change: `renderer` leaves out the suites `renderer-compiled` runs, and `renderer-timing` is dropped;
    - runs 39581780079, 39582919173, 39582934642: test step 302, 314, 305 s (median 305; C0's was 399), so −94 s
      (−24%); Duration median 301.2 s;
    - 1402 files and 19,136 tests ran, against 1620 and 22,453: 218 file runs and 3,317 test executions fewer.
      `renderer` keeps its 220 suites that render nothing;
    - the third run was red on a desk-hub test the change does not touch.

    The numbers went to CI-opt for the MAWS architect, whose coverage decision it is. The architect declined it as
    measured: `apps/desk-web` builds the same `src/renderer` modules with plain `react()`, so the uncompiled
    behaviour ships in the desk. The desk lane is moving desk-web onto the compiler, and the change waits for that.
  - **CD, the delivered cache.** It ran as C0 plus `actions/cache` restore and save, every run on one fixed ref
    (`ci/m5-cd`) so they share a cache scope.
    - The restore took 3 s: 68 MB compressed, 232 MB in 6,973 files. The transform share fell to 2%, but the runs
      were 13 s faster than C0 at the median, which is under the bar. Two more of each, run at the same time as
      supplementary numbers outside the rule: CD 359 and 401 s (39589561728, 39589577964), C0 385 and 440 s
      (39589602365, 39589665895). Over five runs each, the medians are 386 and 399 s and the means 379 and 406 s, so
      the delivered cache saves about 13–27 s.
    - The ceiling's 41 s came from a warm pass on the same VM as its cold pass. There, `node_modules` and the sources
      had already been read off the disk. A fresh VM's disk is hydrated lazily from its image, so it pays those reads
      whatever cache it is given. This is the likely reason, not verified.
    - **Absolute paths.** vitest's entries, keys and cached code name absolute paths, and each GCE VM's work folder is
      named after the VM (`/var/lib/ci-kit/cache/work/<instance>/…`), so a cache from another VM never hits.
      - The arm moved the checkout to `work/fixed/MAWS/MAWS` and linked the work folder to it. The fixed path must be
        exactly as deep: actions/cache stores the path relative to the link, and tar resolves it from the real
        directory. The first save failed on that (39584455603).
      - The clean fix is a fixed `work_folder` for GCE jobs in ci-kit (one job per VM).
    - **One ref cancels itself.** gate.yml's concurrency group, `gate-${{ github.ref }}` with cancel-in-progress, cancels
      runs that share a ref. Three restored runs pushed together cancelled each other (39587055562, 39587070800,
      39587086156), and the arm's scratch commit put the run id in the group.
    - **Planted failure, 39587101466.** The cache was restored, and `plural()` in `copy.ts` was changed after the cache
      was built. 14 files and 42 tests failed: the changed module was transformed again, not served stale.
    - **Stale key, 39588409984.** A comment added to `test/support/compiled-suites.ts` changed the key prefix: "Cache not
      found", transform share 14%, as cold.
    - **H tested that explanation (CI-opt's request).**
      - Setup: B plus C0, and a step right before the tests that reads every file of the checkout, `node_modules`
        included (50,255 files, 1,557 MiB), with `xargs -P 32`.
      - The pre-read took 9.5 s, about 165 MB/s.
      - The test step fell to a median of 382 s, 17 s under C0's 399, so the pre-read and test together saved 7 s. Its
        transform share stayed at C0's 14%.
      - So hydration explains part of the ceiling: about 17 s of its 41, with the transforms (CD) the rest. A
        pre-read in series pays back 10 of those 17 s, so it is no lever for this job. Overlapping it with the build
        might be one; that is unmeasured.
    - **The production form.** It was drafted and not opened, since CD was not adopted:
      - a composite action with `place`, `restore` and `save`;
      - a `unit-cache.yml` on master: on a push that changes the key's files, daily, and on dispatch; the whole suite
        on the pool, saved whatever its outcome;
      - the unit job restores, and never saves from a `ci/` ref.
  - **A desk-hub test flakes on the current suite.** `provisioning-sweep.test.ts > the offline sweep > binds each
    candidate to the enrollment it read…` failed in 2 of about 33 runs: S's (interleaved order) and the third
    compiler-only run (vitest's own order). S's red was therefore partly this flake; its other failure was
    `session-plane.test.ts`'s lease test.
  - **D duplicated packages.** With the optimizer on for `client`, 15 files failed: the code editor's and viewer's
    suites, the sidebar's and the artifact viewers', each in both renderer projects, and `mermaid.dom.test.ts`, whose
    spy sat on a second instance of mermaid. The run took 448.7 s.

## Outcomes & Retrospective

- **M5 (2026-10-21).** One arm of nine was adopted: C0, `--fsModuleCache` on a fresh checkout, −50 s (−11%) on the
  unit test step, with nothing to deliver, store or key. It is MAWS #104; it lands after its `unit:darwin` run.
  - Compiler-only measured −94 s on top of C0, but it changes what is tested. It waits on desk-web moving to the
    compiler (branch `unit-compiler-only`).
  - S′ and I measured −26 s each, below a bar set by the pool's own noise.
  - A delivered cache measured −13 s, H −7 s net. D and V broke tests, and S as written met a flake.
  - Lessons for M6:
    - **Read per-file times across arms, not only totals.** The tail looked like scheduling. Only App.test.tsx's
      test time collapsing in C's cold runs (44 s → 8 s) showed it was transform work duplicated by a second Vite
      server.
    - **A before/after on one VM is not a fresh VM.** C's ceiling (−41 s warm against cold) mixed transforms with a
      disk the cold pass had already read; delivered to fresh VMs, the transforms were worth about 13–27 s.
    - **Three runs resolve about 10% here.** Five baseline runs on one commit and one machine type spread 424–477 s.
      Gains of 20–30 s need more runs, or runs paired in time, before they can be called.
    - **vitest's diagnostics point at real costs, not at safe fixes.** Its hint toward `vmThreads` (environment
      setup) broke tests across realms. Its `fsModuleCache` hint was right, for a reason it does not name.
