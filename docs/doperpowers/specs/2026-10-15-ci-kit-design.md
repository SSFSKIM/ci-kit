# ci-kit — gates off the MacBook, for every repo — living spec

**Date.** 2026-10-15. **Status.** Reviewed; executing (plan-executor, from 2026-10-15).
**Home.** `SSFSKIM/ci-kit` (public); this file is `docs/doperpowers/specs/2026-10-15-ci-kit-design.md`.
**Design history.** Brainstormed on 2026-10-15 in the doperpowers session named "CI-opt", from
three peer sessions' bottleneck reports, a mining of 4,021 session transcripts (09-22..10-15),
GitHub Actions run data for MAWS, and measurements of both Macs. The human approved the design with
the Hetzner on-demand pool, over GCE spot VMs and Namespace. On 2026-10-16, with MAWS's real
arrival rate measured, the human moved private Linux gates to GCE spot VMs (§3a); the Hetzner
pool serves until that backend is live. The working evidence was gathered under
`/tmp/ci-analysis/` on the MacBook. `/tmp` is purged, so a copy that names private MAWS internals
is kept in the private repo `SSFSKIM/ci-kit-sandbox` under `evidence/2026-10-15/`. The numbers this
spec relies on are copied into §Context.

## Purpose

One person runs dozens of Claude Code sessions across three repos on two Macs:

- **MAWS**: private; an Electron desktop app.
- **cua**: public; a macOS GUI-automation plugin.
- **doperpowers**: public; this methodology plugin.

Every gate those sessions run (unit suites, builds, Electron e2e) runs on the MacBook that also
hosts the sessions. That machine sits at load 90–330 all day. Gates wait hours for it to calm down,
and timing tests fail because of it. That is the problem this initiative removes.

After this work:

- **One command per repo.** An agent in any adopting repo verifies a commit with `ci-gate`. The
  repo's gates run off the MacBook. The command prints one line per gate and a final verdict, and
  puts the logs of failed gates on local disk.
- **Free PR checks for public repos.** cua and doperpowers get PR checks on GitHub's free hosted
  runners, configured by two files.
- **No MAWS gate on the MacBook.** Both moves depend on maws-fe adopting the proposals.
  - MAWS's Linux gates run on GCE spot VMs, one per job, each sized to its job and deleted after
    it (§3a). Until that backend is live, they run on a Hetzner server that exists only while
    gates run (§3).
  - MAWS's Electron e2e runs on the Mac mini.
- **No timing flakes on gate lanes.** Tests assert that events happened, not how fast the machine
  was.
- **Self-cleaning hosts.** Both Macs kill orphaned test processes on their own. They report
  worktrees and VMs that could go, and delete nothing without a person.

How to see it working: §Acceptance. The shortest proofs are:

- A2: `ci-gate` on cua prints `GREEN`.
- A5: a gate on the pool. A server is created for it, runs it, and deletes itself when idle.

### What it must not be

- **Not a change to doperpowers' plugin or agent rules** (`skills/`, `agents/`, `hooks/`,
  `output-styles/`). The human ruled it out. Whether a repo's agents use `ci-gate` is that repo's
  call, made in its CLAUDE.md, not this kit's.
- **Not a change to merge rules or branch protection.** Checks are added, never made required.
- **Never a self-hosted runner on a public repo.** On a public repo, a stranger's fork PR could run
  code on the pool box or on the human's mini.
- **Not the MacBook as a runner.** The owner, 10-14: compute distribution is the goal.
- **Not the owner of MAWS's `.github/workflows/gate.yml`.**
  - **maws-fe** is the MAWS architect session. It owns that workflow, MAWS's test scripts, and the
    list of macOS-only unit files (the "§6 list" of MAWS's gate-offload plan).
  - MAWS changes reach maws-fe as proposals with evidence, and maws-fe lands them.
  - This initiative commits nothing to MAWS.
- **Not over $50/month of CI compute for MAWS.** Public repos run free.

## Progress

- [x] (2026-10-15 21:30Z) Design approved; spec written.
- [x] (2026-10-15 22:10Z) Independent spec review and execution-section buildability review;
  14 findings folded (Decision Log). A second round was not run. The changes are additive
  hardening, and the pool code they shape gets its own milestone reviews and the high-rung
  whole-range review.
- [x] (2026-10-15 23:20Z) M1 — Kit core: config, planner, reusable workflow, `ci-gate`, the kit's
  own CI. PR #2 merged (0a930ee); `v1` at 0a930ee; `ci-gate` installed on both Macs from the main
  clones.
- [x] (2026-10-15 23:20Z) M2/M3 prerequisite: the hosted probe report is committed to
  `ci-kit-sandbox` (`evidence/2026-10-15/hosted-probe.md`), and its results are folded into §5.
- [x] (2026-10-16 04:10Z) M2 — cua: adoption and timing-test stabilization. SSFSKIM/cua#143
  merged (45c003aa) after a medium review and one fix wave. A1: checks finished 5m10s after the
  push. A2/A10: 20/20 consecutive `ci-gate` runs GREEN at 9ab5439, and the final head b45df7d is
  GREEN. serve-cli and serve-lazy are deferred to cua#145; the clipboard product edge is cua#144.
  - [x] (2026-10-15 23:30Z) Kit additions (`setup.fetch_depth`, `CI_KIT_BASE`/`CI_KIT_HEAD`): PR #3
    merged; `v1` moved to it.
- [x] (2026-10-16 09:50Z) M3 — doperpowers: adoption and timing-test stabilization.
  SSFSKIM/doperpowers#198 merged (979192b8, 7.160.1) after medium reviews. A1: ten checks green
  in 8m14s. A10: 20/20 consecutive `ci-gate` runs GREEN across nine gates (stabF1–20). Negative
  shell-lint proof RED on SC2068 (run 38828692666). codex-companion is not gated (discarded by
  the owner).
- [x] (2026-10-15 22:10Z) M4 — Spike: the pool's boot path. Verdict ≤ 5 min; PR #1 merged
  (spike scripts and results under `spike/pool-boot/`).
- [x] (2026-10-16 04:20Z) M5 — The pool
  - [x] (2026-10-16 02:40Z) Code reviewed clean after three rounds; PR #7 merged; `v1` moved to
    86069cf. A5, A6 and the box-local A7 parts proven live from the branch.
  - [x] (2026-10-16 04:20Z) Post-merge proofs on dispatched guard runs from `main` (stale
    heartbeat, wrong key with the watchdog stopped, wake, re-enable), a re-bake (cpx12 holds it),
    the clamp, and cleanup. PR #8 merged; `v1` moved. Still open: the guard's *scheduled* runs
    had not fired 85 minutes after the merge, so the timing "within two guard cycles" on the real
    schedule is checked in M9.
- [x] (2026-10-16 00:05Z) M6 — The mac lane on the mini. PR #4 merged; runner `ci-kit-mac-mini`
  live on MAWS; `e2e:composer` 10/10, ship. A8's macOS-only unit subset is M7's.
- [x] (2026-10-16 06:40Z) M7 — MAWS: evidence and proposals for maws-fe. The package is in the
  sandbox `evidence/maws/` (191afcc), reviewed and approved for relay, and sent to CI-opt for
  maws-fe. The kit fix (Electron cache) is PR #10. A9 waits on maws-fe adopting P1; activation
  stays with M7's activation steps or with CI-opt after finish.
- [x] (2026-10-16 02:20Z) M8 — Host janitor. PR #6 merged after four review rounds; the first
  dry-run would-kill lists were empty on both Macs; the janitor runs live from the main clones on
  both.
- [ ] M9 — Acceptance
- [ ] M10 — The GCE backend and cutover

## Context: what was measured (2026-10-15)

| Fact | Value | Source |
|---|---|---|
| MacBook | M1 Max, 10 cores, 32 GB | `sysctl` |
| MacBook load during the day | 90–330 (1-min); CPU 0% idle, 56% system | sampled 13:00 onward |
| MacBook memory | 13 GB compressed; swap 10.3 of 11.2 GB | `vm_stat`, `sysctl vm.swapusage` |
| Test runners' share at the time sampled | ~0% CPU | the load comes from sessions and non-test processes, not tests |
| MAWS: share of a gate's wall clock spent waiting for load < 20 | ~80% (P3-A: 2 h 21 m wall for 28.6 min of running) | MAWS transcripts |
| MAWS: session wall clock spent in the load rule since 10-12 | 49.1 h over 1,018 commands | MAWS transcripts |
| Timing-flake reports, all three repos | ~174 reports in ~191 subagent transcripts, daily 09-26..10-15; real bugs masked twice | history catalogue #3 |
| MAWS unit job on GitHub's 2-core private runner | 16–21 min (85% of it is `pnpm test`, 14.5k tests, 1,031 files) | runs 38783679574 and others |
| MAWS unit suite on the Mac, 4 workers | 130–314 s | MAWS docs |
| MAWS Electron e2e on the Mac | about 2 min per group, ~40 s of it a rebuild; 18 groups ≈ 40 min at low load | maws-fe |
| MAWS e2e on Linux | 17 of 22 groups fail for platform reasons; rejected by MAWS | gate-offload plan §3.1 |
| MAWS Actions volume | 1,899 billed min in 20.3 h (10-14/15); 49% of runs red; 9–10 of 14 post-landing unit reds not caused by the change | Actions API |
| GitHub Actions queue wait | median 2 s | Actions API |
| cua suite (`npm test`) | 2,436 tests in 224 files; median 50.7 s, max 687 s locally; runs twice (Node 22 and 26) | 117 local logs |
| doperpowers suites | ~65 shell test scripts; sminos alone ~1,740 assertions; its 2-s checks fail on unchanged base in 11/48 runs at load ~130, 55/64 at ~250 | TECH-DEBT T3 |
| Mac mini | M2 Pro, 10 cores (6P+4E), 16 GB (14 GB used on 10-14), macOS 27; autologin `new`, never sleeps; ~11 Claude sessions; already hosts another repo's runner (`actions-runner-ida-solution`); the cua session drives its GUI | `ssh mini` |
| Hetzner prices (API, 2026-10-15; net = gross on this account) | CPX62 16 vCPU / 32 GB €0.2452/h (cap €152.99/mo); CPX52 12/24 €0.1907/h; CPX42 8/16 €0.1314/h; CX53 16/32 €0.0561/h (cap €34.99) but **unavailable in every location**; snapshots €0.0199/GB-mo; IPv4 €0.001/h | `GET /v1/server_types`, `/v1/pricing` |
| Hetzner billing | per started hour of a server's life, rounded up; a powered-off server still bills; delete to stop billing | docs.hetzner.com/cloud/billing/faq |

## Acceptance

Each item is a behavior someone can check. The commands are in Concrete Steps under M9.

1. **A1 — Public PR checks.**
   - A pull request to `SSFSKIM/cua` (and one to `SSFSKIM/doperpowers`) shows a check `ci / <gate>`
     for each gate the change selects, plus `ci / verdict`.
   - All of them run on GitHub-hosted runners and finish within 10 minutes of the push.
2. **A2 — `ci-gate` on a public repo.**
   - From a cua worktree, `ci-gate` prints one `PASS` line per selected gate, then
     `GREEN <run-url>`, and exits 0.
   - Afterwards the `ci/` ref it pushed is gone from the remote.
   - On a commit that breaks one test:
     - it prints `FAIL <gate> <duration> log=<path>`;
     - the file at `<path>` contains the failing assertion;
     - the last line is `RED 1/<n> <run-url>` and the exit code is 1.
   - Two `ci-gate` calls on the same commit and label, started 5 s apart:
     - they get separate refs and separate runs, and each reports its own verdict;
     - each deletes only its own ref, and neither run is cancelled.
3. **A3 — Config errors fail early and say why.**
   - A `.github/ci-kit.yml` that puts a gate on lane `pool` in a public repo fails the `plan` job
     before any gate runs. Its message is `ci-kit: lane "pool" is for private repos only (gate "<name>")`.
   - `ci-gate` prints that message and exits 2.
4. **A4 — Two-file onboarding.**
   - The CI wiring in `ci-kit-sandbox`, cua and doperpowers is exactly `.github/ci-kit.yml` plus
     `.github/workflows/ci.yml`, as given in `docs/adopting.md`.
   - Test fixes land as separate commits.
5. **A5 — Pool round trip.**
   - Start with no pool server in the Hetzner project, then push a commit to `ci-kit-sandbox` whose
     config has a `cpus: 4` pool gate.
   - A server named `ci-kit-pool` is created and runs the gate. The gate's log shows `nproc` = 4.
     The gate reports `PASS` no more than 5 minutes after the push. M4's verdict may revise this bound; see M4.
   - With no further work, the server deletes itself at or after minute 50 of its billed hour.
   - The ledger gains one row for that server session.
6. **A6 — Pool parallelism without overcommit.**
   - Four `cpus: 4` gates in one run start within 60 s of each other on one box.
   - A fifth gate in the same run starts only after one of the four finishes.
7. **A7 — Backstops.**
   - Take a server labelled as a pool box whose heartbeat is stale (made from a stock image with no
     agent). The guard deletes it within two guard cycles and opens an alert issue.
   - Take a pool job that stays queued with no pool server, as when a job was queued after the box
     deleted itself. The guard creates a box for it within two guard cycles.
   - A box whose agent cannot reach GitHub is deleted within 40 minutes. For the test, the box is
     booted with a deliberately invalid App key through a user-data override; the real key is not
     revoked.
     - its watchdog deletes it on its own (box-local);
     - if the watchdog is stopped too, the guard deletes it.
   - A job container that outlives its job, because its process ignores exit (made for the test),
     is killed within 10 minutes of its runner leaving GitHub.
   - Cancelling a bake after its builder exists, and failing one before its snapshot, both leave no
     builder server after the next guard cycle.
   - A guard workflow that GitHub has disabled is enabled again by the next pool boot.
8. **A8 — The mac lane.**
   - In MAWS, `scripts/ci-gate.sh <sha> --runner macos --gates e2e:composer` runs that e2e group on
     the mini's runner (the job's runner name is the mini's) and is green.
   - No process of the job runs on the MacBook.
   - After the job, no process started under the runner's work directory is left on the mini.
   - MAWS's macOS-only unit subset (the 13 guarded files) runs on the mini, and its report shows
     those files' tests executed, not skipped.
9. **A9 — MAWS on the pool.**
   - maws-fe has the evidence package and the proposals (M7).
   - Once maws-fe lands the pool lane, a MAWS gate run's static, unit and probes jobs run on
     runners named `ci-kit-pool-*`. The unit job's wall time is no more than 8 minutes, against
     16–21 today.
   - The unit job's log shows vitest started as many workers as the job's `cpus-<N>`, not 16.
   - If maws-fe has not landed it by finish, Outcomes records that A9 is pending and why.
10. **A10 — Timing stability.**
    - Each test fixed in M2/M3 is checked under an induced CPU load of 2× the cores (with the
      command recorded): it fails before the fix and passes 20 of 20 runs after it.
    - The cua and doperpowers CI gates pass 20 consecutive `ci-gate` runs of the adoption branch's
      head. That needs no merge: a `ci/**` push uses the workflow file in the pushed commit.
11. **A11 — The janitor.**
    - On the MacBook, a test process orphaned for more than 2 hours (made for the test) is killed
      within one janitor interval and logged in `~/Library/Logs/ci-kit/janitor.log`.
    - A detached watcher (`vitest --watch`, made for the test) that is equally old and orphaned is
      reported and left running.
    - `~/Library/Logs/ci-kit/report.md` lists worktrees that are clean and merged, and VMs that
      have run more than 12 h, and deletes nothing.
12. **A12 — Cost is visible.**
    - The ledger issue holds one row per pool server session and a weekly cost summary posted by
      the guard.
    - At finish, Outcomes records the cost per day projected from the days observed so far, and
      whether it fits $50/month.

13. **A13 — The GCE backend.**
    - With a repo in `gce.json`, each pool job gets a VM of its mapped machine type, and its runner
      name is `ci-kit-gce-*`.
    - The median time from queue to start is at most 2.5 min, over at least 10 jobs.
    - A job's VM is gone within 2 min of the job's end.
    - An hour with no pool demand leaves no `ci-kit=gce` instances, disks or runners.
    - A VM whose job was cancelled before pickup is gone within 12 min.
    - Every VM shows `maxRunDuration` and a `DELETE` termination action.
    - Inside a job container, `getent hosts github.com` succeeds, and a request to
      `169.254.169.254:80` fails.
    - A simulated preemption (`gcloud compute instances simulate-maintenance-event` on a spot VM)
      fails its job ("runner lost"). The ledger finalizes that allocation `preempted` with the job
      it actually held, and no instance, disk or runner is left.
    - Moving the sandbox from `pool.json` to `gce.json`, and back, never has one pool job served by
      both backends. Jobs queued during the move start once it completes.
    - The ledger holds a row per allocation and a daily line. Outcomes records the month projected
      from MAWS's observed rate.
    - MAWS's `gate.yml` is byte-identical before and after its move.

## Design

### Terms

- **Gate.** One named check a repo runs: a shell command with a lane and a timeout, such as `unit`
  or `lint`.
- **Lane.** Where a gate runs.
  - `hosted`: GitHub's `ubuntu-latest`.
  - `hosted-macos`: GitHub's `macos-latest`. Free on public repos.
  - `pool`: private Linux capacity. It is the Hetzner box (§3) or, once live, GCE spot VMs
    (§3a), per repo: a repo in `gce.json` is served by GCE, one in `pool.json` by Hetzner. Private repos only.
  - `mac`: the Mac mini's self-hosted runner. Private repos only.
- **Kit.** This repository:
  - the reusable workflow (`.github/workflows/gates.yml`);
  - the **planner**, which reads a repo's config and decides which gates run where;
  - `ci-gate`;
  - the pool's code;
  - the mac-lane setup;
  - the host janitor.
- **ci ref.** A branch named `ci/<label>-<sha8>-<nonce6>` that `ci-gate` pushes to trigger a run. It is
  deleted after the run.
- **Nonce commit.** The empty commit `ci-gate` puts on top of the tested commit. Its unique message
  makes every push start a run of its own. It carries the `CI-Gates:` trailer.
- **Pool box.** The one Hetzner server named `ci-kit-pool`. It runs **job containers**, each a fresh
  Docker container running one GitHub Actions runner for one job.
- **JIT runner.** A runner registered through GitHub's just-in-time API
  (`POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`). It takes exactly one job and
  then unregisters itself.
- **Pool agent.** The service on the pool box. It watches GitHub for queued pool jobs, starts job
  containers, and deletes the box when it is idle.
- **Ensure.** The step a workflow runs before it queues pool jobs. It creates the pool box if none
  exists.
- **Guard.** A scheduled workflow in the kit and the backstop for the pool. It wakes a box for
  stranded jobs, deletes a box with a dead agent, and records cost.
- **Bake.** The workflow that builds the pool's Hetzner snapshot (its disk image).
- **Ledger.** An issue titled "pool ledger" in the private `SSFSKIM/ci-kit-sandbox`, with one row
  per pool server session.
- **maws-fe, cua_repl, doperpowers-74.** The peer sessions that own, respectively:
  - MAWS's gates;
  - cua's development;
  - the sminos desk work in doperpowers.

  This session ("CI-opt") is the route to them (Constraints).

### Overview

```
 agent in a worktree ──ci-gate──► push ci/<label>-<sha8> (+ nonce commit, CI-Gates trailer)
 PR opened/updated  ───────────► caller workflow .github/workflows/ci.yml
                                   └─ uses SSFSKIM/ci-kit/.github/workflows/gates.yml@v1
                                        plan  (hosted: read .github/ci-kit.yml, select gates,
                                               emit matrix; if any pool gate → ensure)
                                        gate  (matrix; one job per gate, runs-on by lane)
                                          ├─ hosted / hosted-macos : GitHub runners (public: free)
                                          ├─ pool  : Hetzner box ── job container per job
                                          └─ mac   : Mac mini runner (LaunchAgent, GUI session)
                                        verdict (always; one stable check)
 MAWS's own gate.yml ─ (maws-fe's choice) ─ same pool labels + ensure; mini via its macOS lane
```

Two layers can be adopted independently:

- **The infrastructure lanes.** The pool, with its labels and ensure action, and the mac runner.
  MAWS uses them from its own `gate.yml`.
- **The config layer.** `ci-kit.yml`, the reusable workflow, and `ci-gate`. cua, doperpowers and
  future repos use it.

MAWS keeps its own `gate.yml` and `scripts/ci-gate.sh`. Those already do for MAWS what the config
layer does generically, and maws-fe owns them.

### 1. The project config and the reusable workflow

**Onboarding a repo.** A repo adopts the kit with two files.

1. `.github/ci-kit.yml` — the gates (schema in Interfaces I1).
2. `.github/workflows/ci.yml` — a short caller that runs on:
   - `pull_request`;
   - pushes to `ci/**`;
   - `workflow_dispatch`, with an optional `gates` input.

   It calls the kit's reusable workflow, pinned at `@v1`, with `secrets: inherit` (template in I2).

**The plan job.** It runs on a hosted runner and gets the changed files.

- **Change basis:**
  - for a PR, the PR's base;
  - for a ci ref, the merge-base of the tested commit with the default branch;
  - a dispatch ignores changes.
- **Selection rules, applied in order:**
  1. An explicit list wins. That is the dispatch input `gates` or the nonce commit's
     `CI-Gates: a,b` trailer. Exactly those gates run, and `paths` is ignored.
  2. Otherwise, a gate runs when its `on:` list includes the event and either it has no `paths`,
     or a changed file matches one of them (glob, `**` crossing directories).
  3. A selection that is empty is a success. `verdict` is green with "no gates selected".
- **Output.** The plan job emits the matrix. If any selected gate is on the pool lane, it runs
  ensure (§3).

**Lane rule.**

- The planner reads the repo's visibility from the event payload (`repository.private`).
- It refuses lanes `pool` and `mac` on a public repo with the A3 message. The pool agent also
  refuses public repos (§3), so a mistaken config can never put a stranger's code on the box.

**Gate jobs.**

- Each gate is one matrix job named after the gate, so checks read `ci / unit`.
- Steps: check out at the tested commit, apply the shared `setup`, run the gate with `bash -eo pipefail`, and on failure upload `artifacts`.
- `setup` gives Node via `actions/setup-node`, pnpm via corepack, and the `install` command. A gate
  can skip it with `setup: false`.

**The verdict job.**

- `verdict` always runs. It is green only when every selected gate is green.
- It gives a repo one stable check it can later choose to require. The kit never makes it required.
- A newer push to the same PR cancels the older run. A ci ref is never cancelled, because each
  `ci-gate` call has its own ref.

**Why a config file and a planner.** The strongest alternative was that each repo writes plain
GitHub workflows from a template. It lost, for three reasons:

- Every repo would re-implement the trailer parsing, path selection, lane rule and pool ensure.
- `ci-gate` needs one predictable job and check shape across repos.
- The human chose a shared kit.

**Why YAML.** It is the format GitHub Actions users already read. The planner validates it fully,
so typos fail in `plan` with the gate and field named.

**Versioning.** Callers pin `@v1`, a tag the kit moves forward on compatible releases. A breaking
schema change is `version: 2` and `@v2`.

**Planner and workflow at the same version.** The planner must always run at the same version as
the reusable workflow that invoked it (pitfall: inside a reusable workflow, `./` paths refer to the
caller's repo, not the kit's).

### 2. `ci-gate`

`ci-gate` is a Node CLI installed on both Macs (contract in I5). It follows the protocol MAWS's
`scripts/ci-gate.sh` already proved, generalized to any repo that uses the kit.

1. It resolves the target: a worktree path (its `HEAD`) or a sha. Uncommitted changes are not
   tested, and it says so on stderr when the worktree is dirty.
2. It pushes the tested commit, plus the nonce commit, to `refs/heads/ci/<label>-<sha8>-<nonce6>` with
   force. The label defaults to the branch name, else `gate`.
3. It finds the run by the nonce commit's sha, which is unique, rather than by time.
4. It prints a line when each gate job finishes, as it finishes, not at the end. maws-fe's
   complaint F was that the MAWS script reports only at the end.
5. It also prints a `WAIT` line when a gate has been queued for more than 2 minutes. On the pool
   lane this is visible boot time.
6. It downloads the failed jobs' logs and artifacts under `/tmp/ci-gate/<owner>-<repo>/<run-id>/`.
7. It deletes the ref unless `--keep`, and exits 0 (green), 1 (red) or 2 (infra or config error).
   - The ref carries the first 6 hex characters of the nonce, so concurrent calls on the same
     commit and label never share a ref.
   - Deletion is compare-and-delete: `git push --force-with-lease=<ref>:<nonce commit>`, as MAWS's
     script already does. A call can then never remove a ref it did not push.

**Why Node.** One language across the kit:

- The pool agent needs RS256 JWT signing for the GitHub App, which `node:crypto` has and Python's
  standard library lacks.
- Node 22 or later is on both Macs and on every hosted image.

**`gh` dependency.** `ci-gate` uses the `gh` CLI's authentication, the human's, which already
works on both Macs. It needs no other credential.

### 3. The pool

**Shape.**

- There is one box at a time, named `ci-kit-pool`.
- **Server type.** The first available from a preference list:
  1. `cx53` — 16 vCPU / 32 GB at €0.0561/h. It is out of stock everywhere on 10-15. Listing it
     first means the pool gets it automatically when it returns.
  2. `cpx62` — 16 vCPU / 32 GB at €0.2452/h.
- **Location.** The first that offers the chosen type, from `hel1`, `fsn1`, `nbg1`. All three are
  in the EU, which is cheapest. Latency to GitHub does not matter at job scale.
- **Images.** The box boots from the newest snapshot labelled `ci-kit=pool-image`. Snapshots are
  global, so the location choice is free.

**Job containers.**

- Each pool job gets a fresh container from the pool runner image, running one JIT runner.
- The job's labels say its size, `cpus-N` with N one of 2, 4, 8, 16. The agent gives the container
  an exclusive set of N cores (`--cpuset-cpus`) and 2N GB of memory.
- Admission is by free cores. There is no overcommit. Jobs that do not fit wait, first in, first
  out, by the job's creation time.
- **Pitfall:** a `--cpus` quota leaves `nproc` and Node's `os.availableParallelism()` reporting all
  16 cores, so vitest would start 16 workers inside a 4-core quota. A cpuset makes them report N.
  This is what A5 checks.

**Caches** are baked into the snapshot under `/var/lib/ci-kit/cache/`:

- the pnpm store;
- the npm cache;
- the runner's tool cache, with Node 22 and 24;
- Playwright browsers;
- Electron.

They are mounted into every job container, with the tools pointed at them through environment
variables. Each container's work directory is on the same filesystem as the pnpm store, so pnpm
hardlinks instead of copying. A box that lives for hours keeps what it fetched.

**Why not a volume.** The strongest alternative was a persistent Hetzner Volume for caches. It lost
because a volume is bound to one location, so a stock-driven change of location would lose it, and
because attach adds boot steps. The snapshot is re-baked weekly and the drift between bakes is a
small fetch.

**Lifecycle.** The box's state is a Hetzner server label, `ci-kit-state`.

| State | Entered when | Left when |
|---|---|---|
| (absent) | — | ensure or guard creates the server |
| `booting` | created by ensure/guard (label set at create) | the agent starts and sets `ready` |
| `ready` | the agent is polling | the agent finds the box idle at minute ≥ 50 of its billed hour, and sets `draining` |
| `draining` | the agent's idle check passed | re-check finds work → `ready`; re-check still idle → the agent writes the ledger row and deletes the server (→ absent) |

**Idle** means three things at once:

- no running job container;
- no queued job carrying `ci-kit-pool` in any run of a served repo;
- no queued or in-progress run of a watched workflow in any served repo.

**Served repos and watched workflows.**

- The served repos are configured (I8).
- The watched workflows, per repo, are the ones that use the pool: `ci.yml` and `maws-probe.yml`
  for the sandbox, and `gate.yml` for MAWS once maws-fe adopts P1. MAWS is added to the served list
  only then.

**Why a watched run keeps the box.** A pool job that `needs:` a slow hosted job is queued late.
Judging idleness by queued pool jobs alone, the box could delete itself between the ensure and that
job.

**Why only watched workflows.** Watching every workflow would let a served repo's hosted-only runs
keep a box alive all day. MAWS ran 63 runs on 10-15.

**Demand comes from all workflows.** Demand, unlike idleness, is read from all workflows. A queued
pool job anywhere in a served repo gets a runner.

**Minute ≥ 50 rule.** The billed hour is counted from the server's `created` time. Billing rounds a
server's life up to whole hours, so a box that has gone idle has already paid for the rest of its
current hour. It stays up for free until just before the hour turns, and catches any job that
arrives meanwhile.

**Ensure (I7).** The linearization point is the server name.

1. List servers labelled `ci-kit=pool`. If one is `booting` or `ready`, done.
2. If one is `draining`, wait until it is gone (at most 3 min), then continue.
3. Create `ci-kit-pool` from the snapshot, with:
   - the type and location preference;
   - firewall `ci-kit-pool`;
   - labels `ci-kit=pool` and `ci-kit-state=booting`.
4. A `uniqueness_error` means a concurrent ensure won. Treat it as done.
5. `resource_unavailable` moves on to the next type or location pair.
6. Ensure does not wait for boot. The gate jobs wait in GitHub's queue, which holds a job up to 24 h
   and is where `ci-gate`'s `WAIT` line comes from.

There is a residual race. Ensure sees `ready` just as the agent has passed its re-check, so the box
deletes itself and the job is stranded. The guard's wake rule catches that case.

**Pool agent.** It runs as a systemd service. Every 10 s it does the following:

1. For each served repo, it lists queued and in-progress runs of every workflow, and their queued
   jobs that carry `ci-kit-pool`.
2. Demand is the number of queued jobs for each label set, minus the idle runners already started
   for that label set.
3. For each unit of demand that fits, it starts a job container with a fresh JIT config, using
   exactly the job's labels.
4. It removes containers that have exited.
5. It removes a runner that has been idle for 10 min, for example because its job was cancelled,
   by unregistering it and stopping its container.

**API budget.** An installation token allows 5,000 requests an hour. A 10 s poll over 2 repos uses
about 1,000 an hour, including job listings.

**Heartbeat.** The heartbeat records the last successful reconciliation, not that the process is
alive.

- The agent writes the label `ci-kit-heartbeat=<unix seconds>` at most every 60 s, and only after
  a tick in which both of these succeeded:
  - the GitHub listing for every served repo;
  - the Docker listing.
- An agent that runs but cannot reach GitHub, for example because of a revoked App key, therefore
  goes stale like a dead one.

**Watchdog.** A dead-man switch on the box that depends on neither the agent nor GitHub. It is a
systemd timer, separate from the agent, that runs every 5 minutes. It deletes the server through
the Hetzner API (writing the ledger row first, I9) in two cases:

- the last successful reconciliation is older than 30 min (read from a local file the agent
  touches with each heartbeat). Until the first success, the clock runs from boot;
- the server has been up for more than 24 h. No gate legitimately needs that: the I1 timeout
  ceiling is 6 h.

The guard is then the backstop for a box whose kernel or network is gone, not the only one.

**Container deadline.** A container stops counting against idleness when its job is over:

- it is killed 5 minutes after its runner has left GitHub (a JIT runner unregisters when its job
  ends);
- it is killed in any case at 6 h 15 min of age.

A container can therefore never keep the box alive past its job.

**Re-enabling schedules.** GitHub disables a public repository's scheduled workflows after 60 days
without repository activity, and kit activity stops once it is stable.

- At each boot, the agent re-enables `pool-guard.yml` and `pool-bake.yml` through the Actions API.
  The App is also installed on the kit, with Actions read and write.
- The guard matters only while the pool is in use, and every use starts with a boot. The watchdog
  covers the box in between.

**Config source.** The agent reads its config (I8) from the kit's `main` branch
(`raw.githubusercontent.com`; the kit is public).

- It reads it at start, and again every 5 minutes.
- If a fetch fails, it keeps the last good copy. At start, that is the copy baked into the
  snapshot.
- Adding a served repo therefore takes a commit, not a re-bake or a restart.

**Public repos.** The agent refuses to serve any repo whose API record says it is public, and logs
that at start.

**Guard** (`.github/workflows/pool-guard.yml` in the kit). It runs on a schedule every 10 minutes.
GitHub's cron can run late; this is a backstop, not the main path.

- **Wake.** A pool job queued for more than 5 min with no pool server → run ensure.
- **Dead agent.** A server whose heartbeat is older than 10 min (successful reconciliation, see
  Heartbeat):
  1. delete it;
  2. write or finalize its ledger row with end reason `stale-heartbeat`;
  3. open an alert issue.
- **Uptime.**
  - A server that has been up for more than 12 h straight → alert issue.
  - A server that has been up for more than 24 h → delete it, as the watchdog would.
  - Pool hours for today (UTC) above `max_hours_per_day` (default 8) → alert issue. It never
    deletes the box, because a hung gate costs more than an hour of box.
- **Builders.** A server labelled `ci-kit=builder` that is more than 2 h old → delete it and open
  an alert.
- **Weekly cost.** It posts a summary to the ledger issue: hours, euros, jobs, and the projected
  month.

Alerts are issues labelled `ci-kit-alert` in `ci-kit-sandbox`. That repo is private, so MAWS
activity does not leak through the public kit. The owner is notified by GitHub's issue mail.

**Bake** (`.github/workflows/pool-bake.yml` in the kit). It runs weekly and on dispatch. No inbound
network or ssh is needed.

1. Create a small builder server from `ubuntu-24.04`, with user-data that does three things:
   - installs Docker, Node 22 and the agent;
   - builds the pool runner image from `pool/image/Dockerfile`, based on GitHub's
     `actions-runner` image at a pinned version, plus build tools, `xvfb` and Electron/Chromium
     libraries;
   - warms the caches (for MAWS, `pnpm fetch` against MAWS's lockfile, using an App token with
     contents read) and writes `/etc/ci-kit/`.

   Then it powers off.
2. Wait for the builder to show `off`, for at most 30 min.
3. Snapshot it with labels `ci-kit=pool-image` and `ci-kit-commit=<sha>`.
4. Delete the builder.
5. Keep the two newest snapshots.

**When a bake does not complete.**

- The builder is created with labels `ci-kit=builder` and `ci-kit-run=<run id>`.
- The workflow's last step runs on every exit (`if: always()`, including cancellation). It deletes
  any builder carrying its own run id, and any snapshot it started that never reached `available`.
- The guard's builder rule catches what that step cannot reach, such as a runner lost mid-job.
- A failed bake leaves the previous snapshots in place, so the pool keeps booting.

**Credentials.**

- **The GitHub App `ci-kit-runners`.** Owned by SSFSKIM and installed on MAWS, `ci-kit-sandbox`
  and `ci-kit`. Permissions:
  - Administration: read and write, to register runners;
  - Actions: read and write. Write re-enables the kit's schedules; the agent writes nothing else
    there;
  - Contents: read;
  - Issues: read and write.
- **Baked into the snapshot.** The App's id and private key, a Hetzner token, and the served-repo
  config, all under `/etc/ci-kit/` (root, mode 0600).
- **Caller repos** hold `HCLOUD_TOKEN`, for ensure. MAWS holds nothing else. The sandbox also holds
  `CI_KIT_APP_ID` and `CI_KIT_APP_KEY`, because its `maws-probe.yml` mints an App token to check out
  MAWS.
- **The kit** holds `HCLOUD_TOKEN`, `CI_KIT_APP_ID` and `CI_KIT_APP_KEY`, for the guard and bake.
- **Why an App.** Its tokens are short-lived and minted on the box, it is not tied to the human's
  account, and it gets a separate API rate limit. The alternative was a fine-grained PAT, which
  expires and acts as the human.
- **Why baked.** It keeps the caller side to one secret. Rotating a credential means re-baking.

**Isolation.**

- The firewall allows no inbound traffic.
- Job containers have no Docker socket, run as the image's non-root `runner` user, and never mount
  `/etc/ci-kit`.
- The host drops container traffic to the metadata address `169.254.169.254`, so job code cannot
  read the server's user-data.
- The code served is SSFSKIM's own private repos, so these measures are hygiene, not a sandbox
  against hostile code. That is also why public repos are refused.
- **Debugging.** The Hetzner web console, or a temporary firewall rule plus an ssh key added
  through the API (runbook in `docs/pool.md`).

**Hetzner project.** The pool runs in the project behind the existing `HETZNER_API_TOKEN`, which
had no servers and no snapshots on 10-15. Every resource the kit creates carries a `ci-kit=` label,
and the agent and guard only ever touch resources with that label.

The token is project-wide. When the personal-cloud devbox
(`doperpowers/docs/doperpowers/specs/2026-10-02-personal-cloud-env-design.md`) lands, it goes in a
project of its own, so a CI box cannot delete it.

**Cost.**

| Billed pool hours per day | 4 | 6 | 8 | 10 |
|---|---|---|---|---|
| CPX62, €/month | 29 | 44 | 59 | 74 |
| CX53 (when in stock), €/month | 7 | 11 | 13 | 17 |

Snapshots add about €0.30 a month. Private repos' plan/ensure jobs and light gates stay on
GitHub-hosted runners under an Actions budget of about $15 a month (owner, 2026-10-16), inside
the ~$50 total. MAWS's plan jobs on hosted runners add about 1 minute per run,
which goes on the cheapest hosted runner that can run `node`.

Hours per day depend on how gates arrive through the day, not on their compute. That is the main
empirical unknown, and the ledger answers it in the first week.

If the projection exceeds $50, the levers are:

- a smaller type (CPX52 or CPX42);
- CX53 stock;
- MAWS scoping its gates (M7), so fewer runs touch the pool.

The guard alerts. The choice between those levers is the human's.

**Alternatives considered.**

- **An always-on box.** CPX62 at €153 a month is over budget. An always-on CX53 at €35 a month
  would beat the on-demand pool on simplicity and speed. If CX53 returns and stays in stock,
  revisit with the human, recorded in the Decision Log.
- **GCE spot.** Per-second billing, but more pieces to run and possible preemption mid-gate.
- **Namespace.** Managed, $0.006 a minute for 4 vCPU. The human chose Hetzner on cost.
- **Ubicloud.** Hetzner-backed and cheap, but its support for personal accounts is unconfirmed.
- **Cloud Run jobs.** No GitHub checks integration, at most 8 vCPU, and no macOS.

### 3a. The GCE backend (private Linux, from M10)

**Why it replaces the Hetzner box.**
- MAWS's gates arrive all day: 116 gate runs across 23 of the 24 hours of 10-15 (Actions API).
- The Hetzner box deletes itself only when it is idle. At that arrival rate it is almost never
  idle, so it bills its monthly cap: €82 (CPX42) to €153 (CPX62).
- GCE spot bills per second, with a 1-minute minimum, only for the minutes jobs actually run.
- The owner moved private Linux gates to GCE spot on 2026-10-16 (Decision Log). The Hetzner pool
  serves until this backend is live, and it stays as a fallback behind the same interface.

**Shape.**
- **One spot VM per pool job.** It runs in the project `ssfskim-ci-kit`, region `us-central1`. The
  zones are tried in the configured order.
- **The machine comes from the job's `cpus-N` label** (I12):

  | Label | Machine | vCPU / GiB |
  |---|---|---|
  | `cpus-2` | `e2-highcpu-2` | 2 / 2 |
  | `cpus-4` | `c3d-highcpu-4` | 4 / 8 |
  | `cpus-8` | `c3d-highcpu-8` | 8 / 16 |
  | `cpus-16` | `c3d-highcpu-16` | 16 / 32 |

  C3D's smallest shape is 4 vCPU, so `cpus-2` uses E2. If E2 quota is refused, `cpus-2` falls back
  to `c3d-highcpu-4`.
- **The job runs in one container from the same pool runner image as on the Hetzner box.** The
  container gets all of the VM's cores and the same cache mounts, so a job sees the same
  environment on either backend. `nproc` is N because the VM has N vCPUs, which is what A5 checks.
- **Spot first.** When every configured zone refuses spot capacity, the launcher creates the same
  machine on demand, so a gate is never stranded by stock. Each fallback is recorded in the ledger.
- **No credentials on the VM.**
  - VMs have no service account, so job code that reaches the metadata server finds no
    credentials.
  - The metadata does hold the JIT config, so the container's traffic to the metadata server's
    HTTP port (TCP 80 on `169.254.169.254`) is dropped.
  - DNS stays open (UDP and TCP 53 to the same address). GCE's resolver lives there, and the
    Hetzner box's all-protocol drop would leave the runner unable to resolve GitHub.
  - A live check in A13 proves both: GitHub resolves from inside the container, and a metadata
    request is refused.
- **Network.** Each VM has an ephemeral external IPv4 for outbound traffic. The VPC has no inbound
  firewall rules.
- **Lifetime bounds.** Two separate mechanisms, with no claim that either covers everything:
  - **A VM that is still running** (a hung job, a dead unit) is deleted by Compute Engine at
    `maxRunDuration` (default 120 min), through `instanceTerminationAction=DELETE`. MAWS's longest
    pool job takes about 6 minutes. A repo whose pool gates run longer raises `max_run_minutes`.
  - **A VM the guest has powered off** is `TERMINATED`. Stopping clears its termination timer, so
    the launcher deletes it, on its next tick.
  - If the launcher is down, stopped VMs cost only their disks: about $0.007 a day each at 50 GB.
    The ledger's daily line goes missing, and a Cloud Monitoring alert on failed
    `ci-kit-launcher-tick` executions mails the owner.

**VM lifecycle.** VMs are named by allocation, not by job. A runner can take any queued job with
its repo and label set, so a job-derived name would be wrong as soon as it does.
1. **Record the launch.** The launcher writes a provisional ledger row: the allocation id, repo,
   label set and zone, marked `launching`.
2. **Mint and create.** It mints a JIT config, with runner labels `self-hosted`, `ci-kit-pool`,
   `cpus-N` and `ci-kit-gce`, and the runner named after the instance. It then creates the instance
   `ci-kit-gce-<allocation id>` from the newest image in the family `ci-kit-runner`. The JIT config
   goes into metadata, and the instance gets the I12 labels. Its boot disk has `autoDelete`.
3. **Boot and run.** At boot, a systemd unit in the image reads the JIT config, runs the job
   container, and powers the VM off when the container exits.
4. **Delete stopped VMs.** On its next tick, the launcher deletes every `ci-kit=gce` instance it
   finds `TERMINATED`. It finalizes that VM's ledger row with the actual job (the runner's
   assignment, read from the Actions API), the seconds and the dollars. Finalizing is idempotent,
   keyed by the allocation id.
5. **Idle runners: unregister first.** A runner that has been registered and idle for 10 minutes
   (its job was cancelled, or another runner took it) is cleaned up with the Hetzner reconciler's
   protocol:
   - unregister the runner first;
   - delete the VM only after GitHub confirms removal (or 404);
   - on `busy` or any error, defer to the next tick, because the runner may have just taken a job.

   A failed runner listing is never read as idleness.

**The launcher.** It is a Cloud Run service, `ci-kit-launcher`, running the kit's Node code with no
public ingress. Cloud Scheduler invokes it every minute with an OIDC token.

- **Overlap is rare, and nothing depends on it never happening.**
  - The service runs with `max-instances=1` and `concurrency=1`. Each reconciliation has a 45 s
    budget, and the request timeout is 300 s.
  - These settings make overlapping reconciliations rare, but they are not a guarantee. Cloud Run
    can briefly exceed its maximum instances, and two revisions overlap during a deploy.
  - Correctness therefore rests on three things:
    - **The project's vCPU quota is the hard cap.** Compute Engine refuses an insert over quota
      atomically. `max_vcpus` is the launcher's soft target below it.
    - **Every write is idempotent.** Deletes and unregisters treat 404 as done. Ledger rows are
      keyed by allocation id, and a provisional row for an allocation that never got an instance
      is finalized `abandoned`.
    - **An over-launch heals itself.** Two overlapping reconciliations can each launch for the same
      queued jobs. The extra VMs' runners stay idle and are cleaned up by lifecycle step 5 within
      `idle_runner_minutes`. That costs a few cents, about $0.012 for a c3d-8 for 10 minutes.
  - **Rejected: a lease** (a GCS object with generation preconditions). It is real coordination,
    but it adds a store, expiry and lease-loss handling to prevent an outcome that is already
    bounded and self-healing.
  - All state lives in GCE labels, the ledger and GitHub. Every reconciliation can act as the first.
- **Demand.** Demand is keyed by (repo, label set).
  - Count the queued jobs carrying `ci-kit-pool` in each served repo, using the Hetzner agent's
    listing, ETag-conditional.
  - Subtract that key's **unclaimed** instances: those whose runner is not `busy` in the runners
    API and that are younger than `idle_runner_minutes`. A busy instance covers nothing.
  - Launch one VM for each remaining unit, while the total vCPUs in flight stay at or below
    `max_vcpus` (≤ the project quota). Excess demand waits in GitHub's queue.
- **Creating across zones.** List instances across all zones (aggregated), by label.
  - An `insert` whose outcome is unknown, such as a timeout, is reconciled through its zone
    operation before any other zone is tried.
  - Only a definite capacity refusal (`ZONE_RESOURCE_POOL_EXHAUSTED*`) moves to the next zone.
  - After every zone has refused spot, the same machine is created on demand.
- **Cleanup**, every tick:
  - **Stopped VMs:** delete `TERMINATED` instances (lifecycle step 4).
  - **Idle runners:** lifecycle step 5.
  - **Runners with no instance:** a `ci-kit-gce-*` runner whose instance does not exist, older
    than 5 min, is unregistered. This covers a crash between minting the JIT config and the insert.
  - **Overage:** any `ci-kit=gce` instance older than `max_run_minutes` + 5 is deleted, and an
    alert opens. This should never happen.
  - **Orphan disks:** a `ci-kit=gce` disk with no instance is deleted.
  - **Old builders:** builders older than 2 h are deleted.
  - **Provisional rows:** a `launching` ledger row with no instance and no runner after 10 min is
    finalized `abandoned`.
- **Preemption.** Recorded, not re-run, in this version.
  - A VM deleted by preemption shows a `compute.instances.preempted` operation. The launcher
    finalizes its row `preempted`, with the job its runner actually held.
  - GitHub fails that job ("runner lost"), and the agent re-runs it, for example with `ci-gate`
    again.
  - **Why not an automatic re-run.** `rerun-failed-jobs` would also re-run genuine failures, so
    an automatic re-run needs per-job correlation: the job's `runner_name` against the instance's
    preemption operation, and the job-scoped rerun endpoint, once per job attempt. That is built
    only if the first two weeks' ledger shows preemption above 1% of pool jobs. M7 saw 0 of 12.
- **Scope.** Public repos are refused, as on the Hetzner box. The launcher touches only resources
  labelled `ci-kit=gce` or `ci-kit=gce-builder` in its own project.

**Why a one-minute reconciler, not the webhook.**
- One mechanism does both launch and cleanup.
- There is no public endpoint.
- The App's event subscriptions do not change.

The cost is up to 60 s of queue latency on top of boot. A webhook fast path, the App's
`workflow_job` event into the same service, is added only if A13's measured median from queue to
start is above 2.5 min.

**Image.** The family `ci-kit-runner` is built by a Cloud Run job, `ci-kit-bake`, weekly and on
demand. The Hetzner `builder.sh` cannot be reused as it stands: it writes the App key and the
Hetzner token into its image, reports through Hetzner, and powers off on failure too. M10 therefore
splits the bake.

- **Provider-neutral cache warming,** shared by both backends:
  - the runner image;
  - the pnpm store, the npm cache, Node and Playwright;
  - Electron.

  `warm.mjs` takes an installation token as input instead of reading the App key.
- **A GCE builder script** that installs only the VM unit. It writes no credentials, and it reports
  its result as a guest attribute (`ci-kit/bake=ok|failed:<step>`) before powering off.

The bake job:
1. Creates a builder `ci-kit-gce-builder-<n>` from `ubuntu-2404-lts-amd64`, with a one-hour
   installation token in its metadata. The App key never reaches a VM.
2. Waits for `ci-kit/bake=ok` and power-off, for at most 30 min.
3. Only on `ok`, creates the image into the family, labelled `ci-kit=gce-image` and
   `ci-kit-commit=<sha>`.
4. Boots one smoke VM from the new image, which checks the unit, the image and the caches. Only on
   a pass is the image marked `ci-kit-ready=true`; the launcher uses only ready images.
5. Deletes the builder in every case. A failed bake deletes its own image and leaves the previous
   ready images in place.
6. Keeps the two newest ready images.

**Credentials.**
- The App's id and key are in Secret Manager in `ssfskim-ci-kit` (`ci-kit-app-id`,
  `ci-kit-app-key`).
- The launcher and the bake run as `ci-kit-launcher@ssfskim-ci-kit.iam.gserviceaccount.com`, which
  holds `roles/compute.instanceAdmin.v1` on the project and secret access to those two secrets only.
- No GCP credential exists in GitHub. `gce/deploy.sh` deploys idempotently from the MacBook with
  gcloud's default account.
- MAWS holds nothing new. Its `HCLOUD_TOKEN` is removed when the Hetzner pool retires.

**Cost.** Measured by M7 on MAWS class 1a (`ci-kit-sandbox` `evidence/maws/gce-spot.md`, sandbox
4d2f044; MAWS dfb01258a; us-central1 spot catalog prices of 2026-10-16).

| Layout | $ per gate (warm image) | Month at 116 gates a day | Class 1a, dispatch → last job end |
|---|---|---|---|
| **One VM per job** (c3d-8 unit, c3d-4 static, e2-2 probes) | **$0.0117** | **$41** | about 6.0 min |
| One c3d-highcpu-16 per gate | $0.0150 | $52 | about 6.0 min |
| Hetzner cpx42 at its cap | — | €82 | 9–11 min (8 cores) |
| Hetzner cpx62 at its cap | — | €153 | 5.2 min, box already up |

- **Speed.** C3D at 8 vCPUs runs the unit job at cpx62-cpus-8 speed.
- **Boot.** From the create call to the runner online: 33–55 s on a warm image. The runner is
  usually online before the hosted plan job ends.
- **Cold images** cost 1–2.5 min and $0.002–0.005 more per gate, so the bake matters.
- **Every price above includes disk and IP.** Cores and memory bill until the VM enters
  `STOPPING`, at the guest's power-off. The disk and IP bill until `TERMINATED`, which is 15–175 s
  later.
- **No preemptions** in 12 VM runs, which is too few to estimate a rate.
- **Spot stock-outs happen.** `c3d-highcpu-16` was exhausted in us-central1-a and -b once
  (08:10Z), and -c served 15 s later. The zone order and the on-demand fallback are required, not
  optional.
- **The control plane** stays inside the free tiers: two Scheduler jobs and about 43k short
  Cloud Run requests a month.
- **The whole budget.**
  - GCE MAWS class 1a: about $41.
  - Images and the weekly bake: about $1.
  - A 5% allowance for on-demand fallbacks and re-runs: about $2.
  - GitHub-hosted minutes, now that heavy Linux and e2e are off hosted: MAWS's plan jobs, about 1
    billed minute a run, so about 3,500 minutes a month against the 3,000 included, which is about
    $3.

  That is **about $47 a month**.
  - This holds only once MAWS's e2e runs on the mini (P4's flip). MAWS's hosted Linux e2e billed
    621 min on 10-15, about $110 a month if it stayed.
  - The owner's $15 Actions limit (§3) is a ceiling, not this estimate. At that ceiling the total
    would be about $59.
- **A billing budget alert** on the project, at $40 with 50/90/100% emails, is created by the
  billing admin (Human-only steps).

**Which backend serves a repo.** Each backend serves the repos in its own file, so an agent that
does not know the other backend still behaves correctly.
- **The Hetzner backend** serves `pool/config/pool.json`'s `repos`. Its schema does not change, so
  the agents in today's snapshots keep parsing it.
- **The GCE backend** serves `pool/config/gce.json`'s `repos` (I12).
- **Ensure** checks `gce.json` (the kit's `main`, falling back to its bundled copy). For a GCE repo
  it prints `result=gce` and exits 0.
- **A repo is never in both files.** The planner's config test and the launcher both refuse a repo
  listed in both, and the launcher then serves neither.

**Moving a repo between backends.** MAWS's workflow never changes. The move works only with agents
that support it. M10 changes the Hetzner agent and re-bakes before the first move. Today's agent,
once a repo is removed, stops listing that repo's runners but still lists its containers. After
5 minutes it kills them as runner-gone, without unregistering, which would kill an in-flight job.

**What M10 adds to the Hetzner agent:**
- A repo it no longer serves is **draining**:
  - it starts no new containers for it;
  - it keeps listing the repo's runners and leaves running containers alone until their jobs end,
    or until the 6 h 15 min container deadline;
  - it unregisters the repo's idle runners by the existing unregister-first protocol.
- The agent writes the commit of the `pool.json` it is running as a server label,
  `ci-kit-config=<sha8>`. It is written only after a successful fetch, or from the baked copy at
  boot, which carries its bake commit.

**Ensure** creates a Hetzner box only for a calling repo listed in `pool.json` (the kit's `main`,
falling back to its bundled copy). For any other repo it returns `result=gce` or `result=none`, so a
repo in transit never wakes a box that would not serve it.

**The move, from Hetzner to GCE:**
1. Remove the repo from `pool.json` on `main`. Note the commit.
2. Wait until every `ci-kit=pool` box shows that commit (or a later one) in `ci-kit-config`, or no
   box exists. A box stuck on an older config (a failed fetch, or a snapshot booted with its baked
   list) blocks the move. It is deleted once it has no running containers, and the move waits.
3. Wait until the repo has no pool job in progress on a `ci-kit-pool-*` runner (Actions API).
4. Unregister any `ci-kit-pool-*` runner still registered to the repo.
5. Re-bake, so no snapshot's baked config still lists the repo. Delete older snapshots that list
   it.
6. Add the repo to `gce.json`.

Pool jobs queued during the move wait in GitHub's queue: the move fails closed.

**The reverse move, GCE to Hetzner,** is the fallback. It follows the same steps with the
launcher's equivalents:
- a repo removed from `gce.json` is draining: no launches, busy VMs left to finish, idle runners
  unregistered first;
- the launcher writes the `gce.json` commit it ran, in the ledger's daily line and in a
  `ci-kit-config` label on every instance it creates.

**Retirement.**
- `hetzner` stays a working fallback: ensure, the agent, the guard, the bake and the snapshots keep
  their code.
- Once GCE has run a week clean, CI-opt proposes retiring the Hetzner pieces to the owner:
  - the guard's schedule;
  - the snapshots;
  - MAWS's `HCLOUD_TOKEN`.


**Alternatives considered.**
- **gcrunner** (MIT; github.com/CamdenClark/gcrunner, with an active fork at appwrite-labs). It is
  the closest prior art: a webhook-driven Go service on Cloud Run that runs per-job spot VMs sized
  by `runs-on` labels and that delete themselves.
  - It lost because its label grammar (`gcrunner=<run_id>/machine=…`) would change MAWS's workflow,
    which breaks the interface commitment. The kit also already has the JIT, App, runner-image and
    ledger pieces in Node.
  - Borrowed from it:
    - a lifetime cap on every VM (appwrite-labs PR #16 added one after stray VMs);
    - the fallback from spot to on-demand.
- **One 16-vCPU VM per gate.** $52 a month measured, against $41 for per-job VMs. It lost to
  per-job sizing, which the owner asked for and which leaves no cores idle.
- **A managed instance group with an autoscaler** (terraform-google-github-actions-runners). It
  scales on CPU, keeps minimum replicas, and has no ephemeral runner per job.
- **Serverless runners** (Cloud Run, Fargate). See §3's alternatives: 5–9× the price per vCPU, an
  8-vCPU cap, and no privileged mode or user namespaces.

### 4. The mac lane

**Runner setup.**

- The mini runs one GitHub Actions runner, registered to `SSFSKIM/MAWS` at repo level. Personal
  accounts can only register at repo level.
- Its directory is `~/actions-runner-maws`, separate from the existing ida-solution runner's.
- Its labels are `self-hosted`, `macOS`, `ARM64` and `ci-kit-mac`. The first three are what MAWS's
  `gate.yml` already targets for its macOS lane.
- It runs as a LaunchAgent in user `new`'s GUI session, so Electron windows have a WindowServer.
  A LaunchDaemon would have none.
- **Concurrency is one,** because e2e groups contend for the desktop (focus, pointer, clipboard;
  history catalogue #12).

**Job hooks** (`ACTIONS_RUNNER_HOOK_JOB_STARTED` / `_COMPLETED`):

- Before a job, they kill any process left under the runner's work directory.
- After it, they do the same again and log what was killed. This is the orphan class that cost the
  MacBook its load (catalogue #5).

**Runs other repos' code? Never.** The runner serves MAWS only. Public repos never reach it. Every
`mac`-lane gate in a kit config is refused on a public repo.

**Measured, not assumed.** The mini has 16 GB, ~14 GB already in use, and ~11 sessions. Also, the
cua session drives the mini's GUI, and MAWS e2e opens windows on the same desktop.

M6 runs the `e2e:composer` group (about 2 minutes; keyboard and focus cases, the ones owner
input broke before; `e2e:c7` if it is absent) 10 times during normal use and records failures and memory
pressure. MAWS's quiet e2e mode (windows shown inactive, the default since 10-10) is expected to
keep GUI contention low. The measured rate decides:

- **0–1 failures in 10:** ship.
- **More:** take a desktop lease to the human, before shipping more than the runner. The lease is a
  file lock held by e2e jobs and honoured by cua's GUI tools, and it changes how the human's mini
  is shared.

### 5. Adoption per repo

**cua** (M2):

The hosted-runner probe's report, folded on 2026-10-15, is at `ci-kit-sandbox`
`evidence/2026-10-15/hosted-probe.md`. The final cua matrix was run 38805346841 in SSFSKIM/cua.

- **Gates.** Both run on `hosted-macos`.

  | Gate | Command | Probe result |
  |---|---|---|
  | `test` | `npm test` | 2,316 pass, 0 fail, 86 skip in about 168 s |
  | `plugin` | `claude plugin validate .` then `npm run test:mods` | passes, 32/32 |

  - Both gates use Node 24 and `npm ci`.
  - The `claude` CLI is installed in the gate with `npm i -g @anthropic-ai/claude-code`, retried
    up to 3 times. One install hung for 6 minutes.
  - Neither gate needs credentials.
- **Full history.** Both gates check out the full history (`setup.fetch_depth: 0`). The
  browser-parity and repl-parity tests read git history: shallow, 48 of them failed on every leg.
- **Why not ubuntu.** It gates nothing for now. It fails 5 tests for platform reasons:
  1. a socket test expects EPIPE, and Linux gives ECONNRESET;
  2. `serve-lazy` uses the macOS-only peer-identity addon with no skip guard;
  3. `remote-agent` Chrome readability, even after `apt install bubblewrap` and the unprivileged
     user-namespace sysctl;
  4. `linux-chrome-features.mjs:59` assumes `birthtimeMs >= Date.now()` for a new file, which is
     false on ext4 (1,527 of 2,000 files);
  5. `chrome-cua-registration` route, which flakes.

  Item 4 is product code, which this initiative does not touch. Items 1, 2 and 3 are guards or
  expectations. All five go to cua_repl as findings, through this session. A Linux leg is cua's to
  add once they are fixed.
- **Node.** Node 22 skips about 74 more tests than Node 24, on both platforms, so CI runs Node 24
  only. The double local run (Node 22 + 26) is cua's to retire.
- **The macOS runner is noisy.** The hosted macOS VM had load 14–55 at job start, so cua's timing
  tests can still flake there. The §6 fixes are what make A10 hold, not a quiet runner.
- **Live checks stay local.** Live-evidence checks (`verify.mjs`, `accept-native`, `accept-chrome`)
  need the real `$CUA_HOME`, a native helper and the GUI. They are not CI gates.
- **Coordination.** cua_repl is mid-work on the same test files (its M4, own REPL host). The
  executor asks it, through this session, which files are in flight before touching tests.

**doperpowers** (M3):

- **Gates.** One gate per suite family that runs without model calls. Probe results come from
  `evidence/2026-10-15/hosted-probe.md`, final run 38814103021. Serial, the ubuntu job took
  25.5 min, so each family is its own gate and they run in parallel. Each gate's `paths` is set to
  its area.

  | Gate | Lane | Command | Probe |
  |---|---|---|---|
  | `shell-lint` | `hosted` | the committed shell files changed against `CI_KIT_BASE`, passed to `scripts/lint-shell.sh` as file arguments | bare, it lints only uncommitted changes, so it lints nothing on a clean checkout; `--all` exits 1 on 9 old warnings, so `--all` is not used until that debt is paid |
  | `sminos` | `hosted` | `tests/sminos/run-sminos-tests.sh` | 1,728 assertions in 428 s |
  | `issue-tracker` | `hosted` | the hermetic issue-tracker suites | pass |
  | `board-api` | `hosted` | the hermetic suites, without `integration` | 1,451 assertions |
  | `claude-code` | `hosted` | `tests/claude-code/run-skill-tests.sh`, non-live tier | pass |
  | `mods` | `hosted` | `tests/mods/run-mods-tests.sh` | `claude plugin test` with no credentials, 295 green |
  | `triaging-feedback` | `hosted` | `npm test` in `application-agents/triaging-feedback` | 117 pass |

  - **Shared setup on ubuntu:**
    - `bun`;
    - the `claude` CLI from npm, retried;
    - a system git identity (`sudo git config --system user.name/user.email`). Not `GIT_*`
      environment variables: those override the `-c user.name=` that `test-archive` relies on, and
      3 archive assertions failed in the probe because of it.
- **ubuntu-only test fixes** (test code only):
  - `test-review-standin.sh` expects macOS `sort` collation. Locale settings do not change glibc's
    order, so the expectation is made order-independent.
  - `test-execute-dispatch.sh` line 667 commits with an overridden `HOME`. The system identity above
    covers it.
- **codex-companion is not gated.** The owner discarded the component on 2026-10-16, so it has
  no CI gate and M3 changes none of its tests. Every doperpowers gate runs on `hosted`.
- **Timing-flake targets.** `test-bridge-requests.sh` failed 1 full run and 2 of 5 reruns on macOS.
  It joins the T3 list in §6. Its gate (sminos) runs on ubuntu, where it passed.
- **Excluded:** tests that spend model calls, need Docker plus `ARKHO_DIR`, or exercise the
  installed plugin cache.
- **Not plugin behavior.** These are test and CI files, not skills, agents or hooks, so the "no
  plugin or agent-rule changes" constraint holds. No version bump is needed, since nothing shipped
  changes.
- **Coordination.** doperpowers-74 is told before sminos tests change.

**MAWS** (M7) gets evidence and proposals, not commits (§Constraints). The proposals:

- **P1 — Pool lane.**
  - `gate.yml` resolves `GATE_RUNNER=pool` to `["self-hosted","ci-kit-pool","cpus-<N>"]`.
  - The plan job runs `SSFSKIM/ci-kit/pool-ensure@v1`.
  - The secret `HCLOUD_TOKEN` is set.
  - The unit job's worker count comes from `nproc`, which respects the container's cpuset.
    - Today it comes from `getconf _NPROCESSORS_ONLN`. glibc reads that from the host's
      `/sys/devices/system/cpu/online`, so in a `cpus-4` container it says 16 and vitest starts 16
      workers in 4 cores and 8 GB.
    - M7 measures with the workflow's actual command, both ways.
- **P2 — Shard unit.** Shard the unit job with `vitest --shard=i/N`, with the N chosen from M7's
  measurements on the pool.
- **P3 — Scope unit on ci refs.** Use `vitest --changed <merge-base>` on ci refs, with the full
  suite on landing. This only goes forward if the recall evidence holds (M7).
- **P4 — Mac-bound gates on the mini.**
  - Route e2e there through MAWS's existing macOS lane (`GATE_E2E_RUNNER=macos`, or per run
    `--runner macos`).
  - Build once per gate rather than once per group (maws-fe's `MAWS_E2E_PREBUILT=1` seam).
  - Run the macOS-only unit subset there too, as a job of its own. That is the "§6 list", the 13
    files `gate.yml` has no job for, which today run locally under the load wrappers (MAWS
    gate-offload plan §3.5).
  - M7 inventories every other gate that still needs the MacBook. That includes the measured
    performance bounds, class 2. Each one is either routed to the mini or named as staying local,
    with its reason.
- **P5 — Drop the duplicate type check.** Drop vitest's duplicate type-check pass if
  `pnpm typecheck` covers the `*.test-d.ts` files. That removes the out-of-memory class seen three
  times.
- **P6 — Make MAWS's timing tests event-driven** (§6):
  - `e2e/code-tools.spec.ts` 2 s read;
  - `src/main/sessions/recovery.test.ts`;
  - the `pause-take-over` pty test;
  - `resource.test.tsx` 5 s.
  - the history-rail day-boundary test (expected "Today, Yesterday", got "Yesterday, October 13" when
    a Linux run crossed the UTC day). It needs an injected clock. If M7's recall or shard
    measurements hit it, it is labelled clock-dependent, not a lane or shard effect (maws-fe,
    2026-10-16).
- **P7 — Retire the load rule for gates.** Retire `waitload20.sh` and `with-slot.sh` for every gate
  P4's inventory moved off the MacBook. They stay for anything the inventory names as staying local.
  - Context (owner ruling, relayed by maws-fe 2026-10-16): unit/DOM vitest, typecheck and eslint
    runs on the MacBook are already exempt from the load wait. e2e, builds and measured bounds keep
    it.

### 6. Test stabilization: the rule

- **Assert events, not speed.**
  - A test asserts that an event happened, never how fast the machine produced it.
  - Waits are on the condition: poll it, or await the event. The ceiling is a liveness bound,
    generous and uniform (10–30 s), not a performance claim.
- **Budget logic gets a controlled clock.** Code whose logic depends on a time budget gets a
  controllable clock in its test (cua's CDP budget, `timeoutMs 368 with 365 ms left`). The test
  checks the arithmetic, not the scheduler.
- **Speed claims are their own gate.** A real end-to-end performance bound is a separate `perf`
  gate on the pool with pinned cores, not part of a correctness gate.
- **Proof.** Each fixed test is shown failing under induced load before the fix and passing 20 of
  20 runs after it (A10). The load is `stress-ng --cpu <2×nproc>`, or `yes` loops where `stress-ng`
  is absent.
- **Where the proof runs.** Only on a GitHub-hosted runner, through a `ci-gate` run whose stress
  step runs beside the test loop. Never on the MacBook, which already sits at load 100–300, and
  never on the mini, which hosts the human's sessions. Full-suite runs go through `ci-gate` too.
  Locally, only single focused test files run while iterating (clarified 2026-10-15, CI-opt).
- **Known lists** at authoring (M2/M3 refine them from the probe):
  - **cua:**
    - `cdp.test.mjs` budget;
    - `extension-host.test.mjs` cancel-debugging;
    - the "group enumeration failed or timed out" family;
    - `mcp-upstream`, `chrome-host-run`, browser-service CDP budget;
    - `actions` element-without-box;
    - `eof-drain`;
    - `serve-cli` / `serve-lazy` / `repl-host` teardown;
    - issue #123.
  - **doperpowers (TECH-DEBT T3):**
    - sminos git-mirror "lands within two seconds";
    - the `send --wait` ack window;
    - "at most once more";
    - watcher finalize-vs-retire;
    - `test-bridge-requests.sh` (macOS flake).

**Why this rule** rather than load-calibrated budgets (cua's candidate 2). Calibration still fails
when the load changes mid-test, and it keeps a speed claim inside a correctness test. Event waits
remove the failure class. The pool's pinned cores make what speed claims remain measurable.

### 7. Host hygiene: the janitor

`host/janitor.mjs` runs every 30 minutes as a LaunchAgent, `com.ssfskim.ci-kit.janitor`, on the
MacBook and on the mini.

**It acts on one class only.** A process qualifies when all three hold:

- its command matches the configured one-shot test patterns, and none of the exclusion patterns
  (I11);
- its parent is `launchd` (pid 1);
- it has run for more than 2 hours.

**Exclusions.** These modes are long-lived on purpose, so they are report-only:

- watch, UI and server modes: `--watch`, `-w`, `--ui`, `serve`, `dev`, `preview`;
- vitest started without `run`, unless it carries `--run` or `CI`-style one-shot arguments.

It sends such a process SIGTERM, then SIGKILL after 10 s, and logs a line in
`~/Library/Logs/ci-kit/janitor.log`. A macOS notification goes out when it killed anything.

**Why that rule.** A one-shot test process re-parented to `launchd` for two hours has outlived the
session that ran it, whatever that session's state. Parentage and age alone cannot tell a stray
from a watcher someone detached on purpose. So killing needs a positively one-shot command line,
and everything else is reported, never killed.

**It reports and never deletes.** It rewrites `~/Library/Logs/ci-kit/report.md` with:

- the worktrees under `~/Developer/GitHub/*` that are clean and whose branch is merged into the
  default branch;
- VMs (`tart list`) running for more than 12 h;
- the top memory users by category.

Deleting what the report lists is the human's call or a session's.

**Owner action.** Update cmux, which is outside this kit. cmux 0.64.19, installed, burns ~1 core
in six `libghostty` threads, fixed upstream in ≥ 0.64.23; the latest is 0.65.1.

- Update it and restart at a quiet time; a restart ends sessions running in cmux terminals.
- Its sidebar git watcher was switched off on 10-15. To revert:
  `defaults delete com.cmuxterm.app sidebarWatchGitStatus`.

## Execution

### Constraints (bind every milestone)

**Where work happens.**

- **Kit code** lives in `SSFSKIM/ci-kit`.
  - Each milestone's kit changes are developed on a branch `m<N>-<topic>` in a worktree.
  - A milestone's branch merges to `main` by PR once its milestone review is clean.
  - **Why per milestone, not at the end.** Later live proofs need published kit code:
    - GitHub runs scheduled workflows (the guard, the bake) only from the default branch.
    - Callers resolve `@v1` to a tag.
  - **Moving `v1`.** The tag `v1` is moved to `main` after M1 merges (cua and doperpowers consume
    it), after M5 merges (the pool branch of `gates.yml`), and at M9.
  - The whole-range review in the Decision Log covers `main` from the spec commit to the final head.
- cua and doperpowers changes are PRs in those repos, following each repo's CLAUDE.md, with one
  branch per milestone.
- MAWS is not committed to. M7's output is a message and evidence.
  - Pushing temporary `ci/` refs to MAWS through MAWS's own `scripts/ci-gate.sh` is allowed. That
    is MAWS's own protocol, and the refs are deleted after the run.
- The `SSFSKIM/ci-kit-sandbox` repo (private) holds the evidence copy, the pool test configs, the
  ledger and alerts. It was created at authoring, with the evidence under `evidence/2026-10-15/`.

**Peers.** Talking to maws-fe, cua_repl or doperpowers-74 goes through the spec's author session
(CI-opt). The executor sends that session the text and gets the reply back. The author session is
the one these peers already address (`@doperpowers/CI-opt`).

**Forbidden surfaces.**

- Never `skills/`, `agents/`, `hooks/` or `output-styles/` in doperpowers.
- Never branch protection or rulesets, anywhere.
- Never a self-hosted runner on a public repo.
- Never the MacBook as a runner.

**Secrets.**

- Read a secret only inside the shell command that uses it, from `~/.config/claude-secrets/<KEY>`,
  and never print it.
- GitHub secrets are set with `gh secret set NAME -R <repo> < file`.
- The App's private key is written to a 0600 file under a `mktemp -d` directory and removed after
  use.

**Money.**

- Every Hetzner resource this work creates carries a `ci-kit=` label.
- Each milestone deletes what it created for testing before it ends, except the pool's own box,
  which the agent handles.
- Leftovers are found with `hcloud`-style API listing by label.
- Every GCP resource this work creates carries a `ci-kit` label and lives in `ssfskim-ci-kit`.
  Nothing in any other GCP project is touched.

**Language.**

- Node ≥ 22, ES modules, run with `node`.
- Runtime dependencies: only a YAML parser (the `yaml` package).
- Tests use `node --test`, run from the kit root with `npm test`, need no network, and finish under
  a minute on the MacBook.
- Code that talks to GitHub or Hetzner goes through small clients (`lib/github.mjs`,
  `lib/hcloud.mjs`). The decision logic is in pure functions tested against recorded API shapes:
  - the planner's selection;
  - the agent's demand, admission and idle checks;
  - ensure's branches;
  - the guard's rules.

**The Mac.** Kit tests are light. Anything heavy runs on the lanes the kit provides. The
`waitload20` / `with-slot` wrappers are MAWS's and are not used here.

**Human-only steps.**

- Creating the GitHub App in the human's logged-in browser. The executor may drive the human's
  Chrome profile with the Playwright extension, per the human's tools note, and escalates if that
  is blocked.
- Any purchase beyond pool usage.
- The desktop-lease decision (§4).
- Changing server types for cost.
- The GCP billing budget alert (§3a, Cost): it needs the billing admin. Also any quota increase
  the Quotas API does not approve on its own.

These go up through the author session.

### Plan of Work

#### M1 — Kit core: config, planner, reusable workflow, `ci-gate`, the kit's own CI

**What exists at its end.**

- A repo that adds the two files gets PR checks on hosted lanes.
- `ci-gate` works against it.
- The kit dogfoods itself: its own `.github/ci-kit.yml` runs its `npm test` on `hosted`.
- `docs/adopting.md` states the two-file onboarding and the schema reference.
- Tag `v1` exists.

**What it touches.**

- `plan/` — the planner.
- `.github/workflows/gates.yml` — the reusable workflow.
- `.github/workflows/ci.yml` and `.github/ci-kit.yml` — the kit's own.
- `bin/ci-gate` and `cli/`.
- `lib/github.mjs`.
- `test/`.
- `docs/adopting.md`.
- `install.sh`, which symlinks `ci-gate` into `~/.local/bin` and is run on the MacBook and on the
  mini (`ssh mini`).
- `README.md`.

**Interfaces.**

- Produces I1, I2, I3, I4 and I5.
- The `pool` lane's planner output (`runs_on` with pool labels, `pool: true`) is produced here. The
  ensure step it triggers comes in M5.
- Until M5, the workflow fails a pool-lane selection with
  `ci-kit: pool lane not available yet`. M5 replaces that branch.

**Decisions.**

- Changed-file matching uses globs of `*`, `?` and `**` (crossing directories); every other
  character is literal. Bracket expressions, backslash escapes, braces, a leading `!` or `/`, and
  an empty pattern are config errors naming the gate and field. The match set is the union of
  added, modified, renamed (both paths) and deleted files.
- On a ci ref, the default branch is read from the repo API.
- The nonce commit's message is `ci-gate <random 12 hex>`. The trailers follow a blank line. Only
  `CI-Gates:` is defined.
- Pitfall, as with MAWS's script: `gh` calls name the repo explicitly, so `ci-gate` runs from any
  directory.

**What it does not touch.** Pool and mac lanes beyond planner output, any other repo, and MAWS.

**What it proves.**

- A2 against `ci-kit` itself.
- A3:
  - in tests, with fixture inputs;
  - live, with a `ci-gate` run on a throwaway commit of the kit (a public repo) whose
    `.github/ci-kit.yml` adds a pool gate.
- The planner's selection table: explicit list beats paths, `on:` filtering, empty selection is
  green.

#### M2 — cua: adoption and timing-test stabilization

**What exists at its end.**

- cua has the two files.
- Its PRs get `ci / …` checks on hosted lanes within 10 minutes.
- The timing-sensitive tests named in §6 (refined by the probe) are event-driven or clock-injected.
- 20 dispatched runs are green.

**What it touches.**

- In `SSFSKIM/cua`: `.github/ci-kit.yml`, `.github/workflows/ci.yml`, and the test files named in
  §6 plus whatever the probe adds.
- A test helper for waiting on conditions, if cua has none.

**Interfaces.**

- Consumes I1, I2 and I5.
- Produces two kit additions, merged to the kit's `main` before the cua PR uses them, with `v1`
  moved after the merge:
  - `setup.fetch_depth` (I1);
  - gate jobs receive `CI_KIT_BASE` and `CI_KIT_HEAD` in their environment: the change basis of §1,
    empty on dispatch.

  M3 consumes both.

**Prerequisite.** M2 and M3 start only after the author session has done two things:

- committed the hosted-runner probe's report to `ci-kit-sandbox` at
  `evidence/2026-10-15/hosted-probe.md`;
- recorded its results in §5: per repo, the gate commands, lanes, Node version, tool
  prerequisites, and justified exclusions.

**Decisions.**

- The probe report decides:
  - the lane per gate;
  - the Node version;
  - which tests must be skipped on a lane, by a platform guard in the test with the reason;
- Coordinate with cua_repl before touching tests it has in flight.
- Its PR #50, on leaked `fake-upstream-process.mjs`, is checked for status first.

**What it does not touch.**

- cua's live checks, its `verify.mjs`, its plugin manifest, and anything outside tests and CI.
- Its merge settings.

**What it proves.**

- A1 and A2 on cua.
- A10 for each fixed test, with the before and after counts recorded in the PR body.

#### M3 — doperpowers: adoption and timing-test stabilization

**What exists at its end.**

- doperpowers has the two files, with gates per suite family (§5).
- The T3 timing assertions are event-driven.
- PR checks finish within 10 minutes.
- TECH-DEBT T2 ("No CI or pre-push gate") and T3 are updated with what landed.

**What it touches.**

- In `SSFSKIM/doperpowers`: `.github/ci-kit.yml`, `.github/workflows/ci.yml`, `tests/sminos/` and
  the other suites' tests as the probe requires, and `TECH-DEBT.md`.

**Interfaces.** Consumes I1, I2 and I5.

**Decisions.**

- A suite that tests the installed plugin cache (`claude -p` without `--plugin-dir`) is not a gate.
  It proves the wrong tree.
- (Superseded 2026-10-16: codex-companion is discarded and not gated, so its cleanup scoping is
  dropped.)
- doperpowers-74 is told before sminos tests change.

**What it does not touch.** `skills/`, `agents/`, `hooks/`, `output-styles/`, plugin manifests and
versions.

**What it proves.**

- A1 and A10 on doperpowers.
- A negative proof: a committed shell file with a ShellCheck error turns the shell-lint gate red.

#### M4 — Spike: the pool's boot path

**Question.**

- How long from a push, with no pool server in existence, to `PASS` of a trivial pool gate? That is
  the interval A5 bounds. Its parts are recorded separately:
  - push to the ensure call;
  - `POST /servers` to the agent's `ready`;
  - `ready` to the job's `started_at`;
  - the job itself.
- Does snapshot size (about 5 GB vs about 15 GB with caches) change it?
- Does a cpuset container report `nproc` = N?

**Build.**

- A throwaway snapshot: Ubuntu 24.04, Docker, and a pulled `actions-runner` image.
- `ci-kit-sandbox` with a dispatch workflow whose job `runs-on: [self-hosted, ci-kit-pool, cpus-4]`
  prints `nproc` and sleeps 30 s.
- A JIT config generated on the MacBook with `gh api` (the human's admin token; no App yet) and
  passed in user-data, so the box starts the runner at boot.
- Three cold creates per snapshot size, timed from the create call to the job's `started_at`. For
  the large snapshot, 10 GB of incompressible data written to disk before the snapshot stands in
  for the caches.

**Promote or discard.**

The spike runs on a hand-made box and has no planner, so it measures the box part: `POST /servers`
to `started_at`. It adds 1 minute for the hosted plan and ensure steps. The measured cold
push→`PASS` of M5 must then fit A5.

| p90 `POST /servers`→`started_at`, + 1 min | Verdict |
|---|---|
| ≤ 5 min | Promote the on-demand design as written. A5's bound stays at 5 min. |
| 5–8 min | Promote. Raise A5's bound to the measured p90 + 1 min, with a Decision Log entry. Only the first gate of a burst pays it; the MAWS target (scoped gate p50 ≤ 10 min) still holds when later gates find a warm box. |
| > 8 min | Stop. Take "always-on smaller box vs on-demand" to the human. |

**After.** Delete every server and snapshot it made. Record the verdict, the numbers, and whether
`cx53` was ever available during the spike, in Surprises & Discoveries.

#### M5 — The pool

**What exists at its end.**

- The bake workflow has produced a snapshot.
- The App exists and is installed on MAWS and the sandbox.
- Pool-lane gates in the sandbox run through the full lifecycle (§3): ensure, agent, job containers
  with cpusets and caches, the idle delete at minute ≥ 50, guard, ledger and alerts.
- `docs/pool.md` is the operator runbook: credentials, re-bake, the debug-access procedure, reading
  the ledger, and changing type or location preferences.

**What it touches.**

- In the kit: `pool/agent/`, `pool/image/Dockerfile`, `pool/bake/`, `pool/config/pool.json` (the
  served repos and watched workflows; no secrets), `pool-ensure/action.yml` and its script,
  `lib/hcloud.mjs`, `.github/workflows/pool-guard.yml`, `.github/workflows/pool-bake.yml`, and
  `docs/pool.md`.
- The reusable workflow's pool branch.
- In the sandbox: its `.github/ci-kit.yml` with pool gates (a `nproc` check, a 4-way parallel set,
  and a real Node workload), and the ledger issue.
- Repo secrets in the kit and the sandbox.

**Interfaces.**

- Produces I6, I7, I8 and I9.
- Consumes I1–I3. The pool branch of `gates.yml` replaces M1's "not available yet".

**Decisions.**

- The spike's verdict applies.
- Agent state is in memory plus server labels. A restarted agent rebuilds it:
  - from Docker (running containers, by label `ci-kit-job`);
  - from GitHub (runners named `ci-kit-pool-*`).
- Runner names are `ci-kit-pool-<server id>-<counter>`, so A9 can read them.
- Every API call the agent makes has a 20 s timeout. A failed poll skips that tick; it does not
  crash the agent. A run of failed ticks stops the heartbeat, and the watchdog and guard act on
  that (§3).
- **Ledger rows.** The deleter writes the row before its delete call (I9), marked `deleting`.
  - Whoever next sees the server gone finalizes that same comment, keyed by server id:
    - the guard;
    - a later agent at boot.
  - A server that outlived its row, because of a crash between the row and the delete, is deleted
    by the guard or the watchdog. The same comment is updated with the true deletion time, billed
    hours and end reason.
- The watchdog is in the snapshot as its own systemd unit. It reads the Hetzner token and the
  agent's last-success file, and nothing else.

**What it does not touch.** MAWS's workflow and MAWS's secrets. Setting `HCLOUD_TOKEN` in MAWS is
part of P1, done when maws-fe takes it.

**What it proves.**

- A5, A6 and A7.
- Pure-function tests pin these rules:
  - the heartbeat advances only after a fully successful tick;
  - the watchdog's two deletion conditions;
  - the container deadline;
  - the ledger comment is finalized in place across a crash window that spans an hour boundary;
  - the idle predicate counts in-progress runs;
  - demand subtracts idle runners;
  - admission never exceeds free cores;
  - ensure treats `uniqueness_error` as success and walks the type/location list on
    `resource_unavailable`;
  - the guard's wake and dead-agent rules.
  - the guard, the watchdog, the bake cleanup and ensure leave a resource without a `ci-kit=` label
    untouched, even when it matches by name or type. The Hetzner project holds other work's
    resources: a firewall `ks2-db-fw` with no labels, seen 2026-10-15.

#### M6 — The mac lane on the mini

**What exists at its end.**

- The mini's MAWS runner is registered and running as a LaunchAgent, with the job hooks.
- MAWS's `scripts/ci-gate.sh --runner macos` lands e2e jobs on it.
- The contention measurement (§4) is recorded with its verdict.

**What it touches.**

- In the kit: `mac/` — the LaunchAgent plist template, the hooks, `mac/install.sh` (run over
  `ssh mini`), and `docs/mac-lane.md`.
- On the mini: `~/actions-runner-maws` and `~/Library/LaunchAgents/com.ssfskim.ci-kit.mac-runner.plist`.

**Interfaces.** Produces I10. Consumes MAWS's existing `Runner:` trailer and `GATE_E2E_RUNNER`
semantics (read-only).

**Decisions.**

- The registration token comes from `gh api -X POST repos/SSFSKIM/MAWS/actions/runners/registration-token`
  on the MacBook, passed over ssh, never stored.
- The runner is non-ephemeral. The hooks do the cleaning.
- The existing ida-solution runner is left alone.
- MAWS's toolchain prerequisites on the mini are verified before registering, and any gap is
  reported rather than worked around with system changes:
  - Node ≥ 22.12;
  - pnpm through corepack;
  - Xcode Command Line Tools, for native modules such as `node-pty`;
  - Node on the runner's PATH, since MAWS's `plan` job runs `node` from PATH;
  - LibreOffice (`soffice`), for the document and presentation conversion groups.

  These follow MAWS's gate-offload plan §3.6, steps 3 and 6. A Homebrew install that asks no
  password is routine tool setup and may be done; anything that needs a password is reported.
- The first-run Keychain and notification prompts are allowed by hand in the mini's GUI session,
  by the human: never clicked by an agent, never through cua. The executor sends the exact prompts
  and the group that triggers them to the author session.
- When the runner is ready, the author session is told; it notifies maws-fe, who decides when to
  set `GATE_E2E_RUNNER`. Until then only an explicit `--runner macos` or `Runner: macos` trailer
  reaches the mini (MAWS has no repository variables set on 10-15).
- Before the 10-run measurement, `gh run list -R SSFSKIM/MAWS` is checked for macOS-lane runs
  already queued; any that land on the mini during it count as part of the measurement.
- If the 10-run measurement shows more than 1 failure in 10, the runner ships disabled
  (LaunchAgent unloaded) and the lease question goes to the human.

**What it does not touch.** MAWS's repo variables. Flipping `GATE_E2E_RUNNER` is maws-fe's (P4).
Any GUI setting on the mini.

**What it proves.** A8.

#### M7 — MAWS: evidence and proposals for maws-fe

**What exists at its end.** maws-fe has received P1–P7 with evidence, through the author session.
The evidence is measured on the pool through a sandbox workflow that checks out MAWS with an App
token:

- **Unit timings.** The unit job's actual command from `gate.yml`, run two ways:
  - as it is (with `getconf`);
  - with `--maxWorkers=$(nproc)`.

  Each runs full at `cpus-16` and sharded at N = 2, 4 and 8 over `cpus-4` containers. Record wall
  time per shard and the worker count vitest reports.
- **Linux-portable e2e groups.** MAWS's `LINUX_E2E` groups under `xvfb` on the pool, with timings.
- **Scoping recall.**
  1. From MAWS's gate history (`gh run list -R SSFSKIM/MAWS --workflow gate.yml`), find the
     post-landing unit reds caused by the change: the failing test fails at the commit and passes
     at its parent.
  2. For each, check whether `vitest list --changed <parent>` at that commit includes the failing
     file.
  3. Report the recall and the mean size of the selected set against the full suite.

The evidence also includes the inventory of Mac-bound gates (P4), and a mini run of the
macOS-only unit subset through a sandbox job that checks out MAWS on the `mac` lane.

maws-fe's responses are recorded in the Decision Log.

**Activating MAWS on the pool.** When maws-fe confirms that P1 has landed or is about to land, M7
does three things:

1. It sets `HCLOUD_TOKEN` in MAWS, if maws-fe asks for that.
2. It commits MAWS's entry to `pool/config/pool.json` on `main`. The agent picks it up within 5
   minutes.
3. It observes the first MAWS gate run on the pool, for A9.

If maws-fe adopts after finish, the activation is the CI-opt session's. `docs/pool.md` states it as
"adding a served repo", so anyone can do it.

**What it touches.**

- In the sandbox: `.github/workflows/maws-probe.yml` and `evidence/maws/`.
- In the kit:
  - MAWS's served-repo entry, upon activation;
  - fixes the probe exposes in the pool image, such as missing system libraries.
- The mac runner serves MAWS only, so the sandbox's mac-lane job needs one more step: the mini gets
  a second runner registration, for the sandbox, under the same LaunchAgent pattern, with
  concurrency kept at one machine-wide by a lock in the job hooks.
  - Alternatively, ask maws-fe to run the subset with `--runner macos`, if `gate.yml` gains that
    job (P4).
  - Choose whichever arrives first, and record which.

**Interfaces.** Consumes I6–I8, and MAWS's `package.json` scripts (read-only).

**Decisions.**

- P3 is proposed only if recall is 100% over at least 5 change-caused reds. Otherwise the evidence
  goes as a finding with no proposal.
- The P6 tests are proposed with the §6 rule and the A10 proof method, not with patches. They are
  maws-fe's code.

**What it does not touch.** MAWS's repo: no branches, variables or secrets.

**What it proves.** A9 (conditional, as stated there).

#### M8 — Host janitor

**What exists at its end.**

- The janitor runs on both Macs.
- It has killed nothing it should not: its first run is dry, and its would-kill list is reviewed in
  the PR.
- The report file exists on both Macs.

**What it touches.** In the kit: `host/janitor.mjs`, `host/janitor.json` (patterns), the LaunchAgent
plist, `host/install.sh`, and `docs/host.md`.

**Interfaces.** Produces I11.

**Decisions.**

- Patterns at authoring:
  - `node --test`;
  - `vitest`;
  - `playwright`;
  - `electron` with a worktree path in its arguments, and only with positive evidence of a test
    or automation launch (revised 2026-10-16; see the Decision Log);
  - `fake-upstream-process.mjs`;
  - sminos test stand-in supervisors;
  - `codex-plugin-test-`.

  Each pattern is a regex over the normalized invocation (revised 2026-10-16, M8 review):
  - `host/invocation.mjs` parses the command line and walks node's or python's own options by an
    arity table in code;
  - patterns see `node [--test] <entry> <args…>` or `python <entry> <args…>`, never the whole
    line;
  - execution modes, unknown options and missing values match nothing;
  - watch options make a match report-only.

  The exclusion patterns of §7 are checked after the kill patterns, and an exclusion always
  wins.
- The process listing uses `ps -axo pid,ppid,etime,command` for the current user only. The janitor
  never touches other users' or root's processes.
- The worktree report reads `git worktree list --porcelain` per repo under `~/Developer/GitHub`, plus
  `git status --porcelain` and `git branch --merged <default>`.

**What it does not touch.** Deleting worktrees or VMs, cmux, and any process not matched by
pattern, parentage and age together.

**What it proves.** A11.

#### M9 — Acceptance

**What exists at its end.**

- Every acceptance item has been run, with its output recorded in Surprises & Discoveries or in the
  PR bodies.
- The kit's `npm test` is green.
- The whole-range review of `main` (Decision Log) has run and its findings are addressed.
- Outcomes reports MAWS's hosted minutes per day once P1 lands, to check the ~$15 a month Actions
  budget.
- `v1` points at the final `main`.
- Outcomes & Retrospective is written, including:
  - the cost projection (A12);
  - A9's state;
  - the owner actions left (cmux update; the GitHub App, if it was escalated).

**What it touches.** This spec, and nothing else beyond fixes that acceptance exposes.

**What it proves.** A1–A12.

#### M10 — The GCE backend and cutover

**What exists at its end.**

- In `ssfskim-ci-kit`, deployed by `gce/deploy.sh`:
  - the launcher service and its one-minute Scheduler job;
  - the bake job and its weekly Scheduler job;
  - the two secrets;
  - the service account;
  - the Monitoring alert.
- The image family `ci-kit-runner` holds a ready image.
- The sandbox's pool gates and MAWS's pool jobs are served by GCE: both repos are in `gce.json` and
  neither is in `pool.json`, on `main`.
- The Hetzner pool is left as a fallback, with no box up.
- `docs/pool.md` has a GCE section covering:
  - deploy;
  - rotating the App key in Secret Manager;
  - reading the ledger;
  - moving a repo between backends, both ways;
  - the quota and budget settings.

**What it touches.**

- In the kit:
  - `gce/`: the launcher service, the bake job, the GCE builder script, the VM's systemd unit and
    the container's metadata/DNS rule, and `deploy.sh`;
  - `lib/gce.mjs`: a small REST client for Compute Engine, Secret Manager and Monitoring, which
    takes its token from the metadata server on Cloud Run and from
    `gcloud auth print-access-token` on the Mac;
  - the provider-neutral split of `pool/bake/` (`warm.mjs` takes an installation token);
  - ensure's `gce.json` check, and the rule that ensure creates a box only for repos in `pool.json`;
  - the Hetzner agent: draining for unserved repos, and the `ci-kit-config` label (§3a, Moving a
    repo between backends). Re-baked before the first move;
  - `pool/config/gce.json`;
  - `docs/pool.md`.
- GCP resources, in `ssfskim-ci-kit` only.
- The ledger issue.

**Interfaces.** Produces I12. Consumes I6–I9.

**Decisions.**

- §3a applies, including: one writer; allocation-named VMs; unregister before delete; ownership by
  file; preemption recorded, not re-run.
- The VM runs the existing pool runner image (`pool/image/Dockerfile`). It does not run a second
  image.
- **Pure functions, tested against recorded Compute and Actions API shapes:**
  - demand per (repo, label set), where a busy instance covers nothing;
  - admission under `max_vcpus`;
  - the order of zone, spot and on-demand attempts, including an insert with an unknown outcome
    reconciled through its operation before another zone;
  - each cleanup predicate;
  - ledger rows: provisional, finalized and idempotent;
  - the one-file-per-repo rule.
- **Tests beyond the pure functions:**
  - **Concurrency:** two independent launcher processes run against the same GCE and GitHub
    state with different demand snapshots. The test checks three things:
    - every ledger row is unique per allocation;
    - there are no double deletes or unregisters beyond the idempotent 404;
    - over-launched VMs are cleaned up by the idle rule. A quota refusal is handled as "wait".
  - **The move:** a busy job lasting more than 5 min is in flight when its repo is removed from
    `pool.json`, and it finishes. A failed config refresh (a stale `ci-kit-config`) blocks step 2.
    Queued jobs start only after step 6. The same checks run in reverse for `gce.json`.
  - **The idle race:** a runner takes a job between the idle read and the unregister call. Its VM
    survives.
  - **Crash windows:** after the provisional row, after the JIT mint, after an accepted insert,
    around the delete, and a provider-initiated delete (spot, max-run). Each ends in one final row
    and no leftover runner, instance or disk.
  - **Live on one VM:** GitHub resolves from inside the container, and `curl
    http://169.254.169.254/` is refused.
  - **Live, guest power-off with the launcher paused past `max_run_minutes`:** the VM stays
    `TERMINATED` and is deleted when the launcher resumes. This is the documented bound.
- **The order of work.**
  1. Quota requests (done 2026-10-16; see the Decision Log).
  2. The bake split and a ready image.
  3. The launcher, with only the sandbox in `gce.json`.
  4. A13 on the sandbox.
  5. MAWS's move by the §3a procedure: out of `pool.json`, drained, into `gce.json`. CI-opt tells
     maws-fe before and after.
- **When MAWS moves.** MAWS moves after maws-fe has flipped `GATE_RUNNER=pool` onto the Hetzner
  pool, after PR #16's drain proof. The move is then invisible to MAWS.
- **Every GCE resource:**
  - carries a `ci-kit` label;
  - lives in `ssfskim-ci-kit`;
  - is listed and cleaned at the end of each test step.

  Never touch another project.

**What it does not touch.** MAWS's workflow, which is byte-identical across the move, and MAWS's
secrets.

**What it proves.**

- A13.
- On GCE, A5 (the job log shows `nproc` = N), A7 (no stray instances, disks, runners or images
  beyond the two newest ready ones) and A12 (cost is visible).

**Review.** M10 gets a high-rung milestone review, as M5 did. The launcher creates paid resources
and holds the App key.

### Concrete Steps

**Working directories.**

- Kit: `~/Developer/GitHub/ci-kit-wt-m<N>`, a worktree of `~/Developer/GitHub/ci-kit` on the milestone's branch.
- Other repos: their own worktrees.

```
# M1 — kit tests and a live ci-gate against the kit itself
cd ~/Developer/GitHub/ci-kit-wt-m1 && npm test
#   expect: "# pass <n>" and "# fail 0"
ci-gate .
#   expect lines like:
#     PASS test 0m41s
#     GREEN https://github.com/SSFSKIM/ci-kit/actions/runs/<id>
#   exit 0; then:
git ls-remote origin 'refs/heads/ci/*'      # expect: no output

# M2/M3 — PR checks
gh pr checks <n> -R SSFSKIM/cua            # expect: every "ci / …" pass, "ci / verdict" pass
gh run view <id> -R SSFSKIM/cua --json jobs --jq '.jobs[]|[.name,.startedAt,.completedAt]|@tsv'
for i in $(seq 20); do ci-gate ~/Developer/GitHub/<cua-worktree> --label stab$i | tail -1; done
#   expect: 20 lines starting GREEN

# M5 — pool round trip (sandbox)
TOKEN="$(cat ~/.config/claude-secrets/HETZNER_API_TOKEN)"
curl -s -H "Authorization: Bearer $TOKEN" 'https://api.hetzner.cloud/v1/servers?label_selector=ci-kit=pool' | jq '.servers|length'
#   expect 0 before
ci-gate ~/Developer/GitHub/ci-kit-sandbox --gates nproc
#   expect: WAIT nproc 2m.. (boot), PASS nproc …, GREEN …; the job log contains "nproc=4"
#   then (≥ minute 50 of the server's hour): the servers query returns 0
#   and the ledger issue has a new row

# M6 — mac lane (run from a MAWS worktree; MAWS's own script)
scripts/ci-gate.sh <sha> --runner macos --gates e2e:composer
#   expect green, and the job's runner_name = the mini's runner:
gh api repos/SSFSKIM/MAWS/actions/runs/<id>/jobs --jq '.jobs[]|[.name,.runner_name]|@tsv'
ssh mini 'pgrep -fl actions-runner-maws/_work' # expect: no output after the job

# M8 — janitor
node host/janitor.mjs --dry-run      # expect: a list of would-kill lines, each with pid, age, pattern
tail ~/Library/Logs/ci-kit/janitor.log
```

### Interfaces and Dependencies

**I1 — `.github/ci-kit.yml`, version 1.** The planner rejects unknown keys.

```yaml
version: 1
setup:                      # optional; applied to every gate unless the gate sets setup: false
  node: "24"                # optional; actions/setup-node version spec
  pnpm: false               # optional; true → corepack enable (version from package.json packageManager)
  install: npm ci           # optional; shell command run after checkout
  fetch_depth: 1            # optional; actions/checkout depth for gate jobs; 0 = full history
gates:                      # required; non-empty
  - name: unit              # required; [a-z0-9][a-z0-9-]*; unique
    run: npm test           # required; bash, run with -eo pipefail at the repo root
    lane: hosted            # hosted | hosted-macos | pool | mac ; default hosted
    cpus: 4                 # pool only; one of 2 4 8 16; default 4
    timeout: 15             # minutes; default 30; max 360
    paths: ["src/**"]       # optional; selection filter for pr and ci-ref (§1)
    on: [pr, ci-ref, dispatch]   # optional; default all three
    artifacts: ["test-results/**"]  # optional; uploaded when the gate fails
    setup: true             # optional; false skips the shared setup
    env: {FOO: bar}         # optional; string values
```

**I2 — The caller workflow** (`.github/workflows/ci.yml`, verbatim in `docs/adopting.md`).

```yaml
name: ci
on:
  pull_request:
  push:
    branches: ['ci/**']
  workflow_dispatch:
    inputs:
      gates: {description: 'comma list of gate names; empty = all', required: false, default: ''}
jobs:
  ci:
    uses: SSFSKIM/ci-kit/.github/workflows/gates.yml@v1
    secrets: inherit
```

**I3 — The planner.**

- Command: `node plan/plan.mjs`. Inputs come from the environment, as set by `gates.yml`:
  - `CI_KIT_CONFIG` (path);
  - `CI_KIT_EVENT` (`pr` | `ci-ref` | `dispatch`);
  - `CI_KIT_PRIVATE` (`true` | `false`);
  - `CI_KIT_BASE` and `CI_KIT_HEAD` (shas);
  - `CI_KIT_GATES` (comma list, or empty);
  - `CI_KIT_HEAD_MESSAGE` (for trailers).
- On success it writes JSON to stdout:

  ```json
  {"gates":[{"name":"unit","run":"npm test","runs_on":["ubuntu-latest"],"timeout":15,
             "setup":{"node":"24","pnpm":false,"install":"npm ci"},"artifacts":[],"env":{}}],
   "pool":false,"note":""}
  ```

  - `runs_on` per lane:
    - hosted → `["ubuntu-latest"]`;
    - hosted-macos → `["macos-latest"]`;
    - pool → `["self-hosted","ci-kit-pool","cpus-<N>"]`;
    - mac → `["self-hosted","macOS","ARM64","ci-kit-mac"]`.
  - `pool` is true when any selected gate is on the pool.
  - `note` is `"no gates selected"` when the selection is empty.
- On a config error: `ci-kit: <message>` on stderr, exit 2. Messages name the gate and field.

**I4 — The `CI-Gates:` trailer.** On the head commit of a `ci/**` push, `CI-Gates: a,b` is an
explicit gate list (§1). Unknown names are a config error.

**I5 — `ci-gate`.**

```
ci-gate [<worktree-or-sha>] [--gates a,b] [--repo OWNER/NAME] [--label NAME] [--keep]
```

- Defaults: the current directory, and the repo from `origin`.
- Stdout is one line per event:

  ```
  WAIT <gate> <m>m<s>s
  PASS <gate> <m>m<s>s
  FAIL <gate> <m>m<s>s log=<path>
  SKIP <gate>
  CANCEL <gate>
  ```

  A `WAIT` line appears once, when a gate has been queued for 2 min.
- The last line is one of:
  - `GREEN <run-url>`;
  - `RED <failed>/<total> <run-url>`;
  - `ERROR <message>`.
- Exit 0, 1 or 2 respectively.
- Logs go to `/tmp/ci-gate/<owner>-<repo>/<run-id>/<gate>.log`, with artifacts beside them.
- `ERROR` cases:
  - no run appeared within 2 min of the push;
  - `gh` is not authenticated;
  - the planner failed (its message is printed).

**I6 — Pool names and labels.**

- Runner labels: `self-hosted`, `ci-kit-pool`, `cpus-<N>`.
- Server: name `ci-kit-pool`; labels `ci-kit=pool`, `ci-kit-state=booting|ready|draining`,
  `ci-kit-heartbeat=<unix seconds>`.
- Snapshot labels: `ci-kit=pool-image`, `ci-kit-commit=<sha>`.
- Firewall: `ci-kit-pool`, with no inbound rules.
- Runner names: `ci-kit-pool-<server id>-<counter>`.
- Container label: `ci-kit-job`.

**I7 — The ensure action.**

```yaml
- uses: SSFSKIM/ci-kit/pool-ensure@v1
  with: {hcloud-token: "${{ secrets.HCLOUD_TOKEN }}"}
```

- Output `result`, one of:
  - `existing`;
  - `created:<type>@<location>`;
  - `raced` (another ensure created it).
- It fails only when every type and location pair is unavailable, or the token is rejected.
- Semantics are in §3.

**I8 — The pool config** (`pool/config/pool.json`, baked to `/etc/ci-kit/pool.json`).

`repos[].workflows` lists the watched workflows (§3, Idle). Since PR #16 (2026-10-16) the agent
no longer reads it: only pool demand keeps a box alive. The key stays only because agents in
older snapshots still require it, and it is dropped once every snapshot runs the new code (M9). MAWS's entry,
`{"repo":"SSFSKIM/MAWS","workflows":["gate.yml"]}`, is added when maws-fe adopts P1.

```json
{"repos":[{"repo":"SSFSKIM/ci-kit-sandbox","workflows":["ci.yml","maws-probe.yml"]}],
 "types":["cx53","cpx62"],"fallback_types":["cpx52","cpx42"],"locations":["hel1","fsn1","nbg1"],
 "poll_seconds":10,"idle_runner_minutes":10,"drain_minute":50,
 "memory_gb_per_cpu":2,"max_hours_per_day":8,
 "ledger":{"repo":"SSFSKIM/ci-kit-sandbox","issue_title":"pool ledger"}}
```

Secrets go beside it as `/etc/ci-kit/app.pem`, `/etc/ci-kit/app_id` and `/etc/ci-kit/hcloud_token`.

**I9 — Ledger rows.** One comment per server session on the ledger issue, in this form:

```
| server id | created (UTC) | deleted (UTC) | type@location | billed h | € | jobs | end |
```

- `end` is one of `idle`, `stale-heartbeat`, `watchdog`, `max-uptime`, `manual` or `vanished`.
  `vanished` means the guard found a `running` row whose server was gone. Its deletion time is
  estimated from the last sighting, at most one guard cycle late.
- A row is written as `deleting` before the delete call, and finalized in place once the server is
  confirmed gone (M5 Decisions).
- At most one row is written per server id. The guard checks for an existing row before it writes
  one. The weekly summary comment states hours,
euros, jobs, and the projected month at the current rate.

**I10 — The mac runner.**

- Directory `~/actions-runner-maws` on the mini.
- LaunchAgent `com.ssfskim.ci-kit.mac-runner` (RunAtLoad, KeepAlive).
- Labels `self-hosted, macOS, ARM64, ci-kit-mac`.
- Hooks `mac/hooks/job-started.sh` and `mac/hooks/job-completed.sh`, logging to
  `~/Library/Logs/ci-kit/mac-runner-hooks.log`.

**I11 — The janitor.**

- `node host/janitor.mjs [--dry-run]`.
- Config `host/janitor.json`: `{"patterns":[…regex…],"exclude":[…regex…],"min_age_hours":2,"vm_report_hours":12,"repos_root":"~/Developer/GitHub"}`.
- LaunchAgent `com.ssfskim.ci-kit.janitor`, every 1800 s.
- Outputs `~/Library/Logs/ci-kit/janitor.log` and `report.md`.

**I12 — The GCE backend: config, names, labels and ledger rows.**

- **`pool/config/gce.json`** lives beside `pool.json`, which does not change:

  ```json
  {"repos":[{"repo":"SSFSKIM/ci-kit-sandbox"}],
   "project":"ssfskim-ci-kit","region":"us-central1",
   "zones":["us-central1-a","us-central1-b","us-central1-c","us-central1-f"],
   "machines":{"2":"e2-highcpu-2","4":"c3d-highcpu-4","8":"c3d-highcpu-8","16":"c3d-highcpu-16"},
   "machine_fallback":{"2":"c3d-highcpu-4"},
   "disk_gb":50,"max_run_minutes":120,"max_vcpus":64,
   "image_family":"ci-kit-runner","idle_runner_minutes":10,
   "ledger":{"repo":"SSFSKIM/ci-kit-sandbox","issue_title":"pool ledger"}}
  ```

- **One file per repo.** A repo appears in at most one of `pool.json` and `gce.json` (§3a, Which
  backend serves a repo).
- **Ensure.** It creates a Hetzner box only for a calling repo in `pool.json`.
  - For a repo in `gce.json`, it prints `result=gce`.
  - For a repo in neither file, it prints `result=none`.
  - In both cases it exits 0 without calling Hetzner. I7's `result` gains `gce` and `none`.
- **Instances.**
  - Name `ci-kit-gce-<allocation id>`, where the allocation id is 10 lowercase base36 characters.
  - Labels:
    - `ci-kit=gce`;
    - `ci-kit-alloc=<allocation id>`;
    - `ci-kit-repo=<owner>--<repo>`, lowercased;
    - `ci-kit-cpus=<N>`;
    - `ci-kit-provisioning=spot|standard`.
  - The boot disk carries the same `ci-kit=gce` and `ci-kit-alloc` labels, and `autoDelete`.
  - The runner's name equals the instance name.
  - Runner labels: `self-hosted`, `ci-kit-pool`, `cpus-<N>`, `ci-kit-gce`.
  - Metadata `ci-kit-jit` holds the JIT config.
- **Images and builders.**
  - Images: family `ci-kit-runner`, labels `ci-kit=gce-image`, `ci-kit-commit=<sha>` and
    `ci-kit-ready=true|false`.
  - Builders and smoke VMs: `ci-kit-gce-builder-<n>`, labelled `ci-kit=gce-builder`.
  - The guest attribute `ci-kit/bake` reports `ok` or `failed:<step>`.
- **Control plane.**
  - Cloud Run service `ci-kit-launcher` (`max-instances=1`, `concurrency=1`, request timeout
    300 s) and job `ci-kit-bake`.
  - Scheduler jobs `ci-kit-launcher-tick` (`* * * * *`) and `ci-kit-bake-weekly`.
  - Service account `ci-kit-launcher@ssfskim-ci-kit.iam.gserviceaccount.com`.
  - Secrets `ci-kit-app-id` and `ci-kit-app-key`.
  - A Cloud Monitoring alert on failed `ci-kit-launcher-tick` executions, mailed to the owner.
- **Ledger rows** go on the same issue, one comment per allocation, keyed by the allocation id:

  ```
  | alloc | instance | repo | job (actual) | created (UTC) | deleted (UTC) | machine@zone | spot/standard | seconds | $ | end |
  ```

  - A row is written `launching` before the JIT mint, and finalized in place.
  - `end` is one of `done`, `cancelled-idle`, `preempted`, `max-run`, `abandoned` or `orphan`.
  - A daily line totals the VMs, seconds and dollars, and projects the month.

**External dependencies.**

| Dependency | Use |
|---|---|
| GitHub Actions | hosted runners; reusable workflows; JIT runner API; Actions REST for runs and jobs |
| `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` | latest major versions |
| GitHub's `actions-runner` container image | pinned by digest in `pool/image/Dockerfile` |
| Hetzner Cloud API v1 | `servers`, `images`, `firewalls`, `server_types`. The `datacenters` endpoint was removed on 2026-06-02; availability is read from `server_types[].locations[].available` |
| `yaml` (npm) | the planner's YAML parser |
| Google Compute Engine API v1, Cloud Run, Cloud Scheduler, Secret Manager, Cloud Quotas | the GCE backend (§3a, I12), in project `ssfskim-ci-kit` |
| `gh` CLI | `ci-gate` and setup scripts on the Macs |

## Surprises & Discoveries

- **Observation:** Hetzner prices are higher than the research figures, and the cheap 16-core type
  is out of stock.
  - CPX62 is €0.2452/h, against €0.2083 in the research.
  - The cost-optimized CX/CAX types are unavailable in every location, except `cx23` (nbg1) and
    `cax11` (nbg1, hel1).
  - The `datacenters` endpoint is gone.

  Evidence: `GET /v1/server_types` on 2026-10-15 shows `cx53 … h=0.0561 mo=34.990 avail=[]` and
  `cpx62 … h=0.2452 avail=['fsn1','nbg1','hel1','sin']`, and `GET /v1/datacenters` returns
  `deprecated_api_endpoint`.
- **Observation:** the mini already hosts another repo's self-hosted runner, and the cua session
  drives its GUI. Evidence: maws-fe's ssh to the mini on 10-14 (`actions-runner-ida-solution`, 14
  of 16 GB used); the history catalogue's session index.

- **Observation (M4, 2026-10-15 21:44–21:58Z):** a cold pool box takes 41–56 s from
  `POST /servers` to the job's `started_at`, and snapshot size barely matters.
  - cpx62 in hel1, six cold creates. Small snapshot (1.70 GB compressed): median 46.5 s, max
    51.6 s. Large (12.16 GB, +10 GiB incompressible): median 51.3 s, max 56.3 s.
  - Where it goes: ~20 s of Hetzner provisioning before the kernel runs, ~15–22 s to
    `network-online` plus Docker, ~5 s from container start to job assignment.
  - Hetzner's snapshot `image_size` is compressed: the base, Docker and the runner image come to
    1.70 GB, not ~5 GB.
  - A cpuset container (`--cpuset-cpus=0-3 --memory=8g` on 16 vCPU) reports `nproc` = 4 and
    `os.availableParallelism()` = 4, while `getconf _NPROCESSORS_ONLN` = 16. That is P1's pitfall,
    reproduced.
  - `cx53` was never available during the spike (checked before every trial); cx33 and cx43 were
    unavailable too, cx23 only in hel1.
  - Evidence: kit branch `m4-spike`, `spike/pool-boot/results/`.
- **Observation (M4):** a queued job's `started_at` equals its `created_at` until a runner takes
  it; GitHub rewrites it at assignment. Queue age and FIFO order (the agent's admission, `ci-gate`'s
  `WAIT`) must use `created_at` and `status`, never `started_at`, for queued jobs.
- **Observation (M4):** the `actions-runner` image ships `externals/node24_alpine`, which does not
  run on its glibc base; scripts must not pick `externals/node*` blindly.
- **Observation (M4):** an ephemeral box should have `apt-daily*` timers and
  `unattended-upgrades` disabled in its image; patching is a re-bake. Not measured: first-read
  throughput of baked caches on a freshly restored disk (M5 looks once).

- **Observation (M1):** GitHub's default `shell: bash` is `bash -e -o pipefail`, and a later
  `set -uo pipefail` does not turn `-e` off. A step that inspects a failing command's status
  captures it with `|| status=$?`. This hid the planner's message on the first A3 run.
- **Observation (M1):** hosted runners announce that `ubuntu-latest` moves to Ubuntu 26 from
  2026-10-19 (actions/runner-images#14748). Probe results and timings taken before then may shift.
- **Observation (M1):** `actions/checkout`, `setup-node` and `upload-artifact` are at v7.
  `setup-node@v7` caches automatically when `packageManager` names npm; the kit passes
  `package-manager-cache: false`.
- **Observation (M1):** on an empty selection, the API lists the skipped matrix job as
  `ci / matrix.gate.name`; `ci-gate` filters it out. A hosted kit run takes about 40 s from push to
  GREEN.

- **Observation (M6, 2026-10-15):** the mini carries MAWS e2e without contention trouble.
  `e2e:composer` ran 10 of 10 green (18 passed each) against MAWS master 767fcbb7, all on
  `ci-kit-mac-mini`. Memory pressure stayed normal, free memory was 52–70%, swap did not grow, and
  load peaked at 6.5. No maws-fe macOS-lane runs landed during the window.
- **Observation (M6):** the job-completed hook killed 12 leftover processes (Electron and its
  helpers, playwright, pnpm) in each of two cancelled jobs.
- **Observation (M6):** MAWS's Actions cache never hits on `ci/` refs, so every gate run uploads
  about 280 MB, about 2 minutes per job on the mini. This is M7 proposal material.
- **Observation (M6):** `gh run view --json jobs` returns an empty `runnerName`. The jobs API's
  `runner_name` (`gh api repos/<repo>/actions/runs/<id>/jobs`) carries it.
- **Open owner step:** LibreOffice's first launch on the mini. The human opens it once and allows
  the Gatekeeper prompt by hand. Done means the quarantine flag on `/Applications/LibreOffice.app`
  gains the user-approved bit (it read `0181;…` on 10-15). Until then no soffice-launching group
  runs on the mini. CI-opt checks it and tells maws-fe. It is not an M6 deliverable.
- **Observation (M6):** LibreOffice on the mini (installed by Homebrew without a password) is
  still quarantined and has never been launched. The first document or presentation group may
  raise a Gatekeeper prompt that only the human can answer.

- **Observation (incident, 2026-10-15 ~23:00–23:50Z):** concurrent `ci-gate` pollers exhausted
  the human's GitHub REST budget (5,000/h). The M2 and M3 executors had about 8 alive at once, each
  making 2 requests every 10 s. Every session on the account shares that token: maws-fe's
  `ci-gate.sh`, `gh` in every session, qa-loop merges. Executors were capped at 2 pollers until
  the fix below landed.

- **Observation (M5, 2026-10-16):** the pool's round trip works live, run from the branch.
  - **A5.** A cold box went from push to PASS in about 1.3 minutes (the bound is 5). Inside it,
    `nproc` = 4 and `getconf` = 16. It deleted itself at minute 50, and its ledger row went from
    `deleting` to finalized.
  - **A6.** Four `cpus-4` gates started within 3 s of each other; the fifth started after the
    first finished.
  - **A7, box-local parts.** The watchdog deleted a box with a wrong App key at 30.7 minutes. A
    container whose runner had left was killed at 5 min 52 s. A cancelled bake and a failed bake
    each left no builder.
  - **Isolation.** A job container cannot reach the metadata service, has no Docker socket, has no
    `/etc/ci-kit`, and runs as `runner`. The private-repo base fetch works inside a pool container
    (git 2.55).
- **Observation (M5):** the Hetzner project's shared-core limit is below 20 vCPU. A bake failed
  with `403 resource_limit_exceeded (shared core limit exceeded)` while the pool box and a foreign
  2-core server (`session-mirror`, unlabelled) existed. Hetzner uses the same code for other
  project limits, such as server count.
- **Observation (M5):** the Electron cache stays empty after the bake, though the warm step
  reports ok. This is left for M7.
- **Observation (M5):** a JIT runner's work folder must be a real directory under the cache mount.
  A symlink broke checkout's credentials.
- **Observation (M5):** the App `ci-kit-runners` (id 5337915) was created through the human's
  Chrome with the manifest flow, without escalation.

- **Observation (M7, 2026-10-16):** vitest's `--changed` reruns the whole suite whenever a changed
  file matches a force-rerun trigger: a `package.json`, a vitest or vite config, or a setup file.
  70 of MAWS's 71 unit-bearing gate runs touched one against their base, and so did all 22 unit
  reds. P3 as written would select the full suite every time. M7 measures scoping by the import
  graph alone.
- **Observation (M7):** MAWS's `unit:darwin` (maws-fe, master 7180fe78) ran 13 files and 263 tests
  on the mini, none skipped (run 38841090087), closing A8's subset item. The job took 5 min 07 s:
  setup 16 s, tests 15 s, and 4 min 24 s in the setup action's Post step, which saves the Electron
  and pnpm-store caches. A `ci/` ref can never restore them. That is the ci/ cache-miss cost.
- **Observation (M7):** Electron 44 has no install script, so `npm install electron` never
  downloads it, and the pool's Electron cache was empty. The bake now warms it through
  `install-electron`.

- **Observation (M5 post-merge, 2026-10-16):** GitHub did not fire `pool-guard.yml`'s schedule
  for 85+ minutes after it reached `main`, though dispatch worked. Community reports give
  touching the file as the remedy (PR #8). Re-check in M9.
- **Observation (M5 post-merge):** the Actions runner accepts a job-started hook only when its
  filename ends in `.sh`, `.ps1` or `.js`. The first image baked from `main` failed every job in
  setup, and only a live probe caught it: the bake's smoke test runs no real job.
- **Observation (M5 post-merge):** a cpx12 builder holds the image build (233–279 s, peak memory
  plus swap 1.1–1.3 GB). The snapshot is 3.5 GB on a 40 GB disk.
- **Observation (M5 post-merge):** `systemctl mask` fails silently on a unit file that already
  exists in `/etc/systemd/system`. Test overrides use `disable --now`.

- **Observation (2026-10-16):** a system modal alert held key focus on the mini. The frontmost app
  was `UserNotificationCenter`, probably an unanswered Automation consent dialog. maws-fe's full
  class-1b run went red in 7 groups, all of them focus and pasteboard failures. The mini's locale
  is ko-KR, and maws-fe pins `--lang=en-US` in its launcher. The mac lane's job-started hook gains
  a desktop precondition (see the Decision Log).

- **Observation (2026-10-16 05:28–06:10Z):** GitHub refused hosted jobs in `ci-kit-sandbox`
  until the human raised the account's spending limit; MAWS hosted plan jobs ran again from
  06:10:56Z (run 38859758633). This is the known single point of failure: when the hosted budget
  is exhausted, nothing wakes the pool for a private repo. Details: The
  annotation read: "recent account payments have failed or your spending limit needs to be
  increased". Two runs confirm it: 38855962530 and probe 38856777128. A MAWS hosted plan job ran
  normally at 05:32Z, so the block was not shown to be account-wide.
  - This is a single point of failure for the pool. A private repo's plan job, which calls ensure,
    runs on a hosted runner, so without hosted billing nothing can wake the pool for that repo.
  - The cost section already accepts the dependency (about 1 hosted minute per run). The design is
    unchanged unless the human stops private hosted spending. The alternative then is a second,
    light runner instance on the mini for plan jobs.

- **Observation (M7, 2026-10-16):** on the pool, MAWS's unit job takes 4–5 minutes, against
  19.1 minutes hosted.
  - All of class 1a fits on one box in about 5 minutes: unit on 8 cores, static on 4, probes on 2.
  - Measured on MAWS master dfb01258a with warm caches on both sides. The hosted baseline is run
    38848353451; the pool runs are 38850160827 (55 jobs) and 38856271856.
  - Sharding over 4-core jobs is never faster than one unit job using the same total cores.
- **Observation (M7):** one MAWS unit test,
  `browser/import/service.test.ts` › "hears a cancel between history batches", timed out in all 5
  full pool runs that kept TMPDIR on disk. Its fixture does 1,200 separate SQLite inserts, each
  with its own fsync.
- **Observation (M7):** scoping by the import graph alone catches 5 of 6 change-caused reds. It
  misses `tokens-guard`, which reads source files rather than importing them.
- **Observation (M7):** Chromium inside a pool container runs only with `--no-sandbox`, because
  Docker's default seccomp profile refuses user namespaces. This rules out Linux e2e on the pool
  until the kit ships a seccomp profile that allows them, or the setuid helper. Open item.
- **Observation (M7):** M7's hosted use on 2026-10-16 was about 60 billed minutes: 53 for the MAWS
  baseline and 7 for the probe's plan jobs.

- **Observation (2026-10-16 06:37Z):** a second system dialog held focus on the mini, and the
  desktop precondition worked.
  - A SecurityAgent keychain-access dialog appeared at 06:37:22Z. PR #9's job-started check
    failed 12 MAWS jobs fast from 06:37:41Z (runs 38860039850 and 38860081438), instead of
    letting them run into it.
  - **Cause.** The mini's unified log shows the ClaudeUsage menubar app's `SecItemCopyMatching`
    was denied. It then fell back to `/usr/bin/security find-generic-password`, and securityd
    spawned SecurityAgent. Neither MAWS nor the kit was involved.
  - **Tooling.** On the mini, `/usr/bin/log` needs its full path, because zsh's builtin `log`
    shadows it. The predicate `process == "launchservicesd" AND eventMessage CONTAINS "SETFRONT"`,
    then a `processID == <pid>` follow-up, attributes a dialog in seconds.
  - Focus falling back to Finder when an e2e app quits is expected and harmless.
  - **Host-readiness rule:** no app that can raise a keychain or permission prompt runs in the
    runner's GUI session.

- **Observation (2026-10-16, CI-opt from the MAWS Actions API):** MAWS's gate rate breaks the
  pool's cost model.
  - On 10-15 UTC, 116 gate runs arrived across 23 of 24 hours. That is far more often than every
    50 minutes, so an on-demand box would almost never idle-delete, and its bill reaches the
    monthly cap:
    | type | cores | monthly cap |
    |---|---|---|
    | cpx62 | 16 | €152.99 |
    | cpx52 | 12 | €118.99 |
    | cpx42 | 8 | €81.99 |
  - The 4–10 h/day cost table does not fit this rate, and the 8 h/day guard alert would fire
    every day.
  - Hosted that day: 2,253 billed minutes (unit 1,153, e2e 621, static 291, plan 116, probes 72),
    about $13.50 at $0.006/min. The billing block came from Pro's 3,000 included minutes running
    out.
  - Stock that day:
    | type | shape | price | stock |
    |---|---|---|---|
    | cx53 | 16 cores | €34.99/mo | none |
    | cax41 (ARM) | 16 cores | €48.49/mo | none |
    | cpx41 | 8 cores / 16 GB | €0.0609/h, €37.99/mo cap | ash and hil only |
    | cpx51 | 16 cores / 32 GB | €0.1338/h, €83.49/mo cap | ash and hil only |
  - cpx41 and cpx51 are measured before the human chooses a lever. pool.json's types and
    locations, and A9's activation, wait on that choice and on the owner's approval.

- **Observation (2026-10-16, maws-fe's gate-offload DL 38, MAWS master a54943ff7):** P4 parts 2–4
  landed and were measured on the mini.
  - **Build cache.** Restoring `out/` takes 1 s, against a 33–41 s build. A job drops from about
    1 m 30 s to about 50 s, and a full lane builds 2 times instead of 26, saving 14–16 minutes.
  - **Default set.** browser-cua 7/7 and browser-chrome 7/7 joined it.
  - **The packaged gate** ran green except for two known in-front cases:
    - swiftc is present; build:app ran unsigned in 42 s; the fuses check passed;
    - supervisor:packaged 1/1 and voice:packaged 1/1;
    - e2e:packaged 86 pass and 2 fail of 150, the two being the known in-front cases.
  - **Still waiting.** P4 step 1, the GATE_E2E_RUNNER flip, waits for the Terminal-in-front hook
    and one whole green class-1b run.
- **Decision record (2026-10-16):** a GCE spot measurement of MAWS class 1a is an added M7
  evidence item, approved by the human, in project `ssfskim-ci-kit`. It is evidence only: the
  Hetzner pool stays the built lane, and a GCE backend would be a spec revision with its own
  milestone.

- **Observation (A9, 2026-10-16):** MAWS run 38868739039 (branch gate-offload-linux, 43fffa11b)
  ran class 1a on the pool, on box 170701310 (cpx41@ash, 8 cores).
  - The plan job ran hosted (07:40:45–07:40:53Z), and pool-ensure logged `existing`.
  - The jobs ran on `ci-kit-pool-*` runners:
    - probes on `ci-kit-pool-170701310-9`: 23 s;
    - unit on `-10`: 5 m 37 s, `vitest --maxWorkers=8`, 14,224 tests;
    - static on `-11`: 4 m 14 s. It queued behind unit, because unit's cpus-8 held the whole 8-core
      box.
  - All jobs passed, and the whole gate took about 11 minutes.
  - **A9 passes.** On an 8-core box `nproc` and `getconf` both read 8, so this run cannot tell them
    apart. M7's shard evidence (6/14 vs 4/14 red) does. The confirming check is the first 16-core
    pool run after GATE_RUNNER flips: its unit log should show maxWorkers=8 on a 16-core host
    (M9, post-flip, not a blocker).
- **Observation (A9 post-flip, 2026-10-16):** MAWS flipped GATE_RUNNER=pool. Its first production
  pool run, 38884821068 (master cd44b560a), ran class 1a on box 170733794 (cpx62@hel1, 16 vCPU).
  - **Box creation.** Ensure created the box at 10:04:56Z; the plan job ran 10:04:51–10:04:58Z.
  - **Runners and times.** Every job ran on a `ci-kit-pool-170733794-*` runner and passed:
    - probes on `-1` (cpus-2): 39 s;
    - static on `-2` (cpus-4): 3 m 37 s;
    - unit on `-3` (cpus-8): 5 m 11 s.
  - **Unit log.** It shows `cores 8-15 (nproc 8)` from the pre-job hook and `vitest run --maxWorkers=8`
    on the 16-vCPU host: 14,974 tests passed, 1068 files.
  - **Post-flip check confirmed.** On a host wider than its job, the gate sized to the cpuset, not
    the host. The unit log prints no getconf; M4 measured it at 16 in the same container shape.
  - **Total.** About 6 min 23 s from push to verdict.
- **Observation (2026-10-16):** the scheduled guard fired once, at 07:29:36Z. That is 3 h 40 min
  after the schedule was re-registered, and nearly 8 h after the workflow was created.
- **Observation (2026-10-16):** a MAWS e2e test leaked an open-URL into the owner's real Chrome on
  the mini. LaunchServices `open` ran at 07:19:24Z, during e2e:tools (run 38866065402), and Chrome
  took focus a second later. CI-opt told maws-fe.

- **Observation (M7 GCE evidence, 2026-10-16; sandbox `evidence/maws/gce-spot.md`):** MAWS
  class 1a on GCE spot, MAWS dfb01258a, six passes, no preemptions.
  - **One VM per gate** (c3d-highcpu-16): the gate took 346 s cold and 315–324 s warm, and cost
    $0.0149–0.0174 a gate.
  - **One VM per job** (c3d-8 + c3d-4 + e2-2): the gate took 412 s cold and 321–325 s warm, and
    cost $0.0117 a gate warm.
  - **Boot.** VM create to runner online took 33–55 s warm, and 61–137 s cold, when packages
    install at boot.
  - **Monthly at 116 gates a day:** about $41 (€36) warm per job, $52 warm per gate, and $57–61
    cold. The Hetzner caps are €82 for cpx42 and €153 for cpx62. The GCE figure covers MAWS class
    1a only.
  - c3d-highcpu-16 spot was out of stock once in us-central1-a and -b. The retry in -c took 15 s.
  - The unit job was red in all six passes, on the known import-test timeout.
- **Observation (M10 step 1, 2026-10-16):** quota preferences were filed through the Cloud Quotas
  API in `ssfskim-ci-kit`. All were reconciling when filed.
  | quota | current | requested |
  |---|---|---|
  | `CPUS-ALL-REGIONS` | 32 | 96 |
  | C3D per-family (us-central1) | 24 | 64 |
  | E2 per-family (us-central1) | reported 0 | 64 |
  | `IN-USE-ADDRESSES` (us-central1) | 8 | 32 |
  | `SSD-TOTAL-GB` (us-central1) | 500 | 2048 |

  `SSD-TOTAL-GB` was added beyond the spec's list. pd-balanced disks count against it, and at
  `max_vcpus` 64 with 2-vCPU jobs and 50 GB disks the pool needs up to 1,600 GB.

- **Observation (guard schedule, window 03:49:48–09:50Z on 2026-10-16):** `pool-guard.yml`'s
  `*/10` schedule fired once, at 07:29:36Z, where 36 runs were expected. The workflow is active,
  the repo is public with Actions on, and dispatch works. The GitHub schedule is not a backstop to
  rely on, see the Decision Log for what replaces it.
- **Observation (M10, 2026-10-16):** the human uploaded the App key for GCE to Secret Manager,
  because agents' secret-store writes are blocked here. Only `ci-kit-launcher@` can read it. A
  double generate created a third App key (fingerprint 9NaIZCKu…); its downloaded file was
  deleted, and the M10 worker revokes the key on GitHub. The remaining two are yj//oTVK… (Hetzner)
  and qQgu9F… (GCE).

- **Observation (drain proof, 2026-10-16, PR #16 on snapshot 444209129):** box 170721447
  (cx23@hel1, created 09:05:21Z) received an ensure stamp at 09:42:23Z from sandbox run 38882260237.
  It stayed `ready` past minute 50 while the stamp was under 15 min old, and deleted itself at
  09:57:33Z, 15 min 10 s after the stamp.
  - MAWS gate.yml runs were active throughout and never pinned it: 38882155146 and 38884000341
    were in progress at the deletion, and four more completed in the window.
  - Ledger row: `| 170721447 | … 09:05:21 | … 09:57:33 | cx23@hel1 | 1 | 0.01 | 1 | idle |`.
  - The `draining` label lasts one 10 s tick, too short for 30 s sampling to see.

## Decision Log

- **Decision:** the verification for this work.
  - **The spec.** One independent spec review by `doperpowers:adversarial-reviewer`, since the spec
    is technical-heavy. In the same round, a buildability review of the execution section by
    `doperpowers:adversarial-reviewer`, since there are nine milestones.
  - **Execution.** Execution follows `doperpowers:subagent-driven-execution` under a
    `doperpowers:plan-executor`, with reviews at its dependency frontiers.
  - **The kit.** The whole-range review of `main`, from the spec commit to the final head, is
    `doperpowers:review-code` at **high**, run in M9. The pool holds credentials, spends money on its own,
    and deletes servers.
  - **The PRs.** The cua and doperpowers PRs are each reviewed at **medium**.
  - **Rationale:** the review weight follows the stakes, not the size.
  - **Date/Author:** 2026-10-15, CI-opt.

- **Decision:** the review round folded six buildability findings.
  - **Publication.** Kit milestones merge to `main` one at a time, and `v1` moves after M1 and M5.
    The single `build` branch merged at the end is gone, because scheduled workflows and `@v1`
    callers need published code.
  - **Stability proof.** A10 uses `ci-gate` runs, which need no merge in the adopter repos, instead
    of dispatched runs.
  - **Mac-bound gates.** P4 now covers MAWS's macOS-only unit subset and an inventory of the
    remaining Mac-bound gates. P7 is limited to the gates that inventory moves.
  - **MAWS activation.** M7 owns MAWS's served-repo activation, and the agent re-reads its config
    every 5 min.
  - **Spike and A5 aligned.** The spike's verdict is set against A5's bound, which is now 5 min and
    revisable only through the spike's middle band.
  - **Probe prerequisite.** M2 and M3 wait for the hosted probe report, committed and folded into
    §5.
  - **Shell lint.** The doperpowers shell-lint gate passes the changed files explicitly.
  - **Rationale:** each finding was a real gap between a live proof and what the plan published or
    owned.
  - **Alternative rejected:** keeping one end-merged branch and moving the live proofs to after
    M9. That would defer every integration failure to the end.
  - **Date/Author:** 2026-10-15, CI-opt.

- **Decision:** the design review round folded eight findings.
  - **Cost leaks closed.** The heartbeat now means a successful reconciliation. A box-local
    watchdog deletes a box after 30 min without one, or after 24 h of uptime. Containers have
    deadlines. Bake builders are labelled, cleaned on every exit, and reaped by the guard. The
    agent re-enables the guard and bake schedules at each boot.
  - **Refs.** ci refs carry a nonce, and cleanup is compare-and-delete.
  - **MAWS.** P1 carries the worker-count fix (`getconf` sees the host's cores). A8 checks the
    macOS-only unit subset executes on the mini.
  - **Ledger.** Rows are provisional and finalized in place.
  - **Janitor.** Only one-shot test commands are killed; watchers are excluded.
  - **Rationale:** each finding was a state in which the box kept billing, or the evidence went
    green while the problem remained.
  - **Alternative rejected:** moving the guard to the private sandbox to escape the 60-day schedule
    rule. A 10-minute schedule on a private repo bills at least 1 minute per run, about 4,300
    minutes a month, which is a quarter of the CI budget spent on a backstop.
  - **Date/Author:** 2026-10-15, CI-opt.

- **Decision:** execution order and concurrency (pre-flight, plan-executor).
  - **Order.** M1 and M4 run first and concurrently: M4 is a hand-made box with no kit code. M6
    and M8 follow, M8 after M1 (it joins M1's `npm test`). M5 consumes M1 and M4's verdict. M2 and
    M3 consume M1 and wait for the probe prerequisite. M7 consumes M5 and M6. M9 consumes all.
  - **Concurrency.** Executors run in parallel only in separate worktrees on their own milestone
    branches (`~/Developer/GitHub/ci-kit-wt-m<N>`), never two in one checkout. The spec itself is
    edited only on `main`, by the plan-executor; milestone branches do not touch it.
  - **M2's "20 dispatched runs".** Read as A10's 20 consecutive `ci-gate` runs of the adoption
    branch's head, per the publication decision above, which replaced dispatched runs.
  - **Ledger.** The execution ledger under `.doperpowers/sde/` is gitignored (`.gitignore` added).
  - **Date/Author:** 2026-10-15, plan-executor.

- **Decision:** M6 measures with `e2e:composer`, not `e2e:default`, and gains readiness steps.
  - `e2e:default` is the bare `pnpm e2e` (`playwright test` over every spec); ten runs would hold
    the mini for most of a day. A named group of about 2 minutes, chosen for the keyboard and focus
    cases that owner input broke before, measures the same contention. A8 and Concrete Steps
    follow.
  - Readiness (Node on PATH, LibreOffice, Xcode CLT), the human-only first-run prompts, and the
    hand-off to maws-fe for `GATE_E2E_RUNNER` come from maws-fe's reply (their gate-offload DL22),
    which raised no conflict with registering the runner.
  - **Date/Author:** 2026-10-15, plan-executor, from maws-fe through CI-opt.

- **Decision:** M4's verdict is the "≤ 5 min" band. The on-demand design is promoted as written,
  and A5's bound stays at 5 minutes.
  - p90 of `POST /servers`→`started_at` is 56.3 s, so 1.9 min with the 1-minute plan-and-ensure
    allowance (Surprises & Discoveries, M4). The spike cost about €1.50, and all its resources
    were deleted (label listings in the M4 report).
  - The spike measured on cpx62, the pool type, rather than the cheapest: the nproc question needs
    more host cores than N, and boot time depends on the type.
  - **Date/Author:** 2026-10-15, plan-executor.

- **Decision:** M1's resolutions of gaps the spec left open.
  - **The kit's own caller** uses `./.github/workflows/gates.yml`, permanently, so every kit
    commit is gated by its own workflow and planner. I2's `@v1` is for adopters, and A4 does not
    cover the kit.
  - **The planner at the workflow's version.** The plan job checks out the kit at
    `job.workflow_repository@job.workflow_sha`, the job-context properties GitHub documents for
    this.
  - **Change basis.** The planner runs `git diff --no-renames base...head`, which counts from the
    merge-base and gives a rename's two paths. The default branch comes from the event payload's
    `repository.default_branch`, the same field the repo API returns.
  - **Config strictness.** `plan` and `verdict` are reserved gate names. `setup.node` and `env`
    values must be YAML strings. All errors are reported at once, one `ci-kit:` line each.
    Globs treat dotfiles as ordinary.
  - **Explicit lists** ignore `on:` as well as `paths`. An empty dispatch input means all gates.
    The trailer is read only on `ci-ref`, from the message's last paragraph.
  - **`ci-gate`.** It talks to the REST API with `gh auth token` through `fetch`, with a 20 s
    timeout per call, and `gh run download` for artifacts. It reads planner errors from the plan
    job's check-run annotations.
    - SIGINT cancels the run, removes the ref and exits 130.
    - `startup_failure`, an outside cancel, or 20 unreadable polls are `ERROR`, exit 2.
    - Progress notes go to stderr, so stdout carries only I5's lines.
  - **Date/Author:** 2026-10-15, M1 executor, folded by plan-executor.

- **Decision:** `paths` globs are a fail-closed subset: `*`, `?`, `**`, literals (revised
  2026-10-15 from "POSIX globs with `**`").
  - The M1 review found the first glob translator silently mis-matching bracket expressions and
    escapes, so a gate could drop out of a selection and leave a green verdict. A pattern the
    planner cannot match exactly is now refused at validation.
  - No adopter's paths need more. A future need for brackets is a compatible addition: a pattern
    that is refused today cannot be in use anywhere.
  - **Alternative rejected:** implementing POSIX bracket and escape semantics. It is more code to
    get exactly right, for a feature no config uses.
  - **Date/Author:** 2026-10-15, plan-executor.

- **Decision:** the hosted probe's results are folded into §5.
  - **cua** gates on `hosted-macos` only, with Node 24 and full history. Ubuntu waits for 5
    platform fixes, which are cua_repl's.
  - **doperpowers** gates on `hosted` per suite family. codex-companion goes on `hosted-macos`,
    because an ubuntu fix would touch plugin code.
  - **The kit** gains `setup.fetch_depth` and the base and head shas in gate environments, in M2.
  - **Rationale:** these are measured portability facts (runs listed in §5).
  - **Alternative rejected:** gating cua on both OSes with Linux skips added by this initiative.
    That would hide the product bug at `linux-chrome-features.mjs:59` behind a guard.
  - **Date/Author:** 2026-10-15, CI-opt.

- **Decision:** cua test coordination for M2 (from CI-opt, both cua_repl sessions having ended).
  - PR #50 (the fake-upstream watchdog) was merged 2026-10-06. Nothing to do.
  - cua's own-REPL-host M4 branch (`feat/own-repl-host-m4`) changes 54 test files. M2 edits none
    of them. The list is kept beside the execution ledger as `cua-m4-test-files.txt`.
    - The §6 `serve`/`repl-host` teardown flakes in `test/repl-host/*` stay with that branch. The
      cua PR body records them as deferred.
    - The other §6 targets are fixed: cdp, extension-host, group enumeration, mcp-upstream,
      chrome-host-run, browser-service, `actions` element-without-box, eof-drain, serve-cli and
      serve-lazy. Each is rechecked against the list before it is edited.
  - The Linux findings are filed as SSFSKIM/cua#142, so M2 has no Linux work.
  - **Date/Author:** 2026-10-15, CI-opt, recorded by plan-executor.
- **Decision:** M3 is sequenced around the doperpowers desk's DC7 branch.
  - DC7 is in its final fix wave. It touches `tests/sminos/test-bridge-requests.sh` and
    `tests/sminos/run-sminos-tests.sh`. M3 edits neither until DC7 merges to doperpowers `main`.
    `test-bridge-requests.sh` is then made event-driven on top of DC7's version, including DC7's
    new flaky check ("the terminal won, as a field").
  - Everything else in M3 proceeds now: the CI files and the other T3 fixes.
  - The sminos gate is sized against the post-DC7 suite, about 3.8k more lines of tests. Over
    about 8 minutes on ubuntu, it splits into two gates, shell suites and Python suites, without
    editing `run-sminos-tests.sh`.
  - **Date/Author:** 2026-10-15, CI-opt, recorded by plan-executor.
- **Decision:** M2's kit additions (`setup.fetch_depth`, `CI_KIT_BASE`/`CI_KIT_HEAD` in gate
  environments) run as their own kit branch, `m2-kit`. It is reviewed and merged first, and `v1`
  moves after it. The cua and doperpowers adoption work starts at the same time on the test fixes
  and takes `v1` for its live proofs once `v1` has moved.
  - **Date/Author:** 2026-10-15, plan-executor.

- **Decision:** M6's verdict is "0–1 failures in 10": ship. The runner is enabled, so no lease
  question goes to the human. M6's resolutions:
  - A leftover process is one whose command line names a path under `_work`, or whose working
    directory is under it, together with its descendants.
  - The hooks are Node files copied into the runner's directory, so they need no kit checkout.
  - The registration token travels over stdin and reaches the runner through an environment
    variable, never an argument or a file.
  - Jobs get `LANG=en_US.UTF-8`, because the mini's locale is Korean.
  - **Date/Author:** 2026-10-15, M6 executor, folded by plan-executor.
- **Decision:** the m2-kit additions' semantics.
  - `CI_KIT_BASE` is the merge-base of the plan's base with the commit the gate checked out. It is
    empty on a dispatch.
  - `CI_KIT_HEAD` is the commit the gate checked out: a PR's merge commit, or the nonce commit on
    a ci ref.
  - When the checkout lacks the base, a gate step fetches it at depth 1, so a two-dot
    `git diff $CI_KIT_BASE $CI_KIT_HEAD` works at the default depth. The pool image needs git ≥ 2.31
    for that step.
  - `setup: false` leaves a gate at depth 1. Gate `env` may not use `CI_KIT_*` names.
  - **Date/Author:** 2026-10-15, m2-kit executor, folded by plan-executor.

- **Decision:** `ci-gate` is a good citizen of the shared token. It is a kit fix wave before
  the next `v1` move.
  - Run and job polling use conditional requests (`If-None-Match`; a 304 does not count against
    the limit).
  - Jobs are polled every 15 s for the first 2 minutes, then every 30 s. Logs are fetched only for
    failed jobs.
  - `X-RateLimit-Remaining` is read on every response. Below 500, the poll stretches to 60 s and
    `ci-gate` prints one line, `THROTTLE remaining=<n>`.
  - Proof: a pure-function test of the schedule, and a live run that spends fewer than about 60
    requests over 5 minutes.
  - The pool agent polls on the App's installation token (its own budget) and uses the same ETag
    behaviour.
  - **Rationale:** adoption means many agents running `ci-gate` at once on one human's token. A
    poller that can drain it breaks the whole account.
  - **Date/Author:** 2026-10-15, CI-opt, recorded by plan-executor.
- **Decision:** the DC7 owner (smns-erb-88) approved M3's three changes to DC7's tests. It declined
  a test-only `saw_waiting` or presence counter on `GET /requests/<id>`; it does not belong in the
  DX5 contract. The one 2 s wait in `test-bridge-requests.sh` stays. If it flakes in CI, the run id
  is reported to CI-opt as a bug. The `launched_by` off-by-a-second finding is tracked in Arkho #84.
  - **Date/Author:** 2026-10-15, CI-opt, recorded by plan-executor.

- **Decision:** the ci-gate rate-limit fix wave merged (PR #5), and `v1` moved to it. One pacer
  covers discovery and watching. An exhausted budget during discovery is a named rate-limit
  `ERROR`. The budget is the lowest remaining across the rate-limit windows that are still open:
  the run and jobs endpoints reported different windows in one poll. The 2-poller cap on
  executors is lifted.
  - **Date/Author:** 2026-10-16, plan-executor.

- **Decision:** the janitor kills only command lines that positively establish a one-shot test
  (revised 2026-10-16, from the M8 review).
  - **Electron.** A worktree path alone does not prove a test: a developer's app opened from a
    worktree can be orphaned past 2 hours on purpose. Electron is killed only with positive
    evidence of a test or automation launch, such as the flags Playwright passes. Otherwise it is
    reported. This follows §7's rule, which outranks the authoring list's looser entry.
  - **Patterns match the entrypoint.** They match the running script or the runner's own option
    position, not any later argument. A Node-hosted CLI (`node …/claude-code/cli.js --resume
    "… vitest run …"`) or an argument that merely mentions a test never qualifies.
  - **Config.** Every pattern and exclusion must be a string; anything else is a config error.
  - **Signals.** Process identity (birth time) is revalidated before SIGTERM and before SIGKILL, as
    in M6's hooks.
  - **Date/Author:** 2026-10-16, plan-executor.

- **Decision:** the pool degrades gracefully when the Hetzner project's core limit is hit.
  - **Ensure.** A create refused for the core limit moves on to a smaller type: cpx52 (12 vCPU),
    then cpx42 (8 vCPU). It records the type in the ledger row and opens an alert naming the
    cause. A smaller box is far better than a stranded gate. Gates whose `cpus` exceed the box wait
    in GitHub's queue, as with any lack of capacity.
  - **Bake.** A builder refused for the core limit waits and retries for at most 2 h, then fails
    with an alert. It never fails silently.
  - **Why.** The project's shared-core limit is below 20 vCPU. The 16-core pool box plus a foreign
    2-core server leave no room for a builder. Raising the limit is with the human (asked
    2026-10-16).
  - **Date/Author:** 2026-10-16, CI-opt, recorded by plan-executor.
- **Decision:** the janitor's exclusions win over its patterns, with no exemption. The
  codex-companion test broker (`app-server-broker.mjs serve …`) is therefore reported, not
  killed. Its worker and the fake `codex app-server` are still killed. (Superseded by the M8
  parser: options with a separate value are consumed by arity, so `node --import tsx --test` now
  parses.)
  - **Rationale:** §7's safety rule says killing needs a positively one-shot command line. A
    `serve` process is the case the exclusion exists for.
  - **Date/Author:** 2026-10-16, plan-executor.

- **Decision:** M5's resolutions of gaps the spec left open.
  - **Watchdog.** It reads the App key only to write its ledger row, and deletes the box whether or
    not that write succeeds. A box it deletes while GitHub is unreachable gets no row.
  - **Agent state.** The job count lives in a server label, `ci-kit-jobs`. A restarted agent
    resumes its runner counter past that label, its containers and its runner names.
  - **Admission.** Strictly first in, first out. A job no box size could ever serve is logged and
    passed over rather than blocking the queue.
  - **Idle (`servable`).** A queued job too large for this box does not keep it alive. A
    smaller fallback box holding only such jobs deletes itself at minute 50, and the guard's wake
    rule asks for a full-size box again.
  - **Draining.** A box that is draining when its hour turns goes back to `ready`, since that hour
    is already paid.
  - **A served repo that cannot be read** fails the tick, so the heartbeat does not advance.
  - **Ensure.**
    - It moves on to the next type or location on `placement_error` as well as
      `resource_unavailable`.
    - On a name clash, it reports `raced` only when a labelled pool box exists.
    - A core-limit refusal skips that type in every location. The fallback types are
      `fallback_types` in I8. A fallback box carries `ci-kit-fallback=core-limit`, and its agent
      opens the alert at boot, because callers hold only `HCLOUD_TOKEN`.
  - **Guard.** Heartbeat age counts from creation until the first heartbeat. Each alert opens at
    most once while an issue with that title is open. The weekly summary is due 7 days after the
    last one.
  - **Bake.** The builder reports through its own server labels. Cache warming is best effort and
    recorded in a file jobs can read. A core-limit refusal retries every 5 minutes for 2 hours, so
    the workflow timeout is 180 minutes. Alerts are one shared module.
  - **Polling.** The agent's run, runner and job listings use the kit's conditional-request
    client on the App's installation token. The guard, a fresh process every 10 minutes, does not.
  - **Date/Author:** 2026-10-16, M5 executor, folded by plan-executor.

- **Decision:** the kit lives within the Hetzner project's current core limit. This is now a
  design fact: the human cannot raise the limit for now, and `session-mirror` is not ours and
  stays.
  - **Ensure** falls back on a core-limit refusal to cpx52, then cpx42 (above). The ledger row
    records the type, and an alert names the cause.
  - **Bake schedule.** The bake runs at an hour when no pool box usually exists, picked from the
    ledger's created times so far, or else Sunday 18:00Z (03:00 KST Monday).
    - If a pool box exists when it starts, or the builder create hits the core limit, it retries
      every 15 minutes for up to 2 hours, then fails with an alert. The previous snapshot stays in
      use.
  - **Builder size.** The builder is the smallest type that holds the image build: cpx22, or cpx12
    if the build fits in 2 GB with swap.
  - **`docs/pool.md`** states the limit, what a fallback looks like in the ledger, and that raising
    the project's limit removes both measures.
  - **Date/Author:** 2026-10-16, CI-opt, recorded by plan-executor.

- **Decision:** two M5 review findings resolved in the spec (2026-10-16).
  - **A box smaller than a job runs it on all its cores, rather than counting as idle.** On a
    fallback box (cpx52 or cpx42), a job whose `cpus-N` exceeds the box's cores gets an exclusive
    cpuset of every core the box has, once the box is otherwise empty. The job's log records the
    clamp. This replaces the executor's `servable()` idle rule. That rule could not see watched
    runs, so a `cpus-16` gate kept a 12-core box alive. Dropping watched runs from idleness would
    break the protection for late dependent jobs. A clamped gate is slower; a stranded one costs a
    box-day.
  - **Ledger coverage.** Every pool session gets a row before any deleter can need one:
    - the agent writes a provisional `running` row at boot;
    - the guard writes one for any pool server it sees without a row;
    - deleters finalize that row.

    The watchdog still deletes whether or not GitHub answers, because deletion must not depend on
    GitHub. So a box that never reached GitHub and lived less than one guard cycle can go
    unrecorded. That residue is accepted as an exception to I9's one row per session.
    Duplicates from concurrent writers are reconciled deterministically: readers count one row per
    server id, and a writer that finds two keeps the most final and deletes the rest.
  - **Date/Author:** 2026-10-16, plan-executor.

- **Decision:** a ledger row overwritten by a stale concurrent PATCH is accepted, not
  coordinated (M5 re-review).
  - GitHub's comment API has no conditional update. A guard and a deleter that read the same row
    within milliseconds can leave a `final` row back at `running`.
  - The guard's own rule repairs this. A `running` row whose server is gone is finalized as
    `vanished` within one guard cycle. The damage is limited to one session's end reason and up to
    10 minutes of estimated hours.
  - **Alternative rejected:** one comment per state transition, with readers taking the most final.
    It multiplies comments on the human-read ledger to close a window of milliseconds that the
    guard already heals.
  - **Date/Author:** 2026-10-16, plan-executor.

- **Decision:** MAWS's macOS-only unit subset runs in maws-fe's own `unit:darwin` gate, not in
  a sandbox runner.
  - maws-fe is adding a MAWS-owned `unit-darwin` job on the macOS runner. It finds the §6 files by
    their guard, is part of the macOS lane's default set, and is selectable with
    `Gates: unit:darwin`.
  - M7 registers no second runner on the mini. P4's unit part drops; its e2e routing and
    build-once remain.
  - A8's subset item is closed by one `scripts/ci-gate.sh --gates unit:darwin --runner macos` run
    once that lands. Its report must show the 13 files' tests executed, not skipped.
  - **Date/Author:** 2026-10-16, CI-opt from maws-fe, recorded by plan-executor.

- **Decision:** two codex-companion tests come out of doperpowers' CI gate until their product
  races are fixed (M3, overridable by CI-opt).
  - `test-resume.sh` and `test-verb-e2e.sh` went red unloaded in 2 of 7 runs, on races in
    codex-companion's runtime under `skills/`, which M3 must not touch:
    - verb-e2e case 9, a resume lease race (run 38833218641);
    - phase 9 "got 0": the worker is gone just after SIGKILL (run 38843076054).
  - They keep running in the local `run-workflow-tests.sh` list. The exclusion is commented in
    `.github/ci-kit.yml` and recorded in TECH-DEBT. The races go to the doperpowers owner.
  - **Rationale:** a check that goes red on its own teaches agents to ignore red, which costs more
    than these two files' coverage.
  - **Alternative rejected:** keep the gate whole and count those two tests as a declared exception
    to A10. That keeps coverage, but leaves a noisy check on every PR.
  - **Date/Author:** 2026-10-16, plan-executor.
- **Decision:** maws-fe took the ci/ cache item itself. There is no Actions cache on the macOS
  runner, whose disk keeps the stores. A `warm` job on master fills the Linux caches that ci/ refs
  restore. M7's pool-vs-hosted comparisons record the MAWS sha and the cache state of each side.
  - **Date/Author:** 2026-10-16, CI-opt from maws-fe, recorded by plan-executor.

- **Decision:** codex-companion is discarded (owner, 2026-10-16), so it has no doperpowers CI
  gate. This supersedes the entry above that excluded two of its tests from the gate.
  - M3's PR carries no edits to codex-companion's tests or runner. TECH-DEBT records only that the
    component is not gated because it is discarded. The race signatures are dropped, since no one
    will act on them.
  - The only `hosted-macos` doperpowers gate goes with it. Every remaining gate is on `hosted`,
    and A10's 20/20 restarts on them.
  - **Date/Author:** 2026-10-16, CI-opt from the owner, recorded by plan-executor.

- **Decision:** M2's resolutions (cua PR #143).
  - Budget arithmetic gets a controlled clock (node:test's mocked timers), so no product change
    was needed.
  - "Eventually" waits use liveness bounds of 10–20 s.
  - Each A10 proof runs the file at `main` beside the fixed file, under `yes` loops at 2× cores on
    a hosted macOS runner. The cdp flake reproduced only at 8× load (1 in 220), recorded as such.
  - serve-cli and serve-lazy are deferred. Their failures come from `cua serve`'s own 5 s
    teardown budget, which is product code.
  - The plugin gate bounds each `claude` install with `perl alarm`, because macOS runners have no
    `timeout`.
  - Found and left for cua's owner: a clipboard paste can run after its caller was told
    "timeout", in `src/browser-service`.
  - **Date/Author:** 2026-10-16, M2 executor, folded by plan-executor.

- **Decision:** the guard's schedule is checked over a window of at least 6 hours in M9, and its
  observed cadence is recorded in Surprises & Discoveries. If it still never fires:
  - the watchdog remains the primary cost safety (30 minutes without a successful
    reconciliation, or 24 hours of uptime);
  - the guard's wake rule is recorded as effectively dispatch-only;
  - `docs/pool.md` gains one line on dispatching the guard by hand.

  No second scheduling mechanism is added.
  - **Date/Author:** 2026-10-16, CI-opt, recorded by plan-executor.

- **Decision:** the mac lane's job-started hook fails a job at once when a system dialog holds
  focus.
  - The hook reads the frontmost app with `lsappinfo` only, never AppleScript or System Events,
    which raise TCC prompts. If it is `UserNotificationCenter`, `CoreServicesUIAgent`,
    `SecurityAgent` or `loginwindow`, the job fails with `ci-kit: a system dialog (<name>) holds
    focus on the mini — dismiss it there and rerun`.
  - **Rationale:** an hour of red e2e groups becomes one clear failure.
  - **Date/Author:** 2026-10-16, CI-opt, recorded by plan-executor.

- **Decision:** M3 merges doperpowers `main` into its branch and bumps the version with
  `scripts/bump-version.sh` above main's (7.157.4). This amends M3's "no versions" line, at the
  author's instruction.
  - The new waits from main's #201 get the same 30 s liveness bound, so the race class M3 fixed
    does not return through main.
  - The 20-run A10 series runs on the merged head.
  - **Date/Author:** 2026-10-16, CI-opt, recorded by plan-executor.

- **Decision:** M7's verdicts on the proposals, measured on the pool.
  - **P1 (pool lane for class 1a):** proposed. It is gated on the SQLite-fsync test above, and
    needs workers from `nproc`, pnpm through corepack, and no Actions cache.
  - **P2 (sharding):** not proposed.
  - **P3 (`--changed` scoping):** not proposed; it goes as a finding. Recall is 6 of 6, but only
    because the whole suite runs every time. Import-graph scoping reaches 5 of 6.
  - **P4 (mini for Mac-bound gates):** proposed. The cache item is listed as taken.
  - **P5 (duplicate type check):** proposed at low priority. Its value is avoiding the
    out-of-memory failures, not time.
  - **P6 (event-driven timing tests):** proposed, with three more tests the pool runs found.
  - **P7 (retire the load rule):** proposed, framed around the owner's ruling.
  - A red counts as caused by the change when it fails 3 of 3 at the tested commit and passes, or
    does not exist, at the base.
  - **Date/Author:** 2026-10-16, M7 executor, folded by plan-executor.

- **Decision:** a small Actions budget (owner, 2026-10-16).
  - Private repos keep their plan/ensure job and their light gates on GitHub-hosted runners,
    under an Actions budget of about $15 a month. Heavy MAWS jobs move to the pool. The total
    stays inside the ~$50 a month target.
  - **Rejected alternative:** no hosted spend at all, with a second, light runner on the mini for
    plan jobs. The pool's wake would then depend on the mini being online, and the mini is a
    single home machine.
  - M9's Outcomes reports MAWS's hosted minutes per day once P1 lands, to check that the budget
    holds.
  - **Date/Author:** 2026-10-16, owner via CI-opt, recorded by plan-executor.

- **Decision:** the guard-schedule window runs from the schedule's re-registration (042a8ee,
  workflow `updated_at` 03:49:48Z) and closes at 09:50Z.
  - Before then, zero schedule runs had come since the workflow's creation at 23:39:50Z, although
    the workflow is `active`, the repo is public with Actions enabled, and the commit author
    resolves to SSFSKIM.
  - **If it never fires by 09:50Z:**
    - the watchdog becomes primary;
    - the guard also runs from the mini as its own LaunchAgent every 10 minutes, beside the
      janitor, because the mini is always on and the MacBook is not a CI host;
    - the Hetzner token sits in a 0600 file under `~/.config/ci-kit/` on the mini;
    - the GitHub schedule stays in place.
  - **Rejected alternative:** manual dispatch only. Nobody dispatches at 3 a.m., and a box whose
    watchdog is dead bills without limit.
  - **Date/Author:** 2026-10-16, CI-opt, recorded by plan-executor.

- **Decision:** the mac lane makes the desktop deterministic before each job by putting Terminal
  in front (maws-fe's gate-offload DL 37, approved by CI-opt).
  - **What happens before a job.** If the frontmost app is Finder, the job-started hook runs
    `open -a Terminal`. This goes through LaunchServices, so there are no Apple Events and no
    Automation consent. The hook then re-reads the frontmost app with the same `lsappinfo` parse,
    polling for up to 5 seconds. If Terminal is not in front by then, the job fails fast.
  - **What does not change.** System dialogs are still refused, and the hook never tries to clear
    them. The before and after frontmost apps are logged.
  - The hook acts only before the job, so it never fights MAWS's own `MAWS_E2E_FOREGROUND=1`.
  - **Why.** Some of MAWS's paste and to-human results depend on which app is in front. When an
    e2e app quits, focus falls to Finder, so a job's outcome depended on what the last job left
    behind.
  - **Rejected alternative:** refusing to run when Finder is in front. That would fail nearly
    every job after the first e2e app quits.
  - **Date/Author:** 2026-10-16, CI-opt from maws-fe, recorded by plan-executor.

- **Decision:** only demand for the pool extends a box's life. A watched run with no pool demand
  never pins the box (CI-opt, 2026-10-16).
  - **Demand is either:**
    - a job with pool labels queued or in progress in a served repo; or
    - a recent ensure call. Ensure stamps the box with `ci-kit-want=<unix ts>`, on both its create
      and existing paths, and the agent treats now < want + 15 min as busy.
  - **Label writes.** Hetzner label updates replace the whole set. So ensure and the agent
    read-modify-write, and the agent re-reads the labels right before every write.
  - **Why.** Live, MAWS's watched gate.yml runs (116 a day across 23 hours, almost none using the
    pool) pinned a box past minute 50.
  - **Rejected alternatives:** "any watched run pins the box" (the original design), and a grace
    period after every watched run's plan job. At MAWS's rate both keep a box up nearly all day.
  - **Date/Author:** 2026-10-16, CI-opt, recorded by plan-executor.
- **Decision:** the mac lane brings Terminal to the front before a job whenever any other app is
  in front, not just Finder (CI-opt, as the lane's owner).
  - System dialogs are still refused and never touched.
  - **Why.** The mini is a CI host, and GUI e2e jobs take focus at launch anyway, so moving focus
    once before a job adds nothing new.
  - **Date/Author:** 2026-10-16, CI-opt, recorded by plan-executor.

- **Decision:** MAWS's interface to the pool does not change between backends (CI-opt's
  commitment to maws-fe, 2026-10-16). It binds any future GCE backend.
  - The runner labels stay `[self-hosted, ci-kit-pool, cpus-N]`.
  - `pool-ensure@v1` stays in MAWS's plan job, and pool.json chooses the backend. On a GCE backend,
    ensure does nothing.
  - **A GCE launcher** would be driven by the `workflow_job.queued` webhook, through the existing
    ci-kit-runners App. It creates one spot VM per queued pool job, sized from `cpus-N`:
    | label | machine |
    |---|---|
    | cpus-8 | c3d-highcpu-8 |
    | cpus-4 | c3d-highcpu-4 |
    | cpus-2 | e2-highcpu-2 |

    No new secret goes into MAWS.
  - **Rejected alternative:** a separate action and secret per backend. It puts a MAWS workflow
    change on the critical path of every backend switch.
  - **Date/Author:** 2026-10-16, CI-opt, recorded by plan-executor.

- **Decision:** the lane policy (owner, 2026-10-16). In their words: "okay 비공개만 Linux를 GCE spot,
  macOS를 mini로 돌리는것 확정".
  - **Private repos:**
    - Linux pool jobs run on GCE spot VMs (§3a).
    - macOS jobs run on the mini.
    - Light jobs (plan, ensure) stay on GitHub-hosted runners.
  - **Public repos** stay on GitHub-hosted runners only, with no overflow to self-hosted capacity.
    - Measured hosted queue waits since 10-14: cua macOS median 7 s, p90 10 s, max 47 s; cua Linux
      median 2 s; doperpowers Linux median 2 s, max 7 min.
    - A fork PR can rewrite its workflow's `runs-on` to target any registered runner label, so
      overflow would expose the mini or paid VMs to strangers.
  - **Rejected alternatives:**
    - the Hetzner pool as MAWS's lasting backend. At MAWS's measured rate of 116 gates over 23 of
      24 hours, it bills its monthly cap of €82–153;
    - overflow of public repos to GCE or the mini when concurrency is short.
  - **Date/Author:** 2026-10-16, owner, recorded by CI-opt.
- **Decision:** the GCE backend's shape (§3a, M10; CI-opt, 2026-10-16):
  - one spot VM per pool job, sized from `cpus-N`;
  - VMs run the existing pool runner image;
  - no service account on VMs;
  - a `maxRunDuration` with a `DELETE` action on every VM;
  - spot falls back to on-demand;
  - backend ownership per repo, for a staged cutover. The review revised this to one file per
    backend (below).
  - **The launcher is a one-minute Cloud Scheduler reconciler on Cloud Run, not the webhook.** This
    revises the GCE launcher line of the interface decision above (2026-10-16, CI-opt): one
    mechanism does both launch and cleanup, with no public endpoint and no change to the App's
    events. The webhook stays a fast path, added only if A13's measured latency is missed.
  - **Built in the kit rather than adopting gcrunner.** Its label grammar would change MAWS's
    workflow. Its safeguards are borrowed: the lifetime cap and the on-demand fallback.
  - **MAWS goes to the Hetzner pool first** (after PR #16's drain proof) and moves to GCE by a
    `pool.json` commit. Its hosted burn of about $13.50 a day stops in the meantime.
  - **Date/Author:** 2026-10-16, CI-opt.

- **Decision:** the GCE design after its adversarial review (2026-10-16, CI-opt; reviewer
  findings on 26ed91b, all accepted). These revise §3a, I12, M10 and A13 in place.
  - **The metadata block keeps DNS.** GCE's resolver is `169.254.169.254:53`, so only TCP 80
    there is dropped.
  - **Backend ownership is by file.** Repos move with a drain step between them. The considered
    alternative, `backend` keys inside `pool.json`, lost because today's baked agents reject
    unknown keys and would keep serving their last good config.
  - **The bake is split.** Provider-neutral cache warming takes an installation token. The GCE
    builder writes no credentials and reports through a guest attribute. Images publish only after
    `ok` and a smoke boot.
  - **The launcher is a single writer** (`max-instances=1`, `concurrency=1`). Inserts with an
    unknown outcome are reconciled through their operation before another zone is tried.
  - **VMs are named by allocation, not by job.** Demand is keyed by repo and label set, and a busy
    instance covers nothing.
  - **The lifetime claims are narrowed.** `maxRunDuration` bounds a running VM. A powered-off VM is
    the launcher's to delete. A launcher that is down is surfaced by a Monitoring alert, and a
    stopped VM then costs only its disk.
  - **Idle cleanup unregisters the runner first**, as the Hetzner reconciler does.
  - **Ledger rows are provisional before the JIT mint**, and finalized idempotently. Cleanup
    covers runners with no instance, and orphan disks.
  - **Preemption is recorded, not re-run, in this version.** Rejected: `rerun-failed-jobs`, which
    would also re-run genuine failures. A correlated, job-scoped re-run is built only if
    preemption exceeds 1% of pool jobs over two weeks.
  - **The whole budget is stated:** about $47 a month, with e2e on the mini.
  - **Date/Author:** 2026-10-16, CI-opt.

- **Decision:** the GCE design's second review round (2026-10-16, CI-opt). Eight of the ten
  findings were confirmed closed. Two stayed open, and are resolved as follows:
  - **Overlapping reconciliations.** Cloud Run can briefly exceed `max-instances`. Correctness
    does not rest on a single writer. The project's vCPU quota is GCE's atomic hard cap, every
    write is idempotent, and an over-launch is a few idle VMs that the idle rule removes.
    Rejected: a GCS lease, coordination machinery for an outcome that is already bounded and
    heals itself.
  - **Moving between backends.** The move is a six-step protocol with checks. The Hetzner agent
    gains draining for unserved repos and a `ci-kit-config` label, re-baked before the first move.
    Ensure wakes a box only for `pool.json` repos.
  - **Date/Author:** 2026-10-16, CI-opt.

- **Decision:** M3's resolutions (doperpowers#198).
  - **Gates.**
    - A `repo-checks` gate runs the hygiene suites; §5's table doesn't list it.
    - The claude-code gate runs its four hermetic files directly.
    - sminos splits as `core` and `suites` through `SMINOS_PART`. After DC7 merged, editing the
      runner was allowed.
    - No gate needs `fetch_depth`, because v1 fetches the change basis itself.
  - **Waits.** One 30 s liveness ceiling applies everywhere. The one remaining 2 s clock wait,
    `seen_waiting` in bridge-requests, has no product event to wait on, and its owner declined
    to add one.
  - **"Fails before" proofs at 8×.** Watcher-vs-retire and the daemons' delivery and nudge cases
    never failed at 2×, so their before-fix failures are shown at 8×. All pass 20/20 after at
    both 2× and 8×.
  - **Left in TECH-DEBT** as candidates for a pinned-core `perf` gate: two speed claims owned by
    DC4 and DC7 that only 8× breaks. They are test-uplink "within a second while the fetch hangs"
    (17/20) and test_session_plane "presence within a second" (8/20).
  - **Date/Author:** 2026-10-16, M3 executor, folded by plan-executor.

- **Decision (supersedes the mini-guard entry withdrawn the same day):** the GitHub schedule
  failed its window, firing 1 of about 36 expected runs between 03:49:48Z and 09:50Z.
  - For the Hetzner interim, the on-box watchdog is primary, the GitHub schedule stays as best
    effort, and `docs/pool.md` documents manual dispatch.
  - GCE replaces the guard's role with its Cloud Scheduler reconciler.
  - What the guard alone covers is small:
    - a box whose kernel or network is dead while its watchdog cannot act;
    - a pool job stranded by the ensure/drain race. At MAWS's rate, the next run's ensure creates
      a box within about 12 minutes.
  - **Rejected:** a guard LaunchAgent on the mini. It would put the Hetzner token and a GitHub
    credential on a CI host, under the user that runs the CI jobs, for a backend that retires
    within days.
  - **Date/Author:** 2026-10-16, CI-opt, recorded by plan-executor.

- **Decision (PR #17 review):** ensure fails when main's pool.json was fetched but its repo list
  cannot be read. It exits with an error and makes no change to Hetzner.
  - It does not answer `result=none` with a warning, as CI-opt's note first proposed. A config that
    parses but has no readable repos is a kit bug. An error turns the plan job red and puts the
    cause in its log. `none` would leave the pool jobs queued with nothing saying why.
  - Repo membership is read apart from the operational schema (`kitRepos`), so main's list counts
    even when the bundled parser rejects main's copy.
  - The bundled copy is used only when main cannot be reached. A 404 means the repo is in no list.
  - The token is required only once the repo resolves to Hetzner; gce.json is checked first.
  - **Date/Author:** 2026-10-16, task-executor, confirmed by CI-opt, recorded by plan-executor.

## Outcomes & Retrospective

Pending — written at finish.
