# ci-kit — gates off the MacBook, for every repo — living spec

**Date.** 2026-10-15. **Status.** Reviewed; executing (plan-executor, from 2026-10-15).
**Home.** `SSFSKIM/ci-kit` (public); this file is `docs/doperpowers/specs/2026-10-15-ci-kit-design.md`.
**Design history.** Brainstormed on 2026-10-15 in the doperpowers session named "CI-opt", from
three peer sessions' bottleneck reports, a mining of 4,021 session transcripts (09-22..10-15),
GitHub Actions run data for MAWS, and measurements of both Macs. The human approved the design with
the Hetzner on-demand pool, over GCE spot VMs and Namespace. The working evidence was gathered under
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
  - MAWS's Linux gates run on a 16-vCPU Hetzner server that exists only while gates run.
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
- [ ] M1 — Kit core: config, planner, reusable workflow, `ci-gate`, the kit's own CI
- [ ] M2 — cua: adoption and timing-test stabilization
- [ ] M3 — doperpowers: adoption and timing-test stabilization
- [x] (2026-10-15 22:10Z) M4 — Spike: the pool's boot path. Verdict ≤ 5 min; PR #1 merged
  (spike scripts and results under `spike/pool-boot/`).
- [ ] M5 — The pool
- [ ] M6 — The mac lane on the mini
- [ ] M7 — MAWS: evidence and proposals for maws-fe
- [ ] M8 — Host janitor
- [ ] M9 — Acceptance

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

## Design

### Terms

- **Gate.** One named check a repo runs: a shell command with a lane and a timeout, such as `unit`
  or `lint`.
- **Lane.** Where a gate runs.
  - `hosted`: GitHub's `ubuntu-latest`.
  - `hosted-macos`: GitHub's `macos-latest`. Free on public repos.
  - `pool`: the Hetzner box. Private repos only.
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

Snapshots add about €0.30 a month. MAWS's plan jobs on hosted runners add about 1 minute per run,
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

- **Lanes.** Gates on `hosted` and `hosted-macos`, per what the hosted-runner probe found. The
  probe was still running at authoring; its result is folded into M2 before M2 starts.
- **Node.** One Node version in CI, the one that runs the most tests (≥ 24, which the own-host
  tests need). The double local run (Node 22 + 26) is cua's to retire.
- **Live checks stay local.** Live-evidence checks (`verify.mjs`, `accept-native`, `accept-chrome`)
  need the real `$CUA_HOME`, a native helper and the GUI. They are not CI gates.
- **Coordination.** cua_repl is mid-work on the same test files (its M4, own REPL host). The
  executor asks it, through this session, which files are in flight before touching tests.

**doperpowers** (M3):

- **Gates.** One gate per suite family that runs without model calls:
  - shell-lint, over the committed shell files changed relative to the base, passed to
    `scripts/lint-shell.sh` as file arguments. Run bare, the script lints only uncommitted changes,
    so on a clean checkout it lints nothing. `--all` is used instead if the tracked baseline is
    clean;
  - sminos (`tests/sminos/run-sminos-tests.sh`);
  - issue-tracker suites;
  - mods (`tests/mods/run-mods-tests.sh`), if `claude plugin test` runs on a hosted runner without
    credentials.

  Each gate has `paths` set to its area. The probe settles each family's portability.
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
- **P7 — Retire the load rule for gates.** Retire `waitload20.sh` and `with-slot.sh` for every gate
  P4's inventory moved off the MacBook. They stay for anything the inventory names as staying local.

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
    - watcher finalize-vs-retire.

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

**Interfaces.** Consumes I1, I2 and I5.

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
- `codex-companion`'s `pkill -f` cleanup is scoped to its own run, since CI and local runs must not
  kill each other's processes.
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
  - `electron` with a worktree path in its arguments;
  - `fake-upstream-process.mjs`;
  - sminos test stand-in supervisors;
  - `codex-plugin-test-`.

  Each pattern is a regex over the full command line. The exclusion patterns of §7 are checked
  after the kill patterns, and an exclusion always wins.
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
- `v1` points at the final `main`.
- Outcomes & Retrospective is written, including:
  - the cost projection (A12);
  - A9's state;
  - the owner actions left (cmux update; the GitHub App, if it was escalated).

**What it touches.** This spec, and nothing else beyond fixes that acceptance exposes.

**What it proves.** A1–A12.

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
gh run view <id> -R SSFSKIM/MAWS --json jobs --jq '.jobs[]|[.name,.runnerName]|@tsv'
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

`repos[].workflows` lists the watched workflows (§3, Idle). MAWS's entry,
`{"repo":"SSFSKIM/MAWS","workflows":["gate.yml"]}`, is added when maws-fe adopts P1.

```json
{"repos":[{"repo":"SSFSKIM/ci-kit-sandbox","workflows":["ci.yml","maws-probe.yml"]}],
 "types":["cx53","cpx62"],"locations":["hel1","fsn1","nbg1"],
 "poll_seconds":10,"idle_runner_minutes":10,"drain_minute":50,
 "memory_gb_per_cpu":2,"max_hours_per_day":8,
 "ledger":{"repo":"SSFSKIM/ci-kit-sandbox","issue_title":"pool ledger"}}
```

Secrets go beside it as `/etc/ci-kit/app.pem`, `/etc/ci-kit/app_id` and `/etc/ci-kit/hcloud_token`.

**I9 — Ledger rows.** One comment per server session on the ledger issue, in this form:

```
| server id | created (UTC) | deleted (UTC) | type@location | billed h | € | jobs | end |
```

- `end` is one of `idle`, `stale-heartbeat`, `watchdog`, `max-uptime` or `manual`.
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

**External dependencies.**

| Dependency | Use |
|---|---|
| GitHub Actions | hosted runners; reusable workflows; JIT runner API; Actions REST for runs and jobs |
| `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` | latest major versions |
| GitHub's `actions-runner` container image | pinned by digest in `pool/image/Dockerfile` |
| Hetzner Cloud API v1 | `servers`, `images`, `firewalls`, `server_types`. The `datacenters` endpoint was removed on 2026-06-02; availability is read from `server_types[].locations[].available` |
| `yaml` (npm) | the planner's YAML parser |
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

## Outcomes & Retrospective

Pending — written at finish.
