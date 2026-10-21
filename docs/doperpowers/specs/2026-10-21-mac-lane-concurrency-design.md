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

- **Instance.** One runner of the lane on a machine: its directory, LaunchAgent and runner name. The mini's first is
  today's `ci-kit-mac-mini` in `~/actions-runner-maws`.
- **Desktop lease.** A machine-wide reader-writer lock on the GUI session. Every lane job holds it shared. A job its
  repo names exclusive holds it alone.
- **Exclusive group.** A job that must run alone: measured, foreground, or not yet proven. The calling repo names
  them.

## Progress

- [x] (2026-10-21 09:5xZ) Read-only audit of every MAWS Mac group (local: `~/Developer/ci-analysis/mac-concurrency-audit.md`
  on the MacBook; MAWS is private, so this spec carries its conclusions, not its line references).
- [ ] M1 — ci-kit: instances and the desktop lease.
- [ ] M2 — MAWS: the exclusive list and the shared-state fixes.
- [ ] M3 — Install the second instance on the mini.
- [ ] M4 — Trial.
- [ ] M5 — Widen the shared set.
- [ ] M6 — A third instance (only if M4's memory reads allow).

## Design

**Instances.** `mac/install.sh` takes an instance count, 2 by default (1 keeps today's install).
- Instance 1 keeps its directory, LaunchAgent label and runner name, so a machine that installs with one instance is
  unchanged.
- Instance *n* ≥ 2 has:
  - directory `~/actions-runner-maws-<n>`, with its own `_work`;
  - LaunchAgent `com.ssfskim.ci-kit.mac-runner-<n>`;
  - runner name `ci-kit-mac-<machine>-<n>`, with the same labels.
- Everything else is shared: the hooks (one copy, run from each instance), the dialog watcher (one per machine), the
  logs, and the state files.
- What today reads one runner reads every instance:
  - `runner-state.py`'s idle check;
  - the dialog watcher's drain (`runner-drained` holds every instance);
  - the sweep, which already scopes itself to its own `_work`;
  - uninstall.
- A hold or a drain is not complete until every instance is idle and booted out.

**The desktop lease.** A reader-writer lock in one machine-wide state directory under `~/Library/Application Support/ci-kit/`.
- **Shared.** Every lane job takes the lease shared in its job-started hook, before the dialog and Terminal steps.
  It waits while an exclusive holder or an exclusive waiter exists.
- **Exclusive.** A job its repo names exclusive upgrades through the step `SSFSKIM/ci-kit/mac/lease@v1`. The step runs
  first in the job, before `settle`, because the hook cannot tell one matrix entry from another (`GITHUB_JOB` is `e2e`
  for every group). While waiting, the job gives up its shared hold, so two exclusive waiters cannot deadlock each
  other. Exclusive waiters are granted oldest first.
- **Release.** The job-completed hook releases the lease. A holder whose job is gone is stale and is dropped by the next
  reader. A holder is identified by its instance and the job's `Runner.Worker` process; the instance's runner having
  moved on, or the process being gone, makes it stale.
- **Waits.** Any wait longer than the bound (30 min, an input) ends the job with a `ci-kit: … rerun` line, so
  MAWS's ci-gate counts it as refused and relaunches it. Every grant, wait and release goes to the hooks log and to the
  job's log, with who held the lease.
- **Measured jobs.** For a measured job, `settle` now runs inside an exclusive lease, so the quiet it reads stays quiet
  for the whole job.
- **Mutual exclusion.** State changes take a `mkdir` mutex; macOS has no `flock(1)`.

**What runs beside what.** The calling repo decides. MAWS lists its exclusive groups in `gate.yml`:
- `MEASURED_E2E` and the foreground groups (`default`, `widgets`, `to-human`, `document-app`);
- until M5, every group the audit found unsafe without a change (`tools`, `deliverables`, `dashboard`, `design`);
- any group a trial shows to differ beside a neighbour.

`unit:darwin` is shared, but never beside a measured group (the lease guarantees that), and runs at half the cores when
another job holds the lease.

**MAWS's shared state** (M2; the audit's hazards):
- **The e2e build cache** becomes one directory per instance (`…/maws-e2e-build/$RUNNER_NAME`). Two jobs on one
  variant otherwise race its restore, store and prune. The cost is one extra build per variant per instance.
- **The clipboard lock** moves from `os.tmpdir()` to a fixed machine-wide path, so it holds across instances. The
  dashboard steps that use the pasteboard outside it move inside it (M5).
- **Each instance's windows open at their own origin**, so two jobs' windows do not stack exactly. A covered window's
  child WebContentsViews stop drawing.
- **A shared-host flag** (`MAWS_E2E_SHARED_HOST=1`, set by the lane when the lease is shared) makes the load-aware
  latency budgets treat the host as loaded. The raw bounds the audit names go through that budget.
- **Later (M5):**
  - a lock around the recorded `/private/tmp` repo directories that four groups create and delete;
  - focus calls under quiet e2e that do not activate the app;
  - the dashboard clipboard steps.

**Memory.** The mini has 16 GB, most of it used by the owner's sessions. Two jobs fit by estimate. A sampler records
memory pressure, swap and free memory through M4. A third instance (M6) needs M4's reads to show no pressure above
level 1 and no swap growth.

**The trial.** Taken from the audit's protocol:
- The first pair is `browser` (harness build) with `connectors` (plain build). Both are quiet; they use different build
  variants; and together they probe the open questions: occlusion of WebContentsViews, activation by
  `webContents.focus()`, and the cross-instance clipboard lock.
- At least 10 paired runs at one sha, alternating which starts first, plus solo runs of each at that sha as the
  control.
- A 1 Hz `lsappinfo front` and load logger runs outside the jobs.
- **The pair fails the classification on any of:**
  - a red the solo control lacks;
  - an action stuck waiting for stability;
  - a stalled screenshot;
  - a visibility read of hidden in a scene that showed its window;
  - an Electron app frontmost;
  - a clipboard lock timeout;
  - a failed cache restore.
- Then `terminal` with `code`, comparing latency annotations against solo.
- Then the whole Mac set at one sha, serial (one instance enabled) against concurrent (two). Compare per-group results,
  wall time and the queue's drain time.

## Plan of Work

### M1 — ci-kit: instances and the desktop lease

At the end, `mac/install.sh` can install *n* instances, and the lease and its step exist. Tests prove the lease's
states without a Mac. Nothing on the mini changes in M1.
- `mac/install.sh`: instance count, instance paths and names; idempotent; uninstall removes every instance.
- `mac/hooks/lease.*`: acquire shared (from `job-started.sh`, before the dialog check), upgrade to exclusive, release
  (from `job-completed.sh`), stale detection, the log lines, the refusal line.
- `mac/lease/action.yml`: inputs `mode` (exclusive) and `bound` (30 min).
- `runner-state.py`, the dialog watcher's drain and `desktop-check.sh` read every instance.
- `docs/mac-lane.md`:
  - "Why one runner per machine" becomes the lease section;
  - holds and drains name every instance;
  - the Adding a Mac section gets the instance count.
- Tests (node --test, the repo's pattern):
  - two shared holders at once;
  - an exclusive holder blocking a shared one;
  - an exclusive waiter blocking new shared holders;
  - two exclusive waiters with no deadlock, oldest first;
  - stale holders dropped;
  - the bound's refusal line;
  - a hook run with one instance installed behaves exactly as today, apart from the log line.

Proof:
- `npm test` and `ci-gate` green, and `doperpowers:reviewer-medium` on the PR.
- Merge, and move `v1` by the PATCH rule.

### M2 — MAWS: the exclusive list and the shared-state fixes

At the end, MAWS's `gate.yml`:
- names its exclusive groups;
- runs the lease step first in each of them (before `settle` where both run);
- gives each instance its own e2e build cache;
- and MAWS has the fixed clipboard-lock path, the per-instance window origin and the shared-host flag.

With one instance nothing behaves differently, because the lease is always free.

Proof:
- class 1a on the pool green;
- one Mac set at the head, with one instance, green, scheduled through CI-opt (never inside a hold);
- the PR goes to the MAWS architect, who lands it.

### M3 — Install the second instance on the mini

After M1 merges and outside any hold or measured window:
- reinstall the lane on the mini with two instances, at idle;
- check that both runners are online, that both instances' `$TMPDIR` is the same, and that each has its own `_work`;
- update the coordinator's hold and release scripts (`~/Developer/ci-analysis/hold-now.sh` and the release command) to
  boot out, and bring back, every instance;
- tell every session that books the mini.

Until M4's verdict, instance 2 stays disabled except during trial runs.

### M4 — Trial

As in Design, in a window agreed with the MAWS architect: no measured or foreground job of anyone else on the mini
during the trial, and the quiet flag down.
- Record every run's id, its pair partner, the front-app log, and the memory and load samples, in this spec's Surprises.
- **Verdict:**
  - groups that pass go into MAWS's shared set;
  - any that fail join the exclusive list, with the evidence;
  - instance 2 is enabled permanently if the shared set is non-empty and memory held.

### M5 — Widen the shared set

MAWS fixes for the four groups the audit found unsafe without a change:
- the recorded-directory lock;
- the dashboard clipboard steps;
- deliverables' notification focus;
- the quiet-focus helper where the trial showed activation.

Each group leaves the exclusive list only after a paired trial like M4's.

### M6 — A third instance

Only if M4's and M5's memory reads show room: install instance 3 and repeat a short trial at three.

## Verification

- Spec: one `doperpowers:adversarial-reviewer` round on the design and the execution section.
- M1: `doperpowers:reviewer-medium`, ci-gate.
- M2, M5: the MAWS architect lands each, on a green class 1a and a green Mac set.
- M4: the trial's own pass rule, checked by the spec's owner against the run logs.

## Decision Log

- 2026-10-21: **Lease on the host, not VMs or a second Mac.** The owner ruled for parallelism and pointed at the
  mini's idle CPU. A second Mac was declined on 10-21's measurement, and the Tart VM runner was put on hold by the
  owner after the spike: 1.3–1.7× slower e2e, and a display-geometry difference that failed a case. The host lease
  keeps the calibrated desktop and costs nothing new.
- 2026-10-21: **The repo names its exclusive groups.** The lane cannot tell a measured or foreground matrix entry from
  any other; MAWS already lists its measured groups in `gate.yml`, and the step form follows `settle`.
- 2026-10-21: **Writer preference, and a waiting exclusive job gives up its shared hold.** Without the first,
  shared jobs starve a measured job. Without the second, two exclusive waiters each holding shared deadlock.
- 2026-10-21: **`tool-time-heavy-live` stays exclusive** while it is in `MEASURED_E2E`, though its code is safe beside
  others. Dropping it from that list is MAWS's call.

## Surprises & Discoveries

(As found.)

## Outcomes & Retrospective

(At completion.)
