# Mac lane concurrency

## Purpose

On 2026-10-21 the owner ruled that maximizing CI parallelism, so CI is never the bottleneck, is the top priority. Cost
is no reason to lower it. The owner also observed that the Mac mini's CPU sits mostly idle, and directed that MAWS run
its e2e there. Today the mac lane runs one job per machine:
- **The queue.** On 10-20 the mini ran 178 jobs. The median wait was 9.5 min and the p90 39.7 min, and in landing hours
  the mini was busy 78% of the time. Cross-set queueing was 68% of the wait.
- **The load.** The 1-minute load mostly stays at 2–6 on 10 cores.

The one-job rule (`docs/mac-lane.md`, "Why one runner per machine") exists because e2e groups share one desktop: focus,
pointer and pasteboard. This initiative runs two jobs at a time on the mini. A desktop lease keeps every job that needs
the desktop, or a quiet machine, alone. Everything else runs beside another job.

It serves the people building MAWS: the sessions and children whose Mac sets wait in that queue. What it enables is
roughly twice the Mac lane's throughput without a second Mac.

### What it must not be

- **No result changes because of a neighbour.** A group runs beside another only once a trial has shown its results
  match its solo runs. Anything unproven runs alone.
- **Measured and foreground groups never share the desktop.** Measured groups are timing-bounded (MAWS `MEASURED_E2E`);
  foreground groups are the ones whose cases test the app in front. The lease, not the settle step, is what
  guarantees this (settle checks at start and holds nothing).
- **The mini's other users keep what they have.** GUI holds, the quiet flag, the dialog watcher, the owner's own use
  and other sessions' bookings work as today, over every runner of the machine.
- **No VM.** The Tart spike (10-21) was put on hold by the owner; this uses the host's own GUI session.

## Glossary

- **Instance.** One runner of the lane on a machine: its directory, LaunchAgent, runner name and labels.
- **The exclusive instance.** Instance 1, today's `ci-kit-mac-<machine>` in `~/actions-runner-maws`, with today's
  labels. Every job it runs runs alone on the desktop.
- **A shared instance.** Instance *n* ≥ 2. It carries only `self-hosted` and `ci-kit-mac-shared`, so only a job that
  asks for `ci-kit-mac-shared` can reach it. Shared instances run beside each other, never beside an exclusive job.
- **The shared hold.** The marker that stops the shared instances while an exclusive job runs or waits.
- **Proven-shared group.** A group whose trial evidence (M4) shows its results unchanged beside neighbours. Only these
  ask for `ci-kit-mac-shared`.

## Progress

- [x] (2026-10-21 09:5xZ) Read-only audit of every MAWS Mac group (local: `~/Developer/ci-analysis/mac-concurrency-audit.md`
  on the MacBook; MAWS is private, so this spec carries its conclusions, not its line references).
- [x] (2026-10-21 10:2xZ) Adversarial review of the first draft (a reader-writer lease taken in hooks): six P1s and two
  P2s, all taken; the design below replaces it (Decision Log).
- [ ] M1 — ci-kit: instances, the shared hold, per-instance hooks.
- [ ] M2 — MAWS: the shared-state fixes and the routing of proven-shared groups.
- [ ] M3 — Install on the mini: one exclusive and two shared instances, shared ones disabled.
- [ ] M4 — Trial and the first proven-shared groups.
- [ ] M5 — Widen the proven-shared set.
- [ ] M6 — A third shared instance (only if memory allows).

## Design

**Admission is by labels, and fails closed.** Which jobs may share the desktop is decided before any runner accepts a
job, by the labels a job asks for:
- The exclusive instance keeps today's labels (`self-hosted`, `macOS`, `ARM64`, `ci-kit-mac`). So every job that
  exists today reaches only it and runs alone: an old commit's workflow, a rerun, a new group nobody classified, a
  measured or foreground group.
- A shared instance has only `self-hosted` and `ci-kit-mac-shared`. A job reaches it only if its workflow names
  `ci-kit-mac-shared`, which MAWS does for proven-shared groups alone (M2, M4).
- The first draft's alternative failed review: every job took a shared lease in its hook, and exclusive groups
  upgraded in a step. An old workflow, or a group nobody listed, then ran shared. And the runner prepares a job (its
  workspace, action downloads) before any hook runs, so a lease taken in a hook could not keep a neighbour's
  preparation out of a measured job.

**An exclusive job stops the shared instances first.** The exclusive instance's job-started hook, before its desktop
check:
1. **Raises the shared hold.** Each shared instance's LaunchAgent wrapper (`runner-hold.sh`) waits while the hold is
   up, and each shared instance's job-completed drain stops its runner at its job's end. This is the dialog drain's
   existing mechanism, applied per instance: the stop lands between jobs, never inside one.
2. **Waits until every shared instance is stopped.** Stopped means its listener is down, read the way the drain reads
   idle. A shared instance that is idle is stopped on two matching idle reads, as the drain does today. The wait is
   bounded (20 min, an input); past it, the hook drops the hold and refuses the job with a `ci-kit: … rerun` line.
3. **Sweeps every shared instance's `_work`.** They are stopped, so anything left there is a crashed job's.
4. Runs today's start: the dialog check, Terminal to the front, the cursor park, its own sweep.

The exclusive job therefore starts on a desktop with no neighbour and no neighbour's leftovers, and none can arrive
until it ends. Its job-completed hook first sweeps its own `_work`, then drops the hold. A measured job's `settle` now
reads a desktop that stays as it read.

**Shared instances.** A shared instance's hooks are today's: the dialog check, Terminal to the front (harmless to
proven-shared groups, which do not need key), the cursor park, and the sweep of its own `_work`. A shared job never
waits for a lease. Two shared jobs simply run.

**Per-instance identity.**
- Every hook acts on the instance that runs it, never on a path derived from where the hook file lives. The sweep, the
  drain and the job-end stop each take the instance's root from the runner's own environment or from a per-instance
  copy of the hooks.
- `runner-state.py` reads each instance by its own `bin/Runner.Worker` path and its own `_diag`.
- Uninstall, the dialog watcher's drain (a dialog holds every instance) and a human's hold cover every instance.
- The coordinator's scripts (`hold-now.sh` and the release command) boot out and bring back every instance.

**Recovery.**
- The shared hold and its transitions are guarded by a kernel-released lock (Perl's `flock`, as `dialog.sh` uses), so
  a process killed mid-transition leaves no lock behind.
- The hold names the exclusive job (run id, job id, the instance's `Runner.Worker` start time) so PID reuse or a reboot
  cannot pass for it.
- **A crashed exclusive job.** The dialog watcher, which already reads the runner every minute, reconciles: when the
  hold names a job and the exclusive instance has had no `Runner.Worker` for two matching reads, it sweeps that
  instance's `_work` and drops the hold. A hold whose sweep fails stays up, the shared instances stay stopped, and the
  watcher logs and alerts, the lane falling back to one job at a time rather than admitting a neighbour.
- **After a reboot.** Every wrapper starts by RunAtLoad and waits on its markers. The watcher reconciles as above.

**Time budgets.** Only exclusive jobs wait (at most the 20-minute bound); a refusal comes before GitHub's timeout. MAWS
adds that bound to its exclusive Mac jobs' `timeout-minutes` (30 → 50, measured 45 → 65). Shared jobs keep theirs.

**MAWS's shared state** (M2; the audit's hazards). All of these matter only between shared jobs:
- **The e2e build cache** becomes one directory per instance (`…/maws-e2e-build/$RUNNER_NAME`). Two jobs on one
  variant otherwise race its restore, store and prune.
- **The clipboard lock** moves from `os.tmpdir()` to a fixed machine-wide path, so it holds across instances.
- **Each instance's windows open at their own origin.** A covered window's child WebContentsViews stop drawing.
- **The shared-desktop flag.** Shared instances set `CI_KIT_SHARED_DESKTOP=1` in their runner environment, and MAWS's
  load-aware latency budgets treat the host as loaded under it. The raw bounds the audit names go through that budget.
- **Later, for the groups that need them (M5):**
  - a lock around the recorded `/private/tmp` repo directories;
  - focus calls that do not activate the app under quiet e2e;
  - the dashboard clipboard steps inside the lock.

**Which groups become proven-shared** (M4). A group is proven-shared only with evidence, from paired runs at one sha
whose test intervals actually overlapped (read from the job logs), each compared against solo runs of the same groups
at that sha:
- beside itself;
- beside a heavy neighbour (`unit:darwin`, `terminal`'s flood);
- beside another clipboard user, if it uses the pasteboard (for example `browser` with `panel`);
- through its own named risk, if the audit gave one: presentations' display-sized window, connectors-direct's restore,
  browser's occluded tab views, settings' pixel shots.

**What fails a pair:**
- a red the solo control lacks;
- an action stuck waiting for stability, or a stalled screenshot;
- a visibility read of hidden in a scene that showed its window;
- an Electron app frontmost in the 1 Hz `lsappinfo front` log;
- a clipboard lock timeout;
- a failed cache restore;
- a timing annotation outside its solo spread.

`unit:darwin` is first in line: it uses no desktop, its shared state is temporary directories, and the measured groups
it must never meet now run only on the exclusive instance.

**Memory.** The mini has 16 GB, most of it used by the owner's sessions. Two shared jobs fit by estimate. A sampler
records memory pressure, swap and free memory through M4. A third shared instance (M6) needs no pressure above level 1
and no swap growth in M4's reads, and its own trial: three-way overlaps of proven-shared groups, judged by the same
fail rules.

## Plan of Work

### M1 — ci-kit: instances, the shared hold, per-instance hooks

At the end, `mac/install.sh` installs one exclusive instance and *n* shared ones. `--shared <n>` sets the count.
Without it, a re-run keeps the machine's installed count, and a fresh machine gets 0, so sharing is always opted into
and a plain refresh never re-enables a shared instance. The shared hold, its recovery and per-instance hooks exist. Nothing on the mini
changes in M1.
- **`mac/install.sh`:**
  - shared instances at `~/actions-runner-maws-<n>`, LaunchAgent `com.ssfskim.ci-kit.mac-runner-<n>`, runner name
    `ci-kit-mac-<machine>-<n>`, labels `self-hosted,ci-kit-mac-shared` only (`--no-default-labels`);
  - `CI_KIT_SHARED_DESKTOP=1` in their `.env`;
  - a full copy of the hooks per instance, under that instance's directory (the sweep finds its `_work` from its own
    location);
  - `--disabled` applies per instance;
  - uninstall removes every instance.
- **The hooks:** per-instance identity everywhere. The exclusive instance's start raises and waits on the hold; its end
  drops it. The shared instances' wrappers and job-end drains honour it.
- **`runner-state.py`:** reads any instance.
- **The dialog watcher:** holds every instance on a dialog, and reconciles a crashed exclusive job's hold.
- **`docs/mac-lane.md`:** the instances, the shared hold, the labels, and what a calling repo does to opt a group in.
- **Tests,** with fakes as the existing hook tests do:
  - an exclusive start waiting for a busy shared instance and admitted after its job-end stop;
  - an idle shared instance stopped on two matching reads;
  - the bound's refusal;
  - two shared instances held at once;
  - a crashed exclusive job reconciled, and a failed sweep keeping the hold;
  - a process killed mid-transition leaving no lock;
  - a reboot (markers on disk, wrappers started fresh);
  - each instance's sweep killing only its own leftovers while the other instance's job runs;
  - an install with no shared instances behaving exactly as today.

Proof:
- `npm test` and `ci-gate` green, and `doperpowers:reviewer-medium` on the PR.
- Merge, and move `v1` by the PATCH rule.
- Then reinstall on the mini with no shared instances, at idle, outside any hold; one Mac set there stays green. This
  ships the new hooks before any concurrency.

### M2 — MAWS: the shared-state fixes and the routing

At the end:
- MAWS's plan can send a named list of groups (`MAC_SHARED_E2E`, empty at first) to `[self-hosted, ci-kit-mac-shared]`,
  and every other Mac job to today's labels;
- exclusive Mac jobs' timeouts carry the 20-minute bound;
- the e2e build cache is per runner, and the clipboard lock path is machine-wide;
- windows open at a per-instance origin, and the budgets read `CI_KIT_SHARED_DESKTOP`.

With the list empty, nothing behaves differently.

Proof: class 1a on the pool green; one Mac set at the head green (scheduled through CI-opt, never inside a hold); the
PR goes to the MAWS architect, who lands it.

### M3 — Install the shared instances on the mini

After M1 and M2 land, outside any hold or measured window:
- reinstall with `--shared 2 --disabled` for the shared ones, at idle;
- check that both shared runners register with only their two labels, that their `$TMPDIR` equals the exclusive
  instance's, and that each has its own `_work`;
- update the coordinator's hold and release scripts;
- tell every session that books the mini.

The shared instances are enabled only for trial runs until M4's verdict.

### M4 — Trial and the first proven-shared groups

In a window agreed with the MAWS architect, quiet flag down, nothing else of anyone's on the mini:
1. `unit:darwin` beside itself and beside a quiet group.
2. The audit's first pair, `browser` with `connectors`.
3. Then the frequent quiet groups, each through Design's evidence list.

Run scratch MAWS commits that put the groups under trial on `MAC_SHARED_E2E` (never merged as such).
- Record every run's id, its partner, the overlap, the front-app log and the memory samples in Surprises.
- **Verdict:**
  - a MAWS PR sets `MAC_SHARED_E2E` to the groups that passed;
  - the shared instances are enabled for good;
  - the rest stay on the exclusive instance, with the evidence.

### M5 — Widen the proven-shared set

The MAWS fixes for the groups the audit found unsafe without a change:
- the recorded-directory lock;
- the dashboard clipboard steps;
- deliverables' notification focus;
- the quiet-focus helper where a trial showed activation.

Each group joins `MAC_SHARED_E2E` only through M4's evidence.

### M6 — A third shared instance

Only if M4's and M5's memory reads show room: install it, and run the three-way trial in Design.

## Verification

- Spec: one `doperpowers:adversarial-reviewer` round, done; a second, on this revision, before M1's PR is reviewed.
- M1: `doperpowers:reviewer-medium`, ci-gate, and the one-instance reinstall on the mini staying green.
- M2, M5: the MAWS architect lands each, on a green class 1a and a green Mac set.
- M4: Design's evidence and fail rules, checked by the spec's owner against the run logs.

## Decision Log

- 2026-10-21: **Lease on the host, not VMs or a second Mac.** The owner ruled for parallelism and pointed at the
  mini's idle CPU. A second Mac was declined on 10-21's measurement, and the Tart VM runner was put on hold by the
  owner after the spike: 1.3–1.7× slower e2e, and a display-geometry difference that failed a case. The host lease
  keeps the calibrated desktop and costs nothing new.
- 2026-10-21 (review of the first draft, all taken): **labels and a shared hold replace the reader-writer lease.**
  The adversarial review (astra) found six P1s in the lease taken by hooks:
  1. Admission was not fail-closed: old workflows and unlisted groups ran shared.
  2. The runner prepares a job before its hook, so a hook-held lease admitted neighbours' preparation into a measured
     job.
  3. One shared hook copy swept the wrong instance's `_work`.
  4. Waiters and the mutex had no crash recovery.
  5. A dead worker's leftovers were admitted beside the next holder.
  6. An upgraded job inherited a desktop its own start had not checked.

  It also found two P2s: the trial authorized combinations it never ran, and the waits exceeded MAWS's job timeouts.
  Labels make admission fail closed before any runner accepts a job. Stopping the shared instances' listeners keeps
  their preparation out. Per-instance identity, sweep-before-release, a reconciling watcher, a kernel-released lock,
  and the desktop check after the neighbours stop answer the rest. Evidence per group, and a timeout raise, answer the
  P2s. The cost: an exclusive job waits for running shared jobs to end (bounded), and the exclusive instance serves no
  shared job.
- 2026-10-21: **`tool-time-heavy-live` stays exclusive** while it is in `MEASURED_E2E`, though its code is safe beside
  others. Dropping it from that list is MAWS's call.

## Surprises & Discoveries

(As found.)

## Outcomes & Retrospective

(At completion.)
