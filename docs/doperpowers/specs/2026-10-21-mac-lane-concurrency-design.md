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
- **A shared instance.** Instance *n* ≥ 2. It carries only `ci-kit-mac-shared`, so only a job that asks for that label
  can reach it. Shared instances run beside each other, never beside an exclusive job.
- **The shared hold.** The marker an exclusive job raises while it waits or runs. While it is up, no shared job gets
  past its job-started hook.
- **A running marker.** The file a shared job writes when its hook admits it and removes at its end. It names the job's
  run id, job id and `Runner.Worker` (pid and start time).
- **Proven-shared group.** A group whose trial evidence (M4) shows its results unchanged beside neighbours. Only these
  ask for `ci-kit-mac-shared`.

## Progress

- [x] (2026-10-21 09:5xZ) Read-only audit of every MAWS Mac group (local: `~/Developer/ci-analysis/mac-concurrency-audit.md`
  on the MacBook; MAWS is private, so this spec carries its conclusions, not its line references).
- [x] (2026-10-21 10:2xZ) Adversarial review of the first draft (a reader-writer lease taken in hooks): six P1s and two
  P2s, all taken; the design below replaces it (Decision Log).
- [x] (2026-10-21 ~10:1xZ) Second adversarial review (astra), of the second draft (shared listeners stopped by a
  wrapper hold and a drain): two P1s and two P2s, all taken; admission moved into the hooks under one lock (Decision
  Log).
- [x] (2026-10-21 ~10:2xZ) Third adversarial review (astra), of the lock: two P1s and one P2, all taken (Decision
  Log).
- [x] (2026-10-21 ~12:2xZ) M1 — ci-kit: instances, admission in the hooks, per-instance identity. ci-kit #67 merged
  fcb538a (reviewer-medium, reviewer-high, and a delta review; every finding fixed; ci-gate 39594858245); `v1` moved.
  Its reinstall on the mini, with no shared instance, waits for an idle moment after the 10-21 evening hold and #103's
  Mac set.
- [ ] M2 — MAWS: the shared-state fixes and the routing of proven-shared groups. MAWS #103 open (head 7554ba433,
  class 1a 39589318188 green); its Mac set runs after the 10-21 evening hold.
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
- A shared instance has only `ci-kit-mac-shared` (`--no-default-labels`, so not even `self-hosted`). A job reaches it
  only if it asks for that label alone, which MAWS does for proven-shared groups (M2, M4). A bare `runs-on:
  self-hosted` cannot reach it.
- The first draft's alternative failed review: every job took a shared lease in its hook, and exclusive groups
  upgraded in a step. An old workflow, or a group nobody listed, then ran shared.

**Admission happens in the job-started hooks, under one lock.** One machine-wide lock file, taken with Perl's `flock`
(kernel-released, as `dialog.sh` uses), guards the shared hold and the running markers. Each side checks and writes
while holding it, so no check can be overtaken between its read and its write.
- **A shared job's start.** It takes the lock. If neither the shared hold nor the dialog drain's marker
  (`runner-drained`) is up, it writes its running marker, releases the lock, and runs today's start. Otherwise it
  releases the lock and retries about once a second. The job is parked in its hook and has run no step. Past the
  shared wait bound (60 min, an input), it refuses with a `ci-kit: … rerun` line naming the hold.
- **A shared job's end.** It sweeps its own instance, then removes its marker under the lock.
- **An exclusive job's start,** before its desktop check:
  1. It raises the hold under the lock, naming its run id, job id and `Runner.Worker` (pid and start time). From then
     on no shared job is admitted, so a waiting exclusive job cannot be starved.
  2. It waits until no live running marker remains. A marker whose `Runner.Worker` is gone (pid and start time) is
     stale. The wait is bounded (10 min, an input); past it, the hook refuses with a rerun line and keeps the hold
     until its end hook.
  3. It sweeps what finished or dead shared jobs left running. Every live shared `Runner.Worker` and its descendants
     are spared: by then each is parked, or in its end hook after its own sweep. A hook runs as a child of its worker,
     with its working directory in the job's workspace, so the sweep would otherwise select a parked hook. Everything
     else under a shared `_work` is a finished or dead job's.
  4. It runs today's start: the dialog check, Terminal to the front, the cursor park, its own sweep.
- **An exclusive job's end.** It sweeps its own instance, then drops the hold. A failed own sweep keeps the hold up
  for the watcher's reconcile (Recovery).

**A refusal is not an abort, so a claim lasts to the job's end.** A job-started hook that fails only fails its step.
Later steps conditioned on `failure()`, `always()`, `!cancelled()` or `cancelled()` still run (actions/runner
v2.338.0, `ScriptHandler.cs` and `StepsRunner.cs`). So:
- A start refused after admission keeps its claim (a shared job its marker, an exclusive job the hold) until its end
  hook releases it. A refusal can come from the dialog check, Terminal, the sweep, or the exclusive wait bound.
- A shared job refused at its bound holds no claim. Its post-refusal steps can run beside the exclusive job.
- The lane's contract therefore covers steps that can run after a failed start: they must not use the desktop.
  `docs/mac-lane.md` states it, and MAWS pins it with a test over its Mac jobs (M2). Today those steps are artifact
  uploads, or are gated on a step that runs only after admission.

The exclusive job starts on a desktop where no neighbour runs a step and none has left anything running, and no
neighbour can start one until it ends. A measured job's `settle` reads a desktop that stays as it read, apart from
the bounded preparation below.

**No listener is stopped for an exclusive job.** The second draft stopped the shared instances' listeners: a hold in
their LaunchAgent wrapper and a drain at each job's end. Its second review showed that stop cannot be made safe:
- A wrapper can pass its check, stall, and start its listener after the exclusive hook has read it as stopped.
- The drain's SIGTERM can land after the listener has accepted its next job. `mac/hooks/dialog-watch.sh` already
  records the result: a job left in progress on an offline runner, or a cancelled one.

**The cost:** a shared job can be assigned while an exclusive job runs. Its preparation then happens beside the
exclusive job, before it parks:
- **Typically:** on the mini that preparation (`Set up job`) is 3–4 s of light disk and network work, once per shared
  instance per exclusive job.
- **It can recur.** A preparation that fails ends its job without reaching the hook, which frees the listener for
  the next queued shared job. A parked job that is cancelled frees it too. Action downloads retry up to three times,
  20 minutes each (actions/runner `ActionManager.cs`, `JobRunner.cs`).
- **What M4 must show.** Round one's objection to hooks, that a neighbour's preparation reaches a measured job, is
  therefore real but unbounded in its failure cases. M4 tests it: measured groups beside cold preparation, a download
  failure, and a cancel-and-replace burst, each inside its solo spread.
- **If M4 cannot show that,** shared instances are not enabled while measured groups can run. Sharing then waits for
  a design that isolates before setup.

**Shared instances.** A shared instance's start, once admitted, is today's: the dialog check, Terminal to the front
(harmless to proven-shared groups, which do not need key), the cursor park, and the sweep of its own `_work`. Two
shared jobs simply run.

**Per-instance identity.**
- Every hook acts on the instance that runs it, never on a path derived from where the hook file lives. The sweep, the
  drain and the running markers each take the instance's root from the runner's own environment or from a per-instance
  copy of the hooks.
- `runner-state.py` reads each instance by its own `bin/Runner.Worker` path and its own `_diag`.
- Uninstall, the dialog watcher's drain and a human's hold cover every instance. A shared job is not admitted while
  the drain's marker is up. The shared hold keeps one owner, the exclusive job.
- The coordinator's scripts (`hold-now.sh` and the release command) boot out and bring back every instance, restoring
  each shared instance's enabled state as it was.

**Recovery.**
- A process killed while it holds the lock leaves no lock behind (`flock` is released by the kernel).
- The hold and every running marker name a `Runner.Worker` by pid and start time, so PID reuse or a reboot cannot pass
  for one.
- **A dead shared job.** Its marker is stale and admits nothing. The exclusive start sweeps what it left running.
- **Every sweep spares every live `Runner.Worker` tree,** of any instance, taken from the sweep's own process
  snapshot. That covers the exclusive start's sweep and the reconcile's.
- **A crashed exclusive job.** Two matching idle reads do not reserve the exclusive instance, whose listener can start
  the next job at any moment. So recovery runs under the admission lock: it revalidates that the hold's owner is dead,
  sweeps, and drops the hold. A new exclusive job cannot pass admission meanwhile, and the sweep spares its live
  worker.
  - An exclusive start that finds a stale hold reconciles it itself, under the lock, then raises its own.
  - The dialog watcher, which already reads the runner every minute, reconciles a stale hold when no new exclusive job
    comes.
  - A hold whose sweep fails stays up, and the shared jobs stay parked. The watcher
  logs it and opens one alert issue (`ci-kit alert: shared hold stuck on <machine> since <minute> …`, a title outside
  MAWS's dialog-alert pattern), which it closes once no hold is up. Rather than admit a neighbour, the lane falls back
  to one job at a time.
- **After a reboot.** No `Runner.Worker` survives, so every marker is stale. The watcher reconciles the hold as above.

**Time budgets.**
- **An exclusive job** waits at most the 10-minute bound (`CI_KIT_EXCLUSIVE_WAIT`), and is refused before GitHub's
  timeout. Proven-shared groups are short: M4 admits no group whose p95 job time exceeds 8 minutes. So the bound is
  rarely reached.
- **MAWS adds the bound** to its exclusive Mac jobs' `timeout-minutes`: 30 → 40, measured 45 → 55.
- **An old commit's workflow** keeps its old timeout and still fits. Successful Mac jobs 10-19 to 10-21: the longest
  functional job is `e2e:default` at 13.8 min of its 30, and the longest measured job `e2e:document-scale` at 12.3 of
  45. After a full 10-minute wait, the first still has 6 minutes to spare and the second 23.
- **A shared job** parks for at most one exclusive job at a time. When a hold drops, a parked job, retrying each
  second, is admitted before the next exclusive job's preparation reaches its hook. Its parked time counts against
  its timeout, so MAWS gives shared jobs their own budget plus the 60-minute shared bound (`CI_KIT_SHARED_WAIT`).
  Both bounds are read from the runner's environment, which an instance's `.env` can set.

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
- its p95 job time at most 8 minutes, so an exclusive job's 10-minute wait for it fits (Time budgets).

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

### M1 — ci-kit: instances, admission in the hooks, per-instance identity

At the end, `mac/install.sh` installs one exclusive instance and *n* shared ones. `--shared <n>` sets the count.
Without it, a re-run keeps the machine's installed count, and a fresh machine gets 0, so sharing is always opted into.
Each shared instance keeps the enabled state launchd has for it, and a new one starts disabled, so a plain refresh
never turns one on or off. The admission lock, the hold, the running markers, their recovery and per-instance hooks
exist. Nothing on the mini changes in M1.
- **`mac/install.sh`:**
  - shared instances at `~/actions-runner-maws-<n>`, LaunchAgent `com.ssfskim.ci-kit.mac-runner-<n>`, runner name
    `ci-kit-mac-<machine>-<n>`, the label `ci-kit-mac-shared` only (`--no-default-labels`);
  - `CI_KIT_SHARED_DESKTOP=1` in their `.env`;
  - a full copy of the hooks per instance, under that instance's directory (the sweep finds its `_work` from its own
    location);
  - `--disabled` disables every instance, for a new machine. Without it, the exclusive instance is enabled as today.
    Each shared instance keeps its state; a read of that state that fails counts as disabled;
  - uninstall removes every instance.
- **The hooks:** per-instance identity everywhere. Admission works as Design describes: the lock, the shared start
  parked on the hold or the drain marker, the exclusive start raising the hold and waiting on live markers, the sweep
  that spares live shared workers, and the bounds from `CI_KIT_EXCLUSIVE_WAIT` and `CI_KIT_SHARED_WAIT`. With no shared
  directory on the machine, the hooks behave exactly as today, with no marker and no extra log line. `runner-hold.sh`
  and the drain stay as today.
- **`runner-state.py`:** reads any instance.
- **The dialog watcher:**
  - drains every instance on a dialog;
  - reconciles a crashed exclusive job's hold;
  - opens and closes the stuck-hold alert.
- **`docs/mac-lane.md`:** the instances, admission, the labels, and what a calling repo does to opt a group in.
- **Tests,** with fakes as the existing hook tests do:
  - the second review's interleaving: a shared start holding the lock between its check and its marker write blocks
    the exclusive raise;
  - a shared job parked while the hold is up, and admitted after the drop;
  - a shared job parked while the drain marker is up;
  - an exclusive start waiting on a live marker, and admitted after that job's end;
  - a dead shared worker's marker read as stale, and its leftovers swept while another shared job is parked and
    spared;
  - both bounds' refusals;
  - a crashed exclusive job reconciled, and a failed sweep keeping the hold, with the alert opened and closed;
  - the third review's interleaving: second idle read, then the next exclusive worker starts, then the recovery sweep.
    The new worker and its hook survive;
  - a start refused after admission, and an exclusive bound refusal, each keeping its claim until its end hook;
  - a process killed while holding the lock, leaving no lock;
  - a reboot (markers on disk, no workers alive);
  - each instance's sweep killing only its own leftovers while the other instance's job runs;
  - the install's label sets: neither today's tuples nor a bare `self-hosted` can match a shared instance;
  - an install with no shared instances behaving exactly as today.

Proof:
- `npm test` and `ci-gate` green, and `doperpowers:reviewer-medium` on the PR.
- Merge, and move `v1` by the PATCH rule.
- Then reinstall on the mini with no shared instances, at idle, outside any hold; one Mac set there stays green. This
  ships the new hooks before any concurrency.

### M2 — MAWS: the shared-state fixes and the routing

At the end:
- MAWS's plan can send a named list of groups (`MAC_SHARED_E2E`, empty at first) to `[ci-kit-mac-shared]`, and every
  other Mac job to today's labels;
- exclusive Mac jobs' timeouts carry the 10-minute bound (30 → 40, measured 45 → 55). A group routed shared gets its
  own budget plus the 60-minute shared bound, pinned by a test while the list is empty;
- a test pins the lane's contract: every step of a Mac job that can run after a failed start is an artifact upload, or
  is gated on a step that runs only after admission;
- the e2e build cache is per runner, and the clipboard lock path is machine-wide;
- windows open at a per-instance origin, and the budgets read `CI_KIT_SHARED_DESKTOP`.

With the list empty, nothing behaves differently.

Proof: class 1a on the pool green; one Mac set at the head green (scheduled through CI-opt, never inside a hold); the
PR goes to the MAWS architect, who lands it.

### M3 — Install the shared instances on the mini

After M1 and M2 land, outside any hold or measured window:
- reinstall with `--shared 2`, at idle; the new shared instances start disabled;
- check that both shared runners register with only `ci-kit-mac-shared`, that their `$TMPDIR` equals the exclusive
  instance's, and that each has its own `_work`;
- update the coordinator's hold and release scripts to cover every instance and restore each shared instance's enabled
  state;
- before enabling any shared instance: MAWS's `scripts/ci-gate-alerts.mjs` must fold the `-<n>` suffix (it reads
  `ci-kit-mac-mini-2` as a machine `mini-2`, outside `mini`'s alert), or skip shared runners;
- delete the orphaned `~/Library/Caches/maws-e2e-build/<sha>` entries (M2 moved the cache to `<runner name>/`);
- tell every session that books the mini.

The shared instances are enabled only for trial runs until M4's verdict.

### M4 — Trial and the first proven-shared groups

In a window agreed with the MAWS architect, quiet flag down, nothing else of anyone's on the mini:
1. `unit:darwin` beside itself and beside a quiet group.
2. The audit's first pair, `browser` with `connectors`.
3. Then the frequent quiet groups, each through Design's evidence list.
4. An old commit's exclusive Mac jobs, one functional and one measured, admitted while shared jobs run: each finishes
   within its old timeout, and the measured one's timings stay inside their solo spread.
5. Measured groups beside shared preparation: cold preparation, a download failure, and a cancel-and-replace burst of
   shared jobs during the measured interval. Each measured timing stays inside its solo spread, or sharing is not
   enabled while measured groups can run (Design, the cost).

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

- Spec: two `doperpowers:adversarial-reviewer` rounds, done. A third, focused on the admission lock and its recovery,
  runs on this revision while M1 is built; its findings reach M1 before its PR is reviewed.
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
- 2026-10-21 (second review, all taken): **admission in the hooks under one lock; no listener is stopped.** The
  second adversarial review (astra) found two P1s and two P2s in the second draft:
  1. A shared wrapper could pass its check, stall, and start after the exclusive hook read it as stopped. It was
     reproduced with the unmodified `runner-hold.sh` and a fake service.
  2. The drain's SIGTERM could land after a listener accepted its next job, leaving the job in progress on an offline
     runner or cancelling it. Every exclusive admission would have exposed shared jobs to this.
  3. The `self-hosted` label let a bare `runs-on: self-hosted` job reach a shared instance.
  4. An old commit's exclusive job kept its old timeout but met the new 20-minute wait.

  The fixes:
  - Both sides now check and write under one `flock`, so there is no window between a check and a write, and no
    listener is ever stopped.
  - Shared instances carry `ci-kit-mac-shared` alone.
  - The exclusive wait bound drops to 10 minutes, and M4 admits only groups whose p95 is at most 8, so an old workflow
    still fits its old timeout (Time budgets).

  The alternatives rejected:
  - A runner-supported one-job lifecycle (ephemeral or JIT shared runners). It is race-free at the server, but it
    needs a credential on the mini that can register runners, readable by every job running as the same user.
  - Detecting and rerunning jobs lost in a shutdown. It needs an `actions: write` token on the mini, and it still
    loses the job once.

  The costs taken:
  - Round one's objection returns in bounded form: a shared job assigned during an exclusive job prepares beside it,
    3–4 s, at most once per shared instance per exclusive job.
  - A parked shared job burns its own timeout, which is why its budget carries the shared bound.

  Chosen with M1's builder:
  - the dialog drain's marker parks shared admission, and the hold keeps a single owner;
  - the exclusive sweep spares live shared workers and their descendants;
  - each shared instance keeps its enabled state across a re-install;
  - a stuck hold opens one alert issue.
- 2026-10-21 (third review, all taken): **claims last to the job's end, and recovery runs under the lock.** The third
  adversarial review (astra) of the lock found:
  1. P1: a refused hook is not an abort. Later `failure()`/`always()`/`!cancelled()` steps run, so a start refused
     after dropping its claim could run work beside a neighbour.
  2. P1: crash recovery swept after two idle reads but outside the lock, and could kill the next exclusive job started
     in between. It was reproduced on a pure process table against `selectStrays`.
  3. P2: preparation beside an exclusive job recurs in failure cases (failed initialization, cancellation, download
     retries), so the "once, 3–4 s" bound held only in the common case.

  The fixes:
  - Claims are held until the end hook.
  - The contract for post-refusal steps, pinned by MAWS.
  - Recovery runs under the lock, and every sweep spares all live workers.
  - M4 evidence for measured groups beside preparation bursts, with a stated fallback.

- 2026-10-21 (M1's builder, from the runner source): **no runner-level abort.** The alternative was to end a refused
  job by sending SIGKILL to its own `Runner.Worker`. The runner source (v2.338.0) shows it would work mechanically: the
  listener reads the signalled exit as a worker crash and reports the job Failed (`JobDispatcher.cs` L543–601), it
  keeps dispatching (`Runner.cs`), and no further step runs, since the end hook and post steps run inside the worker
  (`JobExtension.cs` L572–581). It was rejected for two reasons:
  - The `ci-kit: … rerun` line would likely never reach the job's log, because the worker uploads its own step logs.
    The caller would see a worker crash, not a refusal.
  - The end hook would never run, so a claim could be released only by staleness or the watcher's reconcile.

  The contract on post-refusal steps stands.
- 2026-10-21: **`tool-time-heavy-live` stays exclusive** while it is in `MEASURED_E2E`, though its code is safe beside
  others. Dropping it from that list is MAWS's call.

## Surprises & Discoveries

- 2026-10-21, M1 (ci-kit #67), from its reviews:
  - **A cross-instance sweep uses the caller's own `sweep.mjs`, with `--work <dir>`**, not the target instance's copy.
    A half-installed shared directory (no hooks yet) otherwise refused every exclusive job. Each job's own sweeps still
    find their `_work` from their own location.
  - **The target is matched by its real path** (`realpathSync`): `lsof` reports physical paths, so a symlinked home
    hid leftovers.
  - **Workers are known by the kernel's executable path** (`runner-state.py --workers`, read right after the `ps`
    snapshot; a failed read kills nothing). `ps` cannot identify a worker by its executable: it prints argv[0] and
    unquoted command lines, so a path with a space made a live parked hook look like a leftover.
  - **Waits:** the exclusive start waits up to 180 s for the lock, because a recovery sweep under it is bounded at
    120 s. Shared starts retry inside their own bound.
  - **Debt** (PR body; ci-kit #44 for the watcher):
    - leftovers that survive a shared job's end sweep sit beside other shared jobs until the next exclusive admission;
    - a leftover with the symlinked path only in its arguments is not matched;
    - parked jobs poll the lock about once a second.

- 2026-10-21, M2 (MAWS #103):
  - **The runner-name contract.** MAWS reads an instance's number from the trailing `-<n>` of `RUNNER_NAME`
    (`ci-kit-mac-<machine>-<n>`), and fails a launch under `CI_KIT_SHARED_DESKTOP=1` without it. M1 keeps that naming
    and documents it.
  - **Bounds M4 must weigh before sharing a group:**
    - `browser-chrome`'s 34 ms "no hole" check is the product's `STILL_SETTLE_MS`, not a test bound, so it cannot go
      through the latency budget;
    - `scm`'s 150 ms bound tells the stage's own refresh from the watcher's 250 ms debounce, which it can no longer do
      at the budget's 5× ceiling;
    - `unit:darwin`'s `--maxWorkers` is not halved when shared, as the audit suggested. Decide it before trialling
      `unit:darwin` with itself.
  - **`packaged`'s upload** is not gated on its checkout, unlike e2e's. After a refused start it would upload the
    previous job's reports. The contract allows it, since no desktop is used, but it is a correctness wart for MAWS's
    tracker.

## Outcomes & Retrospective

(At completion.)
